import { writeBatches } from "../../db/batch.js";
import { Readable } from "node:stream";
import { CAPACITY_LIMITS } from "../../capacity.js";
import { canonicalJson, sha256 } from "../../package/contract.js";
import { parseSourceRecords } from "../../parser/index.js";
import { hasProjectCapability } from "../../security/project-access.js";
import {
  decodeUploadHeader,
  UPLOAD_HEADER_ENCODING,
} from "../../upload-headers.js";
import type { ServerContext } from "../context.js";
import {
  AuthenticatedRequest,
  opaqueId,
  isPlainObject,
  AssetFormat,
  DisplayMapping,
  CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE,
  PARSER_VERSION,
  assetFormat,
  firstHeaderValue,
  defaultParserConfig,
  normalizeDisplayMapping,
  mapMaterialRecord,
} from "../support.js";

export function registerUploads(
  context: Pick<
    ServerContext,
    "db" | "artifacts" | "app" | "authenticate" | "writeAllowed"
  >,
) {
  const { db, artifacts, app, authenticate, writeAllowed } = context;
  // One parser per Web process: avoid simultaneous 50 MB buffers and record arrays.
  let parsing: Promise<void> = Promise.resolve();
  function parsePendingUpload(row: Record<string, unknown>) {
    const work = parsing.then(async () => {
      const format = row.format as AssetFormat;
      return parseSourceRecords({
        assetId: String(row.id),
        parsedViewId: `pending-view:${row.id}`,
        parserVersion: PARSER_VERSION,
        bytes: await artifacts.read(String(row.object_ref)),
        format,
        config: defaultParserConfig(format) as never,
      });
    });
    parsing = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  function pendingPreviewCache(
    parsed: Awaited<ReturnType<typeof parsePendingUpload>>,
  ) {
    return {
      parserVersion: PARSER_VERSION,
      previewRecords: parsed.records
        .filter((record) => record.parseStatus === "valid")
        .slice(0, 5)
        .map((record) => record.fields),
    };
  }

  function pendingResponse(
    row: Record<string, unknown>,
    parsed: Awaited<ReturnType<typeof parsePendingUpload>>,
  ) {
    return {
      id: row.id,
      fileName: row.file_name,
      format: row.format,
      size: Number(row.size_bytes),
      recordCount: parsed.summary.totalCount,
      fields: (parsed.summary.fieldProfiles ?? []).map((field) => ({
        path: field.path,
        sample: field.examples[0] ?? null,
      })),
      issues: [
        ...(parsed.summary.blockingErrors ?? []),
        ...parsed.records
          .filter((record) => record.parseStatus === "invalid")
          .slice(0, 10)
          .map((record) => record.error),
      ].filter(Boolean),
    };
  }

  app.post<{ Params: { projectId: string }; Body: Readable }>(
    "/api/projects/:projectId/pending-uploads",
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
        return reply.code(404).send({ error: { code: "project_not_found" } });
      if (
        Object.keys(request.headers).some((header) =>
          /^(?:x-source-|x-responsible-|x-license-|x-sensitivity-|x-acquired-at$|x-deidentification-confirmed$)/u.test(
            header,
          ),
        )
      )
        return reply
          .code(422)
          .send({ error: { code: "upload_payload_invalid" } });
      const encoded =
        firstHeaderValue(request.headers["x-agentbench-upload-encoding"]) ===
        UPLOAD_HEADER_ENCODING;
      let fileName: string;
      try {
        fileName = decodeUploadHeader(
          firstHeaderValue(request.headers["x-file-name"]) ?? "",
          encoded,
        ).trim();
      } catch {
        return reply
          .code(400)
          .send({ error: { code: "upload_payload_invalid" } });
      }
      const format = assetFormat(fileName);
      if (!fileName || !format)
        return reply
          .code(415)
          .send({ error: { code: "unsupported_asset_format" } });
      let stored;
      try {
        stored = await artifacts.storeOriginal(
          opaqueId("pending"),
          request.body,
        );
      } catch (error) {
        if ((error as { code?: string }).code === "asset_too_large")
          return reply.code(413).send({
            error: {
              code: "asset_too_large",
              actualBytes: (error as { observedBytes?: number }).observedBytes,
              limitBytes: CAPACITY_LIMITS.dataAssetBytes,
            },
          });
        throw error;
      }
      const row = {
        id: opaqueId("pending"),
        project_id: request.params.projectId,
        actor_id: actor.id,
        file_name: fileName,
        mime_type: String(
          request.headers["content-type"] ?? "application/octet-stream",
        ),
        format,
        blob_sha256: stored.sha256,
        object_ref: stored.objectRef,
        size_bytes: stored.size,
      };
      const parsed = await parsePendingUpload(row);
      const response = pendingResponse(row, parsed);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:upload-content:${row.project_id}:${row.blob_sha256}`,
        ]);
        const existingAsset = await client.query(
          `SELECT da.file_name, collection.name AS collection_name
             FROM data_asset da
             JOIN raw_material_collection collection ON collection.id = da.collection_id
            WHERE da.project_id = $1 AND da.blob_sha256 = $2
              AND da.status NOT IN ('deletion_pending', 'tombstoned')
            ORDER BY da.uploaded_at, da.id
            LIMIT 1`,
          [row.project_id, row.blob_sha256],
        );
        if (existingAsset.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "duplicate_upload",
              existingFileName: existingAsset.rows[0].file_name,
              existingCollectionName: existingAsset.rows[0].collection_name,
            },
          });
        }
        const existingPending = await client.query(
          `SELECT file_name FROM pending_upload
            WHERE project_id = $1 AND blob_sha256 = $2
              AND status = 'previewable' AND expires_at > now()
            ORDER BY created_at, id
            LIMIT 1`,
          [row.project_id, row.blob_sha256],
        );
        if (existingPending.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "duplicate_upload",
              existingFileName: existingPending.rows[0].file_name,
              existingCollectionName: null,
            },
          });
        }
        await client.query(
          `INSERT INTO pending_upload
           (id, project_id, actor_id, file_name, mime_type, format, blob_sha256,
            object_ref, size_bytes, status, parse_summary, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'previewable', $10,
                 now() + interval '24 hours')`,
          [
            row.id,
            row.project_id,
            row.actor_id,
            row.file_name,
            row.mime_type,
            row.format,
            row.blob_sha256,
            row.object_ref,
            row.size_bytes,
            { ...response, ...pendingPreviewCache(parsed) },
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return reply.code(201).send({ pendingUpload: response });
    },
  );

  app.put<{
    Params: { projectId: string; pendingUploadId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/pending-uploads/:pendingUploadId/preview",
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
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const mapping = isPlainObject(request.body)
        ? normalizeDisplayMapping(request.body.mapping, true)
        : undefined;
      if (!mapping)
        return reply
          .code(422)
          .send({ error: { code: "display_mapping_invalid" } });
      const pending = await db.query(
        `SELECT * FROM pending_upload
         WHERE id = $1 AND project_id = $2 AND actor_id = $3
           AND status = 'previewable' AND expires_at > now()`,
        [request.params.pendingUploadId, request.params.projectId, actor.id],
      );
      if (!pending.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "pending_upload_not_found" } });
      const row = pending.rows[0];
      const cache = isPlainObject(row.parse_summary) ? row.parse_summary : {};
      let response: Record<string, unknown>;
      let fields: unknown[];
      if (
        cache.parserVersion === PARSER_VERSION &&
        Array.isArray(cache.previewRecords)
      ) {
        response = { ...cache };
        delete response.parserVersion;
        delete response.previewRecords;
        fields = cache.previewRecords;
      } else {
        const parsed = await parsePendingUpload(row);
        response = pendingResponse(row, parsed);
        fields = pendingPreviewCache(parsed).previewRecords;
      }
      const preview = fields.map((record) =>
        mapMaterialRecord(record, mapping),
      );
      await db.query(
        `UPDATE pending_upload SET display_mapping=$4,parse_summary=$5,updated_at=now()
        WHERE id=$1 AND project_id=$2 AND actor_id=$3 AND status='previewable' AND expires_at>now()`,
        [
          row.id,
          request.params.projectId,
          actor.id,
          mapping,
          {
            ...response,
            parserVersion: PARSER_VERSION,
            previewRecords: fields,
          },
        ],
      );
      return { ...response, preview };
    },
  );

  app.delete<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/pending-upload-batches",
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
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const ids =
        isPlainObject(request.body) &&
        Object.keys(request.body).length === 1 &&
        Array.isArray(request.body.pendingUploadIds) &&
        request.body.pendingUploadIds.every((id) => typeof id === "string")
          ? request.body.pendingUploadIds
          : undefined;
      if (!ids?.length || new Set(ids).size !== ids.length)
        return reply
          .code(422)
          .send({ error: { code: "pending_upload_batch_invalid" } });
      const cancelled = await db.query(
        `UPDATE pending_upload SET status = 'cancelled', updated_at = now()
         WHERE id = ANY($1::text[]) AND project_id = $2 AND actor_id = $3
           AND status = 'previewable'`,
        [ids, request.params.projectId, actor.id],
      );
      if (cancelled.rowCount !== ids.length)
        return reply
          .code(404)
          .send({ error: { code: "pending_upload_not_found" } });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/pending-upload-batches/confirm",
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
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      const ids =
        isPlainObject(body) &&
        Object.keys(body).every((key) =>
          ["collectionId", "pendingUploadIds"].includes(key),
        ) &&
        typeof body.collectionId === "string" &&
        Array.isArray(body.pendingUploadIds) &&
        body.pendingUploadIds.every((id) => typeof id === "string")
          ? body.pendingUploadIds
          : undefined;
      const collectionId = isPlainObject(body) ? body.collectionId : undefined;
      const idempotencyKey = firstHeaderValue(
        request.headers["idempotency-key"],
      );
      if (!ids?.length || new Set(ids).size !== ids.length || !idempotencyKey)
        return reply
          .code(422)
          .send({ error: { code: "pending_upload_batch_invalid" } });
      const earlierReceipt = await db.query(
        `SELECT receipt FROM confirmed_upload_batch
        WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
        [request.params.projectId, actor.id, idempotencyKey],
      );
      if (earlierReceipt.rowCount)
        return { assets: earlierReceipt.rows[0].receipt, replayed: true };
      const committedReceipt = async () => {
        const receiptClient = await db.connect();
        try {
          await receiptClient.query("BEGIN");
          await receiptClient.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [
              `agentbench:confirmed-upload:${request.params.projectId}:${actor.id}:${idempotencyKey}`,
            ],
          );
          const result = await receiptClient.query(
            `SELECT receipt FROM confirmed_upload_batch
            WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
            [request.params.projectId, actor.id, idempotencyKey],
          );
          await receiptClient.query("COMMIT");
          return result.rows[0]?.receipt;
        } catch (error) {
          await receiptClient.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          receiptClient.release();
        }
      };
      const preliminary = await db.query(
        `SELECT * FROM pending_upload WHERE id=ANY($1::text[])
        AND project_id=$2 AND actor_id=$3 AND status='previewable' AND expires_at>now()`,
        [ids, request.params.projectId, actor.id],
      );
      if (preliminary.rowCount !== ids.length) {
        const receipt = await committedReceipt();
        if (receipt) return { assets: receipt, replayed: true };
        return reply
          .code(404)
          .send({ error: { code: "pending_upload_not_found" } });
      }
      const parsedById = new Map<
        string,
        {
          row: Record<string, unknown>;
          parsed: Awaited<ReturnType<typeof parsePendingUpload>>;
        }
      >();
      try {
        for (const row of preliminary.rows)
          parsedById.set(String(row.id), {
            row,
            parsed: await parsePendingUpload(row),
          });
      } catch (error) {
        const receipt = await committedReceipt();
        if (receipt) return { assets: receipt, replayed: true };
        throw error;
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:confirmed-upload:${request.params.projectId}:${actor.id}:${idempotencyKey}`,
        ]);
        const replay = await client.query(
          `SELECT receipt FROM confirmed_upload_batch
           WHERE project_id = $1 AND actor_id = $2 AND idempotency_key = $3 FOR UPDATE`,
          [request.params.projectId, actor.id, idempotencyKey],
        );
        if (replay.rowCount) {
          await client.query("COMMIT");
          return { assets: replay.rows[0].receipt, replayed: true };
        }
        const collection = await client.query(
          `SELECT id FROM raw_material_collection
           WHERE id = $1 AND project_id = $2`,
          [collectionId, request.params.projectId],
        );
        if (!collection.rowCount) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "collection_not_found" } });
        }
        const pending = await client.query(
          `SELECT * FROM pending_upload
           WHERE id = ANY($1::text[]) AND project_id = $2 AND actor_id = $3
             AND status = 'previewable' AND expires_at > now() FOR UPDATE`,
          [ids, request.params.projectId, actor.id],
        );
        if (pending.rowCount !== ids.length) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "pending_upload_not_found" } });
        }
        const rows = pending.rows.sort(
          (left, right) => ids.indexOf(left.id) - ids.indexOf(right.id),
        );
        const hashes = [
          ...new Set(rows.map((row) => String(row.blob_sha256))),
        ].sort();
        for (const hash of hashes)
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `agentbench:upload-content:${request.params.projectId}:${hash}`,
          ]);
        if (hashes.length !== rows.length) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: { code: "duplicate_upload" } });
        }
        const existingAssets = await client.query(
          `SELECT 1 FROM data_asset
            WHERE project_id = $1 AND blob_sha256 = ANY($2::text[])
              AND status NOT IN ('deletion_pending', 'tombstoned')
            LIMIT 1`,
          [request.params.projectId, hashes],
        );
        if (existingAssets.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: { code: "duplicate_upload" } });
        }
        const parsed = rows.map((row) => {
          const before = parsedById.get(String(row.id));
          if (
            !before ||
            before.row.object_ref !== row.object_ref ||
            before.row.blob_sha256 !== row.blob_sha256 ||
            before.row.format !== row.format
          )
            throw Object.assign(new Error("pending_upload_changed"), {
              code: "pending_upload_changed",
            });
          return before.parsed;
        });
        if (
          rows.some(
            (row, index) =>
              !row.display_mapping ||
              parsed[index].summary.blockingErrors?.length,
          )
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "pending_upload_not_previewable" } });
        }
        const assets: Array<{
          id: string;
          fileName: string;
          format: string;
          size: number;
        }> = [];
        for (const [index, row] of rows.entries()) {
          const assetId = opaqueId("asset");
          const parsedViewId = opaqueId("view");
          const parserConfig = defaultParserConfig(row.format as AssetFormat);
          await client.query(
            `INSERT INTO data_asset
               (id, project_id, collection_id, blob_sha256, object_ref, size_bytes,
                mime_type, file_name, format, status, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'stored', $10)`,
            [
              assetId,
              request.params.projectId,
              collectionId,
              row.blob_sha256,
              row.object_ref,
              row.size_bytes,
              row.mime_type,
              row.file_name,
              row.format,
              actor.id,
            ],
          );
          await client.query(
            `INSERT INTO source_attribution_revision
               (id, asset_id, source_type, source_name, purpose, responsible_actor,
                responsible_person, license_status, sensitivity, source_address,
                acquired_at, deidentification_confirmed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, false)`,
            [
              opaqueId("attr"),
              assetId,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.sourceType,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.sourceName,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.purpose,
              actor.id,
              actor.username,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.licenseStatus,
              CONFIRMED_UPLOAD_ENVIRONMENT_SOURCE.sensitivity,
            ],
          );
          await client.query(
            `INSERT INTO parsed_view
               (id, asset_id, format, parser_name, parser_version, parser_config,
                parser_config_hash, display_mapping, status, record_count,
                success_count, failure_count, boundary_trusted, draft_eligible,
                is_current, field_summary, error_summary)
             VALUES ($1, $2, $3, 'format-adapter', $4, $5, $6, $7, 'ready',
                     $8, $9, $10, $11, $12, true, $13, $14)`,
            [
              parsedViewId,
              assetId,
              row.format,
              PARSER_VERSION,
              parserConfig,
              sha256(canonicalJson(parserConfig)),
              JSON.stringify(row.display_mapping as DisplayMapping),
              parsed[index].summary.totalCount,
              parsed[index].summary.successCount,
              parsed[index].summary.failureCount,
              parsed[index].summary.boundaryTrusted,
              parsed[index].summary.draftEligible,
              JSON.stringify(parsed[index].summary.fieldProfiles ?? []),
              JSON.stringify(parsed[index].summary.blockingErrors ?? []),
            ],
          );
          await writeBatches(
            client,
            `INSERT INTO source_record
            (parsed_view_id,ordinal,value,locator,record_hash,parse_status,parse_error)
            SELECT $1,x.ordinal,x.value,x.locator,x.record_hash,x.parse_status,x.parse_error
            FROM jsonb_to_recordset($2::jsonb) AS x(ordinal integer,value jsonb,locator jsonb,record_hash text,parse_status text,parse_error jsonb)`,
            [parsedViewId],
            parsed[index].records.map((record) => ({
              ordinal: record.ordinal,
              value: record.fields,
              locator: record.locator,
              record_hash: record.recordHash,
              parse_status: record.parseStatus,
              parse_error: record.error ?? null,
            })),
          );
          assets.push({
            id: assetId,
            fileName: row.file_name,
            format: row.format,
            size: Number(row.size_bytes),
          });
        }
        await client.query(
          `UPDATE pending_upload SET status = 'confirmed', updated_at = now()
           WHERE id = ANY($1::text[])`,
          [ids],
        );
        await client.query(
          `INSERT INTO confirmed_upload_batch
             (project_id, actor_id, idempotency_key, collection_id, receipt)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            request.params.projectId,
            actor.id,
            idempotencyKey,
            collectionId,
            JSON.stringify(assets),
          ],
        );
        await client.query("COMMIT");
        return reply.code(201).send({ assets });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
