import type { PoolClient } from "pg";
import { canonicalJson, sha256 } from "../../package/contract.js";
import { hasProjectCapability } from "../../security/project-access.js";
import { createCheckpoint } from "../../version/checkpoint.js";
import type { ServerContext } from "../context.js";
import {
  AuthenticatedRequest,
  opaqueId,
  isPlainObject,
  projectResponse,
} from "../support.js";

export function registerDeletion(
  context: Pick<
    ServerContext,
    "db" | "artifacts" | "app" | "authenticate" | "writeAllowed"
  >,
) {
  const { db, artifacts, app, authenticate, writeAllowed } = context;
  const storedStringArray = (value: unknown) =>
    Array.isArray(value) && value.every((id) => typeof id === "string")
      ? value
      : [];

  async function versionBranch(
    client: PoolClient,
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

  async function protectDeletionBoundaries(
    client: PoolClient,
    testSetId: string,
    deletedIds: string[],
    projectId: string,
  ) {
    const boundaries = await client.query(
      `WITH RECURSIVE path AS (
         SELECT id,parent_version_id,status FROM test_set_version
          WHERE test_set_id=$1 AND parent_version_id=ANY($2::text[])
            AND id<>ALL($2::text[])
         UNION ALL
         SELECT child.id,child.parent_version_id,child.status
           FROM test_set_version child JOIN path parent
             ON child.parent_version_id=parent.id
          WHERE child.test_set_id=$1
            AND parent.status IN ('tombstoned','permanently_deleted','degraded_by_deletion')
       )
       SELECT path.id,path.parent_version_id
         FROM path
        WHERE path.status IN ('published','trashed','archived') ORDER BY path.id`,
      [testSetId, deletedIds],
    );
    for (const row of boundaries.rows) {
      const versionId = String(row.id);
      const parentId = String(row.parent_version_id);
      const checkpoint = await createCheckpoint(
        client,
        versionId,
        "deletion_cut",
        projectId,
      );
      if (checkpoint === "skipped")
        throw new Error("deletion_cut_checkpoint_skipped");
      const recordedCut = await client.query(
        "SELECT 1 FROM version_provenance_cut_state WHERE version_id=$1 AND parent_version_id=$2",
        [versionId, parentId],
      );
      if (!recordedCut.rowCount) {
        const before = await client.query(
          `SELECT vm.case_id,cr.input,cr.expected_output,cr.metadata,cr.origin_ref
           FROM resolve_version_members_internal($1,true,true) vm
           JOIN case_revision cr ON cr.id=vm.case_revision_id`,
          [parentId],
        );
        const after = await client.query(
          `SELECT vm.case_id,cr.input,cr.expected_output,cr.metadata,cr.origin_ref
           FROM resolve_version_members_internal($1,true,true) vm
           JOIN case_revision cr ON cr.id=vm.case_revision_id`,
          [versionId],
        );
        const beforeById = new Map(
          before.rows.map((member) => [String(member.case_id), member]),
        );
        const afterById = new Map(
          after.rows.map((member) => [String(member.case_id), member]),
        );
        const facts = [
          ...new Set([...beforeById.keys(), ...afterById.keys()]),
        ].map((caseId) => {
          const previous = beforeById.get(caseId);
          const current = afterById.get(caseId);
          const changedFields =
            previous && current
              ? (
                  [
                    ["question", previous.input, current.input],
                    [
                      "expectedOutput",
                      previous.expected_output,
                      current.expected_output,
                    ],
                    ["metadata", previous.metadata, current.metadata],
                    ["source", previous.origin_ref, current.origin_ref],
                  ] as const
                )
                  .filter(
                    ([, oldValue, newValue]) =>
                      canonicalJson(oldValue) !== canonicalJson(newValue),
                  )
                  .map(([field]) => field)
              : [];
          return {
            caseId,
            changeType: !previous
              ? "added"
              : !current
                ? "removed"
                : changedFields.length
                  ? "modified"
                  : "unchanged",
            changedFields,
          };
        });
        await client.query(
          "DELETE FROM version_provenance_cut_fact WHERE version_id=$1",
          [versionId],
        );
        if (facts.length)
          await client.query(
            `INSERT INTO version_provenance_cut_fact
           (version_id,case_id,change_type,changed_fields)
           SELECT $1,x.case_id,x.change_type,x.changed_fields
             FROM jsonb_to_recordset($2::jsonb)
               AS x(case_id text,change_type text,changed_fields jsonb)`,
            [
              versionId,
              JSON.stringify(
                facts.map((fact) => ({
                  case_id: fact.caseId,
                  change_type: fact.changeType,
                  changed_fields: fact.changedFields,
                })),
              ),
            ],
          );
        await client.query(
          `INSERT INTO version_provenance_cut_state(version_id,parent_version_id)
           VALUES ($1,$2) ON CONFLICT (version_id) DO UPDATE
             SET parent_version_id=EXCLUDED.parent_version_id,completed_at=now()`,
          [versionId, parentId],
        );
      }
    }
    return boundaries.rows.map((row) => String(row.id));
  }

  async function clearVersionContent(
    client: PoolClient,
    versionIds: string[],
    status: "tombstoned" | "permanently_deleted",
    marker: string,
  ) {
    const objects = await client.query(
      `SELECT v.manifest_object_ref, v.cleanup_object_refs,
              cs.object_ref, cs.evidence_object_ref,
              cs.id AS candidate_id, cs.draft_revision_id, cs.draft_id
         FROM test_set_version v
         LEFT JOIN candidate_snapshot cs ON cs.id = v.candidate_id
        WHERE v.id = ANY($1::text[])`,
      [versionIds],
    );
    const objectRefs: string[] = [
      ...new Set(
        objects.rows.flatMap((row) =>
          [
            row.manifest_object_ref,
            row.object_ref,
            row.evidence_object_ref,
            ...storedStringArray(row.cleanup_object_refs),
          ].filter(
            (value): value is string =>
              typeof value === "string" && value.startsWith("blobs/"),
          ),
        ),
      ),
    ];
    const revisionRows = await client.query(
      `SELECT DISTINCT revision_id FROM (
         SELECT vm.case_revision_id AS revision_id FROM version_member vm
          WHERE vm.version_id = ANY($1::text[])
         UNION ALL
         SELECT ch.after_revision_id FROM version_change ch
          WHERE ch.version_id = ANY($1::text[]) AND ch.after_revision_id IS NOT NULL
         UNION ALL
         SELECT cm.case_revision_id FROM version_checkpoint_member cm
          WHERE cm.version_id = ANY($1::text[])
       ) refs`,
      [versionIds],
    );
    const revisionIds = revisionRows.rows.map((row) => String(row.revision_id));
    const candidateIds = objects.rows.map((row) => String(row.candidate_id));
    await client.query(
      "DELETE FROM version_export_cache WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_provenance_cut_fact WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_provenance_cut_state WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM candidate_item WHERE candidate_id = ANY($1::text[])",
      [candidateIds],
    );
    await client.query(
      "DELETE FROM candidate_transformation_run WHERE candidate_id = ANY($1::text[])",
      [candidateIds],
    );
    await client.query(
      "DELETE FROM version_checkpoint WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_change WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      "DELETE FROM version_member WHERE version_id = ANY($1::text[])",
      [versionIds],
    );
    await client.query(
      `UPDATE candidate_snapshot cs
          SET status = 'tombstoned', object_ref = NULL,
              evidence_object_ref = NULL, item_count = 0,
              payload_hash = NULL, evidence_hash = NULL,
              recipe = NULL, sources = NULL, validation_report = NULL,
              attribution_revision_id = NULL, asset_id = NULL,
              parsed_view_id = NULL, schema_revision_id = NULL,
              draft_revision_id = NULL, base_version_id = NULL
         FROM test_set_version v
        WHERE v.id = ANY($1::text[]) AND cs.id = v.candidate_id`,
      [versionIds],
    );
    const draftRevisionIds = objects.rows
      .map((row) => row.draft_revision_id)
      .filter((id): id is string => typeof id === "string");
    if (draftRevisionIds.length)
      await client.query(
        `UPDATE draft_revision dr
            SET recipe = NULL, sources = NULL, operations = '[]'::jsonb,
                version_description = ''
          WHERE dr.id = ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM candidate_snapshot cs
               WHERE cs.draft_revision_id = dr.id AND cs.status <> 'tombstoned'
            )`,
        [draftRevisionIds],
      );
    const draftIds = objects.rows.map((row) => String(row.draft_id));
    if (draftIds.length) {
      await client.query(
        `UPDATE draft_case_operation
            SET previous_content=NULL,diff=NULL
          WHERE draft_id=ANY($1::text[])`,
        [draftIds],
      );
      await client.query(
        `UPDATE draft_revision dr SET operations=COALESCE(
           (SELECT jsonb_agg(op.value - 'previous_content' - 'diff'
                             ORDER BY op.ordinality)
              FROM jsonb_array_elements(dr.operations)
                   WITH ORDINALITY AS op(value,ordinality)),
           '[]'::jsonb)
          WHERE draft_id=ANY($1::text[])`,
        [draftIds],
      );
    }
    const exclusiveDrafts = await client.query(
      `SELECT wd.id FROM working_draft wd
        WHERE wd.id=ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM candidate_snapshot cs
             WHERE cs.draft_id=wd.id AND cs.status<>'tombstoned'
          )`,
      [draftIds],
    );
    const exclusiveDraftIds = exclusiveDrafts.rows.map((row) => String(row.id));
    if (exclusiveDraftIds.length) {
      await client.query(
        `UPDATE working_draft
            SET status='abandoned',recipe=NULL,base_version_id=NULL,version_description=''
          WHERE id=ANY($1::text[])`,
        [exclusiveDraftIds],
      );
      await client.query(
        `UPDATE draft_case_operation
            SET input=NULL,expected_output=NULL,metadata=NULL,reason=NULL,
                previous_content=NULL,diff=NULL
          WHERE draft_id=ANY($1::text[])`,
        [exclusiveDraftIds],
      );
      await client.query(
        `UPDATE draft_revision
            SET recipe=NULL,sources=NULL,operations='[]'::jsonb,
                base_version_id=NULL,version_description=''
          WHERE draft_id=ANY($1::text[])`,
        [exclusiveDraftIds],
      );
    }
    if (draftIds.length) {
      const redacted = await client.query(
        `SELECT id,revision,recipe,sources,operations,schema_revision_id,
                base_version_id,version_description
           FROM draft_revision WHERE draft_id=ANY($1::text[])`,
        [draftIds],
      );
      for (const row of redacted.rows) {
        const revisionHash = sha256(
          canonicalJson({
            revision: Number(row.revision),
            recipe: row.recipe,
            versionDescription: row.version_description,
            baseVersionId: row.base_version_id ?? null,
            schemaRevisionId: row.schema_revision_id ?? null,
            sources: row.sources,
            operations: row.operations,
          }),
        );
        await client.query(
          "UPDATE draft_revision SET revision_hash=$2 WHERE id=$1",
          [row.id, revisionHash],
        );
      }
    }
    if (revisionIds.length) {
      const protectedRows = await client.query(
        `SELECT DISTINCT revision_id FROM (
           SELECT vm.case_revision_id AS revision_id FROM version_member vm
           UNION ALL SELECT cm.case_revision_id FROM version_checkpoint_member cm
           UNION ALL SELECT ch.after_revision_id FROM version_change ch
             WHERE ch.after_revision_id IS NOT NULL
         ) refs WHERE revision_id = ANY($1::text[])`,
        [revisionIds],
      );
      const protectedIds = new Set(
        protectedRows.rows.map((row) => String(row.revision_id)),
      );
      const exclusiveIds = revisionIds.filter((id) => !protectedIds.has(id));
      if (exclusiveIds.length) {
        await client.query(
          "UPDATE version_change SET before_revision_id = NULL WHERE before_revision_id = ANY($1::text[])",
          [exclusiveIds],
        );
        await client.query(
          "UPDATE candidate_item SET parent_case_revision_id = NULL WHERE parent_case_revision_id = ANY($1::text[])",
          [exclusiveIds],
        );
        await client.query(
          "UPDATE case_revision SET parent_revision_id = NULL WHERE parent_revision_id = ANY($1::text[])",
          [exclusiveIds],
        );
        await client.query(
          "DELETE FROM case_revision WHERE id = ANY($1::text[])",
          [exclusiveIds],
        );
      }
    }
    await client.query(
      `UPDATE test_set_version
          SET status = $2,
              item_count = 0,
              manifest_object_ref = $3,
              tombstoned_at = CASE WHEN $2 = 'tombstoned' THEN now() ELSE tombstoned_at END,
              cleanup_object_refs = $4::jsonb,
              cleanup_pending = true
        WHERE id = ANY($1::text[])`,
      [versionIds, status, marker, JSON.stringify(objectRefs)],
    );
    return objectRefs;
  }

  async function removeUnreferencedObjects(objectRefs: string[]) {
    for (const objectRef of objectRefs) {
      const references = await db.query(
        `SELECT 1 FROM (
           SELECT object_ref FROM data_asset
            WHERE object_ref = $1 AND status NOT IN ('deletion_pending', 'tombstoned')
           UNION ALL
           SELECT object_ref FROM pending_upload
            WHERE object_ref = $1 AND status IN ('previewable', 'confirmed')
           UNION ALL
           SELECT object_ref FROM candidate_snapshot
            WHERE object_ref = $1 AND status <> 'tombstoned'
           UNION ALL
           SELECT evidence_object_ref FROM candidate_snapshot
            WHERE evidence_object_ref = $1 AND status <> 'tombstoned'
           UNION ALL
           SELECT manifest_object_ref FROM test_set_version
            WHERE manifest_object_ref = $1 AND status IN ('published', 'trashed')
         ) refs LIMIT 1`,
        [objectRef],
      );
      if (!references.rowCount) await artifacts.remove(objectRef);
    }
  }

  async function finishTombstoneCleanup(
    versionId: string,
    objectRefs: string[],
  ) {
    await removeUnreferencedObjects(objectRefs);
    await db.query(
      `UPDATE test_set_version
          SET cleanup_object_refs = '[]'::jsonb, cleanup_pending = false
        WHERE id = $1 AND status = 'tombstoned'`,
      [versionId],
    );
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

  async function canManageProject(projectId: string, actorId: string) {
    return await hasProjectCapability(db, projectId, actorId, "manage");
  }

  app.post<{
    Params: { projectId: string; testSetId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/trash",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (!isPlainObject(request.body) || Object.keys(request.body).length)
        return reply
          .code(422)
          .send({ error: { code: "trash_payload_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id FROM test_set
            WHERE id = $1 AND project_id = $2 AND status = 'available' FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        const versions = await client.query(
          `SELECT id FROM test_set_version
            WHERE test_set_id = $1 AND status IN ('published', 'tombstoned', 'trashed')`,
          [request.params.testSetId],
        );
        const entryId = opaqueId("trash");
        await client.query(
          "UPDATE test_set SET status = 'trashed' WHERE id = $1",
          [request.params.testSetId],
        );
        await client.query(
          `UPDATE test_set_trash_entry
              SET status = 'restored', updated_at = now()
            WHERE test_set_id = $1 AND type = 'version_branch' AND status = 'trashed'`,
          [request.params.testSetId],
        );
        await client.query(
          `INSERT INTO test_set_trash_entry
             (id, project_id, test_set_id, type, version_ids, status)
           VALUES ($1, $2, $3, 'test_set', $4::jsonb, 'trashed')`,
          [
            entryId,
            request.params.projectId,
            request.params.testSetId,
            JSON.stringify(versions.rows.map((row) => row.id)),
          ],
        );
        await client.query("COMMIT");
        return reply
          .code(201)
          .send({ entry: { id: entryId, type: "test_set" } });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/trash",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).some((key) => key !== "includeDescendants") ||
        (request.body.includeDescendants !== undefined &&
          typeof request.body.includeDescendants !== "boolean")
      )
        return reply
          .code(422)
          .send({ error: { code: "trash_payload_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id FROM test_set
            WHERE id = $1 AND project_id = $2 AND status = 'available' FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        if (!testSet.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        }
        const branch = await versionBranch(
          client,
          request.params.testSetId,
          request.params.versionId,
        );
        if (!branch.length || branch[0].status !== "published") {
          await client.query("COMMIT");
          return reply.code(404).send({ error: { code: "version_not_found" } });
        }
        if (branch.some((row) => row.status !== "published")) {
          await client.query("COMMIT");
          return reply
            .code(409)
            .send({ error: { code: "version_branch_unavailable" } });
        }
        if (branch.length > 1 && request.body.includeDescendants !== true) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "version_branch_required" } });
        }
        const entryId = opaqueId("trash");
        const versionIds = branch.map((row) => String(row.id));
        await client.query(
          "UPDATE test_set_version SET status = 'trashed' WHERE id = ANY($1::text[])",
          [versionIds],
        );
        await client.query(
          `INSERT INTO test_set_trash_entry
             (id, project_id, test_set_id, type, root_version_id, version_ids, status)
           VALUES ($1, $2, $3, 'version_branch', $4, $5::jsonb, 'trashed')`,
          [
            entryId,
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
            JSON.stringify(versionIds),
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({
          entry: {
            id: entryId,
            type: "version_branch",
            rootVersionId: request.params.versionId,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/solo-test-set-trash",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some(
          (key) => !["limit", "offset"].includes(key),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const entries = await db.query(
        `SELECT e.id, e.type, e.test_set_id, e.root_version_id, e.status, e.trashed_at,
                ts.name AS test_set_name, root.version_label AS root_version_label,
                jsonb_array_length(e.version_ids) AS version_count
           FROM test_set_trash_entry e
           JOIN test_set ts ON ts.id = e.test_set_id
           LEFT JOIN test_set_version root ON root.id = e.root_version_id
          WHERE e.project_id = $1 AND e.status IN ('trashed', 'purging')
          ORDER BY e.trashed_at DESC, e.id DESC LIMIT $2 OFFSET $3`,
        [request.params.projectId, limit, offset],
      );
      const total = await db.query(
        `SELECT count(*)::integer AS total FROM test_set_trash_entry
          WHERE project_id = $1 AND status IN ('trashed', 'purging')`,
        [request.params.projectId],
      );
      return {
        entries: entries.rows.map(trashEntryResponse),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
  );

  app.post<{
    Params: { projectId: string; entryId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-set-trash/:entryId/restore",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (!isPlainObject(request.body) || Object.keys(request.body).length)
        return reply
          .code(422)
          .send({ error: { code: "restore_payload_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const entryIdentity = await client.query(
          `SELECT test_set_id FROM test_set_trash_entry
            WHERE id=$1 AND project_id=$2 AND status='trashed'`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entryIdentity.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        await client.query("SELECT id FROM test_set WHERE id=$1 FOR UPDATE", [
          entryIdentity.rows[0].test_set_id,
        ]);
        const entry = await client.query(
          `SELECT * FROM test_set_trash_entry
            WHERE id = $1 AND project_id = $2 AND status = 'trashed' FOR UPDATE`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entry.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        const row = entry.rows[0];
        const versionIds = storedStringArray(row.version_ids);
        if (row.type === "test_set") {
          await client.query(
            "UPDATE test_set SET status = 'available' WHERE id = $1 AND status = 'trashed'",
            [row.test_set_id],
          );
        }
        await client.query(
          "UPDATE test_set_version SET status = 'published' WHERE id = ANY($1::text[]) AND status = 'trashed'",
          [versionIds],
        );
        await client.query(
          "UPDATE test_set_trash_entry SET status = 'restored', updated_at = now() WHERE id = $1",
          [row.id],
        );
        await client.query("COMMIT");
        return { restored: true };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/tombstone",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).length !== 1 ||
        typeof request.body.confirmation !== "string"
      )
        return reply
          .code(422)
          .send({ error: { code: "tombstone_confirmation_required" } });
      const client = await db.connect();
      let objectRefs: string[] = [];
      try {
        await client.query("BEGIN");
        const testSet = await client.query(
          `SELECT id FROM test_set WHERE id=$1 AND project_id=$2 AND status='available' FOR UPDATE`,
          [request.params.testSetId, request.params.projectId],
        );
        const version = testSet.rowCount
          ? await client.query(
              `SELECT id,status,version_label,cleanup_object_refs,manifest_object_ref
             FROM test_set_version
            WHERE test_set_id=$1 AND id=$2 AND status IN ('published','tombstoned') FOR UPDATE`,
              [request.params.testSetId, request.params.versionId],
            )
          : { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };
        if (
          !version.rowCount ||
          request.body.confirmation !== String(version.rows[0].version_label)
        ) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "tombstone_confirmation_required" } });
        }
        const descendants = version.rowCount
          ? await client.query(
              `SELECT 1 FROM test_set_version
                WHERE test_set_id = $1 AND parent_version_id = $2
                  AND status IN ('published', 'tombstoned', 'trashed') LIMIT 1`,
              [request.params.testSetId, request.params.versionId],
            )
          : { rowCount: 0 };
        if (!descendants.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(422)
            .send({ error: { code: "middle_version_required" } });
        }
        if (version.rows[0].status === "published") {
          await client.query(
            `UPDATE test_set_version
                SET status='tombstoned',tombstoned_at=now(),cleanup_pending=true
              WHERE id=$1`,
            [request.params.versionId],
          );
          await client.query(
            `DELETE FROM version_export_cache WHERE version_id IN (
               WITH RECURSIVE affected AS (
                 SELECT id FROM test_set_version WHERE id=$1
                 UNION ALL
                 SELECT child.id FROM test_set_version child
                   JOIN affected parent ON child.parent_version_id=parent.id
               ) SELECT id FROM affected
             )`,
            [request.params.versionId],
          );
          await client.query(
            `INSERT INTO audit_event (project_id, actor_id, action, object_type, object_id, details)
             VALUES ($1, $2, 'solo_test_set_version_tombstoned', 'test_set_version', $3, '{}')`,
            [request.params.projectId, actor.id, request.params.versionId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const cleanupClient = await db.connect();
      try {
        await cleanupClient.query("BEGIN");
        await cleanupClient.query(
          "SELECT id FROM test_set WHERE id=$1 FOR UPDATE",
          [request.params.testSetId],
        );
        const target = await cleanupClient.query(
          `SELECT manifest_object_ref,cleanup_object_refs
             FROM test_set_version WHERE id=$1 AND status='tombstoned' FOR UPDATE`,
          [request.params.versionId],
        );
        if (!target.rowCount) throw new Error("tombstone_target_missing");
        if (
          target.rows[0].manifest_object_ref !==
          `tombstone:${request.params.versionId}`
        ) {
          await protectDeletionBoundaries(
            cleanupClient,
            request.params.testSetId,
            [request.params.versionId],
            request.params.projectId,
          );
          objectRefs = await clearVersionContent(
            cleanupClient,
            [request.params.versionId],
            "tombstoned",
            `tombstone:${request.params.versionId}`,
          );
        } else {
          objectRefs = storedStringArray(target.rows[0].cleanup_object_refs);
        }
        await cleanupClient.query("COMMIT");
      } catch {
        await cleanupClient.query("ROLLBACK").catch(() => undefined);
        return reply
          .code(503)
          .send({ error: { code: "tombstone_cleanup_pending" } });
      } finally {
        cleanupClient.release();
      }
      try {
        await finishTombstoneCleanup(request.params.versionId, objectRefs);
        return { tombstoned: true };
      } catch {
        return reply
          .code(503)
          .send({ error: { code: "tombstone_cleanup_pending" } });
      }
    },
  );

  app.post<{
    Params: { projectId: string; entryId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-set-trash/:entryId/permanent-delete",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (!(await canManageProject(request.params.projectId, actor.id)))
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        !isPlainObject(request.body) ||
        Object.keys(request.body).length !== 1 ||
        typeof request.body.confirmation !== "string"
      )
        return reply
          .code(422)
          .send({ error: { code: "permanent_delete_confirmation_required" } });
      const client = await db.connect();
      let objectRefs: string[] = [];
      try {
        await client.query("BEGIN");
        const entryIdentity = await client.query(
          `SELECT test_set_id FROM test_set_trash_entry
            WHERE id=$1 AND project_id=$2 AND status IN ('trashed','purging')`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entryIdentity.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        await client.query("SELECT id FROM test_set WHERE id=$1 FOR UPDATE", [
          entryIdentity.rows[0].test_set_id,
        ]);
        const entry = await client.query(
          `SELECT * FROM test_set_trash_entry
            WHERE id = $1 AND project_id = $2 AND status IN ('trashed', 'purging') FOR UPDATE`,
          [request.params.entryId, request.params.projectId],
        );
        if (!entry.rowCount) {
          await client.query("COMMIT");
          return reply
            .code(404)
            .send({ error: { code: "trash_entry_not_found" } });
        }
        const row = entry.rows[0];
        const testSet = await client.query(
          "SELECT name FROM test_set WHERE id = $1 FOR UPDATE",
          [row.test_set_id],
        );
        const expected =
          row.type === "test_set"
            ? String(testSet.rows[0]?.name ?? "")
            : String(
                (
                  await client.query(
                    "SELECT version_label FROM test_set_version WHERE id = $1 FOR UPDATE",
                    [row.root_version_id],
                  )
                ).rows[0]?.version_label ?? "",
              );
        if (!expected || request.body.confirmation !== expected) {
          await client.query("COMMIT");
          return reply.code(422).send({
            error: { code: "permanent_delete_confirmation_required" },
          });
        }
        objectRefs = storedStringArray(row.object_refs);
        if (row.status === "trashed") {
          const versionIds =
            row.type === "test_set"
              ? (
                  await client.query(
                    `SELECT id FROM test_set_version
                      WHERE test_set_id = $1
                        AND status IN ('published', 'tombstoned', 'trashed')`,
                    [row.test_set_id],
                  )
                ).rows.map((version) => String(version.id))
              : storedStringArray(row.version_ids);
          objectRefs = await clearVersionContent(
            client,
            versionIds,
            "permanently_deleted",
            `deleted:${row.id}`,
          );
          if (row.type === "test_set")
            await client.query(
              "UPDATE test_set SET status = 'permanently_deleted' WHERE id = $1",
              [row.test_set_id],
            );
          if (row.type === "test_set")
            await client.query(
              `UPDATE test_set_trash_entry
                  SET status = 'permanently_deleted', updated_at = now()
                WHERE test_set_id = $1 AND id <> $2
                  AND status IN ('trashed', 'purging')`,
              [row.test_set_id, row.id],
            );
          await client.query(
            "UPDATE test_set_trash_entry SET status = 'purging', object_refs = $2::jsonb, updated_at = now() WHERE id = $1",
            [row.id, JSON.stringify(objectRefs)],
          );
        }
        await client.query("COMMIT");
        const entryId = String(row.id);
        try {
          await removeUnreferencedObjects(objectRefs);
          await db.query(
            "UPDATE test_set_trash_entry SET status = 'permanently_deleted', updated_at = now() WHERE id = $1",
            [entryId],
          );
          return { permanentlyDeleted: true };
        } catch {
          return reply
            .code(503)
            .send({ error: { code: "delete_cleanup_pending" } });
        }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Querystring: { name?: string; limit?: string; offset?: string };
  }>("/api/projects", { preHandler: authenticate }, async (request, reply) => {
    const actor = (request as AuthenticatedRequest).actor;
    const limit = request.query.limit ? Number(request.query.limit) : 100;
    const offset = request.query.offset ? Number(request.query.offset) : 0;
    if (
      Object.keys(request.query).some(
        (key) => !["name", "limit", "offset"].includes(key),
      ) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      (request.query.name !== undefined &&
        (request.query.name.trim().length === 0 ||
          request.query.name.length > 200))
    )
      return reply
        .code(422)
        .send({ error: { code: "query_parameter_invalid" } });
    const values: string[] = [actor.id];
    const filters = [
      actor.role === "admin" ? "TRUE" : "pm.user_id IS NOT NULL",
    ];
    if (request.query.name) {
      values.push(request.query.name.trim());
      filters.push(`p.name ILIKE '%' || $${values.length} || '%'`);
    }
    const projects = await db.query(
      `SELECT p.id, p.name, p.description, p.updated_at,
              count(DISTINCT c.id)::int AS dataset_count,
              count(DISTINCT ts.id)::int AS test_set_count
       FROM project p
       LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = $1
       LEFT JOIN raw_material_collection c ON c.project_id = p.id
       LEFT JOIN test_set ts ON ts.project_id = p.id
       WHERE ${filters.join(" AND ")}
       GROUP BY p.id
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, String(limit), String(offset)],
    );
    const total = await db.query(
      `SELECT count(*)::text AS total
       FROM project p
       LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE ${filters.join(" AND ")}`,
      values,
    );
    return {
      projects: projects.rows.map(projectResponse),
      pagination: {
        total: Number(total.rows[0]?.total ?? 0),
        limit,
        offset,
      },
    };
  });
}
