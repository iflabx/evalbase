import type { Database } from "../db/pool.js";
import { selectRecords } from "../selection/index.js";
import type { ProcessingInput } from "./protocol.js";
import type {
  ProcessingSource,
  ProcessingScope,
  readProcessingRun,
} from "./store.js";
import { ProcessingError } from "./store.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { presentSources, processingHistory } from "./provenance.js";

export function filterProcessingRecords<T extends ProcessingInput>(
  records: T[],
  search: unknown,
  conditions: unknown,
) {
  if (
    search !== undefined &&
    (typeof search !== "string" || search.length > 200)
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  try {
    const matched = selectRecords(
      records.map((row, ordinal) => ({ ...row, assetId: "scope", ordinal })),
      { method: "all", conditions: conditions ?? [] },
    ).selected;
    const text = String(search ?? "")
      .trim()
      .toLowerCase();
    const ids = new Set(
      matched
        .filter(
          (row) =>
            !text ||
            [
              row.question,
              row.expectedOutput,
              ...row.metadata.flatMap((entry) => [entry.key, entry.value]),
            ].some((value) => value.toLowerCase().includes(text)),
        )
        .map((row) => row.id),
    );
    return records.filter((row) => ids.has(row.id));
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError(422, "query_parameter_invalid");
  }
}

export async function processingSourceSummary(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  source: ProcessingSource,
) {
  const base = `/projects/${encodeURIComponent(scope.projectId)}`;
  if (source.kind === "assets") {
    const assets = await db.query(
      "SELECT id,file_name,collection_id FROM data_asset WHERE project_id=$1 AND id=ANY($2::text[]) AND status='stored'",
      [scope.projectId, source.assetIds],
    );
    const files = assets.rows.map((row) => ({
      name: String(row.file_name),
      href: `${base}/datasets/${encodeURIComponent(row.collection_id)}/files/${encodeURIComponent(row.id)}`,
    }));
    return {
      name: files.length === 1 ? files[0]!.name : `${files.length} 份原始数据`,
      kindLabel: "原始数据",
      files,
      href: files[0]?.href,
    };
  }
  const rows =
    source.kind === "draft"
      ? await db.query(
          "SELECT name FROM collaborative_draft WHERE project_id=$1 AND id=$2",
          [scope.projectId, source.id],
        )
      : await db.query(
          "SELECT t.id,t.name,v.version_label FROM test_set_version v JOIN test_set t ON t.id=v.test_set_id WHERE t.project_id=$1 AND v.id=$2",
          [scope.projectId, source.id],
        );
  const row = rows.rows[0];
  return {
    name: String(row?.name || "未命名测试集"),
    kindLabel:
      source.kind === "draft"
        ? "测试集草稿"
        : `正式版本 ${row?.version_label ?? "未记录"}`,
    files: [],
    href:
      source.kind === "draft"
        ? `${base}/test-sets/drafts/${encodeURIComponent(source.id)}`
        : `${base}/test-sets/${encodeURIComponent(row?.id ?? "")}?version=${encodeURIComponent(source.id)}`,
  };
}

export function processingReviewPage(
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  query: { offset?: string; limit?: string; view?: string; search?: string },
) {
  const offset = Number(query.offset ?? 0),
    limit = Number(query.limit ?? 20),
    view = query.view ?? "all";
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !["all", "changed", "issues"].includes(view) ||
    (query.search !== undefined &&
      (typeof query.search !== "string" || query.search.length > 200))
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const seen = new Set<string>();
  const rows = data.records.map((row) => {
    const added = data.rootOperation === "augment" || !row.original;
    const changedFields = added
      ? ["new"]
      : (["question", "expectedOutput", "metadata"] as const).filter(
          (field) =>
            JSON.stringify(row.original![field]) !==
            JSON.stringify(row.result[field]),
        );
    const issues = data.issues.filter(
      (issue) =>
        !["empty_question", "duplicate_content", "missing_output"].includes(
          issue.code,
        ) &&
        "sourceId" in issue &&
        issue.sourceId === row.result.sourceId,
    );
    if (!row.result.question.trim()) issues.push({ code: "empty_question" });
    const content = JSON.stringify([
      row.result.question,
      row.result.expectedOutput,
      row.result.metadata,
    ]);
    if (seen.has(content)) issues.push({ code: "duplicate_content" });
    seen.add(content);
    return { ...row, changedFields, issues };
  });
  const text = (query.search ?? "").trim().toLowerCase();
  const searched = rows.filter(
    (row) =>
      !text ||
      [
        row.result.question,
        row.result.expectedOutput,
        ...row.result.metadata.flatMap((entry) => [entry.key, entry.value]),
        ...("sourceLabel" in row && typeof row.sourceLabel === "string"
          ? [row.sourceLabel]
          : []),
      ].some((value) => value.toLowerCase().includes(text)),
  );
  const matched = searched.filter(
    (row) =>
      view === "all" ||
      (view === "changed"
        ? row.changedFields.length > 0
        : row.issues.length > 0),
  );
  return {
    run: data.run,
    rootOperation: data.rootOperation,
    issues: data.issues,
    records: matched.slice(offset, offset + limit),
    allIds: matched.map((row) => row.id),
    total: matched.length,
    stats: {
      all: searched.length,
      changed: searched.filter((row) => row.changedFields.length).length,
      needsReview: searched.filter((row) => row.issues.length).length,
    },
    offset,
    limit,
  };
}

export async function presentProcessingReview(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  query: { offset?: string; limit?: string; view?: string; search?: string },
) {
  if (
    query.search !== undefined &&
    (typeof query.search !== "string" || query.search.length > 200)
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  // Only a source-name search needs the full bounded provenance projection.
  // Ordinary browsing still resolves provenance for the current page only.
  const searchable = query.search?.trim()
    ? await presentSources(
        db,
        artifacts,
        scope,
        data.records.map(
          (row) => row.original?.baseline?.source ?? row.original?.source,
        ),
      )
    : null;
  const page = processingReviewPage(
    searchable
      ? {
          ...data,
          records: data.records.map((row, index) => ({
            ...row,
            sourceLabel: searchable[index]!.label,
          })),
        }
      : data,
    query,
  );
  const sourceById = searchable
    ? new Map(data.records.map((row, index) => [row.id, searchable[index]!]))
    : null;
  const origins = sourceById
    ? page.records.map((row) => sourceById.get(row.id)!)
    : await presentSources(
        db,
        artifacts,
        scope,
        page.records.map(
          (row) => row.original?.baseline?.source ?? row.original?.source,
        ),
      );
  const sourceSummary = await processingSourceSummary(
    db,
    scope,
    data.run.source,
  );
  const actor = await db.query(
    "SELECT coalesce(display_name,username) AS name FROM app_user WHERE id=(SELECT actor_id FROM processing_run WHERE id=$1 AND project_id=$2)",
    [data.run.id, scope.projectId],
  );
  const receipts = await db.query(
    `SELECT DISTINCT ON(pa.receipt->>'acceptanceId') pa.receipt,da.collection_id FROM processing_acceptance pa
    JOIN data_asset da ON da.id=pa.receipt->>'assetId' AND da.project_id=$2 AND da.status='stored'
    LEFT JOIN collaborative_draft d ON d.id=pa.draft_id AND d.project_id=$2
    LEFT JOIN test_set ts ON ts.id=d.test_set_id LEFT JOIN test_set_version v ON v.id=d.parent_version_id
    WHERE pa.run_id=$1 AND (pa.draft_id IS NULL OR (d.id IS NOT NULL AND (d.status IN('editing','published') AND (ts.id IS NULL OR ts.status='available') AND (v.id IS NULL OR v.status='published'))))
    AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$2 AND dl.object_id IN(da.id,d.id,ts.id,v.id)) ORDER BY pa.receipt->>'acceptanceId',pa.created_at`,
    [data.run.id, scope.projectId],
  );
  const histories = await processingHistory(
    db,
    artifacts,
    scope,
    page.records.flatMap((row) =>
      row.original ? [{ runId: data.run.id, inputId: row.original.id }] : [],
    ),
  );
  return {
    ...page,
    run: {
      ...page.run,
      sourceSummary,
      actorName: actor.rows[0]?.name ?? "未记录",
    },
    records: page.records.map((row, index) => {
      const origin = origins[index]!;
      const history = row.original
        ? (histories.get(`${data.run.id}\0${row.original.id}`) ?? [])
        : [];
      const generated = data.rootOperation === "augment";
      const badge = { clean: "已清洗", rewrite: "已改写", augment: "模型扩写" }[
        data.run.options.operation
      ];
      const sourcePresentation = {
        ...origin,
        label:
          generated && !origin.generated
            ? `模型扩写 · 参考 ${origin.fileName ?? origin.label}`
            : origin.label,
        generated: generated || origin.generated,
        badges: [
          ...new Set([
            ...origin.badges,
            ...history.filter((step) => step.href).map((step) => step.label),
          ]),
        ],
        steps: [
          ...origin.steps,
          ...(history.length ? history : [{ label: badge }]),
        ],
      };
      return {
        ...row,
        sourcePresentation,
        sourceLabel: sourcePresentation.label,
      };
    }),
    receipts: receipts.rows.map((row) => ({
      acceptanceId: row.receipt.acceptanceId,
      assetId: row.receipt.assetId,
      draftId: row.receipt.draftId,
      fileName: row.receipt.fileName,
      adopted: row.receipt.adopted,
      collectionId: row.collection_id,
    })),
  };
}
