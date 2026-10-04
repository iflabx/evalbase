import { canonicalJson } from "../../package/contract.js";
import { hasProjectCapability } from "../../security/project-access.js";
import type { ServerContext } from "../context.js";
import {
  type AuthenticatedRequest,
  isPlainObject,
  normalizeDisplayMapping,
  mapMaterialRecord,
} from "../support.js";

export function registerMaterialMapping({
  app,
  db,
  authenticate,
  writeAllowed,
}: Pick<ServerContext, "app" | "db" | "authenticate" | "writeAllowed">) {
  const select = `SELECT pv.*,da.file_name FROM data_asset da
    JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
    WHERE da.project_id=$1 AND da.id=$2 AND da.status NOT IN ('deletion_pending','tombstoned')
      AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=da.project_id
        AND ((dl.object_type='data_asset' AND dl.object_id=da.id) OR (dl.object_type='parsed_view' AND dl.object_id=pv.id)))`;
  const path = "/api/projects/:projectId/assets/:assetId/mapping";
  app.post<{ Params: { projectId: string; assetId: string }; Body: unknown }>(
    `${path}/preview`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      )
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const body = request.body;
      const mapping = isPlainObject(body)
        ? normalizeDisplayMapping(body.mapping, true)
        : undefined;
      if (
        !isPlainObject(body) ||
        !mapping ||
        typeof body.parsedViewId !== "string"
      )
        return reply
          .code(422)
          .send({ error: { code: "display_mapping_invalid" } });
      const row = (
        await db.query(select, [
          request.params.projectId,
          request.params.assetId,
        ])
      ).rows[0];
      if (!row)
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      if (row.id !== body.parsedViewId)
        return reply
          .code(409)
          .send({ error: { code: "mapping_revision_conflict" } });
      const records = await db.query(
        "SELECT value FROM source_record WHERE parsed_view_id=$1 AND parse_status='valid' ORDER BY ordinal LIMIT 5",
        [row.id],
      );
      return {
        preview: records.rows.map((record) =>
          mapMaterialRecord(record.value, mapping),
        ),
      };
    },
  );
  app.get<{
    Params: { projectId: string; assetId: string };
    Querystring: { offset?: string; limit?: string };
  }>(path, { preHandler: authenticate }, async (request, reply) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (
      !(await hasProjectCapability(
        db,
        request.params.projectId,
        actor.id,
        "read",
      ))
    )
      return reply.code(404).send({ error: { code: "asset_not_found" } });
    const offset = Number(request.query.offset ?? 0),
      limit = Number(request.query.limit ?? 20);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return reply
        .code(422)
        .send({ error: { code: "query_parameter_invalid" } });
    const row = (
      await db.query(select, [request.params.projectId, request.params.assetId])
    ).rows[0];
    if (!row)
      return reply.code(404).send({ error: { code: "asset_not_found" } });
    const records = await db.query(
      "SELECT ordinal,value,parse_status,parse_error FROM source_record WHERE parsed_view_id=$1 ORDER BY ordinal LIMIT $2 OFFSET $3",
      [row.id, limit, offset],
    );
    return {
      parsedViewId: row.id,
      fileName: row.file_name,
      mappingReady: row.mapping_ready,
      mappingRevision: row.mapping_revision,
      mapping: row.display_mapping,
      fields: (row.field_summary ?? []).map(
        (field: { path: string; examples?: unknown[] }) => ({
          path: field.path,
          sample: field.examples?.[0] ?? null,
        }),
      ),
      records: records.rows.map((record) => ({
        ordinal: record.ordinal,
        value: record.value,
        parseStatus: record.parse_status,
        error: record.parse_error,
      })),
      total: Number(row.record_count),
      offset,
      limit,
    };
  });
  app.put<{ Params: { projectId: string; assetId: string }; Body: unknown }>(
    path,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      )
        return reply.code(404).send({ error: { code: "asset_not_found" } });
      const body = request.body;
      const mapping = isPlainObject(body)
        ? normalizeDisplayMapping(body.mapping, true)
        : undefined;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (k) => !["mapping", "parsedViewId", "expectedRevision"].includes(k),
        ) ||
        typeof body.parsedViewId !== "string" ||
        !Number.isSafeInteger(body.expectedRevision) ||
        !mapping
      )
        return reply
          .code(422)
          .send({ error: { code: "display_mapping_invalid" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const row = (
          await client.query(`${select} FOR UPDATE OF da,pv`, [
            request.params.projectId,
            request.params.assetId,
          ])
        ).rows[0];
        await client.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
          actor.id,
        ]);
        await client.query(
          "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
          [request.params.projectId, actor.id],
        );
        if (
          !row ||
          !(await hasProjectCapability(
            client,
            request.params.projectId,
            actor.id,
            "write",
          ))
        ) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "asset_not_found" } });
        }
        if (row.id !== body.parsedViewId) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "mapping_revision_conflict" } });
        }
        const fields = new Set(
          (row.field_summary ?? []).map(
            (field: { path: string }) => field.path,
          ),
        );
        if (
          [mapping.question, mapping.expectedOutput, ...mapping.metadata]
            .filter(Boolean)
            .some((field) => !fields.has(field))
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "display_mapping_invalid" } });
        }
        // First mapping is frozen once available to drafts; no remapping of published sources.
        if (row.mapping_ready) {
          await client.query("COMMIT");
          if (
            canonicalJson(row.display_mapping) === canonicalJson(mapping) &&
            (body.expectedRevision === row.mapping_revision ||
              body.expectedRevision === row.mapping_revision - 1)
          )
            return {
              mappingReady: true,
              mappingRevision: row.mapping_revision,
              replayed: true,
            };
          return reply
            .code(409)
            .send({ error: { code: "mapping_already_prepared" } });
        }
        if (row.mapping_revision !== body.expectedRevision) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "mapping_revision_conflict" } });
        }
        await client.query(
          "UPDATE parsed_view SET display_mapping=$2,mapping_ready=true,mapping_revision=mapping_revision+1,draft_eligible=(boundary_trusted AND record_count<=10000) WHERE id=$1",
          [row.id, mapping],
        );
        await client.query("COMMIT");
        return {
          mappingReady: true,
          mappingRevision: row.mapping_revision + 1,
          replayed: false,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
