import { deduplicate } from "./deduplication.js";
import type { Database } from "../db/pool.js";
import type { QueryResultRow } from "pg";
import { selectRecords } from "../selection/index.js";
import type { ProcessingInput } from "./protocol.js";
import type {
  ProcessingSource,
  ProcessingScope,
  readProcessingRun,
} from "./store.js";
import { ProcessingError } from "./store.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  presentSources,
  processingHistory,
  processingReferences,
} from "./provenance.js";
import { adoptedCandidateKeys, candidateKey } from "./adoption.js";

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
  sourceRows?: QueryResultRow[],
) {
  const base = `/projects/${encodeURIComponent(scope.projectId)}`;
  if (source.kind === "assets") {
    const assets =
      sourceRows ??
      (
        await db.query(
          "SELECT id,file_name,collection_id FROM data_asset WHERE project_id=$1 AND id=ANY($2::text[]) AND status='stored'",
          [scope.projectId, source.assetIds],
        )
      ).rows;
    const files = assets.map((row) => ({
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
    sourceRows ??
    (source.kind === "draft"
      ? await db.query(
          "SELECT name FROM collaborative_draft WHERE project_id=$1 AND id=$2",
          [scope.projectId, source.id],
        )
      : await db.query(
          "SELECT t.id AS test_set_id,t.name,v.version_label FROM test_set_version v JOIN test_set t ON t.id=v.test_set_id WHERE t.project_id=$1 AND v.id=$2",
          [scope.projectId, source.id],
        )
    ).rows;
  const row = rows[0];
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
        : `${base}/test-sets/${encodeURIComponent(row?.test_set_id ?? "")}?version=${encodeURIComponent(source.id)}`,
  };
}

export function processingReviewPage(
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  query: { offset?: string; limit?: string; view?: string; search?: string },
  runData?: ReadonlyMap<string, Pick<typeof data, "issues" | "rootOperation">>,
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
    !["all", "changed", "issues", "duplicates"].includes(view) ||
    (query.search !== undefined &&
      (typeof query.search !== "string" || query.search.length > 200))
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const duplicate = deduplicate(
    data.records.map((row) => ({ id: row.id, ...row.result })),
  );
  const duplicateIds = new Set(duplicate.duplicateIds),
    questionCollisionIds = new Set(duplicate.questionCollisionIds),
    keptIds = new Set(duplicate.keptIds);
  const usableCount = data.records.filter(
    (row) => keptIds.has(row.id) && row.result.question.trim(),
  ).length;
  const rows = data.records.map((row) => {
    const ref = (row as typeof row & { resultRef?: { runId: string } })
      .resultRef;
    const actual = (ref && runData?.get(ref.runId)) || data;
    const added =
      (row.original?.adoptionOperation ?? actual.rootOperation) === "augment" ||
      !row.original;
    const changedFields = added
      ? ["new"]
      : (["question", "expectedOutput", "metadata"] as const).filter(
          (field) =>
            JSON.stringify(row.original![field]) !==
            JSON.stringify(row.result[field]),
        );
    const issues = actual.issues.filter(
      (issue) =>
        !["empty_question", "duplicate_content", "missing_output"].includes(
          issue.code,
        ) &&
        "sourceId" in issue &&
        issue.sourceId === row.result.sourceId,
    );
    if (!row.result.question.trim()) issues.push({ code: "empty_question" });
    if (duplicateIds.has(row.id)) issues.push({ code: "duplicate_content" });
    if (questionCollisionIds.has(row.id))
      issues.push({ code: "question_collision" });
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
        : view === "duplicates"
          ? duplicateIds.has(row.id)
          : row.issues.length > 0),
  );
  return {
    run: data.run,
    rootOperation: data.rootOperation,
    adoptionFields: data.adoptionFields,
    issues: data.issues,
    records: matched.slice(offset, offset + limit),
    allIds: matched.map((row) => row.id),
    total: matched.length,
    duplicateCount: duplicate.duplicateIds.length,
    usableCount: data.usableCount ?? usableCount,
    stats: {
      duplicates: searched.filter((row) => duplicateIds.has(row.id)).length,
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
  taskRuns: Awaited<ReturnType<typeof readProcessingRun>>[] = [data],
) {
  const runData = new Map(taskRuns.map((item) => [item.run.id, item]));
  const actualRef = (row: (typeof data.records)[number]) =>
    (row as typeof row & { resultRef?: { runId: string; resultId: string } })
      .resultRef ?? { runId: data.run.id, resultId: row.id };
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
    runData,
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
      row.original
        ? [{ runId: actualRef(row).runId, inputId: row.original.id }]
        : [],
    ),
  );
  const adopted = await adoptedCandidateKeys(
    db,
    artifacts,
    scope,
    taskRuns,
    undefined,
    true,
  );
  const referenceByRun = new Map(
    await Promise.all(
      [...new Set(page.records.map((row) => actualRef(row).runId))].map(
        async (id) =>
          [
            id,
            runData.get(id)?.rootOperation === "augment"
              ? await processingReferences(db, artifacts, scope, id)
              : null,
          ] as const,
      ),
    ),
  );
  return {
    ...page,
    adoptedIds: data.records
      .filter((row) => adopted.has(candidateKey(actualRef(row))))
      .map((row) => row.id),
    run: {
      ...page.run,
      sourceSummary,
      actorName: actor.rows[0]?.name ?? "未记录",
    },
    records: page.records.map((row, index) => {
      const origin = origins[index]!;
      const ref = actualRef(row),
        actual = runData.get(ref.runId) ?? data,
        references = referenceByRun.get(ref.runId);
      const history = row.original
        ? (histories.get(`${ref.runId}\0${row.original.id}`) ?? [])
        : [];
      const generated =
        (row.original?.adoptionOperation ?? actual.rootOperation) === "augment";
      const badge = { clean: "已清洗", rewrite: "已改写", augment: "模型扩写" }[
        actual.run.options.operation
      ];
      const sourcePresentation = {
        ...origin,
        label:
          references?.label ??
          (generated && !origin.generated
            ? `模型扩写 · 参考 ${origin.fileName ?? origin.label}`
            : origin.label),
        generated: generated || origin.generated,
        referenceGroups: references?.referenceGroups ?? origin.referenceGroups,
        badges: [
          ...new Set([
            ...origin.badges,
            ...history.filter((step) => step.href).map((step) => step.label),
          ]),
        ],
        steps: [
          ...origin.steps.filter(
            (step) => !references || step.kind !== "reference",
          ),
          ...(references?.steps ?? []),
          ...(history.length ? history : [{ label: badge }]),
        ].filter(
          (step, index, all) =>
            !step.href ||
            all.findIndex(
              (other) => other.href === step.href && other.label === step.label,
            ) === index,
        ),
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
