import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { isPlainObject } from "../server/support.js";
import {
  processingSourceAvailable,
  ProcessingError,
  type ProcessingScope,
  type InputSnapshot,
} from "./store.js";

export type SourcePresentation = {
  label: string;
  badges: string[];
  steps: { label: string; href?: string }[];
  generated?: boolean;
  fileName?: string;
};
const operationLabels: Record<string, string> = {
  clean: "已清洗",
  rewrite: "已改写",
  augment: "模型扩写",
};
const sourceKey = (value: unknown) =>
  isPlainObject(value) &&
  typeof value.assetId === "string" &&
  Number.isSafeInteger(value.ordinal)
    ? `${value.assetId}:${value.ordinal}`
    : null;

/** Follow only each row's proven refinement identity; retained rows skip unselected steps. */
export async function processingHistory(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  requests: { runId: string; inputId: string }[],
) {
  type Run = { input: InputSnapshot; operation: string };
  const runs = new Map<string, Run | null>(),
    batches = new Map<string, { sourceIds: string[]; indices: number[] }>();
  const key = (row: { runId: string; inputId: string }) =>
    `${row.runId}\0${row.inputId}`;
  const histories = new Map<string, { label: string; href?: string }[]>(
    requests.map((row) => [key(row), []]),
  );
  let pending = [
    ...new Map(requests.map((row) => [key(row), row])).values(),
  ].map((row) => ({ ...row, origin: key(row), visited: new Set<string>() }));
  for (let depth = 0; pending.length && depth < 32; depth++) {
    const ids = [...new Set(pending.map((row) => row.runId))].filter(
      (id) => !runs.has(id),
    );
    if (ids.length) {
      const rows = await db.query(
        "SELECT id,source,options,input_ref FROM processing_run WHERE project_id=$1 AND id=ANY($2::text[]) AND (cardinality(background_document_ids)=0 OR actor_id=$3)",
        [scope.projectId, ids, scope.actorId],
      );
      ids.forEach((id) => runs.set(id, null));
      for (const row of rows.rows) {
        try {
          await processingSourceAvailable(db, scope.projectId, row.source);
          if (row.input_ref)
            runs.set(row.id, {
              input: JSON.parse(
                (await artifacts.readBytes(row.input_ref, 100000000)).toString(
                  "utf8",
                ),
              ),
              operation: row.options.operation,
            });
        } catch (error) {
          if (!(error instanceof ProcessingError)) throw error;
        }
      }
    }
    const parents: {
      current: (typeof pending)[number];
      runId: string;
      resultId: string;
    }[] = [];
    for (const row of pending) {
      const history = histories.get(row.origin)!;
      const run = runs.get(row.runId),
        input = run?.input.records.find((record) => record.id === row.inputId);
      if (!run || !input || row.visited.has(row.runId)) {
        history.unshift({ label: "部分处理过程未记录" });
        continue;
      }
      row.visited.add(row.runId);
      const refinement = run.input.refinement;
      if (!refinement || refinement.selectedIds.includes(row.inputId))
        history.unshift({
          label: operationLabels[run.operation] ?? "已处理",
          href: `/projects/${encodeURIComponent(scope.projectId)}/processing?run=${encodeURIComponent(row.runId)}`,
        });
      if (refinement && row.inputId.startsWith("candidate:"))
        parents.push({
          current: row,
          runId: refinement.parentRunId,
          resultId: row.inputId.slice(10),
        });
    }
    // Public result IDs carry batch + saved result index; read the real sourceId, never infer it.
    const wanted = [
      ...new Map(
        parents.map((row) => [
          `${row.runId}:${row.resultId.split(":")[0]}`,
          { runId: row.runId, ordinal: Number(row.resultId.split(":")[0]) },
        ]),
      ).entries(),
    ].filter(([id]) => !batches.has(id));
    if (wanted.length) {
      const found = await db.query(
        `WITH wanted AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x("runId" text,ordinal integer)) SELECT b.run_id,b.ordinal,b.result_ref,b.result_indices FROM wanted w JOIN processing_run r ON r.id=w."runId" AND r.project_id=$1 AND (cardinality(r.background_document_ids)=0 OR r.actor_id=$3) JOIN processing_batch b ON b.run_id=r.id AND b.ordinal=w.ordinal`,
        [
          scope.projectId,
          JSON.stringify(wanted.map(([, row]) => row)),
          scope.actorId,
        ],
      );
      for (const batch of found.rows)
        if (batch.result_ref) {
          const body = JSON.parse(
            (await artifacts.readBytes(batch.result_ref, 100000000)).toString(
              "utf8",
            ),
          );
          batches.set(`${batch.run_id}:${batch.ordinal}`, {
            sourceIds: body.records.map(
              (row: { sourceId: string }) => row.sourceId,
            ),
            indices: batch.result_indices ?? [],
          });
        }
    }
    pending = parents.flatMap(({ current, runId, resultId }) => {
      const [ordinal, index] = resultId.split(":").map(Number),
        batch = batches.get(`${runId}:${ordinal}`);
      const position = batch?.indices.length
        ? batch.indices.indexOf(index!)
        : index!;
      const inputId = batch?.sourceIds[position];
      if (!inputId) {
        histories.get(current.origin)!.unshift({ label: "部分处理过程未记录" });
        return [];
      }
      return [{ ...current, runId, inputId }];
    });
  }
  pending.forEach((row) =>
    histories.get(row.origin)!.unshift({ label: "部分处理过程未记录" }),
  );
  return histories;
}

/** Request-local, page-batched reads. Display facts never replace direct source identities. */
export async function presentSources(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  sources: unknown[],
) {
  type Node = {
    name: string;
    href: string;
    processed: boolean;
    operation?: string;
    runHref?: string;
    runId?: string;
    inputId?: string;
    parent?: string | null;
    generated?: boolean;
  };
  const nodes = new Map<string, Node>(),
    pending = new Map<string, unknown>();
  sources.forEach((source) => {
    const key = sourceKey(source);
    if (key) pending.set(key, source);
  });
  const runs = new Map<
    string,
    { input: InputSnapshot; operation: string } | null
  >();
  const base = `/projects/${encodeURIComponent(scope.projectId)}`;
  for (let depth = 0; pending.size && depth < 32; depth++) {
    const batch = [...pending];
    pending.clear();
    const rows = await db.query(
      `WITH wanted AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x("assetId" text,ordinal integer))
       SELECT da.id,da.file_name,da.collection_id,da.processing_run_id,sr.ordinal,sr.locator
       FROM wanted w JOIN data_asset da ON da.id=w."assetId" AND da.project_id=$1 AND da.status='stored'
       JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.ordinal=w.ordinal
       WHERE NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id=da.id)`,
      [scope.projectId, JSON.stringify(batch.map(([, source]) => source))],
    );
    const runIds = [
      ...new Set(
        rows.rows.flatMap((row) =>
          typeof row.locator?.processingRunId === "string"
            ? [row.locator.processingRunId]
            : [],
        ),
      ),
    ].filter((id) => !runs.has(id));
    if (runIds.length) {
      const found = await db.query(
        "SELECT id,source,options,input_ref,background_document_ids FROM processing_run WHERE project_id=$1 AND id=ANY($2::text[]) AND (cardinality(background_document_ids)=0 OR actor_id=$3)",
        [scope.projectId, runIds, scope.actorId],
      );
      runIds.forEach((id) => runs.set(id, null));
      for (const run of found.rows) {
        try {
          await processingSourceAvailable(db, scope.projectId, run.source);
          if (run.input_ref)
            runs.set(run.id, {
              input: JSON.parse(
                (await artifacts.readBytes(run.input_ref, 100000000)).toString(
                  "utf8",
                ),
              ) as InputSnapshot,
              operation: run.options.operation,
            });
        } catch (error) {
          if (!(error instanceof ProcessingError)) throw error;
        }
      }
    }
    for (const row of rows.rows) {
      const key = `${row.id}:${row.ordinal}`,
        runId = row.locator?.processingRunId,
        run = runs.get(runId);
      const original = run?.input.records.find(
        (record) => record.id === row.locator?.inputId,
      );
      const parent = original
        ? sourceKey(original.baseline?.source ?? original.source)
        : undefined;
      nodes.set(key, {
        name: row.file_name,
        href: `${base}/datasets/${encodeURIComponent(row.collection_id)}/files/${encodeURIComponent(row.id)}`,
        processed: Boolean(row.processing_run_id || runId),
        ...(run
          ? {
              operation: run.operation,
              runId,
              inputId: original?.id,
              generated:
                (run.input.refinement?.rootOperation ?? run.operation) ===
                "augment",
              runHref: `${base}/processing?run=${encodeURIComponent(runId)}`,
              parent,
            }
          : {}),
      });
      if (parent && !nodes.has(parent))
        pending.set(parent, original!.baseline?.source ?? original!.source);
    }
  }
  const histories = await processingHistory(
    db,
    artifacts,
    scope,
    [...nodes.values()].flatMap((node) =>
      node.runId && node.inputId
        ? [{ runId: node.runId, inputId: node.inputId }]
        : [],
    ),
  );
  function render(
    key: string | null,
    seen = new Set<string>(),
  ): SourcePresentation {
    if (!key) return { label: "手工新增", badges: [], steps: [] };
    const node = nodes.get(key);
    if (!node || seen.has(key))
      return { label: "原始来源不可访问", badges: [], steps: [] };
    seen.add(key);
    const direct = {
      label: `${node.name} · 第 ${key.slice(key.lastIndexOf(":") + 1)} 条`,
      href: node.href,
    };
    if (!node.processed)
      return {
        label: direct.label,
        fileName: node.name,
        badges: [],
        steps: [direct],
      };
    if (!node.operation || node.parent === undefined)
      return {
        label: `${direct.label} · 原始来源未记录`,
        badges: [],
        steps: [direct],
      };
    const parent = render(node.parent, seen),
      generated = Boolean(node.generated || parent.generated);
    const label =
      node.generated && !parent.generated
        ? `模型扩写 · 参考 ${parent.fileName ?? parent.label}`
        : parent.label;
    const steps = node.runId
      ? (histories.get(`${node.runId}\0${node.inputId}`) ?? [])
      : [];
    const badge = operationLabels[node.operation] ?? "已处理";
    const processingSteps = steps.length ? steps : [{ label: badge }];
    return {
      label,
      ...(parent.fileName ? { fileName: parent.fileName } : {}),
      generated,
      badges: [
        ...parent.badges,
        ...processingSteps
          .filter((step) => step.href)
          .map((step) => step.label),
      ].filter((value, index, all) => all.indexOf(value) === index),
      steps: [
        ...parent.steps,
        ...processingSteps,
        { label: `当前产物：${node.name}`, href: node.href },
      ],
    };
  }
  return sources.map((source) =>
    source != null && !sourceKey(source)
      ? { label: "原始来源未记录", badges: [], steps: [] }
      : render(sourceKey(source)),
  );
}
