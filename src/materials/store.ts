import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "../db/pool.js";
import { BusinessError } from "../operations/errors.js";
import {
  hasProjectCapability,
  capabilitiesForRole,
} from "../security/project-access.js";
import {
  ensureUnfiledCollection,
  collectionResponse,
  projectResponse,
  mapMaterialRecord,
  normalizeDisplayMapping,
  utf8Prefix,
} from "../server/support.js";
import type { ArtifactRepository } from "../storage/artifacts.js";

type Scope = { projectId: string; actorId: string };
type Query = Pick<Database, "query">;
const id = (kind: string) => kind + "_" + randomUUID().replaceAll("-", "");
export const materialNameSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(1000).optional(),
  })
  .strict();
export const materialPageSchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
const activeAsset =
  "da.status NOT IN ('deletion_pending','tombstoned') AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=da.project_id AND dl.object_id=da.id)";
const literalSearch = (s = "") => "%" + s.replace(/[\\%_]/g, "\\$&") + "%";

/** Same mapped-record search used by the Web and native selection handoff. Never silently pages a selection. */
export async function materialRecordRows(
  db: Query,
  projectId: string,
  collectionId: string,
  assetId?: string,
  search?: string,
) {
  const rows = await db.query(
    `SELECT da.id AS asset_id,da.file_name,pv.id AS parsed_view_id,pv.mapping_revision,pv.display_mapping,sr.ordinal,sr.value
    FROM raw_material_collection c JOIN data_asset da ON da.collection_id=c.id AND da.project_id=c.project_id
    JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
    JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
    WHERE c.project_id=$1 AND c.id=$2 AND ${activeAsset} AND ($3::text IS NULL OR da.id=$3)
    ORDER BY da.uploaded_at DESC,da.id DESC,sr.ordinal`,
    [projectId, collectionId, assetId ?? null],
  );
  const term = search?.trim().toLowerCase();
  return rows.rows
    .map((row) => ({
      assetId: row.asset_id,
      recordId: `${row.asset_id}:${row.ordinal}`,
      parsedViewId: row.parsed_view_id,
      mappingRevision: Number(row.mapping_revision),
      ordinal: Number(row.ordinal),
      sourceFile: row.file_name,
      ...mapMaterialRecord(
        row.value,
        normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
      ),
    }))
    .filter(
      (row) =>
        !term ||
        [
          row.question,
          row.expectedOutput,
          ...row.metadata.flatMap(({ key, value }) => [key, value]),
        ].some((value) => value.toLowerCase().includes(term)),
    );
}

export class MaterialsStore {
  constructor(
    readonly db: Database,
    readonly artifacts?: ArtifactRepository,
  ) {}
  async access(scope: Scope, write = false, db: Query = this.db) {
    if (
      !(await hasProjectCapability(
        db,
        scope.projectId,
        scope.actorId,
        write ? "write" : "read",
      ))
    )
      throw new BusinessError(404, "project_not_found");
  }
  private async transaction<T>(
    client: PoolClient | undefined,
    run: (db: PoolClient) => Promise<T>,
  ) {
    if (client) return run(client);
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const result = await run(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  private async lockAccess(scope: Scope, db: PoolClient) {
    await db.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
      scope.actorId,
    ]);
    await db.query(
      "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
      [scope.projectId, scope.actorId],
    );
    await this.access(scope, true, db);
  }
  async projects(actorId: string, input: unknown) {
    const q = materialPageSchema.parse(input);
    const rows = await this.db.query(
      `SELECT p.id,p.name,p.description FROM project p JOIN app_user u ON u.id=$1 LEFT JOIN project_member pm ON pm.project_id=p.id AND pm.user_id=u.id WHERE (u.role='admin' OR pm.role IN ('owner','editor','viewer')) AND p.name ILIKE $2 ORDER BY p.updated_at DESC,p.id LIMIT $3 OFFSET $4`,
      [actorId, literalSearch(q.search), q.limit + 1, q.offset],
    );
    return {
      items: rows.rows
        .slice(0, q.limit)
        .map((p) => ({ ...p, href: `/projects/${p.id}/datasets` })),
      nextOffset: rows.rows.length > q.limit ? q.offset + q.limit : null,
    };
  }
  async project(scope: Scope) {
    await this.access(scope);
    const row = (
      await this.db.query(
        `SELECT p.id,p.name,p.description,CASE WHEN u.role='admin' THEN 'owner' ELSE pm.role END AS role FROM project p JOIN app_user u ON u.id=$2 LEFT JOIN project_member pm ON pm.project_id=p.id AND pm.user_id=u.id WHERE p.id=$1`,
        [scope.projectId, scope.actorId],
      )
    ).rows[0];
    return {
      ...row,
      capabilities: capabilitiesForRole(row.role),
      href: `/projects/${row.id}/datasets`,
    };
  }
  async createProject(
    actorId: string,
    input: unknown,
    client?: PoolClient,
    legacyOwner = false,
  ) {
    const parsed = materialNameSchema.safeParse(input);
    if (!parsed.success)
      throw new BusinessError(422, "project_payload_invalid");
    const body = parsed.data;
    return this.transaction(client, async (c) => {
      const user = (
        await c.query("SELECT role FROM app_user WHERE id=$1 FOR SHARE", [
          actorId,
        ])
      ).rows[0];
      if (user?.role !== "admin" && !(legacyOwner && user?.role === "owner"))
        throw new BusinessError(403, "administrator_required");
      const projectId = id("project");
      const row = (
        await c.query(
          "INSERT INTO project(id,name,description,owner_id) VALUES($1,$2,$3,$4) RETURNING id,name,description,updated_at",
          [projectId, body.name, body.description ?? "", actorId],
        )
      ).rows[0];
      if (legacyOwner && user.role === "owner")
        await c.query(
          "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'owner')",
          [projectId, actorId],
        );
      await c.query(
        "INSERT INTO audit_event(project_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,'project_created','project',$1,$3)",
        [projectId, actorId, { name: body.name }],
      );
      return {
        project: projectResponse({
          ...row,
          dataset_count: 1,
          test_set_count: 0,
        }),
      };
    });
  }
  async collections(scope: Scope, input: unknown) {
    await this.access(scope);
    const q = materialPageSchema.parse(input);
    await ensureUnfiledCollection(this.db, scope.projectId);
    const rows = await this.db.query(
      `SELECT c.id,c.name,c.description,c.is_unfiled,count(da.id)::int AS file_count FROM raw_material_collection c LEFT JOIN data_asset da ON da.collection_id=c.id AND da.project_id=c.project_id AND ${activeAsset} WHERE c.project_id=$1 AND (c.name ILIKE $2 OR c.description ILIKE $2) GROUP BY c.id ORDER BY c.is_unfiled DESC,c.updated_at DESC,c.id LIMIT $3 OFFSET $4`,
      [scope.projectId, literalSearch(q.search), q.limit + 1, q.offset],
    );
    return {
      items: rows.rows.slice(0, q.limit).map((c) => ({
        ...c,
        href: `/projects/${scope.projectId}/datasets/${c.id}`,
      })),
      nextOffset: rows.rows.length > q.limit ? q.offset + q.limit : null,
    };
  }
  async createCollection(scope: Scope, input: unknown, client?: PoolClient) {
    const parsed = materialNameSchema.safeParse(input);
    if (!parsed.success)
      throw new BusinessError(422, "collection_payload_invalid");
    const body = parsed.data;
    if (body.name === "未整理")
      throw new BusinessError(409, "unfiled_collection_reserved");
    try {
      return await this.transaction(client, async (c) => {
        await this.lockAccess(scope, c);
        const collectionId = id("collection");
        const row = (
          await c.query(
            "INSERT INTO raw_material_collection(id,project_id,name,description,is_unfiled) VALUES($1,$2,$3,$4,false) RETURNING id,project_id,name,description,is_unfiled,created_at,updated_at",
            [collectionId, scope.projectId, body.name, body.description ?? ""],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO audit_event(project_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,'raw_material_collection_created','raw_material_collection',$3,$4)",
          [scope.projectId, scope.actorId, collectionId, { name: body.name }],
        );
        return {
          collection: collectionResponse({
            ...row,
            file_count: 0,
            unified_record_count: 0,
          }),
        };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new BusinessError(409, "collection_name_conflict");
      throw e;
    }
  }
  async files(
    scope: Scope,
    input: {
      collectionId?: string;
      search?: string;
      offset: number;
      limit: number;
    },
  ) {
    await this.access(scope);
    if (input.collectionId) await this.collection(scope, input.collectionId);
    const rows = await this.db.query(
      `SELECT da.id,da.collection_id AS "collectionId",da.file_name AS "fileName",da.format,da.size_bytes AS size,pv.id AS "parsedViewId",pv.record_count AS "recordCount",pv.mapping_ready AS "mappingReady" FROM data_asset da LEFT JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current WHERE da.project_id=$1 AND ($2::text IS NULL OR da.collection_id=$2) AND ${activeAsset} AND da.file_name ILIKE $3 ORDER BY da.uploaded_at DESC,da.id LIMIT $4 OFFSET $5`,
      [
        scope.projectId,
        input.collectionId ?? null,
        literalSearch(input.search),
        input.limit + 1,
        input.offset,
      ],
    );
    return {
      items: rows.rows.slice(0, input.limit).map((row) => ({
        ...row,
        size: Number(row.size),
        recordCount: Number(row.recordCount ?? 0),
        href: `/projects/${scope.projectId}/datasets/${row.collectionId}/files/${row.id}`,
      })),
      nextOffset:
        rows.rows.length > input.limit ? input.offset + input.limit : null,
    };
  }
  async collection(scope: Scope, collectionId: string) {
    await this.access(scope);
    const row = (
      await this.db.query(
        "SELECT id,name FROM raw_material_collection WHERE id=$1 AND project_id=$2",
        [collectionId, scope.projectId],
      )
    ).rows[0];
    if (!row) throw new BusinessError(404, "collection_not_found");
    return row;
  }
  async asset(scope: Scope, assetId: string, db: Query = this.db) {
    await this.access(scope, false, db);
    const row = (
      await db.query(
        `SELECT da.id,da.collection_id AS "collectionId",da.file_name AS "fileName",da.format,da.object_ref,da.size_bytes,pv.id AS "parsedViewId",pv.mapping_ready AS "mappingReady",pv.mapping_revision AS "mappingRevision",pv.display_mapping AS mapping FROM data_asset da LEFT JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current WHERE da.project_id=$1 AND da.id=$2 AND ${activeAsset}`,
        [scope.projectId, assetId],
      )
    ).rows[0];
    if (!row) throw new BusinessError(404, "asset_not_found");
    return row;
  }
  async records(
    scope: Scope,
    input: {
      collectionId: string;
      assetId?: string;
      search?: string;
      offset: number;
      limit: number;
    },
  ) {
    await this.collection(scope, input.collectionId);
    const rows = await materialRecordRows(
      this.db,
      scope.projectId,
      input.collectionId,
      input.assetId,
      input.search,
    );
    return {
      records: rows.slice(input.offset, input.offset + input.limit),
      pagination: {
        total: rows.length,
        offset: input.offset,
        limit: input.limit,
      },
    };
  }
  async record(scope: Scope, assetId: string, ordinal: number) {
    const asset = await this.asset(scope, assetId);
    const rows = await materialRecordRows(
      this.db,
      scope.projectId,
      asset.collectionId,
      assetId,
    );
    const record = rows.find((r) => r.ordinal === ordinal);
    if (!record) throw new BusinessError(404, "record_not_found");
    return { record };
  }
  async raw(scope: Scope, assetId: string) {
    if (!this.artifacts)
      throw new BusinessError(503, "artifact_store_unavailable");
    return this.transaction(undefined, async (c) => {
      await this.access(scope, false, c);
      await c.query(
        "SELECT id FROM data_asset WHERE id=$1 AND project_id=$2 FOR SHARE",
        [assetId, scope.projectId],
      );
      const asset = await this.asset(scope, assetId, c);
      if (
        (
          await c.query(
            "SELECT 1 FROM consistency_finding WHERE project_id=$1 AND object_type='data_asset' AND object_id=$2 AND status='open' LIMIT 1",
            [scope.projectId, assetId],
          )
        ).rowCount
      )
        throw new BusinessError(409, "integrity_blocked");
      const maximumBytes = 12000;
      const bytes = await this.artifacts!.readPrefix(
        asset.object_ref,
        maximumBytes + 4,
      );
      await c.query(
        "INSERT INTO audit_event(project_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,'asset_raw_previewed','data_asset',$3,$4)",
        [
          scope.projectId,
          scope.actorId,
          assetId,
          { origin: "assistant", maximumBytes },
        ],
      );
      return {
        assetId,
        fileName: asset.fileName,
        text: utf8Prefix(bytes, maximumBytes),
        truncated: bytes.byteLength > maximumBytes,
        maximumBytes,
        href: `/api/projects/${scope.projectId}/assets/${assetId}/download?view=raw`,
      };
    });
  }
  async move(
    scope: Scope,
    assetId: string,
    collectionId: string,
    client?: PoolClient,
  ) {
    return this.transaction(client, async (c) => {
      await this.lockAccess(scope, c);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agentbench:controlled-deletion-project:${scope.projectId}`,
      ]);
      const moved = await c.query(
        `UPDATE data_asset da SET collection_id=$3 WHERE da.id=$2 AND da.project_id=$1 AND ${activeAsset} AND EXISTS(SELECT 1 FROM raw_material_collection c WHERE c.id=$3 AND c.project_id=$1) RETURNING da.id,da.file_name AS "fileName"`,
        [scope.projectId, assetId, collectionId],
      );
      if (!moved.rowCount)
        throw new BusinessError(404, "asset_or_collection_not_found");
      await c.query(
        "DELETE FROM version_export_cache c USING test_set_version v,test_set ts WHERE c.version_id=v.id AND v.test_set_id=ts.id AND ts.project_id=$1",
        [scope.projectId],
      );
      await c.query(
        "INSERT INTO audit_event(project_id,actor_id,action,object_type,object_id,details) VALUES($1,$2,'asset_moved','data_asset',$3,$4)",
        [scope.projectId, scope.actorId, assetId, { collectionId }],
      );
      return {
        ...moved.rows[0],
        collectionId,
        href: `/projects/${scope.projectId}/datasets/${collectionId}/files/${assetId}`,
      };
    });
  }
  async pending(scope: Scope) {
    await this.access(scope, true);
    return {
      items: (
        await this.db.query(
          'SELECT id,file_name AS "fileName",format,size_bytes AS size,display_mapping AS mapping,expires_at AS "expiresAt" FROM pending_upload WHERE project_id=$1 AND actor_id=$2 AND status=\'previewable\' AND expires_at>now() ORDER BY created_at DESC,id LIMIT 20',
          [scope.projectId, scope.actorId],
        )
      ).rows,
      confirmationRequired: true,
    };
  }
}
