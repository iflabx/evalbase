import {
  guardAssistantCommit,
  type AssistantGuard,
} from "../assistant/fence.js";
import type { PoolClient } from "pg";
import type { Database } from "../db/pool.js";
import { writeBatches } from "../db/batch.js";
import { hasProjectCapability } from "../security/project-access.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import {
  isPlainObject,
  mapMaterialRecord,
  normalizeDisplayMapping,
  opaqueId,
} from "../server/support.js";
import { selectRecords, sourceIdentity } from "./index.js";

export class SelectionError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}
export type SelectionScope = {
  projectId: string;
  draftId: string;
  actorId: string;
  assistantGuard?: AssistantGuard;
};

async function inDraft<T>(
  db: Database,
  scope: SelectionScope,
  action: (
    client: PoolClient,
    revision: number,
    editing: boolean,
  ) => Promise<T>,
  allowPublished = false,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (
      !(await hasProjectCapability(
        client,
        scope.projectId,
        scope.actorId,
        "write",
      ))
    )
      throw new SelectionError(404, "project_not_found");
    const draft = await client.query(
      "SELECT id FROM collaborative_draft WHERE id=$1 AND project_id=$2 FOR UPDATE",
      [scope.draftId, scope.projectId],
    );
    if (!draft.rowCount) throw new SelectionError(404, "draft_not_found");
    // A membership may have changed while this request waited for the draft lock.
    await client.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
      scope.actorId,
    ]);
    await client.query(
      "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
      [scope.projectId, scope.actorId],
    );
    if (
      !(await hasProjectCapability(
        client,
        scope.projectId,
        scope.actorId,
        "write",
      ))
    )
      throw new SelectionError(404, "project_not_found");
    const state = await client.query(
      `SELECT d.status,d.revision,ts.status AS set_status,v.status AS parent_status,published.status AS published_status
      FROM collaborative_draft d LEFT JOIN test_set ts ON ts.id=d.test_set_id
      LEFT JOIN test_set_version v ON v.id=d.parent_version_id
      LEFT JOIN test_set_version published ON published.id=d.published_version_id
      WHERE d.id=$1`,
      [scope.draftId],
    );
    const row = state.rows[0];
    const editing =
      row.status === "editing" &&
      (!row.set_status || row.set_status === "available") &&
      (!row.parent_status || row.parent_status === "published");
    const published =
      row.status === "published" &&
      row.set_status === "available" &&
      row.published_status === "published";
    if (!editing && !(allowPublished && published))
      throw new SelectionError(409, "draft_not_editable");
    const result = await action(client, Number(row.revision), editing);
    await guardAssistantCommit(client, scope);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && error.message === "selection_invalid")
      throw new SelectionError(422, "selection_invalid");
    throw error;
  } finally {
    client.release();
  }
}

async function loadSources(
  client: PoolClient,
  projectId: string,
  assetIds: string[],
) {
  const assets = await client.query(
    `SELECT da.id,da.file_name,da.size_bytes,pv.id AS view_id,pv.display_mapping
    FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready' AND pv.mapping_ready
    WHERE da.project_id=$1 AND da.id=ANY($2::text[]) AND da.status NOT IN ('deletion_pending','tombstoned')
    ORDER BY da.id FOR SHARE OF da,pv`,
    [projectId, assetIds],
  );
  if (assets.rows.length !== assetIds.length)
    throw new SelectionError(409, "selection_source_unavailable");
  if (
    assets.rows.reduce((total, row) => total + Number(row.size_bytes), 0) >
    100000000
  )
    throw new SelectionError(422, "test_set_capacity_exceeded");
  const rows = await client.query(
    `SELECT parsed_view_id,ordinal,value FROM source_record
    WHERE parsed_view_id=ANY($1::text[]) AND parse_status='valid' ORDER BY parsed_view_id,ordinal LIMIT 10001`,
    [assets.rows.map((row) => row.view_id)],
  );
  if (rows.rows.length > 10000)
    throw new SelectionError(422, "test_set_capacity_exceeded");
  const byView = new Map(assets.rows.map((asset) => [asset.view_id, asset]));
  const records = rows.rows.map((row) => {
    const asset = byView.get(row.parsed_view_id)!;
    return {
      assetId: String(asset.id),
      parsedViewId: String(row.parsed_view_id),
      fileName: String(asset.file_name),
      ordinal: Number(row.ordinal),
      ...mapMaterialRecord(
        row.value,
        normalizeDisplayMapping(asset.display_mapping) ?? { metadata: [] },
      ),
    };
  });
  const snapshot = assets.rows.map((asset) => ({
    assetId: String(asset.id),
    parsedViewId: String(asset.view_id),
    digest: sha256(
      canonicalJson({
        mapping: asset.display_mapping,
        records: rows.rows
          .filter((row) => row.parsed_view_id === asset.view_id)
          .map(({ ordinal, value }) => ({ ordinal, value })),
      }),
    ),
  }));
  return { records, snapshot };
}

function summary(row: Record<string, unknown>) {
  const config = row.configuration as Record<string, unknown>;
  return {
    id: row.id,
    configuration: config,
    seed: config.seed ?? null,
    algorithm: "sha256-rank-v1",
    scopeCount: Number(row.scope_count),
    candidateCount: (row.candidate_ids as string[]).length,
    selectedCount: (row.selected_ids as string[]).length,
    selectedIds: row.selected_ids,
    targetCount: Number(row.target_count),
    draftRevision: Number(row.draft_revision),
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    receipt: row.receipt,
  };
}

export async function createSelectionPreview(
  db: Database,
  scope: SelectionScope,
  input: unknown,
) {
  if (
    !isPlainObject(input) ||
    !Array.isArray(input.assetIds) ||
    !input.assetIds.length ||
    input.assetIds.length > 5 ||
    input.assetIds.some((id) => typeof id !== "string" || !id) ||
    new Set(input.assetIds).size !== input.assetIds.length
  )
    throw new SelectionError(422, "selection_invalid");
  return inDraft(db, scope, async (client, revision) => {
    const { records, snapshot } = await loadSources(
      client,
      scope.projectId,
      input.assetIds as string[],
    );
    const selection = selectRecords(records, input);
    const configuration = {
      assetIds: input.assetIds,
      conditions: input.conditions,
      method: input.method,
      ...(input.method === "random"
        ? { mode: input.mode, value: input.value, seed: selection.seed }
        : {}),
    };
    const saved = await client.query(
      `INSERT INTO selection_preview
      (id,project_id,draft_id,creator_id,configuration,source_snapshot,candidate_ids,selected_ids,scope_count,target_count,draft_revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        opaqueId("selection"),
        scope.projectId,
        scope.draftId,
        scope.actorId,
        configuration,
        JSON.stringify(snapshot),
        JSON.stringify(selection.candidates.map(sourceIdentity)),
        JSON.stringify(selection.selected.map(sourceIdentity)),
        records.length,
        selection.targetCount,
        revision,
      ],
    );
    return { preview: summary(saved.rows[0]) };
  });
}

export async function readSelectionPreview(
  db: Database,
  scope: SelectionScope,
  id: string,
  query: {
    view?: string;
    search?: string;
    offset?: string;
    limit?: string;
    includeIds?: string[];
  },
) {
  if (
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    (query.includeIds !== undefined &&
      (!Array.isArray(query.includeIds) ||
        query.includeIds.length > 10000 ||
        query.includeIds.some((value) => typeof value !== "string")))
  )
    throw new SelectionError(422, "selection_invalid");
  return inDraft(db, scope, async (client, revision) => {
    const result = await client.query(
      "SELECT * FROM selection_preview WHERE id=$1 AND project_id=$2 AND draft_id=$3",
      [id, scope.projectId, scope.draftId],
    );
    if (!result.rowCount) throw new SelectionError(404, "selection_not_found");
    const row = result.rows[0];
    const { records, snapshot } = await loadSources(
      client,
      scope.projectId,
      row.configuration.assetIds,
    );
    if (canonicalJson(snapshot) !== canonicalJson(row.source_snapshot))
      throw new SelectionError(409, "selection_source_changed");
    const candidateIds = new Set<string>(row.candidate_ids);
    const selectedIds = new Set<string>(row.selected_ids);
    const visibleIds = new Set([...selectedIds, ...(query.includeIds ?? [])]);
    const search = String(query.search ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    const ordered = records.sort((a, b) =>
      a.assetId < b.assetId
        ? -1
        : a.assetId > b.assetId
          ? 1
          : a.ordinal - b.ordinal,
    );
    const visible = ordered.filter(
      (record) =>
        candidateIds.has(sourceIdentity(record)) &&
        (query.view === "candidates" ||
          visibleIds.has(sourceIdentity(record))) &&
        (!search ||
          [record.question, record.expectedOutput, record.fileName].some(
            (text) => text.toLowerCase().includes(search),
          )),
    );
    const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
    const limit = Math.min(
      100,
      Math.max(1, Math.trunc(Number(query.limit) || 20)),
    );
    return {
      preview: summary(row),
      currentDraftRevision: revision,
      total: visible.length,
      records: visible.slice(offset, offset + limit).map((record) => ({
        ...record,
        id: sourceIdentity(record),
        selected: selectedIds.has(sourceIdentity(record)),
      })),
    };
  });
}

export async function applySelectionPreview(
  db: Database,
  scope: SelectionScope,
  id: string,
  input: unknown,
) {
  if (
    !isPlainObject(input) ||
    !Array.isArray(input.selectedIds) ||
    !input.selectedIds.length ||
    input.selectedIds.length > 10000 ||
    input.selectedIds.some((value) => typeof value !== "string") ||
    new Set(input.selectedIds).size !== input.selectedIds.length ||
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0
  )
    throw new SelectionError(422, "selection_invalid");
  const selectedIds = (input.selectedIds as string[]).slice().sort();
  const digest = sha256(canonicalJson(selectedIds));
  return inDraft(
    db,
    scope,
    async (client, revision, editing) => {
      const result = await client.query(
        "SELECT * FROM selection_preview WHERE id=$1 AND project_id=$2 AND draft_id=$3 FOR UPDATE",
        [id, scope.projectId, scope.draftId],
      );
      if (!result.rowCount)
        throw new SelectionError(404, "selection_not_found");
      const row = result.rows[0];
      if (row.receipt) {
        if (row.apply_digest !== digest)
          throw new SelectionError(409, "selection_already_applied");
        return { ...row.receipt, replayed: true };
      }
      if (!editing) throw new SelectionError(409, "draft_not_editable");
      if (revision !== input.expectedRevision)
        throw new SelectionError(409, "draft_revision_conflict", {
          currentRevision: revision,
        });
      const candidates = new Set<string>(row.candidate_ids);
      if (selectedIds.some((value) => !candidates.has(value)))
        throw new SelectionError(422, "selection_invalid");
      const { records, snapshot } = await loadSources(
        client,
        scope.projectId,
        row.configuration.assetIds,
      );
      if (canonicalJson(snapshot) !== canonicalJson(row.source_snapshot))
        throw new SelectionError(409, "selection_source_changed");
      const chosen = new Set(selectedIds);
      const selected = records.filter((record) =>
        chosen.has(sourceIdentity(record)),
      );
      const active = await client.query(
        `SELECT source->>'assetId' AS asset_id,(source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
        [scope.draftId],
      );
      const activeIds = new Set(
        active.rows.map((record) =>
          sourceIdentity({
            assetId: String(record.asset_id),
            ordinal: Number(record.ordinal),
          }),
        ),
      );
      const additions = selected.filter(
        (record) => !activeIds.has(sourceIdentity(record)),
      );
      if (!additions.length)
        throw new SelectionError(422, "selection_no_additions");
      const assets = [
        ...new Set([
          ...active.rows.map((record) => String(record.asset_id)),
          ...additions.map((record) => record.assetId),
        ]),
      ];
      const capacity = await client.query(
        `SELECT (SELECT coalesce(sum(size_bytes),0) FROM data_asset WHERE id=ANY($2::text[])) AS bytes,
      count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
      FROM collaborative_draft_record WHERE draft_id=$1`,
        [scope.draftId, assets],
      );
      if (
        assets.length > 5 ||
        Number(capacity.rows[0].bytes) > 100000000 ||
        Number(capacity.rows[0].count) + additions.length > 10000
      )
        throw new SelectionError(422, "test_set_capacity_exceeded");
      let position = Number(capacity.rows[0].high_water);
      additions.sort((a, b) =>
        a.assetId < b.assetId
          ? -1
          : a.assetId > b.assetId
            ? 1
            : a.ordinal - b.ordinal,
      );
      await guardAssistantCommit(client, scope);
      const added = await writeBatches(
        client,
        `INSERT INTO collaborative_draft_record
      (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
      SELECT $1,x.id,x.position,x.question,x.expected_output,x.metadata,x.source,$2,
        jsonb_build_object('question',jsonb_build_object('userId',$2::text,'at',now()),
          'expectedOutput',jsonb_build_object('userId',$2::text,'at',now()),
          'metadata',jsonb_build_object('userId',$2::text,'at',now()))
      FROM jsonb_to_recordset($3::jsonb) AS x(id text,position bigint,question text,expected_output text,metadata jsonb,source jsonb)
      RETURNING id`,
        [scope.draftId, scope.actorId],
        additions.map((record) => ({
          id: opaqueId("draftrow"),
          position: ++position,
          question: record.question,
          expected_output: record.expectedOutput,
          metadata: record.metadata,
          source: { assetId: record.assetId, ordinal: record.ordinal },
        })),
      );
      await client.query(
        "UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1",
        [scope.draftId, scope.actorId],
      );
      const receipt = {
        previewId: id,
        draftId: scope.draftId,
        added,
        skipped: selected.length - added,
        revision: revision + 1,
      };
      await client.query(
        "UPDATE selection_preview SET applied_at=now(),applied_ids=$2,apply_digest=$3,receipt=$4,applied_by=$5 WHERE id=$1",
        [id, JSON.stringify(selectedIds), digest, receipt, scope.actorId],
      );
      return { ...receipt, replayed: false };
    },
    true,
  );
}

async function historyForDraft(
  client: Pick<Database, "query">,
  draftId: string,
) {
  const rows = await client.query(
    `SELECT sp.*,u.display_name,u.username FROM selection_preview sp
    LEFT JOIN app_user u ON u.id=sp.applied_by WHERE sp.draft_id=$1 AND sp.applied_at IS NOT NULL
    ORDER BY sp.applied_at DESC,sp.id DESC`,
    [draftId],
  );
  return {
    history: rows.rows.map((row) => ({
      id: row.id,
      configuration: row.configuration,
      actorName: row.display_name ?? row.username ?? "未记录",
      at: row.applied_at,
      scopeCount: Number(row.scope_count),
      candidateCount: row.candidate_ids.length,
      selectedCount: row.applied_ids.length,
      selectedDigest: row.apply_digest,
      added: row.receipt.added,
      skipped: row.receipt.skipped,
      algorithm: "sha256-rank-v1",
    })),
  };
}

export async function readSelectionHistory(
  db: Database,
  scope: SelectionScope,
) {
  return inDraft(db, scope, (client) => historyForDraft(client, scope.draftId));
}

export async function readVersionSelectionHistory(
  db: Database,
  scope: {
    projectId: string;
    actorId: string;
    testSetId: string;
    versionId: string;
  },
) {
  if (!(await hasProjectCapability(db, scope.projectId, scope.actorId, "read")))
    throw new SelectionError(404, "project_not_found");
  const version = await db.query(
    `SELECT d.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
    LEFT JOIN collaborative_draft d ON d.published_version_id=v.id
    WHERE ts.project_id=$1 AND ts.id=$2 AND v.id=$3 AND ts.status='available' AND v.status='published'`,
    [scope.projectId, scope.testSetId, scope.versionId],
  );
  if (!version.rowCount) throw new SelectionError(404, "version_not_found");
  return version.rows[0].id
    ? historyForDraft(db, version.rows[0].id)
    : { history: [] };
}
