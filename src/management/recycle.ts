import type { Database } from "../db/pool.js";
import type { OperationScope } from "../operations/commit.js";
import { BusinessError } from "../operations/errors.js";
import { hasProjectCapability } from "../security/project-access.js";
import { opaqueId, isPlainObject } from "../server/support.js";
import { managementMutation } from "./transaction.js";
export function recycleOperations(
  db: Database,
  check?: (c: Pick<Database, "query">) => Promise<void>,
) {
  const canManageProject = (p: string, a: string) =>
    hasProjectCapability(db, p, a, "manage");
  const storedStringArray = (value: unknown): string[] =>
    Array.isArray(value) && value.every((x) => typeof x === "string")
      ? value
      : [];
  async function versionBranch(
    client: Pick<Database, "query">,
    testSetId: string,
    rootVersionId: string,
  ) {
    const result = await client.query(
      `WITH RECURSIVE branch AS (
         SELECT id, parent_version_id, status
           FROM test_set_version
          WHERE id = $2 AND test_set_id = $1
         UNION ALL
         SELECT child.id, child.parent_version_id, child.status
           FROM test_set_version child
           JOIN branch parent ON child.parent_version_id = parent.id
          WHERE child.test_set_id = $1
       )
       SELECT id, parent_version_id, status FROM branch`,
      [testSetId, rootVersionId],
    );
    return result.rows;
  }

  function trashEntryResponse(row: Record<string, unknown>) {
    return {
      id: String(row.id),
      type: row.type,
      testSetId: row.test_set_id,
      testSetName: row.test_set_name,
      rootVersionId: row.root_version_id,
      rootVersionLabel: row.root_version_label,
      versionCount: Number(row.version_count),
      trashedAt: new Date(row.trashed_at as string).toISOString(),
      pendingCleanup: row.status === "purging",
    };
  }

  return {
    async trashSet(scope: OperationScope, input: any = {}) {
      return managementMutation(
        db,
        scope,
        async (db) => {
          const actor = { id: scope.actorId };

          if (!(await canManageProject(scope.projectId, actor.id)))
            throw new BusinessError(404, "project_not_found");
          if (!isPlainObject(input.body) || Object.keys(input.body).length)
            throw new BusinessError(422, "trash_payload_invalid");

          const testSet = await db.query(
            `SELECT id FROM test_set
            WHERE id = $1 AND project_id = $2 AND status = 'available' FOR UPDATE`,
            [input.testSetId, scope.projectId],
          );
          if (!testSet.rowCount) {
            throw new BusinessError(404, "test_set_not_found");
          }
          const versions = await db.query(
            `SELECT id FROM test_set_version
            WHERE test_set_id = $1 AND status IN ('published', 'tombstoned', 'trashed')`,
            [input.testSetId],
          );
          const entryId = opaqueId("trash");
          await db.query(
            "UPDATE test_set SET status = 'trashed' WHERE id = $1",
            [input.testSetId],
          );
          await db.query(
            `UPDATE test_set_trash_entry
              SET status = 'restored', updated_at = now()
            WHERE test_set_id = $1 AND type = 'version_branch' AND status = 'trashed'`,
            [input.testSetId],
          );
          await db.query(
            `INSERT INTO test_set_trash_entry
             (id, project_id, test_set_id, type, version_ids, status)
           VALUES ($1, $2, $3, 'test_set', $4::jsonb, 'trashed')`,
            [
              entryId,
              scope.projectId,
              input.testSetId,
              JSON.stringify(versions.rows.map((row) => row.id)),
            ],
          );

          return { entry: { id: entryId, type: "test_set" } };
        },
        false,
        check,
      );
    },
    async trashBranch(scope: OperationScope, input: any = {}) {
      return managementMutation(
        db,
        scope,
        async (db) => {
          const actor = { id: scope.actorId };

          if (!(await canManageProject(scope.projectId, actor.id)))
            throw new BusinessError(404, "project_not_found");
          if (
            !isPlainObject(input.body) ||
            Object.keys(input.body).some(
              (key) => key !== "includeDescendants",
            ) ||
            (input.body.includeDescendants !== undefined &&
              typeof input.body.includeDescendants !== "boolean")
          )
            throw new BusinessError(422, "trash_payload_invalid");

          const testSet = await db.query(
            `SELECT id FROM test_set
            WHERE id = $1 AND project_id = $2 AND status = 'available' FOR UPDATE`,
            [input.testSetId, scope.projectId],
          );
          if (!testSet.rowCount) {
            throw new BusinessError(404, "test_set_not_found");
          }
          const branch = await versionBranch(
            db,
            input.testSetId,
            input.versionId,
          );
          if (!branch.length || branch[0].status !== "published") {
            throw new BusinessError(404, "version_not_found");
          }
          if (branch.some((row) => row.status !== "published")) {
            throw new BusinessError(409, "version_branch_unavailable");
          }
          if (branch.length > 1 && input.body.includeDescendants !== true) {
            throw new BusinessError(422, "version_branch_required");
          }
          const entryId = opaqueId("trash");
          const versionIds = branch.map((row) => String(row.id));
          await db.query(
            "UPDATE test_set_version SET status = 'trashed' WHERE id = ANY($1::text[])",
            [versionIds],
          );
          await db.query(
            `INSERT INTO test_set_trash_entry
             (id, project_id, test_set_id, type, root_version_id, version_ids, status)
           VALUES ($1, $2, $3, 'version_branch', $4, $5::jsonb, 'trashed')`,
            [
              entryId,
              scope.projectId,
              input.testSetId,
              input.versionId,
              JSON.stringify(versionIds),
            ],
          );

          return {
            entry: {
              id: entryId,
              type: "version_branch",
              rootVersionId: input.versionId,
            },
          };
        },
        false,
        check,
      );
    },
    async trash(scope: OperationScope, input: any = {}) {
      const actor = { id: scope.actorId };
      const limit = Number(input.query.limit ?? 10);
      const offset = Number(input.query.offset ?? 0);
      if (
        Object.keys(input.query).some(
          (key) => !["limit", "offset"].includes(key),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        throw new BusinessError(422, "query_parameter_invalid");
      if (
        !(await hasProjectCapability(db, scope.projectId, actor.id, "manage"))
      )
        throw new BusinessError(404, "project_not_found");
      const entries = await db.query(
        `SELECT e.id, e.type, e.test_set_id, e.root_version_id, e.status, e.trashed_at,
                ts.name AS test_set_name, root.version_label AS root_version_label,
                jsonb_array_length(e.version_ids) AS version_count
           FROM test_set_trash_entry e
           JOIN test_set ts ON ts.id = e.test_set_id
           LEFT JOIN test_set_version root ON root.id = e.root_version_id
          WHERE e.project_id = $1 AND e.status IN ('trashed', 'purging')
          ORDER BY e.trashed_at DESC, e.id DESC LIMIT $2 OFFSET $3`,
        [scope.projectId, limit, offset],
      );
      const total = await db.query(
        `SELECT count(*)::integer AS total FROM test_set_trash_entry
          WHERE project_id = $1 AND status IN ('trashed', 'purging')`,
        [scope.projectId],
      );
      return {
        entries: entries.rows.map(trashEntryResponse),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
    async restore(scope: OperationScope, input: any = {}) {
      return managementMutation(
        db,
        scope,
        async (db) => {
          const actor = { id: scope.actorId };

          if (!(await canManageProject(scope.projectId, actor.id)))
            throw new BusinessError(404, "project_not_found");
          if (!isPlainObject(input.body) || Object.keys(input.body).length)
            throw new BusinessError(422, "restore_payload_invalid");

          const entryIdentity = await db.query(
            `SELECT test_set_id FROM test_set_trash_entry
            WHERE id=$1 AND project_id=$2 AND status='trashed'`,
            [input.entryId, scope.projectId],
          );
          if (!entryIdentity.rowCount) {
            throw new BusinessError(404, "trash_entry_not_found");
          }
          await db.query("SELECT id FROM test_set WHERE id=$1 FOR UPDATE", [
            entryIdentity.rows[0].test_set_id,
          ]);
          const entry = await db.query(
            `SELECT * FROM test_set_trash_entry
            WHERE id = $1 AND project_id = $2 AND status = 'trashed' FOR UPDATE`,
            [input.entryId, scope.projectId],
          );
          if (!entry.rowCount) {
            throw new BusinessError(404, "trash_entry_not_found");
          }
          const row = entry.rows[0];
          const versionIds = storedStringArray(row.version_ids);
          if (row.type === "test_set") {
            await db.query(
              "UPDATE test_set SET status = 'available' WHERE id = $1 AND status = 'trashed'",
              [row.test_set_id],
            );
          }
          await db.query(
            "UPDATE test_set_version SET status = 'published' WHERE id = ANY($1::text[]) AND status = 'trashed'",
            [versionIds],
          );
          await db.query(
            "UPDATE test_set_trash_entry SET status = 'restored', updated_at = now() WHERE id = $1",
            [row.id],
          );

          return { restored: true };
        },
        false,
        check,
      );
    },
  };
}
