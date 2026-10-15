import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { isPlainObject } from "../server/support.js";
import { hasProjectCapability } from "../security/project-access.js";
import {
  processingSourceAvailable,
  ProcessingError,
  getProcessingRun,
  type ProcessingScope,
  type InputSnapshot,
} from "./store.js";

export type ReferenceGroup = {
  fileName: string;
  href: string;
  recordCount: number | null;
  positions: { label: string; href?: string }[];
};
function referenceGroups(
  steps: SourcePresentation["steps"],
  inherited: ReferenceGroup[] = [],
): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>();
  for (const step of steps) {
    if (!step.href) continue;
    const group = groups.get(step.href) ?? {
      fileName: step.label.split(" · 第")[0]!,
      href: step.href,
      recordCount: 0,
      positions: [],
    };
    if (!group.positions.some((other) => other.label === step.label))
      group.positions.push(step);
    groups.set(step.href, group);
  }
  for (const group of groups.values())
    group.recordCount = group.positions.length;
  for (const previous of inherited) {
    const current = groups.get(previous.href);
    // Nested task scopes can overlap; their union is not a proven per-record count.
    groups.set(previous.href, {
      ...previous,
      recordCount: null,
      positions: current?.positions ?? previous.positions,
    });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    positions: group.positions.slice(0, 10),
  }));
}
export type SourcePresentation = {
  referenceGroups?: ReferenceGroup[];
  label: string;
  badges: string[];
  steps: {
    label: string;
    href?: string;
    kind?: "reference" | "processing" | "saved";
    occurredAt?: string;
  }[];
  generated?: boolean;
  fileName?: string;
};
const operationLabels: Record<string, string> = {
  clean: "已清洗",
  rewrite: "已改写",
  augment: "模型扩写",
  generate: "依据背景文档生成",
};
const sourceKey = (value: unknown) =>
  isPlainObject(value) &&
  typeof value.assetId === "string" &&
  Number.isSafeInteger(value.ordinal)
    ? `${value.assetId}:${value.ordinal}`
    : null;

/** Generated rows reference the frozen augmentation input, not just the model's first sourceId. */
export async function processingReferences(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runId: string,
): Promise<SourcePresentation | null> {
  const seen = new Set<string>();
  for (let depth = 0; runId && depth < 32 && !seen.has(runId); depth++) {
    seen.add(runId);
    const run = await getProcessingRun(db, scope, runId);
    const input = JSON.parse(
      (await artifacts.readBytes(run.input_ref!, 100000000)).toString("utf8"),
    ) as InputSnapshot;
    if (run.options.operation === "generate")
      return {
        label: "依据背景文档生成",
        badges: [],
        generated: true,
        steps: (input.background?.documents ?? []).flatMap((document) =>
          document.fragments.map((fragment) => ({
            label: `${document.fileName} · ${fragment.page ? `第 ${fragment.page} 页` : `第 ${fragment.startLine ?? fragment.index}–${fragment.endLine ?? fragment.index} 行`}`,
            href: `/projects/${encodeURIComponent(scope.projectId)}/assistant/${encodeURIComponent(run.source.kind === "background" ? run.source.id : "")}`,
            kind: "reference" as const,
          })),
        ),
      };
    if (run.options.operation === "augment") {
      const sources = new Map<string, unknown>();
      let missing = false;
      for (const record of input.records) {
        const source = record.baseline?.source ?? record.source;
        if (!sourceKey(source) || !isPlainObject(source)) {
          missing = true;
          continue;
        }
        sources.set(sourceKey(source)!, source);
      }
      const presentations = await presentSources(db, artifacts, scope, [
        ...sources.values(),
      ]);
      const steps = presentations.flatMap((origin) =>
        origin.steps.filter((step) => step.kind === "reference"),
      );
      const unique = [
        ...new Map(
          steps.map((step) => [`${step.href}\0${step.label}`, step]),
        ).values(),
      ];
      const files = new Set(
        unique.flatMap((step) => (step.href ? [step.href] : [])),
      );
      missing ||= presentations.some(
        (origin) =>
          !origin.steps.some((step) => step.kind === "reference" && step.href),
      );
      const shown = new Map<string, number>();
      const visible = unique.filter((step) => {
        const count = shown.get(step.href ?? "") ?? 0;
        shown.set(step.href ?? "", count + 1);
        return count < 10;
      });
      return {
        label:
          files.size > 1
            ? `模型扩写 · 参考 ${files.size} 份原始数据`
            : `模型扩写 · 参考 ${presentations[0]?.fileName ?? "来源未记录"}`,
        badges: [],
        referenceGroups: referenceGroups(
          unique,
          presentations.flatMap((origin) => origin.referenceGroups ?? []),
        ),
        generated: true,
        steps: [
          ...visible,
          ...(missing || !files.size
            ? [{ label: "部分来源未记录", kind: "reference" as const }]
            : []),
        ],
      };
    }
    runId =
      input.refinement?.parentRunId ??
      (input.continuation?.kind === "continue"
        ? input.continuation.parentRunId
        : input.continuation?.inputParentRunId) ??
      "";
  }
  return null;
}

/** Follow only each row's proven refinement identity; retained rows skip unselected steps. */
export async function processingHistory(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  requests: { runId: string; inputId: string }[],
) {
  type Run = { input: InputSnapshot; operation: string; createdAt: string };
  const runs = new Map<string, Run | null>(),
    batches = new Map<string, { sourceIds: string[]; indices: number[] }>();
  const key = (row: { runId: string; inputId: string }) =>
    `${row.runId}\0${row.inputId}`;
  const histories = new Map<string, SourcePresentation["steps"]>(
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
        "SELECT id,source,options,input_ref,created_at FROM processing_run WHERE project_id=$1 AND id=ANY($2::text[]) AND (cardinality(background_document_ids)=0 OR actor_id=$3)",
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
              createdAt: row.created_at,
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
        history.unshift({ label: "部分处理过程未记录", kind: "processing" });
        continue;
      }
      row.visited.add(row.runId);
      const refinement = run.input.refinement;
      if (!refinement || refinement.selectedIds.includes(row.inputId))
        history.unshift({
          label: operationLabels[run.operation] ?? "已处理",
          href: `/projects/${encodeURIComponent(scope.projectId)}/processing?run=${encodeURIComponent(row.runId)}`,
          kind: "processing",
          occurredAt: run.createdAt,
        });
      const parentId =
        refinement?.parentRunId ??
        (run.input.continuation?.kind === "continue"
          ? run.input.continuation.parentRunId
          : run.input.continuation?.inputParentRunId);
      if (parentId && row.inputId.startsWith("candidate:"))
        parents.push({
          current: row,
          runId: parentId,
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
        histories
          .get(current.origin)!
          .unshift({ label: "部分处理过程未记录", kind: "processing" });
        return [];
      }
      return [{ ...current, runId, inputId }];
    });
  }
  pending.forEach((row) =>
    histories
      .get(row.origin)!
      .unshift({ label: "部分处理过程未记录", kind: "processing" }),
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
    references?: string[];
    savedTarget?: { label: string; href: string };
    documentOrigin?: SourcePresentation | null;
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
  const inputRecords = new Map<
    string,
    Map<string, InputSnapshot["records"][number]>
  >();
  const runReferenceKeys = new Map<string, string[]>();
  const documentOrigins = new Map<string, SourcePresentation | null>();
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
      if (run && !inputRecords.has(runId))
        inputRecords.set(
          runId,
          new Map(run.input.records.map((record) => [record.id, record])),
        );
      const original = inputRecords.get(runId)?.get(row.locator?.inputId);
      const parent = original
        ? sourceKey(original.baseline?.source ?? original.source)
        : undefined;
      if (
        ["augment", "generate"].includes(run?.operation ?? "") &&
        run &&
        !runReferenceKeys.has(runId)
      ) {
        const referenceKeys = new Set<string>();
        for (const record of run.input.records) {
          const source = record.baseline?.source ?? record.source;
          const referenceKey = sourceKey(source);
          if (!referenceKey || !isPlainObject(source)) continue;
          referenceKeys.add(referenceKey);
          if (!nodes.has(referenceKey)) pending.set(referenceKey, source);
        }
        runReferenceKeys.set(runId, [...referenceKeys]);
      }
      if (
        run &&
        (run.input.continuation?.rootOperation ??
          run.input.refinement?.rootOperation ??
          run.operation) === "generate" &&
        !documentOrigins.has(runId)
      )
        documentOrigins.set(
          runId,
          await processingReferences(db, artifacts, scope, runId),
        );
      nodes.set(key, {
        name: row.file_name,
        href: `${base}/datasets/${encodeURIComponent(row.collection_id)}/files/${encodeURIComponent(row.id)}`,
        processed: Boolean(row.processing_run_id || runId),
        ...(run
          ? {
              documentOrigin: documentOrigins.get(runId),
              operation: run.operation,
              runId,
              inputId: original?.id,
              generated:
                (run.input.continuation?.rootOperation ??
                  run.input.refinement?.rootOperation ??
                  run.operation) === "augment",
              runHref: `${base}/processing?run=${encodeURIComponent(runId)}`,
              parent,
              references: runReferenceKeys.get(runId),
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
  if (await hasProjectCapability(db, scope.projectId, scope.actorId, "write")) {
    const targets = await db.query(
      `SELECT DISTINCT ON(pa.asset_id) pa.asset_id,d.id,d.name FROM processing_acceptance pa JOIN collaborative_draft d ON d.id=pa.draft_id AND d.project_id=$1 LEFT JOIN test_set ts ON ts.id=d.test_set_id LEFT JOIN test_set_version v ON v.id=d.parent_version_id WHERE pa.project_id=$1 AND pa.asset_id=ANY($2::text[]) AND d.status IN('editing','published') AND (ts.id IS NULL OR ts.status='available') AND (v.id IS NULL OR v.status='published') AND NOT EXISTS(SELECT 1 FROM deletion_lock dl WHERE dl.project_id=$1 AND dl.object_id IN(d.id,ts.id,v.id)) ORDER BY pa.asset_id,pa.created_at DESC`,
      [
        scope.projectId,
        [
          ...new Set(
            [...nodes.keys()].map((key) => key.slice(0, key.lastIndexOf(":"))),
          ),
        ],
      ],
    );
    for (const row of targets.rows)
      for (const [key, node] of nodes)
        if (key.startsWith(`${row.asset_id}:`))
          node.savedTarget = {
            label: `草稿：${row.name || "未命名测试集"}`,
            href: `${base}/test-sets/drafts/${encodeURIComponent(row.id)}`,
          };
  }
  const rendered = new Map<string, SourcePresentation>();
  const runReferences = new Map<
    string,
    {
      groups: ReferenceGroup[];
      fileCount: number;
      fileName?: string;
      steps: SourcePresentation["steps"];
      omitted: boolean;
      missing: boolean;
    }
  >();
  function render(
    key: string | null,
    seen = new Set<string>(),
  ): SourcePresentation {
    if (!key) return { label: "手工新增", badges: [], steps: [] };
    const node = nodes.get(key);
    if (!node || seen.has(key))
      return { label: "原始来源不可访问", badges: [], steps: [] };
    const cached = rendered.get(key);
    if (cached) return cached;
    seen.add(key);
    const direct = {
      label: `${node.name} · 第 ${key.slice(key.lastIndexOf(":") + 1)} 条`,
      href: node.href,
      kind: "reference" as const,
    };
    if (!node.processed)
      return {
        label: direct.label,
        fileName: node.name,
        badges: [],
        steps: [direct],
      };
    if (node.documentOrigin)
      return {
        ...node.documentOrigin,
        steps: [
          ...node.documentOrigin.steps,
          {
            label: operationLabels[node.operation ?? ""] ?? "已处理",
            href: node.runHref,
            kind: "processing",
          },
          { label: node.name, href: node.href, kind: "saved" },
          ...(node.savedTarget
            ? [{ ...node.savedTarget, kind: "saved" as const }]
            : []),
        ],
      };
    if (!node.operation || node.parent === undefined)
      return {
        label: "已处理 · 原始来源未记录",
        badges: [],
        steps: [{ label: node.name, href: node.href, kind: "saved" }],
      };
    const parent = render(node.parent, new Set(seen)),
      generated = Boolean(node.generated || parent.generated);
    let reference = runReferences.get(node.runId!);
    if (!reference) {
      const references = (node.references ?? []).map((reference) =>
        render(reference, new Set(seen)),
      );
      // Resolve all identities once per run, then retain only compact display
      // positions. Shared frozen input is not copied/expanded for every row.
      const referenceSteps = [
        ...new Map(
          references.flatMap((reference) =>
            reference.steps
              .filter((step) => step.kind === "reference")
              .map((step) => [`${step.href}\0${step.label}`, step] as const),
          ),
        ).values(),
      ];
      const files = new Set(
        referenceSteps.flatMap((step) => (step.href ? [step.href] : [])),
      );
      const shown = new Map<string, number>();
      const visible = referenceSteps.filter((step) => {
        const count = shown.get(step.href ?? "") ?? 0;
        shown.set(step.href ?? "", count + 1);
        return count < 10;
      });
      reference = {
        groups: referenceGroups(
          referenceSteps,
          references.flatMap((origin) => origin.referenceGroups ?? []),
        ),
        fileCount: files.size,
        fileName: references.find((reference) => reference.fileName)?.fileName,
        steps: visible,
        omitted: referenceSteps.length > visible.length,
        missing: references.some(
          (reference) =>
            !reference.steps.some(
              (step) => step.kind === "reference" && step.href,
            ),
        ),
      };
      runReferences.set(node.runId!, reference);
    }
    const label =
      reference.fileCount > 1
        ? `模型扩写 · 参考 ${reference.fileCount} 份原始数据`
        : node.generated && !parent.generated
          ? `模型扩写 · 参考 ${parent.fileName ?? reference.fileName ?? "来源未记录"}`
          : parent.label;
    const steps = node.runId
      ? (histories.get(`${node.runId}\0${node.inputId}`) ?? [])
      : [];
    const badge = operationLabels[node.operation] ?? "已处理";
    const processingSteps = steps.length ? steps : [{ label: badge }];
    const presentation: SourcePresentation = {
      label,
      ...(parent.fileName ? { fileName: parent.fileName } : {}),
      generated,
      referenceGroups: generated
        ? reference.groups.length
          ? reference.groups
          : parent.referenceGroups
        : undefined,
      badges: [
        ...parent.badges,
        ...processingSteps
          .filter((step) => step.href)
          .map((step) => step.label),
      ].filter((value, index, all) => all.indexOf(value) === index),
      steps: [
        ...parent.steps.filter(
          (step) => !reference.fileCount || step.kind !== "reference",
        ),
        ...reference.steps,
        ...(reference.omitted
          ? [{ label: "更多参考位置已省略", kind: "reference" as const }]
          : []),
        ...(reference.missing
          ? [{ label: "部分来源未记录", kind: "reference" as const }]
          : []),
        ...processingSteps,
        { label: node.name, href: node.href, kind: "saved" as const },
        ...(node.savedTarget
          ? [{ ...node.savedTarget, kind: "saved" as const }]
          : []),
      ].filter(
        (step, index, all) =>
          !step.href ||
          (step.kind === "saved"
            ? all.findLastIndex(
                (other) =>
                  other.href === step.href && other.label === step.label,
              )
            : all.findIndex(
                (other) =>
                  other.href === step.href && other.label === step.label,
              )) === index,
      ),
    };
    rendered.set(key, presentation);
    return presentation;
  }
  return sources.map((source) =>
    source != null && !sourceKey(source)
      ? { label: "原始来源未记录", badges: [], steps: [] }
      : render(sourceKey(source)),
  );
}
