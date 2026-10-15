import { generatesRecords } from "./protocol.js";
import { GENERATION_RECIPE, generationBudget } from "./generation.js";
import {
  guardAssistantCommit,
  linkAssistantProcessing,
} from "../assistant/fence.js";
import type { Database } from "../db/pool.js";
import { deduplicate } from "./deduplication.js";
import { freezeBackground } from "../assistant/background.js";
import { cleanupProcessingObjects } from "./cleanup.js";
import { adoptedCandidateKeys, candidateKey } from "./adoption.js";
import { attachProcessingRound, guardProcessingTask } from "./task-state.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { opaqueId, isPlainObject } from "../server/support.js";
import { processingOptions, PROCESSING_EXECUTION } from "./protocol.js";
import {
  processingSourceSummary,
  filterProcessingRecords,
} from "./presentation.js";
import {
  getProcessingRun,
  processingRunSummary,
  processingAccess,
  readProcessingRun,
  ProcessingError,
  type InputSnapshot,
  type ProcessingRun,
  type ProcessingScope,
} from "./store.js";
import type { PoolClient } from "pg";
import { processingTaskCandidates } from "./tasks.js";

async function readFrozenInput(
  artifacts: ArtifactRepository,
  run: ProcessingRun,
) {
  if (!run.input_ref)
    throw new ProcessingError(409, "processing_input_corrupt");
  try {
    const bytes = await artifacts.readBytes(run.input_ref, 100000000);
    if (sha256(bytes) !== run.input_hash)
      throw new Error("Input hash mismatch");
    const input = JSON.parse(bytes.toString("utf8")) as InputSnapshot;
    if (!Array.isArray(input.records)) throw new Error("Missing input records");
    return input;
  } catch {
    throw new ProcessingError(409, "processing_input_corrupt");
  }
}

/** Refine candidates, retaining their original adoption baseline and unselected values. */
export async function createRefinementRun(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  parentId: string,
  key: unknown,
  body: unknown,
  mode: "refine" | "continue" | "rerun" = "refine",
  transaction?: { client: PoolClient; stored: string[] },
) {
  await processingAccess(db, scope);
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 200 ||
    !isPlainObject(body) ||
    Object.keys(body).some(
      (k) =>
        !(
          mode === "refine"
            ? ["resultIds", "instructions", "allowedFields"]
            : mode === "continue"
              ? ["resultIds", "options"]
              : ["options"]
        ).includes(k),
    ) ||
    (mode !== "rerun" &&
      !(
        mode === "continue" &&
        scope.taskRound?.kind === "complete" &&
        isPlainObject(body.options) &&
        body.options.operation === "generate" &&
        Array.isArray(body.resultIds) &&
        body.resultIds.length === 0
      ) &&
      (!Array.isArray(body.resultIds) ||
        !body.resultIds.length ||
        body.resultIds.length > 10000 ||
        body.resultIds.some(
          (id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id),
        ) ||
        new Set(body.resultIds).size !== body.resultIds.length))
  )
    throw new ProcessingError(422, "processing_refinement_invalid");
  let options;
  try {
    options = processingOptions(
      mode !== "refine"
        ? body.options
        : {
            operation: "rewrite",
            instructions: body.instructions,
            allowedFields: body.allowedFields ?? ["question"],
          },
    );
  } catch {
    throw new ProcessingError(422, "processing_configuration_invalid");
  }
  const digest = sha256(
    canonicalJson({
      parentId,
      mode,
      resultIds: Array.isArray(body.resultIds)
        ? [...body.resultIds].sort()
        : [],
      options,
      ...(scope.taskRound
        ? {
            task: {
              id: scope.taskRound.taskId,
              revision: scope.taskRound.expectedRevision,
              kind: scope.taskRound.kind,
            },
          }
        : {}),
    }),
  );
  const client = transaction?.client ?? (await db.connect());
  let storedInput: string | undefined;
  try {
    if (!transaction) await client.query("BEGIN");
    // ponytail: project-wide adoption fence for at most 10 users; split by candidate if measured contention warrants it.
    if (mode !== "refine")
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `processing-candidates:${scope.projectId}`,
      ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing:${scope.projectId}:${scope.actorId}:${key}`,
    ]);
    await processingAccess(client, scope, true);
    const prior = (
      await client.query(
        "SELECT id,request_hash FROM processing_run WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [scope.projectId, scope.actorId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== digest)
        throw new ProcessingError(409, "idempotency_conflict");
      if (transaction)
        return {
          run: processingRunSummary(
            await getProcessingRun(client, scope, prior.id),
          ),
          replayed: true,
        };
      const result = await readProcessingRun(db, artifacts, scope, prior.id, {
        limit: "1",
      });
      await client.query("COMMIT");
      return { run: result.run, replayed: true };
    }
    const located = await getProcessingRun(client, scope, parentId);
    await guardProcessingTask(client, scope);
    if (
      located.background_document_ids.length &&
      (
        await client.query(
          "SELECT id FROM assistant_background_document WHERE id=ANY($1::text[]) FOR SHARE",
          [located.background_document_ids],
        )
      ).rowCount !== located.background_document_ids.length
    )
      throw new ProcessingError(409, "processing_source_unavailable");
    const parent = await getProcessingRun(client, scope, parentId, true);
    const inheritedInput = await readFrozenInput(artifacts, parent);
    const plan = scope.taskRound?.generation ?? inheritedInput.generation;
    const generationRoot = plan
      ? await getProcessingRun(client, scope, plan.rootRunId)
      : undefined;
    const generation =
      generationRoot?.execution_config.recipeVersion === GENERATION_RECIPE
        ? plan
        : undefined;
    if (
      options.operation === "generate" &&
      ((generationRoot?.source ?? parent.source).kind !== "background" ||
        scope.taskRound?.kind !== "complete" ||
        canonicalJson({
          ...options,
          outputCount:
            generationRoot?.options.outputCount ?? parent.options.outputCount,
        }) !== canonicalJson(generationRoot?.options ?? parent.options))
    )
      throw new ProcessingError(422, "processing_configuration_invalid");
    if (
      options.operation === "generate" &&
      generationRoot?.execution_config.recipeVersion === GENERATION_RECIPE
    ) {
      const budget = await generationBudget(client, parentId);
      if (
        !budget ||
        budget.exhausted ||
        budget.blocked ||
        !scope.taskRound?.generation ||
        generation!.positions.length !== options.outputCount
      )
        throw new ProcessingError(409, "processing_completion_unavailable");
    }
    if (!["succeeded", "failed", "cancelled"].includes(parent.status))
      throw new ProcessingError(409, "processing_still_running");
    const data =
      mode === "rerun"
        ? null
        : await readProcessingRun(
            db,
            artifacts,
            scope,
            parentId,
            { limit: "10000" },
            true,
          );
    const resultIds = (
      Array.isArray(body.resultIds) ? body.resultIds : []
    ) as string[];
    if (
      !scope.taskRound?.records &&
      data &&
      resultIds.some((id) => !data.allIds.includes(id))
    )
      throw new ProcessingError(422, "processing_result_invalid");
    const adopted = data
      ? await adoptedCandidateKeys(
          client,
          artifacts,
          scope,
          [data],
          undefined,
          mode !== "refine",
        )
      : new Set();
    if (
      !scope.taskRound?.records &&
      resultIds.some((id) =>
        adopted.has(candidateKey({ runId: parentId, resultId: id })),
      )
    )
      throw new ProcessingError(409, "processing_already_adopted");
    const input =
      options.operation === "generate" && generationRoot
        ? await readFrozenInput(artifacts, generationRoot)
        : inheritedInput;
    const snapshots = new Map(input.records.map((row) => [row.id, row]));
    const selected = new Set(resultIds);
    const inputRootOperation =
      mode === "rerun"
        ? (input.continuation?.inputRootOperation ??
          input.refinement?.rootOperation ??
          "clean")
        : (input.continuation?.rootOperation ??
          input.refinement?.rootOperation ??
          parent.options.operation);
    const refinement = {
      parentRunId: parentId,
      selectedIds: resultIds.map((id) => `candidate:${id}`),
      rootOperation: inputRootOperation,
      adoptionFields: [
        ...new Set([
          ...(input.continuation?.adoptionFields ??
            input.refinement?.adoptionFields ??
            parent.options.allowedFields),
          ...options.allowedFields,
        ]),
      ],
    };
    const records: InputSnapshot["records"] =
      scope.taskRound?.records ??
      (options.operation === "generate"
        ? []
        : mode === "rerun"
          ? input.records.map(({ candidateOrigin: _origin, ...row }) => row)
          : data!.records
              .filter((row) => mode === "refine" || selected.has(row.id))
              .map((row) => {
                const original =
                  snapshots.get(row.result.sourceId) ?? row.original;
                if (!original)
                  throw new ProcessingError(409, "processing_input_corrupt");
                return {
                  id: `candidate:${row.id}`,
                  ...(options.operation === "augment"
                    ? {}
                    : { candidateOrigin: row.candidateOrigin }),
                  question: row.result.question,
                  expectedOutput: row.result.expectedOutput,
                  metadata: row.result.metadata,
                  baseline: original.baseline ?? original,
                  ...(original.source === undefined
                    ? {}
                    : { source: original.source }),
                  ...(original.revisions === undefined
                    ? {}
                    : { revisions: original.revisions }),
                };
              }));
    if (!records.length && options.operation !== "generate")
      throw new ProcessingError(422, "processing_result_invalid");
    if (
      options.operation === "clean" &&
      !options.instructions &&
      records.some((row) => row.raw !== undefined)
    )
      throw new ProcessingError(422, "processing_mapping_required");
    if (
      records.length > 10000 ||
      Buffer.byteLength(canonicalJson({ records, refinement })) > 100000000
    )
      throw new ProcessingError(422, "processing_capacity_exceeded");
    const model =
      options.operation !== "clean" || options.instructions
        ? (
            await client.query(
              "SELECT revision,enabled FROM model_connection ORDER BY revision DESC LIMIT 1",
            )
          ).rows[0]
        : null;
    if (
      (options.operation !== "clean" || options.instructions) &&
      !model?.enabled
    )
      throw new ProcessingError(409, "model_connection_unavailable");
    await guardAssistantCommit(client, scope);
    const rootOperation = generatesRecords(options.operation)
      ? options.operation
      : generatesRecords(inputRootOperation)
        ? inputRootOperation
        : options.operation;
    const inputParentRunId =
      input.continuation?.inputParentRunId ??
      (input.continuation?.kind === "continue"
        ? input.continuation.parentRunId
        : input.refinement?.parentRunId);
    const continuation =
      mode === "refine"
        ? undefined
        : {
            parentRunId: parentId,
            kind: mode,
            inputRootOperation,
            ...(mode === "rerun" && inputParentRunId
              ? { inputParentRunId }
              : {}),
            rootOperation,
            adoptionFields: refinement.adoptionFields,
          };
    let background = scope.assistantGuard
      ? await freezeBackground(client, scope, scope.assistantGuard.sessionId, {
          options,
          records,
          source: parent.source,
          rootOperation: refinement.rootOperation,
        })
      : input.background;
    if (background && scope.completionBaseline && !generation) {
      background = {
        ...background,
        classifications: background.classifications?.map((rule) => {
          const counts = new Map<string, number>();
          for (const row of scope.completionBaseline!) {
            const value =
              rule.field === "expectedOutput"
                ? row.expectedOutput
                : row.metadata.find(
                    (entry) =>
                      entry.key.toLowerCase() === rule.key?.toLowerCase(),
                  )?.value;
            if (value !== undefined)
              counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return {
            ...rule,
            ...(rule.quotas
              ? {
                  quotas: rule.quotas.map((quota) => ({
                    ...quota,
                    count: Math.max(
                      0,
                      quota.count - (counts.get(quota.value) ?? 0),
                    ),
                  })),
                }
              : {}),
            ...(rule.requiredValues
              ? {
                  requiredValues: rule.requiredValues.filter(
                    (value) => !counts.has(value),
                  ),
                }
              : {}),
          };
        }),
      };
    }
    const runId = opaqueId("processing"),
      jobId = opaqueId("job");
    const bytes = Buffer.from(
      canonicalJson({
        source: input.source,
        ...(generation ? { generation } : {}),
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        records,
        ...(generatesRecords(options.operation)
          ? {
              deduplicationBaseline:
                generation && scope.taskRound?.deduplicationBaseline
                  ? scope.taskRound.deduplicationBaseline
                  : [
                      ...(scope.taskRound?.deduplicationBaseline ?? []),
                      ...(input.deduplicationBaseline ?? []),
                      ...input.records,
                      ...(data?.records.map((row) => ({
                        id: row.id,
                        ...row.result,
                      })) ?? []),
                    ],
            }
          : {}),
        ...(mode === "refine" ? { refinement } : { continuation }),
        ...(background ? { background } : {}),
      }),
    );
    if (bytes.byteLength > 100000000)
      throw new ProcessingError(422, "processing_capacity_exceeded");
    const stored = await artifacts.storeProcessing(bytes, runId, "input");
    storedInput = stored.objectRef;
    transaction?.stored.push(stored.objectRef);
    await client.query(
      "INSERT INTO job(id,project_id,actor_id,kind,payload,status,idempotency_key,correlation_id) VALUES($1,$2,$3,'process_data',$4,'queued',$5,$1)",
      [
        jobId,
        scope.projectId,
        scope.actorId,
        { runId, ...(mode === "refine" ? {} : { continuationKind: mode }) },
        `processing:${runId}`,
      ],
    );
    await client.query(
      `INSERT INTO processing_run(id,project_id,actor_id,job_id,idempotency_key,request_hash,source,options,input_ref,input_hash,input_count,model_revision,target_draft_id,execution_config,parent_run_id,background_document_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        runId,
        scope.projectId,
        scope.actorId,
        jobId,
        key,
        digest,
        options.operation === "generate" && generationRoot
          ? generationRoot.source
          : parent.source,
        options,
        stored.objectRef,
        stored.sha256,
        records.length,
        model?.revision ?? null,
        options.operation === "generate" && parent.source.kind === "draft"
          ? parent.source.id
          : (parent.target_draft_id ?? generationRoot?.target_draft_id),
        {
          ...PROCESSING_EXECUTION,
          recipeVersion:
            options.operation === "generate"
              ? generationRoot?.execution_config.recipeVersion ===
                GENERATION_RECIPE
                ? GENERATION_RECIPE
                : "processing-v8"
              : PROCESSING_EXECUTION.recipeVersion,
        },
        parentId,
        background?.documents.map((document) => document.id) ?? [],
      ],
    );
    await linkAssistantProcessing(client, scope, runId);
    await attachProcessingRound(client, scope, runId, parentId);
    if (transaction)
      return {
        run: {
          ...processingRunSummary(await getProcessingRun(client, scope, runId)),
          refinedCount: selected.size,
        },
        replayed: false,
      };
    await client.query("COMMIT");
    const result = await readProcessingRun(db, artifacts, scope, runId, {
      limit: "1",
    });
    return {
      run: { ...result.run, refinedCount: selected.size },
      replayed: false,
    };
  } catch (error) {
    if (!transaction) await client.query("ROLLBACK");
    if (storedInput && !transaction) {
      await db.query(
        "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [scope.projectId, storedInput],
      );
      await cleanupProcessingObjects(db, artifacts, scope.projectId);
    }
    throw error;
  } finally {
    if (!transaction) client.release();
  }
}

/** One user selection may span several existing runs; all child receipts commit together. */
export async function createRefinementGroups(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  groups: { runId: string; resultIds: string[] }[],
  key: string,
  body: { instructions: string; allowedFields: string[] },
) {
  // Resolve each processing workspace once. A raw historical run includes rows that
  // have since been replaced or excluded, so it cannot be the next round's input.
  const workspaces = new Map<
    string,
    Awaited<ReturnType<typeof processingTaskCandidates>>
  >();
  const grouped = new Map<
    string,
    {
      workspace: Awaited<ReturnType<typeof processingTaskCandidates>>;
      selected: Set<string>;
    }
  >();
  for (const group of groups) {
    const current =
      workspaces.get(group.runId) ??
      (await processingTaskCandidates(db, artifacts, scope, group.runId));
    for (const run of current.runs) workspaces.set(run.id, current);
    const item = grouped.get(current.id) ?? {
      workspace: current,
      selected: new Set<string>(),
    };
    for (const id of group.resultIds) {
      const row = current.rows.find(
        (row) => row.runId === group.runId && row.localId === id,
      );
      if (!row)
        throw new ProcessingError(409, "assistant_candidate_selection_changed");
      item.selected.add(row.id);
    }
    grouped.set(current.id, item);
  }
  const client = await db.connect(),
    transaction = { client, stored: [] as string[] };
  try {
    await client.query("BEGIN");
    await guardProcessingTask(client, scope);
    const results = [];
    for (const [index, { workspace, selected }] of [
      ...grouped.values(),
    ].entries()) {
      const receipts = await adoptedCandidateKeys(
        client,
        artifacts,
        scope,
        workspace.runs.map((run) => ({
          run: { id: run.id },
          records: workspace.rows
            .filter((row) => row.runId === run.id && row.localId)
            .map((row) => ({
              id: row.localId,
              candidateOrigin: row.candidateOrigin,
            })),
        })),
        undefined,
        true,
      );
      if (
        workspace.rows.some(
          (row) =>
            selected.has(row.id) &&
            receipts.has(
              candidateKey({ runId: row.runId, resultId: row.localId }),
            ),
        )
      )
        throw new ProcessingError(409, "processing_already_adopted");
      const records = workspace.rows
        .filter((row) => row.localId)
        .map((row) => ({
          id: `candidate:${row.id}`,
          taskRecordKey: row.id,
          candidateOrigin: row.candidateOrigin,
          question: row.result.question,
          expectedOutput: row.result.expectedOutput,
          metadata: row.result.metadata,
          baseline: row.original.baseline ?? row.original,
          ...(row.original.source === undefined
            ? {}
            : { source: row.original.source }),
          ...(row.original.revisions === undefined
            ? {}
            : { revisions: row.original.revisions }),
          adoptionOperation: row.rootOperation,
          adoptionFields: [
            ...new Set([...row.adoptionFields, ...body.allowedFields]),
          ] as InputSnapshot["records"][number]["adoptionFields"],
        }));
      // One child per processing task retains its whole effective workspace, even
      // when the selected identities came from several historical runs.
      const childScope = {
        ...scope,
        taskRound: {
          taskId: workspace.id,
          expectedRevision: workspace.revision,
          before: workspace.refs,
          records,
          kind: "continue" as const,
        },
      };
      delete childScope.assistantResultsGuard;
      results.push(
        await createRefinementRun(
          db,
          artifacts,
          childScope,
          workspace.latestRunId,
          index === 0 ? key : `${key}:${sha256(workspace.id).slice(0, 16)}`,
          { ...body, resultIds: [...selected] },
          "refine",
          transaction,
        ),
      );
    }
    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK");
    for (const objectRef of transaction.stored)
      await db.query(
        "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [scope.projectId, objectRef],
      );
    if (transaction.stored.length)
      await cleanupProcessingObjects(db, artifacts, scope.projectId);
    throw error;
  } finally {
    client.release();
  }
}

/** An explicit, bounded child task for the remaining unique augmentation count. */
export async function completeProcessingRun(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  parentId: string,
  key: unknown,
) {
  const data = await readProcessingRun(
    db,
    artifacts,
    scope,
    parentId,
    { limit: "10000" },
    true,
  );
  if (!generatesRecords(data.run.options.operation))
    throw new ProcessingError(422, "processing_configuration_invalid");
  const input = await readFrozenInput(
    artifacts,
    await getProcessingRun(db, scope, parentId),
  );
  const plan = deduplicate(
    data.records
      .filter((row) => row.result.question.trim())
      .map((row) => ({ id: row.id, ...row.result })),
    [...input.records, ...(input.deduplicationBaseline ?? [])],
  );
  const keptIds = new Set(plan.keptIds);
  const kept = data.records.filter((row) => keptIds.has(row.id)),
    missing = (data.run.options.outputCount ?? 0) - kept.length;
  if (missing <= 0)
    throw new ProcessingError(409, "processing_completion_unnecessary");
  return createRefinementRun(
    db,
    artifacts,
    { ...scope, completionBaseline: kept.map((row) => row.result) },
    parentId,
    key,
    {
      ...(kept.length ? { resultIds: plan.keptIds } : {}),
      options: { ...data.run.options, outputCount: missing },
    },
    kept.length ? "continue" : "rerun",
  );
}

/** Preview frozen inputs only; never creates a task or accepts caller-supplied record bodies. */
export async function previewFollowupInput(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  body: unknown,
) {
  if (
    !isPlainObject(body) ||
    !isPlainObject(body.source) ||
    Object.keys(body).some(
      (key) =>
        ![
          "source",
          "offset",
          "limit",
          "search",
          "conditions",
          "selectedOnly",
          "selectedIds",
        ].includes(key),
    ) ||
    Object.keys(body.source).some(
      (key) => !["kind", "id", "resultIds"].includes(key),
    ) ||
    !["results", "rerun"].includes(String(body.source.kind)) ||
    typeof body.source.id !== "string" ||
    body.source.id.length > 250
  )
    throw new ProcessingError(422, "processing_scope_invalid");
  const offset = Number(body.offset ?? 0),
    limit = Number(body.limit ?? 20);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (body.selectedOnly !== undefined && typeof body.selectedOnly !== "boolean")
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const parent = await getProcessingRun(db, scope, body.source.id);
  if (!["succeeded", "failed", "cancelled"].includes(parent.status))
    throw new ProcessingError(409, "processing_still_running");
  const input = await readFrozenInput(artifacts, parent);
  let records = input.records;
  if (body.source.kind === "results") {
    const ids = body.source.resultIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id))
    )
      throw new ProcessingError(422, "processing_selection_invalid");
    const data = await readProcessingRun(
      db,
      artifacts,
      scope,
      parent.id,
      { limit: "10000" },
      true,
    );
    if (ids.some((id) => !data.allIds.includes(id)))
      throw new ProcessingError(422, "processing_result_invalid");
    const adopted = await adoptedCandidateKeys(
      db,
      artifacts,
      scope,
      [data],
      undefined,
      true,
    );
    if (
      ids.some((id) =>
        adopted.has(candidateKey({ runId: parent.id, resultId: id })),
      )
    )
      throw new ProcessingError(409, "processing_already_adopted");
    records = data.records
      .filter((row) => ids.includes(row.id))
      .map((row) => ({ id: `candidate:${row.id}`, ...row.result }));
  } else if (body.source.resultIds !== undefined)
    throw new ProcessingError(422, "processing_scope_invalid");
  const ids = records.map((row) => row.id),
    selected = body.selectedIds ?? [];
  if (
    !Array.isArray(selected) ||
    selected.length > 10000 ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => typeof id !== "string" || !ids.includes(id))
  )
    throw new ProcessingError(422, "query_parameter_invalid");
  const matched = filterProcessingRecords(
      records,
      body.search,
      body.conditions,
    ),
    visible = body.selectedOnly
      ? matched.filter((row) => selected.includes(row.id))
      : matched;
  const sourceSummary = await processingSourceSummary(db, scope, parent.source);
  await getProcessingRun(db, scope, parent.id);
  return {
    records: visible.slice(offset, offset + limit),
    allIds: matched.map((row) => row.id),
    total: visible.length,
    sourceTotal: records.length,
    matchedTotal: matched.length,
    sourceRevision: sha256(canonicalJson([parent.input_hash, ids])),
    metadataKeys: [
      ...new Set(
        records.flatMap((row) => row.metadata.map((entry) => entry.key)),
      ),
    ]
      .sort()
      .slice(0, 100),
    sourceSummary: {
      ...sourceSummary,
      kindLabel:
        body.source.kind === "results"
          ? "上一次处理结果"
          : "上次提交的完整输入",
    },
    parent: {
      id: parent.id,
      options: parent.options,
      createdAt: parent.created_at,
    },
  };
}
