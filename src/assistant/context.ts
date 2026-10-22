import { deliveryGoals } from "./delivery-plan.js";
import type { Database } from "../db/pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import type { ModelMessage } from "ai";
import { hasProjectCapability } from "../security/project-access.js";
import { backgroundCatalog } from "./background.js";
import {
  AssistantError,
  taskPresentation,
  type AssistantScope,
  type Dependency,
} from "./store.js";

/** Current constraints remain complete; record identities stay in server-side state. */
export function currentTaskFacts(
  task: Record<string, any>,
  selection?: Record<string, any>,
) {
  const facts = taskPresentation(task) ?? {};
  delete facts.selectedCandidates;
  delete facts.backgroundDefinitions;
  delete facts.turnBudget;
  delete facts.executionBudget;
  delete facts.diagnostics;
  delete facts.retryOperations;
  const picked = selection ?? task.selectedCandidates;
  facts.candidateSelection = picked
    ? {
        ...(picked.scope === "task"
          ? { scope: "task", batchCount: picked.groups?.length ?? 0 }
          : { runId: picked.runId }),
        selectedCount: picked.resultIds.length,
        useAllSelected: true,
      }
    : null;
  if (facts.goal !== undefined)
    facts.originalRequest = String(facts.goal).slice(0, 1000);
  delete facts.goal;
  facts.historicalCorrections = (facts.supplements ?? [])
    .slice(-6)
    .map((text: string) => text.slice(0, 1000));
  delete facts.supplements;
  if (task.executionPlan?.contractVersion === 1)
    facts.deliveries = deliveryGoals(task.executionPlan);
  if (facts.executionPlan)
    facts.executionPlan = {
      ...facts.executionPlan,
      steps: facts.executionPlan.steps.map(
        ({ input: _input, backgroundRead: _backgroundRead, ...step }: any) => {
          if (task.executionPlan.contractVersion !== 1) return step;
          // Full delivery contracts are already present above. The model needs
          // progress and object references, not repeated headings or ledger keys.
          delete step.title;
          delete step.revision;
          delete step.countKind;
          if (step.receipt) {
            step.receipt = { ...step.receipt };
            delete step.receipt.key;
          }
          return step;
        },
      ),
    };
  facts.classifications = (facts.classifications ?? []).map((rule: any) =>
    rule.definitions
      ? {
          ...rule,
          definitions: rule.definitions?.map((definition: any) => {
            const ref = task.backgroundDefinitions?.find(
              (entry: any) =>
                entry.field === rule.field &&
                entry.key === rule.key &&
                entry.value === definition.value,
            );
            return ref
              ? { value: definition.value, reference: ref.reference }
              : definition;
          }),
        }
      : rule,
  );
  // Result prose is rereadable evidence, not an active requirement. Keep counts
  // and identity without copying every narrative answer into each turn.
  if (Array.isArray(facts.review?.labels)) {
    const { labels, ...review } = facts.review;
    facts.review = {
      ...review,
      labelKinds:
        review.labelKinds ?? labels.length + (review.additionalLabels ?? 0),
      labelsHash: sha256(canonicalJson(labels)),
      ...(review.runId
        ? {
            readAgain: {
              tool: "read_processing",
              input: { runId: review.runId },
            },
          }
        : {}),
    };
  }
  if (Buffer.byteLength(JSON.stringify(facts)) > 30000)
    throw new AssistantError(
      422,
      "assistant_context_capacity",
      "当前生效要求超出上下文容量，要求已保留。请减少本任务同时处理的规则，不能静默略去约束。",
    );
  return facts;
}

/** Summaries are navigation aids; authoritative bodies and parameters are re-read. */
export function toolResultSummary(
  name: string,
  input: Record<string, any>,
  value: any,
) {
  const readInput: Record<string, any> = {};
  for (const field of [
    "source",
    "runId",
    "documentId",
    "kind",
    "search",
    "testSetId",
    "offset",
    "from",
    "query",
    "limit",
    "aggregate",
    "conditions",
    "groupBy",
    "selection",
  ])
    if (input[field] !== undefined) readInput[field] = input[field];
  if (readInput.source) {
    readInput.source = { ...readInput.source };
    delete readInput.source.recordIds;
  }
  const summary: Record<string, any> = {
    historySummary: true,
    contentTruncated: true,
  };
  for (const field of [
    "total",
    "matchingTotal",
    "readCount",
    "offset",
    "source",
    "partial",
    "missingCount",
    "checkedStatus",
    "nextOffset",
    "nextFrom",
    "fragmentCount",
    "matchCount",
    "status",
    "runId",
    "draftId",
    "previewId",
    "url",
    "selectedCount",
    "refinedCount",
    "added",
    "fileName",
    "sha256",
    "extractorVersion",
  ])
    if (value?.[field] !== undefined) summary[field] = value[field];
  if (summary.source) {
    summary.source = { ...summary.source };
    delete summary.source.recordIds;
  }
  if (name.startsWith("read_") || name === "query_project")
    summary.readAgain = { tool: name, input: readInput };
  if (name === "read_background") {
    readInput.useForProcessing = false;
    // Keep usable definitions, not just an envelope that says they once existed.
    const definitions: Record<string, string>[] = [];
    for (const definition of value?.definitions ?? []) {
      const entry = Object.fromEntries(
        ["value", "text", "reference", "code", "name"]
          .filter((key) => typeof definition[key] === "string")
          .map((key) => [key, definition[key]]),
      );
      if (Buffer.byteLength(JSON.stringify([...definitions, entry])) > 2200)
        break;
      definitions.push(entry);
    }
    summary.definitions = definitions;
    summary.definitionsTruncated =
      Boolean(value?.definitionsTruncated) ||
      definitions.length < (value?.definitions?.length ?? 0);
  }
  if (value?.error)
    summary.error = {
      code: value.error.code,
      hint: String(value.error.hint ?? "").slice(0, 320),
    };
  if (value?.records)
    summary.preview = value.records.slice(0, 2).map((row: any) => ({
      id: row.id,
      question: String(row.question ?? row.result?.question ?? "").slice(
        0,
        160,
      ),
    }));
  if (value?.task)
    summary.task = {
      stage: value.task.stage,
      targetCount: value.task.targetCount,
      nextAction: value.task.nextAction,
    };
  return summary;
}

export function conversationHistory(
  rows: Record<string, any>[],
  encode: (value: any) => any,
): ModelMessage[] {
  return rows.slice(-6).flatMap((row) => {
    const messages: ModelMessage[] = [
      { role: "user", content: String(row.user_text ?? "").slice(0, 1000) },
    ];
    let bytes = 0,
      omitted = 0;
    for (const record of row.tool_results ?? []) {
      if (
        record.name === "plan_task" ||
        !["succeeded", "failed"].includes(record.status)
      )
        continue;
      let input = record.input ?? {},
        value =
          record.status === "succeeded"
            ? record.result
            : { error: record.error };
      if (Buffer.byteLength(JSON.stringify({ input, value })) > 3000) {
        value = toolResultSummary(record.name, input, value);
        input = value.readAgain?.input ?? { historicalParametersOmitted: true };
      }
      const size = Buffer.byteLength(JSON.stringify({ input, value }));
      if (bytes + size > 6000) {
        omitted++;
        continue;
      }
      bytes += size;
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: record.key,
              toolName: record.name,
              input: encode(input),
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: record.key,
              toolName: record.name,
              output: { type: "json", value: encode(value) },
            },
          ],
        },
      );
    }
    messages.push({
      role: "assistant",
      content:
        String(row.assistant_text ?? "")
          .split("\n真实操作记录：")[0]
          .slice(0, 2000) +
        (omitted
          ? `\n另有${omitted}项历史结果因容量未展示；以当前事实为准，需要正文时重新读取。`
          : ""),
    });
    return messages;
  });
}

/** Rebuild referenced business facts; conversation prose never supplies an identity. */
export async function assistantContext(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  page?: Dependency,
) {
  const canWrite = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  const [project, history, proposals, current] = await Promise.all([
    db.query("SELECT name FROM project WHERE id=$1", [scope.projectId]),
    db.query(
      "SELECT user_text,assistant_text,tool_results,dependencies FROM assistant_turn WHERE session_id=$1 AND status<>'running' ORDER BY created_at DESC,id DESC LIMIT 50",
      [sessionId],
    ),
    db.query(
      "SELECT action,status,summary,receipt FROM assistant_proposal WHERE session_id=$1 AND actor_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50",
      [sessionId, scope.actorId],
    ),
    db.query(
      "SELECT task FROM assistant_session WHERE id=$1 AND project_id=$2 AND actor_id=$3",
      [sessionId, scope.projectId, scope.actorId],
    ),
  ]);
  const task = current.rows[0]?.task ?? {};
  const confirmedOperations = proposals.rows
    .filter((p) => p.status === "succeeded")
    .map((p) => {
      const receipt = p.receipt?.receipt ?? p.receipt ?? {};
      return {
        action: p.action,
        status: p.status,
        target: p.summary.target,
        draftRef: receipt.draftId,
        versionRef: receipt.version?.id,
        assetRef: receipt.assetId,
        added: receipt.added,
        updated: receipt.updated,
        adopted: receipt.adopted,
        changedFields: receipt.changedFields,
      };
    });
  const previousCreated: string[] = history.rows
    .flatMap((t) => t.tool_results)
    .filter(
      (t) =>
        ["create_draft", "generate_candidates"].includes(t.name) &&
        t.status === "succeeded",
    )
    .map((t) => t.result.draftId);
  const refs: Dependency[] = history.rows.flatMap((t) => t.dependencies);
  for (const source of [task.target, task.processingScope?.source]) {
    if (source?.kind === "assets")
      refs.push(
        ...source.assetIds.map((id: string) => ({
          kind: "asset" as const,
          id,
        })),
      );
    else if (["draft", "version", "asset"].includes(source?.kind))
      refs.push({ kind: source.kind, id: source.id });
  }
  for (const id of [task.targetDraftId, task.createdDraftId])
    if (id) refs.push({ kind: "draft", id });
  const previousPage = refs.find((ref) => ref.focus);
  if (page) refs.push(page);
  for (const op of confirmedOperations) {
    if (op.draftRef) refs.push({ kind: "draft", id: op.draftRef });
    if (op.assetRef) refs.push({ kind: "asset", id: op.assetRef });
    if (op.versionRef) refs.push({ kind: "version", id: op.versionRef });
  }
  const ids = (kind: Dependency["kind"]) => [
    ...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id)),
  ];
  const draftOrder = [
    ...(page?.kind === "draft" ? [page.id] : []),
    ...confirmedOperations.map((op) => op.draftRef).filter(Boolean),
    ...(previousPage?.kind === "draft" ? [previousPage.id] : []),
    ...previousCreated,
  ];
  const [assets, versions, drafts, testSets] = await Promise.all([
    db.query(
      "SELECT da.id,da.file_name AS name,pv.record_count AS count,pv.mapping_ready FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current WHERE da.project_id=$1 AND da.status='stored' AND da.id=ANY($2::text[]) ORDER BY da.file_name,da.id LIMIT 20",
      [scope.projectId, ids("asset")],
    ),
    db.query(
      "SELECT v.id,v.version_label AS label,v.item_count AS count,v.test_set_id,ts.name AS name FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1 AND ts.status='available' AND v.status='published' AND v.id=ANY($2::text[]) ORDER BY v.published_at DESC,v.id LIMIT 20",
      [scope.projectId, ids("version")],
    ),
    canWrite
      ? db.query(
          "SELECT d.id,d.name,d.revision,d.test_set_id,d.parent_version_id,(SELECT count(*)::int FROM collaborative_draft_record r WHERE r.draft_id=d.id AND NOT r.deleted) AS record_count FROM collaborative_draft d WHERE d.project_id=$1 AND d.status='editing' AND d.id=ANY($2::text[]) ORDER BY array_position($3::text[],d.id),d.updated_at DESC,d.id LIMIT 20",
          [scope.projectId, ids("draft"), draftOrder],
        )
      : Promise.resolve({ rows: [] as Record<string, any>[] }),
    db.query(
      "SELECT ts.id,ts.name FROM test_set ts WHERE ts.project_id=$1 AND ts.status='available' AND ts.id=ANY($2::text[]) ORDER BY ts.name,ts.id LIMIT 20",
      [scope.projectId, ids("testSet")],
    ),
  ]);
  const actualByRef = new Map<string, string>();
  const reference = (id: string) => {
    const prefix = id.startsWith("collabdraft_")
      ? "d"
      : id.startsWith("asset_")
        ? "f"
        : id.startsWith("version_")
          ? "v"
          : "o";
    const ref = `${prefix}:${sha256(id).slice(0, 16)}`;
    actualByRef.set(ref, id);
    return ref;
  };
  const convert = (value: unknown, decode: boolean, key = ""): any => {
    if (typeof value === "string") {
      if (!/(^id$|ref$|ids?$|focusDraft$)/i.test(key)) return value;
      if (decode) {
        if (/^[dfvo]:/.test(value) && !actualByRef.has(value))
          throw new AssistantError(422, "assistant_reference_invalid");
        return actualByRef.get(value) ?? value;
      }
      return /^[a-z][a-z0-9]*_[a-f0-9]{24,}(?::\d+)?$/i.test(value)
        ? reference(value)
        : value;
    }
    if (Array.isArray(value))
      return value.map((entry) => convert(entry, decode, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, entry]) => [
          k,
          convert(entry, decode, k),
        ]),
      );
    return value;
  };
  const encode = (value: unknown) => convert(value, false);
  const decode = (value: unknown) => convert(value, true);
  const focusDraft =
    draftOrder.find((id) => drafts.rows.some((d) => d.id === id)) ??
    (drafts.rows.length === 1 ? drafts.rows[0].id : undefined);
  const pageRow =
    page &&
    (page.kind === "draft"
      ? drafts
      : page.kind === "asset"
        ? assets
        : page.kind === "version"
          ? versions
          : testSets
    ).rows.find((r) => r.id === page.id);
  const state = encode({
    catalogScope: "referenced_objects_only",
    discovery:
      "files/drafts/versions只列当前已引用对象，空数组不表示项目没有资料。按名称定位请调用query_project查询当前项目；多项同名才澄清。",
    backgroundDocuments: await backgroundCatalog(db, scope, sessionId),
    project: project.rows[0]?.name,
    files: assets.rows.map((a) => ({
      ref: a.id,
      name: a.name,
      recordCount: a.count,
      ready: a.mapping_ready,
    })),
    versions: versions.rows.map((v) => ({
      ref: v.id,
      name: v.name,
      label: v.label,
      recordCount: v.count,
      testSetRef: v.test_set_id,
    })),
    drafts: drafts.rows.map((d) => ({
      ref: d.id,
      name: d.name,
      revision: Number(d.revision),
      recordCount: d.record_count,
      testSetRef: d.test_set_id,
      parentVersionRef: d.parent_version_id,
    })),
    focusDraft,
    pageObject: pageRow && {
      kind: page!.kind,
      ref: pageRow.id,
      name: pageRow.name,
      recordCount: pageRow.record_count ?? pageRow.count,
      label: pageRow.label,
    },
    confirmedOperations: confirmedOperations.slice(0, 10),
    pendingOperations: proposals.rows
      .filter((p) => p.status === "pending")
      .slice(0, 10)
      .map((p) => ({ action: p.action, ...p.summary })),
  });
  // Register past references even if their body is omitted from the bounded protocol history.
  encode(history.rows.map((t) => t.tool_results));
  encode(task);
  return {
    state,
    encode,
    decode,
    history: history.rows.slice(0, 6).reverse(),
    drafts: drafts.rows,
    focusDraft,
    sessionDrafts: new Set(previousCreated),
    dependencies: [
      ...assets.rows.map((a) => ({ kind: "asset" as const, id: a.id })),
      ...versions.rows.map((v) => ({ kind: "version" as const, id: v.id })),
      ...drafts.rows.map((d) => ({ kind: "draft" as const, id: d.id })),
      ...testSets.rows.map((t) => ({ kind: "testSet" as const, id: t.id })),
    ],
  };
}
