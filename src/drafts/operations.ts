import {
  draftPatchSchema,
  draftRecordSchema,
  recordPatchSchema,
} from "./protocol.js";

import { presentSources } from "../processing/provenance.js";
import { draftSummary, draftSelect, draftLive } from "../drafts/create.js";
import { cleanupProcessingObjects } from "../processing/cleanup.js";
import { writeBatches } from "../db/batch.js";
import { hasProjectCapability } from "../security/project-access.js";
import { publishSparseVersion } from "../version/publish-sparse.js";
import {
  opaqueId,
  isPlainObject,
  normalizeDisplayMapping,
  displayFieldName,
  MetadataEntry,
  normalizeMetadataEntries,
  mapMaterialRecord,
} from "../server/support.js";
import {
  guardOperationCommit,
  readOperationReceipt,
  writeOperationReceipt,
} from "../operations/commit.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import type { PoolClient } from "pg";
import { versionOperations } from "../version/store.js";
import { DraftOperationError, type DraftScope } from "./errors.js";
export { DraftOperationError } from "./errors.js";
export type { DraftScope } from "./errors.js";
async function requireDraftAccess(db: Database, scope: DraftScope) {
  if (
    !(await hasProjectCapability(db, scope.projectId, scope.actorId, "write"))
  )
    throw new DraftOperationError(404, {
      error: { code: "project_not_found" },
    });
}
async function finishDraftMutation(
  client: PoolClient,
  scope: DraftScope,
  result: any,
  action?: "draft",
) {
  if (!action) await guardOperationCommit(client, scope);
  const record = result?.record;
  await writeOperationReceipt(client, scope, {
    draftId: scope.draftId,
    recordId: record?.id ?? scope.recordId,
    revision: result?.draft?.revision,
    rowRevision: record?.rowRevision,
    completed: true,
    deleted: result?.deleted,
    action: result?.deleted
      ? scope.recordId
        ? "remove_record"
        : "discard_draft"
      : undefined,
  });
  await client.query("COMMIT");
  return result;
}
export function draftOperations(db: Database, artifacts: ArtifactRepository) {
  const publication = versionOperations(db, artifacts);

  const publishedDraftUnavailable = (row: Record<string, unknown>) =>
    row.status === "published" &&
    (row.test_set_status !== "available" ||
      row.published_status !== "published");
  const draftRow = (row: Record<string, unknown>) => ({
    id: String(row.id),
    position: Number(row.position),
    activeOrdinal: row.active_ordinal ? Number(row.active_ordinal) : undefined,
    caseId: row.case_id ? String(row.case_id) : null,
    beforeRevisionId: row.before_revision_id
      ? String(row.before_revision_id)
      : null,
    question: String(row.question),
    expectedOutput: String(row.expected_output),
    metadata: row.metadata,
    source: row.source,
    sourceFileName: row.source_file_name ?? null,
    rowRevision: Number(row.row_revision),
    questionRevision: Number(row.question_revision),
    expectedOutputRevision: Number(row.expected_output_revision),
    metadataRevision: Number(row.metadata_revision),
    sourceRevision: Number(row.source_revision),
    fieldAttribution: row.field_attribution,
    updatedBy: String(row.updated_by),
    updatedByName: String(row.updated_by_name ?? row.updated_by),
    updatedAt: row.updated_at,
  });
  const draftFieldValue = (field: string, value: unknown) => {
    if (field === "question" || field === "expectedOutput")
      return typeof value === "string" && value.length <= 100_000
        ? value
        : undefined;
    if (field === "metadata") return normalizeMetadataEntries(value);
    if (field === "source") {
      if (value === null) return null;
      if (
        isPlainObject(value) &&
        typeof value.assetId === "string" &&
        Number.isInteger(value.ordinal) &&
        Number(value.ordinal) >= 0
      )
        return { assetId: value.assetId, ordinal: Number(value.ordinal) };
    }
    return undefined;
  };

  async function list(
    scope: DraftScope,
    _input: unknown = {},
    query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const rows = await db.query(
      `${draftSelect} WHERE d.project_id=$1
        AND d.status='editing' AND ($2::text IS NULL OR d.test_set_id=$2)
        ORDER BY d.updated_at DESC,d.id DESC`,
      [scope.projectId, query.testSetId ?? null],
    );
    return { drafts: rows.rows.map(draftSummary) };
  }
  async function read(
    scope: DraftScope,
    _input: unknown = {},
    query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const draft = await db.query(
      `${draftSelect} WHERE d.id=$1 AND d.project_id=$2`,
      [scope.draftId, scope.projectId],
    );
    if (
      !draft.rowCount ||
      draft.rows[0].status === "discarded" ||
      draft.rows[0].status === "terminated" ||
      publishedDraftUnavailable(draft.rows[0])
    )
      throw new DraftOperationError(404, {
        error: { code: "draft_not_found" },
      });
    const summary = draftSummary(draft.rows[0]);
    if (summary.suspended) return { draft: summary, records: [], total: 0 };
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = Math.max(0, Number(query.offset) || 0);
    const search = String(query.search ?? "").slice(0, 200);
    const rows = await db.query(
      `SELECT dr.*, da.file_name AS source_file_name,
        coalesce(author.display_name,author.username) AS updated_by_name,
        count(*) OVER() AS total
        FROM (
          SELECT *, row_number() OVER (ORDER BY position) AS active_ordinal
          FROM collaborative_draft_record
          WHERE draft_id=$1 AND deleted=false
        ) dr
        LEFT JOIN app_user author ON author.id=dr.updated_by
        LEFT JOIN data_asset da ON da.id=dr.source->>'assetId'
        WHERE ($2='' OR question ILIKE '%'||$2||'%' OR expected_output ILIKE '%'||$2||'%')
        ORDER BY position LIMIT $3 OFFSET $4`,
      [scope.draftId, search, limit, offset],
    );
    const authorIds = [
      ...new Set(
        [
          summary.nameUpdatedBy,
          summary.purposeUpdatedBy,
          ...rows.rows.flatMap((row) => [
            String(row.updated_by),
            ...Object.values(
              isPlainObject(row.field_attribution) ? row.field_attribution : {},
            ).flatMap((fact) =>
              isPlainObject(fact) && typeof fact.userId === "string"
                ? [fact.userId]
                : [],
            ),
          ]),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const people = authorIds.length
      ? await db.query(
          `SELECT id,coalesce(display_name,username) AS name,avatar_color FROM app_user WHERE id=ANY($1::text[])`,
          [authorIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const authors = Object.fromEntries(
      people.rows.map((person) => [
        String(person.id),
        { name: String(person.name), avatarColor: String(person.avatar_color) },
      ]),
    );
    const presentations = await presentSources(
      db,
      artifacts,
      {
        projectId: scope.projectId,
        actorId: { id: scope.actorId }.id,
      },
      rows.rows.map((row) => row.source),
    );
    return {
      draft: summary,
      records: rows.rows.map((row, index) => ({
        ...draftRow(row),
        ...(presentations[index]?.label === "原始来源不可访问"
          ? { sourceFileName: null }
          : {}),
        sourcePresentation: presentations[index],
      })),
      authors,
      total: Number(rows.rows[0]?.total ?? 0),
    };
  }
  async function update(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    if (!draftPatchSchema.safeParse(input).success)
      throw new DraftOperationError(422, {
        error: { code: "draft_field_invalid" },
      });
    await requireDraftAccess(db, scope);
    const body = input;
    if (
      !isPlainObject(body) ||
      !["name", "purpose"].includes(String(body.field)) ||
      typeof body.value !== "string" ||
      !Number.isInteger(body.expectedFieldRevision) ||
      body.value.length > (body.field === "name" ? 200 : 2000)
    )
      throw new DraftOperationError(422, {
        error: { code: "draft_field_invalid" },
      });
    const field = String(body.field),
      revField = field === "name" ? "name_revision" : "purpose_revision";
    const actor = { id: scope.actorId };
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await readOperationReceipt(client, scope);
      if (replay) {
        await guardOperationCommit(client, scope);
        await client.query("COMMIT");
        return replay;
      }
      const current = await client.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
        [scope.draftId, scope.projectId],
      );
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      }
      if (!draftLive(current.rows[0])) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_not_editable" },
        });
      }
      if (Number(current.rows[0][revField]) !== body.expectedFieldRevision) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_field_conflict" },
          draft: draftSummary(current.rows[0]),
        });
      }
      await client.query(
        `UPDATE collaborative_draft SET ${field}=$2,${revField}=${revField}+1,
          ${field}_updated_by=$3,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`,
        [scope.draftId, body.value, actor.id],
      );
      const updated = await client.query(`${draftSelect} WHERE d.id=$1`, [
        scope.draftId,
      ]);

      return await finishDraftMutation(
        client,
        scope,
        { draft: draftSummary(updated.rows[0]) },
        undefined,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function addRecord(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    if (!draftRecordSchema.safeParse(input).success)
      throw new DraftOperationError(422, {
        error: { code: "draft_record_invalid" },
      });
    await requireDraftAccess(db, scope);
    const body = input;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some(
        (k) =>
          !["source", "question", "expectedOutput", "metadata"].includes(k),
      ) ||
      (body.source !== undefined &&
        (body.question !== undefined ||
          body.expectedOutput !== undefined ||
          body.metadata !== undefined ||
          draftFieldValue("source", body.source) === undefined)) ||
      (body.question !== undefined &&
        draftFieldValue("question", body.question) === undefined) ||
      (body.expectedOutput !== undefined &&
        draftFieldValue("expectedOutput", body.expectedOutput) === undefined) ||
      (body.metadata !== undefined &&
        draftFieldValue("metadata", body.metadata) === undefined)
    )
      throw new DraftOperationError(422, {
        error: { code: "draft_record_invalid" },
      });
    const source =
      body.source === undefined
        ? null
        : (draftFieldValue("source", body.source) as {
            assetId: string;
            ordinal: number;
          } | null);
    const actor = { id: scope.actorId };
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await readOperationReceipt(client, scope);
      if (replay) {
        await guardOperationCommit(client, scope);
        await client.query("COMMIT");
        return replay;
      }
      const current = await client.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
        [scope.draftId, scope.projectId],
      );
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      }
      if (!draftLive(current.rows[0])) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_not_editable" },
        });
      }
      const count = await client.query(
        `SELECT count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
          FROM collaborative_draft_record WHERE draft_id=$1`,
        [scope.draftId],
      );
      if (Number(count.rows[0].count) >= 10000) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(422, {
          error: { code: "test_set_capacity_exceeded" },
        });
      }
      if (source) {
        const existing = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1
            AND source->>'assetId'=$2 AND (source->>'ordinal')::integer=$3
            AND deleted=false LIMIT 1`,
          [scope.draftId, source.assetId, source.ordinal],
        );
        if (existing.rowCount) {
          return await finishDraftMutation(
            client,
            scope,
            { record: draftRow(existing.rows[0]), replayed: true },
            undefined,
          );
        }
      }
      if (source) {
        const used = await client.query(
          `SELECT DISTINCT source->>'assetId' AS asset_id
            FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
          [scope.draftId],
        );
        const assetIds = [
          ...new Set([
            ...used.rows.map((row) => String(row.asset_id)),
            source.assetId,
          ]),
        ];
        const size = await client.query(
          `SELECT coalesce(sum(size_bytes),0)::bigint AS total
            FROM data_asset WHERE project_id=$1 AND id=ANY($2::text[])`,
          [scope.projectId, assetIds],
        );
        if (assetIds.length > 5 || Number(size.rows[0].total) > 100000000) {
          await client.query("ROLLBACK");
          throw new DraftOperationError(422, {
            error: { code: "test_set_capacity_exceeded" },
          });
        }
      }
      let question = String(body.question ?? ""),
        expectedOutput = String(body.expectedOutput ?? ""),
        metadata: MetadataEntry[] =
          (body.metadata as MetadataEntry[] | undefined) ?? [];
      if (source) {
        const material = await client.query(
          `SELECT sr.value,pv.display_mapping FROM data_asset da
            JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
            JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.ordinal=$3 AND sr.parse_status='valid'
            WHERE da.id=$2 AND da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')`,
          [scope.projectId, source.assetId, source.ordinal],
        );
        if (!material.rowCount) {
          await client.query("ROLLBACK");
          throw new DraftOperationError(422, {
            error: { code: "source_selection_invalid" },
          });
        }
        const mapped = mapMaterialRecord(
          material.rows[0].value,
          normalizeDisplayMapping(material.rows[0].display_mapping) ?? {
            metadata: [],
          },
        );
        question = mapped.question;
        expectedOutput = mapped.expectedOutput;
        metadata = mapped.metadata;
      }
      const rowId = opaqueId("draftrow");
      await client.query(
        `INSERT INTO collaborative_draft_record
          (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
            jsonb_build_object(
              'question',jsonb_build_object('userId',$8::text,'at',now()),
              'expectedOutput',jsonb_build_object('userId',$8::text,'at',now()),
              'metadata',jsonb_build_object('userId',$8::text,'at',now())
            ))`,
        [
          scope.draftId,
          rowId,
          Number(count.rows[0].high_water) + 1,
          question,
          expectedOutput,
          JSON.stringify(metadata),
          source ? JSON.stringify(source) : null,
          actor.id,
        ],
      );
      await client.query(
        `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
        [scope.draftId, actor.id],
      );
      const inserted = await client.query(
        `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2`,
        [scope.draftId, rowId],
      );

      return await finishDraftMutation(
        client,
        scope,
        { record: draftRow(inserted.rows[0]) },
        undefined,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function updateRecord(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    if (!recordPatchSchema.safeParse(input).success)
      throw new DraftOperationError(422, {
        error: { code: "draft_field_invalid" },
      });
    await requireDraftAccess(db, scope);
    const body = input;
    if (
      !isPlainObject(body) ||
      !["question", "expectedOutput", "metadata"].includes(
        String(body.field),
      ) ||
      !Number.isInteger(body.expectedFieldRevision) ||
      draftFieldValue(String(body.field), body.value) === undefined
    )
      throw new DraftOperationError(422, {
        error: { code: "draft_field_invalid" },
      });
    const field = String(body.field);
    const column = field === "expectedOutput" ? "expected_output" : field;
    const revColumn = `${column}_revision`;
    const actor = { id: scope.actorId };
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await readOperationReceipt(client, scope);
      if (replay) {
        await guardOperationCommit(client, scope);
        await client.query("COMMIT");
        return replay;
      }
      const draft = await client.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
        [scope.draftId, scope.projectId],
      );
      if (!draft.rowCount) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      }
      if (!draftLive(draft.rows[0])) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_not_editable" },
        });
      }
      const current = await client.query(
        `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 FOR UPDATE`,
        [scope.draftId, scope.recordId],
      );
      if (!current.rowCount || current.rows[0].deleted) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_record_removed" },
        });
      }
      if (Number(current.rows[0][revColumn]) !== body.expectedFieldRevision) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_field_conflict" },
          record: draftRow(current.rows[0]),
        });
      }
      const value = draftFieldValue(field, body.value);
      await client.query(
        `UPDATE collaborative_draft_record SET ${column}=$3,
          ${revColumn}=${revColumn}+1,row_revision=row_revision+1,
          field_attribution=jsonb_set(field_attribution,$4::text[],jsonb_build_object('userId',$5::text,'at',now()),true),
          updated_by=$5,updated_at=now() WHERE draft_id=$1 AND id=$2`,
        [
          scope.draftId,
          scope.recordId,
          field === "metadata" ? JSON.stringify(value) : value,
          [field],
          actor.id,
        ],
      );
      await client.query(`SELECT set_config('evalbase.draft_change',$1,true)`, [
        JSON.stringify({
          recordId: scope.recordId,
          rowRevision: Number(current.rows[0].row_revision) + 1,
        }),
      ]);
      await client.query(
        `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
        [scope.draftId, actor.id],
      );
      const updated = await client.query(
        `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2`,
        [scope.draftId, scope.recordId],
      );

      return await finishDraftMutation(
        client,
        scope,
        { record: draftRow(updated.rows[0]) },
        undefined,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function removeRecord(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const body = input;
    if (!isPlainObject(body) || !Number.isInteger(body.expectedRowRevision))
      throw new DraftOperationError(422, {
        error: { code: "draft_row_revision_required" },
      });
    const actor = { id: scope.actorId };
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await readOperationReceipt(client, scope);
      if (replay) {
        await guardOperationCommit(client, scope);
        await client.query("COMMIT");
        return replay;
      }
      const draft = await client.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
        [scope.draftId, scope.projectId],
      );
      if (!draft.rowCount) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      }
      if (!draftLive(draft.rows[0])) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_not_editable" },
        });
      }
      const current = await client.query(
        `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 FOR UPDATE`,
        [scope.draftId, scope.recordId],
      );
      if (!current.rowCount || current.rows[0].deleted) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_record_removed" },
        });
      }
      if (Number(current.rows[0].row_revision) !== body.expectedRowRevision) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_row_conflict" },
          record: draftRow(current.rows[0]),
        });
      }
      await guardOperationCommit(client, scope, "draft");
      await client.query(
        `UPDATE collaborative_draft_record SET deleted=true,row_revision=row_revision+1,
          updated_by=$3,updated_at=now() WHERE draft_id=$1 AND id=$2`,
        [scope.draftId, scope.recordId, actor.id],
      );
      await client.query(
        `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
        [scope.draftId, actor.id],
      );

      return await finishDraftMutation(
        client,
        scope,
        { deleted: true },
        "draft",
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function discard(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await readOperationReceipt(client, scope);
      if (replay) {
        await guardOperationCommit(client, scope);
        await client.query("COMMIT");
        return replay;
      }
      const draft = await client.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
        [scope.draftId, scope.projectId],
      );
      if (!draft.rowCount) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      }
      if (!draftLive(draft.rows[0])) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_not_editable" },
        });
      }
      if (
        isPlainObject(input) &&
        input.expectedRevision !== undefined &&
        Number(draft.rows[0].revision) !== input.expectedRevision
      )
        throw new DraftOperationError(409, {
          error: { code: "draft_revision_conflict" },
        });
      await guardOperationCommit(client, scope, "draft");
      await client.query(
        `DELETE FROM collaborative_draft_record WHERE draft_id=$1`,
        [scope.draftId],
      );
      await client.query(
        `UPDATE collaborative_draft SET status='discarded',name='',purpose='',revision=revision+1,
          updated_at=now() WHERE id=$1`,
        [scope.draftId],
      );

      const result = await finishDraftMutation(
        client,
        scope,
        { deleted: true },
        "draft",
      );
      await cleanupProcessingObjects(db, artifacts, scope.projectId);
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function sourceFiles(
    scope: DraftScope,
    _input: unknown = {},
    query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));
    const offset = Math.max(0, Number(query.offset) || 0);
    const search = String(query.search ?? "").slice(0, 200);
    const rows = await db.query(
      `SELECT da.id,da.file_name,c.name AS collection_name,pv.display_mapping,
        count(sr.ordinal)::integer AS record_count,count(*) OVER() AS total
        FROM data_asset da JOIN raw_material_collection c ON c.id=da.collection_id
        JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
        JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
        WHERE da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')
          AND ($2='' OR da.file_name ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%')
        GROUP BY da.id,da.file_name,c.name,pv.display_mapping ORDER BY c.name,da.file_name,da.id
        LIMIT $3 OFFSET $4`,
      [scope.projectId, search, limit, offset],
    );
    return {
      files: rows.rows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        collectionName: row.collection_name,
        recordCount: Number(row.record_count),
        metadataKeys: (
          normalizeDisplayMapping(row.display_mapping)?.metadata ?? []
        ).map(displayFieldName),
      })),
      total: Number(rows.rows[0]?.total ?? 0),
    };
  }
  async function sourceRecords(
    scope: DraftScope,
    _input: unknown = {},
    query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    if (!query.assetId)
      throw new DraftOperationError(422, {
        error: { code: "source_asset_required" },
      });
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const offset = Math.max(0, Number(query.offset) || 0);
    const search = String(query.search ?? "").slice(0, 200);
    const rows = await db.query(
      `SELECT sr.ordinal,sr.value,pv.display_mapping,
        count(*) OVER() AS total FROM data_asset da
        JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
        JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
        WHERE da.id=$2 AND da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')
          AND ($3='' OR sr.value::text ILIKE '%'||$3||'%')
        ORDER BY sr.ordinal LIMIT $4 OFFSET $5`,
      [scope.projectId, query.assetId, search, limit, offset],
    );
    return {
      records: rows.rows.map((row) => ({
        assetId: query.assetId,
        ordinal: Number(row.ordinal),
        ...mapMaterialRecord(
          row.value,
          normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
        ),
      })),
      total: Number(rows.rows[0]?.total ?? 0),
    };
  }
  async function selectedSources(
    scope: DraftScope,
    _input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const draft = await db.query(
      `${draftSelect} WHERE d.id=$1 AND d.project_id=$2
        AND d.status IN ('editing','published')`,
      [scope.draftId, scope.projectId],
    );
    if (!draft.rowCount || publishedDraftUnavailable(draft.rows[0]))
      throw new DraftOperationError(404, {
        error: { code: "draft_not_found" },
      });
    if (draftSummary(draft.rows[0]).suspended)
      throw new DraftOperationError(409, {
        error: { code: "draft_not_editable" },
      });
    const rows = await db.query(
      `SELECT id, row_revision, source->>'assetId' AS asset_id,
        (source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record
        WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
      [scope.draftId],
    );
    return {
      sources: rows.rows.map((row) => ({
        assetId: row.asset_id,
        ordinal: row.ordinal,
        recordId: row.id,
        rowRevision: Number(row.row_revision),
      })),
    };
  }
  async function sourceSelection(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const body = input;
    if (
      !isPlainObject(body) ||
      !Array.isArray(body.assetIds) ||
      body.assetIds.length < 1 ||
      body.assetIds.length > 5 ||
      body.assetIds.some((id) => typeof id !== "string") ||
      new Set(body.assetIds).size !== body.assetIds.length ||
      !["add", "remove"].includes(String(body.mode)) ||
      (body.mode === "remove" &&
        (!Array.isArray(body.expectedRecords) ||
          body.expectedRecords.length > 10000 ||
          body.expectedRecords.some(
            (item) =>
              !isPlainObject(item) ||
              typeof item.id !== "string" ||
              !Number.isSafeInteger(item.rowRevision) ||
              Number(item.rowRevision) < 0,
          ) ||
          new Set(body.expectedRecords.map((item) => item.id)).size !==
            body.expectedRecords.length)) ||
      (body.search !== undefined &&
        (typeof body.search !== "string" || body.search.length > 200)) ||
      (body.exclude !== undefined &&
        (!Array.isArray(body.exclude) ||
          body.exclude.length > 10000 ||
          body.exclude.some(
            (item) =>
              !isPlainObject(item) ||
              typeof item.assetId !== "string" ||
              !Number.isInteger(item.ordinal) ||
              Number(item.ordinal) < 0,
          ))) ||
      (body.ordinals !== undefined &&
        (!Array.isArray(body.ordinals) ||
          body.ordinals.length > 10000 ||
          body.ordinals.some(
            (value) => !Number.isInteger(value) || Number(value) < 0,
          )))
    )
      throw new DraftOperationError(422, {
        error: { code: "source_selection_invalid" },
      });
    const assetIds = body.assetIds as string[];
    const excluded = new Set(
      ((body.exclude ?? []) as Array<{ assetId: string; ordinal: number }>).map(
        (item) => `${item.assetId}:${item.ordinal}`,
      ),
    );
    const actor = { id: scope.actorId };
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const replay = await readOperationReceipt(client, scope);
      if (replay) {
        await guardOperationCommit(client, scope);
        await client.query("COMMIT");
        return replay;
      }
      const draft = await client.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
        [scope.draftId, scope.projectId],
      );
      if (!draft.rowCount) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      }
      if (!draftLive(draft.rows[0])) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(409, {
          error: { code: "draft_not_editable" },
        });
      }
      const assets = await client.query(
        `SELECT da.id,da.size_bytes FROM data_asset da
          JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
          WHERE da.project_id=$1 AND da.id=ANY($2::text[]) AND da.status NOT IN ('deletion_pending','tombstoned')`,
        [scope.projectId, assetIds],
      );
      if (
        assets.rows.length !== assetIds.length ||
        assets.rows.reduce((sum, row) => sum + Number(row.size_bytes), 0) >
          100000000
      ) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(422, {
          error: { code: "test_set_capacity_exceeded" },
        });
      }
      const sources = await client.query(
        `SELECT da.id AS asset_id,sr.ordinal,sr.value,pv.display_mapping
          FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
          JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
          WHERE da.project_id=$1 AND da.id=ANY($2::text[])
            AND ($3='' OR sr.value::text ILIKE '%'||$3||'%')
            AND ($4::integer[] IS NULL OR sr.ordinal=ANY($4::integer[]))
          ORDER BY da.id,sr.ordinal LIMIT 10001`,
        [
          scope.projectId,
          assetIds,
          String(body.search ?? ""),
          body.ordinals ?? null,
        ],
      );
      if (sources.rows.length > 10000) {
        await client.query("ROLLBACK");
        throw new DraftOperationError(422, {
          error: { code: "test_set_capacity_exceeded" },
        });
      }
      const selected = sources.rows.filter(
        (row) => !excluded.has(`${row.asset_id}:${row.ordinal}`),
      );
      let changed = 0;
      if (body.mode === "add") {
        const active = await client.query(
          `SELECT source->>'assetId' AS asset_id,
            (source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
          [scope.draftId],
        );
        const activeKeys = new Set(
          active.rows.map((row) => `${row.asset_id}:${row.ordinal}`),
        );
        const additions = selected.filter(
          (row) => !activeKeys.has(`${row.asset_id}:${row.ordinal}`),
        );
        const allAssets = [
          ...new Set([
            ...active.rows.map((row) => String(row.asset_id)),
            ...additions.map((row) => String(row.asset_id)),
          ]),
        ];
        if (allAssets.length > 5) {
          await client.query("ROLLBACK");
          throw new DraftOperationError(422, {
            error: { code: "test_set_capacity_exceeded" },
          });
        }
        const totalSize = await client.query(
          `SELECT coalesce(sum(size_bytes),0)::bigint AS size
            FROM data_asset WHERE id=ANY($1::text[])`,
          [allAssets],
        );
        if (Number(totalSize.rows[0].size) > 100000000) {
          await client.query("ROLLBACK");
          throw new DraftOperationError(422, {
            error: { code: "test_set_capacity_exceeded" },
          });
        }
        const state = await client.query(
          `SELECT count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
            FROM collaborative_draft_record WHERE draft_id=$1`,
          [scope.draftId],
        );
        if (Number(state.rows[0].count) + additions.length > 10000) {
          await client.query("ROLLBACK");
          throw new DraftOperationError(422, {
            error: { code: "test_set_capacity_exceeded" },
          });
        }
        let position = Number(state.rows[0].high_water);
        changed += await writeBatches(
          client,
          `INSERT INTO collaborative_draft_record
            (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
            SELECT $1,x.id,x.position,x.question,x.expected_output,x.metadata,x.source,$2,
              jsonb_build_object('question',jsonb_build_object('userId',$2::text,'at',now()),
                'expectedOutput',jsonb_build_object('userId',$2::text,'at',now()),
                'metadata',jsonb_build_object('userId',$2::text,'at',now()))
            FROM jsonb_to_recordset($3::jsonb) AS x(id text,position bigint,question text,expected_output text,metadata jsonb,source jsonb)
            ON CONFLICT DO NOTHING RETURNING id`,
          [scope.draftId, actor.id],
          additions.map((row) => {
            const mapped = mapMaterialRecord(
              row.value,
              normalizeDisplayMapping(row.display_mapping) ?? {
                metadata: [],
              },
            );
            return {
              id: opaqueId("draftrow"),
              position: ++position,
              question: mapped.question,
              expected_output: mapped.expectedOutput,
              metadata: mapped.metadata,
              source: {
                assetId: String(row.asset_id),
                ordinal: Number(row.ordinal),
              },
            };
          }),
        );
      } else {
        const expected = new Map(
          (
            body.expectedRecords as Array<{ id: string; rowRevision: number }>
          ).map((row) => [row.id, row.rowRevision]),
        );
        const selectedKeys = new Set(
          selected.map((row) => `${row.asset_id}:${row.ordinal}`),
        );
        const current = await client.query(
          `SELECT id,row_revision,source->>'assetId' AS asset_id,
              (source->>'ordinal')::integer AS ordinal
             FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false
               AND source->>'assetId'=ANY($2::text[]) FOR UPDATE`,
          [scope.draftId, assetIds],
        );
        const affected = current.rows.filter((row) =>
          selectedKeys.has(`${row.asset_id}:${row.ordinal}`),
        );
        if (
          affected.some(
            (row) => expected.get(row.id) !== Number(row.row_revision),
          )
        ) {
          await client.query("ROLLBACK");
          throw new DraftOperationError(409, {
            error: { code: "draft_row_conflict" },
          });
        }
        if (affected.length) {
          const removed = await client.query(
            `UPDATE collaborative_draft_record SET deleted=true,
               row_revision=row_revision+1,updated_by=$3,updated_at=now()
               WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false`,
            [scope.draftId, affected.map((row) => row.id), actor.id],
          );
          changed = removed.rowCount ?? 0;
        }
      }
      if (changed)
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,
          updated_by=$2,updated_at=now() WHERE id=$1`,
          [scope.draftId, actor.id],
        );

      return await finishDraftMutation(
        client,
        scope,
        { matched: selected.length, changed },
        undefined,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function publishDraft(
    scope: DraftScope,
    input: unknown = {},
    _query: Record<string, any> = {},
    _key?: string,
  ) {
    await requireDraftAccess(db, scope);
    const body = input;
    if (
      !isPlainObject(body) ||
      !Number.isInteger(body.revision) ||
      Object.keys(body).some((key) => key !== "revision")
    )
      throw new DraftOperationError(422, {
        error: { code: "draft_revision_required" },
      });
    const actor = { id: scope.actorId };
    const draft = await db.query(
      `${draftSelect} WHERE d.id=$1 AND d.project_id=$2`,
      [scope.draftId, scope.projectId],
    );
    if (!draft.rowCount || publishedDraftUnavailable(draft.rows[0]))
      throw new DraftOperationError(404, {
        error: { code: "draft_not_found" },
      });
    const saved = draft.rows[0];
    if (saved.status === "published" && saved.published_version_id) {
      const result = await db.query(
        `SELECT v.id,v.version_label,v.item_count,v.test_set_id,
          ts.name,ts.purpose FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
          WHERE v.id=$1 AND v.status='published' AND ts.status='available'`,
        [saved.published_version_id],
      );
      if (!result.rowCount)
        throw new DraftOperationError(404, {
          error: { code: "draft_not_found" },
        });
      return {
        testSet: {
          id: result.rows[0].test_set_id,
          name: result.rows[0].name,
          purpose: result.rows[0].purpose,
        },
        version: {
          id: result.rows[0].id,
          label: result.rows[0].version_label,
          recordCount: Number(result.rows[0].item_count),
        },
        replayed: true,
      };
    }
    if (!draftLive(saved))
      throw new DraftOperationError(409, {
        error: { code: "draft_not_editable" },
      });
    if (Number(saved.revision) !== body.revision)
      throw new DraftOperationError(409, {
        error: { code: "draft_revision_conflict" },
        draft: draftSummary(saved),
      });
    if (!String(saved.name).trim())
      throw new DraftOperationError(422, {
        error: { code: "test_set_name_required" },
      });
    const records = await db.query(
      `SELECT * FROM collaborative_draft_record
        WHERE draft_id=$1 AND deleted=false ORDER BY position`,
      [scope.draftId],
    );
    if (!records.rowCount)
      throw new DraftOperationError(422, {
        error: { code: "test_set_records_required" },
      });
    if (!saved.parent_version_id) {
      const normalized = records.rows.map((row) => ({
        question: String(row.question),
        expectedOutput: String(row.expected_output),
        metadata: row.metadata as MetadataEntry[],
        ...(row.source
          ? { source: row.source as { assetId: string; ordinal: number } }
          : {}),
      }));
      const selections = [
        ...new Map(
          normalized.flatMap((record) =>
            record.source
              ? [
                  [
                    `${record.source.assetId}:${record.source.ordinal}`,
                    record.source,
                  ] as const,
                ]
              : [],
          ),
        ).values(),
      ];
      return await publication.publishInitial(
        scope,
        {
          name: saved.name,
          purpose: saved.purpose,
          selections,
          operations: normalized.map((after) => ({ operation: "add", after })),
          collaborativeDraftId: scope.draftId,
          draftRevision: body.revision,
        },
        `draft:${scope.draftId}:${body.revision}`,
      );
    }
    try {
      const published = await publishSparseVersion(db, artifacts, {
        ...scope,
        projectId: scope.projectId,
        testSetId: String(saved.test_set_id),
        parentVersionId: String(saved.parent_version_id),
        actorId: actor.id,
        idempotencyKey: `draft:${scope.draftId}:${body.revision}`,
        operations: [],
        draftId: scope.draftId,
        draftRevision: Number(body.revision),
      });
      const count = await db.query(
        `SELECT item_count FROM test_set_version WHERE id=$1`,
        [published.id],
      );
      return {
        testSet: {
          id: saved.test_set_id,
          name: saved.name,
          purpose: saved.purpose,
        },
        version: {
          id: published.id,
          label: published.label,
          recordCount: Number(count.rows[0]?.item_count ?? 0),
          parentVersionId: saved.parent_version_id,
        },
        replayed: published.replayed,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code &&
        ["draft_not_found", "version_not_found", "test_set_not_found"].includes(
          code,
        )
      )
        throw new DraftOperationError(404, { error: { code } });
      if (
        code &&
        ["draft_revision_conflict", "idempotency_conflict"].includes(code)
      )
        throw new DraftOperationError(409, { error: { code } });
      if (
        code &&
        [
          "test_set_records_required",
          "test_record_invalid",
          "source_selection_invalid",
          "test_set_capacity_exceeded",
          "parent_record_invalid",
          "draft_parent_incomplete",
        ].includes(code)
      )
        throw new DraftOperationError(422, { error: { code } });
      if (code === "checkpoint_hard_limit_failed")
        throw new DraftOperationError(503, { error: { code } });
      throw error;
    }
  }
  async function record(scope: DraftScope) {
    const current = await read(scope);
    const row = (
      await db.query(
        "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 AND deleted=false",
        [scope.draftId, scope.recordId],
      )
    ).rows[0];
    if (!row)
      throw new DraftOperationError(404, {
        error: { code: "draft_record_removed" },
      });
    return { draft: current.draft, record: draftRow(row) };
  }
  return {
    record,
    list,
    read,
    update,
    addRecord,
    updateRecord,
    removeRecord,
    discard,
    sourceFiles,
    sourceRecords,
    selectedSources,
    sourceSelection,
    publishDraft,
  };
}
