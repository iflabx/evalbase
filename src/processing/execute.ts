import {
  modelFailure,
  processingRecovery,
  type BatchDiagnostic,
  type CallDiagnostic,
  type FailureCode,
} from "./recovery.js";
import { generateText } from "ai";
import {
  contentKey,
  candidateKey,
  type QuestionPolicy,
} from "./deduplication.js";
import {
  GENERATION_RECIPE,
  isGenerationRecipe,
  generationBudget,
  generationContext,
  generationPosition,
  type GenerationPlan,
} from "./generation.js";
import {
  applyContentReview,
  contentHash,
  contentReviewPrompt,
  contentVerdict,
  reviewRulesHash,
  CONTENT_RECIPE,
  repairReasons,
} from "./content-review.js";
import { cleanupProcessingObjects } from "./cleanup.js";
import type { Config } from "../config.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { configuredModel } from "../model/connection.js";
import {
  cleanRecords,
  generatesRecords,
  PROCESSING_EXECUTION,
  processingPrompt,
  validateModelRows,
  type ProcessingInput,
  type ProcessingResult,
  type ProcessingOptions,
} from "./protocol.js";
import {
  processingAccess,
  processingSourceAvailable,
  ProcessingError,
  type InputSnapshot,
  type ProcessingRun,
} from "./store.js";

type ProcessingJob = {
  id: string;
  project_id: string;
  actor_id: string;
  lease_owner?: string;
  attempt?: number;
  payload: Record<string, string>;
};
async function fence(
  db: Pick<Database, "query">,
  job: ProcessingJob,
  lock = false,
) {
  const claim = await db.query(
    `SELECT id FROM job WHERE id=$1 AND status='running' AND lease_owner=$2 AND attempt=$3 AND lease_expires_at>now() ${lock ? "FOR UPDATE" : ""}`,
    [job.id, job.lease_owner, job.attempt],
  );
  if (!claim.rowCount) throw new Error("processing_lease_lost");
}
async function reserveModelCall(
  db: Database,
  job: ProcessingJob,
  run: ProcessingRun,
  ordinal: number,
  shared: boolean,
) {
  const client = shared ? await db.connect() : undefined;
  try {
    if (client) await client.query("BEGIN");
    if (client)
      await client.query(
        "SELECT id FROM processing_task WHERE id=(SELECT task_id FROM processing_run WHERE id=$1) FOR UPDATE",
        [run.id],
      );
    const budget = client ? await generationBudget(client, run.id) : undefined;
    if (shared && (!budget || budget.exhausted || budget.blocked)) {
      await client!.query("COMMIT");
      return null;
    }
    const reserved = await (client ?? db).query(
      `INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at)
      SELECT $1,$2,1,now() WHERE EXISTS(SELECT 1 FROM job WHERE id=$3 AND lease_owner=$4 AND attempt=$5 AND status='running' AND lease_expires_at>now())
      ON CONFLICT(run_id,ordinal) DO UPDATE SET model_attempts=processing_batch.model_attempts+1,
        model_started_at=coalesce(processing_batch.model_started_at,now())
      WHERE processing_batch.model_attempts<$6 AND (processing_batch.model_started_at IS NULL OR processing_batch.model_started_at>now()-($7::int * interval '1 millisecond')) RETURNING ordinal`,
      [
        run.id,
        ordinal,
        job.id,
        job.lease_owner,
        job.attempt,
        run.execution_config.maxAttempts,
        run.execution_config.batchTimeoutMs,
      ],
    );
    if (client) await client.query("COMMIT");
    return reserved.rowCount ? { deadline: budget?.deadline } : null;
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    client?.release();
  }
}
// Bounded batches keep context and retries small; one model consumer is sufficient for the current ten-user ceiling.
export function modelRequest(
  inputs: ProcessingInput[],
  options: ProcessingOptions,
  expected: number,
  missing: number,
  background: InputSnapshot["background"],
  accepted: ProcessingResult["records"] = [],
  batch?: { offset: number; total: number; positions?: number[] },
  dataOnly = false,
  distinctBatches = false,
  previous: ProcessingResult["records"] = [],
  feedback?: {
    lastFailure?: FailureCode;
    rejectedDuplicates: { question: string; expectedOutput: string }[];
  },
  generation?: GenerationPlan,
  questionPolicy?: QuestionPolicy,
) {
  const generationAccepted: ProcessingResult["records"] = [];
  const generationPositions = new Set<number>(),
    generationContent = new Set<string>();
  if (generation)
    for (const row of [...previous, ...accepted]) {
      const position = generationPosition(row),
        key = candidateKey(row, questionPolicy);
      if (
        !row.question.trim() ||
        position === undefined ||
        generationPositions.has(position) ||
        generationContent.has(key)
      )
        continue;
      generationPositions.add(position);
      generationContent.add(key);
      generationAccepted.push(row);
    }
  const base = processingPrompt(
    inputs,
    options,
    missing,
    background,
    batch
      ? {
          ...batch,
          originalCount: expected,
          accepted: generation ? generationAccepted : accepted,
        }
      : undefined,
    dataOnly,
  );
  const correction = {
    ...JSON.parse(base.prompt),
    ...(generation && batch?.positions
      ? {
          generation: generationContext(
            generation,
            batch.positions,
            generationAccepted!,
          ),
        }
      : {}),
    ...(feedback
      ? {
          lastFailure: feedback.lastFailure,
          rejectedDuplicates: feedback.rejectedDuplicates
            .slice(-5)
            .map((row) =>
              questionPolicy === "distinct-v1"
                ? { question: row.question }
                : row,
            ),
        }
      : {}),
    ...(distinctBatches && generatesRecords(options.operation) && batch
      ? {
          augmentationBatch: { ...batch, count: expected },
          augmentationRule:
            "This is the given global output range, not a new task. Allocate requested topics and taxonomy across the full total using this range. Vary scenarios and questions meaningfully across ranges; do not restart the first topics for every batch.",
        }
      : {}),
    ...(questionPolicy
      ? {
          categoryCriteria: {
            source:
              "background.classifications and background.requirements (frozen below)",
            rule: "Definitions and current requirements determine membership; slots/scenarios are context only. Discard conflicting scene goals. Unverified is not false; discussing is not promoting. A general catch-all rule does not establish specific legal or factual applicability. Do not invent missing facts or norms.",
          },
          questionPolicy,
          questionPolicyRule:
            questionPolicy === "distinct-v1"
              ? "Every new question must differ from the FULL accepted and target baseline set; changing answers or metadata does not make a new question. Only exclusions are sampled here; the server checks all records."
              : "The user explicitly requested same-question answer/contrast variants. Such questions may repeat with genuinely different content; exact duplicate rows remain excluded.",
        }
      : {}),
    originalOutputCount: expected,
    acceptedCount: accepted.length,
    alreadyAccepted: accepted.map((row) => ({
      question: row.question.slice(0, 300),
      ...(questionPolicy === "distinct-v1"
        ? {}
        : { expectedOutput: row.expectedOutput.slice(0, 300) }),
    })),
    ...(previous.length
      ? {
          previousBatchExamples: previous.slice(-20).map((row) => ({
            question: row.question.slice(0, 300),
            ...(questionPolicy === "distinct-v1"
              ? {}
              : { expectedOutput: row.expectedOutput.slice(0, 300) }),
          })),
        }
      : {}),
    correctionRule: generatesRecords(options.operation)
      ? "Return only the missing new records. Do not repeat or rewrite accepted candidates. Count alreadyAccepted toward any category quotas in the original instructions."
      : "Return exactly one record for each supplied remaining input id. Do not regenerate already accepted records.",
  };
  let prompt = JSON.stringify(correction);
  // Correction hints may shrink; confirmed requirements, background and source records never do.
  while (
    Buffer.byteLength(base.system + prompt) >
      PROCESSING_EXECUTION.maxInputBytesPerBatch &&
    (correction.rejectedDuplicates?.length ||
      correction.alreadyAccepted.length ||
      correction.previousBatchExamples?.length)
  ) {
    if (correction.rejectedDuplicates?.length)
      correction.rejectedDuplicates.shift();
    else if (correction.previousBatchExamples?.length)
      correction.previousBatchExamples.shift();
    else correction.alreadyAccepted.shift();
    prompt = JSON.stringify(correction);
  }
  return {
    system:
      base.system +
      (questionPolicy === "variants-v1"
        ? " Frozen questionPolicy permits same-question variants explicitly requested by the user; this overrides only the no-repeated-question instruction, never exact-row deduplication or category criteria."
        : ""),
    prompt,
  };
}
function batches(
  inputs: ProcessingInput[],
  outputCount: number | undefined,
  modelInput = true,
  options?: ProcessingOptions,
  background?: InputSnapshot["background"],
  legacyRecipe = false,
  quotaInput = true,
  dataOnly = false,
  distinctBatches = false,
  generation?: GenerationPlan,
) {
  const result: { inputs: ProcessingInput[]; count: number }[] = [];
  const fits = (rows: ProcessingInput[], offset: number, count: number) => {
    if (legacyRecipe || !modelInput)
      return (
        rows.reduce(
          (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)),
          0,
        ) <= 40000
      );
    const budgetCount =
      distinctBatches || background?.classifications?.length ? count : 20;
    const request = modelRequest(
      rows,
      options!,
      budgetCount,
      budgetCount,
      background,
      [],
      quotaInput
        ? {
            offset,
            total: generation?.total ?? outputCount ?? inputs.length,
            ...(generation
              ? {
                  positions: generation.positions.slice(offset, offset + count),
                }
              : {}),
          }
        : undefined,
      dataOnly,
      distinctBatches,
      [],
      undefined,
      generation,
    );
    return (
      Buffer.byteLength(request.system + request.prompt) <=
      PROCESSING_EXECUTION.maxInputBytesPerBatch
    );
  };
  if (outputCount !== undefined) {
    const batchSize = distinctBatches && outputCount > 20 ? 10 : 20;
    for (let i = 0; i < outputCount; i += batchSize) {
      const start = i % inputs.length,
        count = Math.min(batchSize, outputCount - i),
        group: ProcessingInput[] = [];
      for (let j = 0; j < Math.min(batchSize, inputs.length); j++) {
        const row = inputs[(start + j) % inputs.length];
        if (modelInput && !fits([row], i, count))
          throw new ProcessingError(422, "processing_record_too_large");
        if (!fits([...group, row], i, count)) break;
        group.push(row);
      }
      if (!inputs.length && !fits([], i, count))
        throw new ProcessingError(422, "processing_record_too_large");
      result.push({ inputs: group, count });
    }
  } else {
    let group: ProcessingInput[] = [],
      offset = 0;
    for (const row of inputs) {
      if (modelInput && !fits([row], offset + group.length, 1))
        throw new ProcessingError(422, "processing_record_too_large");
      if (
        group.length === PROCESSING_EXECUTION.batchSize ||
        (group.length > 0 && !fits([...group, row], offset, group.length + 1))
      ) {
        result.push({ inputs: group, count: group.length });
        offset += group.length;
        group = [];
      }
      group.push(row);
    }
    if (group.length) result.push({ inputs: group, count: group.length });
  }
  return result;
}

// Store candidates and an attempted phase before the request. A reclaimed lease may
// retain a pending verdict, but cannot replay an unknown review/repair indefinitely.
async function checkpointReview(
  db: Database,
  artifacts: ArtifactRepository,
  job: ProcessingJob,
  run: ProcessingRun,
  ordinal: number,
  result: ProcessingResult,
  indices: number[],
) {
  const client = await db.connect();
  let stored: { objectRef: string } | undefined;
  try {
    await client.query("BEGIN");
    await fence(client, job, true);
    const current = await client.query(
      "SELECT input_ref FROM processing_run WHERE id=$1 FOR UPDATE",
      [run.id],
    );
    if (!current.rows[0]?.input_ref)
      throw new ProcessingError(404, "processing_not_found");
    await processingAccess(
      client,
      { projectId: job.project_id, actorId: job.actor_id },
      true,
    );
    await processingSourceAvailable(client, job.project_id, run.source, true);
    const old = (
      await client.query(
        "SELECT result_ref FROM processing_batch WHERE run_id=$1 AND ordinal=$2 FOR UPDATE",
        [run.id, ordinal],
      )
    ).rows[0];
    const body = Buffer.from(canonicalJson(result));
    const used = (
      await client.query(
        "SELECT coalesce(sum(output_bytes),0)::bigint AS bytes FROM processing_batch WHERE run_id=$1 AND ordinal<>$2",
        [run.id, ordinal],
      )
    ).rows[0];
    if (Number(used.bytes) + body.byteLength > 100000000)
      throw new ProcessingError(422, "processing_capacity_exceeded");
    stored = await artifacts.storeProcessing(body, run.id, `batch-${ordinal}`);
    await client.query(
      `INSERT INTO processing_batch(run_id,ordinal,result_ref,output_count,issues,error_code,output_bytes,result_indices)
      VALUES($1,$2,$3,$4,$5,'content_review_in_progress',$6,$7)
      ON CONFLICT(run_id,ordinal) DO UPDATE SET result_ref=excluded.result_ref,output_count=excluded.output_count,
      issues=excluded.issues,error_code=excluded.error_code,output_bytes=excluded.output_bytes,result_indices=excluded.result_indices`,
      [
        run.id,
        ordinal,
        stored.objectRef,
        result.records.length,
        JSON.stringify(result.issues),
        body.byteLength,
        indices,
      ],
    );
    if (old?.result_ref && old.result_ref !== stored.objectRef)
      await client.query(
        "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [job.project_id, old.result_ref],
      );
    await client.query("COMMIT");
    return stored.objectRef;
  } catch (error) {
    await client.query("ROLLBACK");
    if (stored)
      await db.query(
        "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [job.project_id, stored.objectRef],
      );
    throw error;
  } finally {
    client.release();
  }
}

export async function runProcessing(
  db: Database,
  artifacts: ArtifactRepository,
  config: Config,
  job: ProcessingJob,
): Promise<Record<string, unknown>> {
  await fence(db, job);
  const run = (
    await db.query<ProcessingRun>(
      "SELECT * FROM processing_run WHERE id=$1 AND job_id=$2 AND project_id=$3",
      [job.payload.runId, job.id, job.project_id],
    )
  ).rows[0];
  if (!run?.input_ref) throw new ProcessingError(404, "processing_not_found");
  const scope = { projectId: job.project_id, actorId: job.actor_id };
  await processingAccess(db, scope);
  await processingSourceAvailable(db, job.project_id, run.source);
  const bytes = await artifacts.readBytes(run.input_ref, 100000000);
  if (sha256(bytes) !== run.input_hash)
    throw new ProcessingError(409, "processing_input_corrupt");
  const input = JSON.parse(bytes.toString("utf8")) as InputSnapshot;
  const evidenceReview =
    input.background?.contentReviewPolicy === "evidence-v1";
  const questionPolicy = generatesRecords(run.options.operation)
    ? input.background?.questionPolicy
    : undefined;
  const recordKey = (row: Parameters<typeof contentKey>[0]) =>
    candidateKey(row, questionPolicy);
  const generation = isGenerationRecipe(run.execution_config.recipeVersion)
    ? input.generation
    : undefined;
  if (
    isGenerationRecipe(run.execution_config.recipeVersion) &&
    (!generation || generation.positions.length !== run.options.outputCount)
  )
    throw new ProcessingError(409, "processing_input_corrupt");
  const legacyRecipe = run.execution_config.recipeVersion === "processing-v1";
  const distinctBatches = [
    "processing-v5",
    "processing-v6",
    "processing-v7",
    "processing-v8",
    "processing-v9",
    CONTENT_RECIPE,
    GENERATION_RECIPE,
  ].includes(run.execution_config.recipeVersion);
  const recovery = [
    "processing-v7",
    "processing-v8",
    "processing-v9",
    CONTENT_RECIPE,
    GENERATION_RECIPE,
  ].includes(run.execution_config.recipeVersion);
  const deduplication =
    recovery || run.execution_config.recipeVersion === "processing-v6";
  const dataOnly = [
    "processing-v3",
    "processing-v4",
    "processing-v5",
    "processing-v6",
    "processing-v7",
    "processing-v8",
    "processing-v9",
    CONTENT_RECIPE,
    GENERATION_RECIPE,
  ].includes(run.execution_config.recipeVersion);
  if (
    ![
      "processing-v1",
      "processing-v2",
      "processing-v3",
      "processing-v4",
      "processing-v5",
      "processing-v6",
      "processing-v7",
      "processing-v8",
      "processing-v9",
      CONTENT_RECIPE,
      GENERATION_RECIPE,
    ].includes(run.execution_config.recipeVersion) ||
    canonicalJson({
      ...run.execution_config,
      recipeVersion: PROCESSING_EXECUTION.recipeVersion,
    }) !== canonicalJson(PROCESSING_EXECUTION)
  )
    throw new ProcessingError(409, "processing_recipe_unavailable");
  const quotaInput =
    !input.refinement ||
    input.refinement.selectedIds.length === input.records.length;
  const groups = batches(
    input.records,
    run.options.outputCount,
    run.model_revision !== null,
    run.options,
    input.background,
    legacyRecipe,
    quotaInput,
    dataOnly,
    distinctBatches,
    generation,
  );
  await db.query(
    "UPDATE job SET counts=coalesce(counts,'{}'::jsonb)||jsonb_build_object('processingBatches',$2::int) WHERE id=$1 AND status='running' AND lease_owner=$3 AND attempt=$4 AND lease_expires_at>now()",
    [job.id, groups.length, job.lease_owner, job.attempt],
  );
  let model: Awaited<ReturnType<typeof configuredModel>> | undefined;
  if (run.model_revision !== null)
    model = await configuredModel(db, config, run.model_revision);
  let output = 0,
    failed = 0,
    warningCount = 0;
  const acceptedContent = new Set<string>();
  const acceptedRows: ProcessingResult["records"] = [];
  if (deduplication && generatesRecords(run.options.operation)) {
    for (const row of [
      ...input.records,
      ...(input.deduplicationBaseline ?? []),
    ])
      acceptedContent.add(recordKey(row));
    if (run.options.operation === "generate")
      for (const row of input.deduplicationBaseline ?? [])
        acceptedRows.push({
          ...row,
          sourceId:
            generation && "sourceId" in row
              ? String(row.sourceId)
              : "previous-candidate",
        });
    // Seed every preserved batch before resuming an earlier incomplete batch.
    const preserved = await db.query(
      "SELECT result_ref FROM processing_batch WHERE run_id=$1 AND result_ref IS NOT NULL ORDER BY ordinal",
      [run.id],
    );
    for (const batch of preserved.rows) {
      const stored = JSON.parse(
        (await artifacts.readBytes(batch.result_ref, 100000000)).toString(
          "utf8",
        ),
      ) as ProcessingResult;
      for (const row of stored.records) {
        const key = recordKey(row);
        if (!acceptedContent.has(key)) acceptedRows.push(row);
        acceptedContent.add(key);
      }
    }
  }
  const positions = new Map(input.records.map((row, index) => [row.id, index]));
  for (let index = 0; index < groups.length; index++) {
    await fence(db, job);
    await processingAccess(db, scope);
    await processingSourceAvailable(db, job.project_id, run.source);
    let prior = (
      await db.query(
        "SELECT result_ref,output_count,issues,error_code,result_indices,model_attempts,model_started_at,diagnostics FROM processing_batch WHERE run_id=$1 AND ordinal=$2",
        [run.id, index],
      )
    ).rows[0];
    const incomplete = prior?.issues.some(
      (issue: { code: string }) => issue.code === "missing_output",
    );
    if (prior?.result_ref && !prior.error_code && !incomplete) {
      output += Number(prior.output_count);
      warningCount += prior.issues.length;
      continue;
    }
    const group = groups[index];
    const selected = new Set(input.refinement?.selectedIds ?? []);
    const modelInputs = input.refinement
      ? group.inputs.filter((row) => selected.has(row.id))
      : group.inputs;
    let errorCode: string | null = null;
    let stored: { objectRef: string } | undefined;
    let count = 0;
    let outputBytes = 0;
    let body: Buffer | undefined;
    let issues: unknown[] = [];
    let resultIndices: number[] = [];
    let priorResult: ProcessingResult | undefined;
    const trace: BatchDiagnostic = prior?.diagnostics ?? {
      calls: [],
      accepted: 0,
      missing: group.count,
    };
    const feedback: {
      lastFailure?: FailureCode;
      rejectedDuplicates: { question: string; expectedOutput: string }[];
    } = {
      rejectedDuplicates: [],
      lastFailure: trace.calls.at(-1)?.code ?? generation?.previousFailure,
    };
    try {
      let result: ProcessingResult;
      if (!model) result = cleanRecords(group.inputs, run.options);
      else if (!modelInputs.length && run.options.operation !== "generate")
        result = cleanRecords(group.inputs, {
          ...run.options,
          allowedFields: [],
        });
      else {
        const started =
          deduplication && prior?.model_started_at
            ? new Date(prior.model_started_at).getTime()
            : Date.now();
        const deadline = started + run.execution_config.batchTimeoutMs;
        const batchSignal = AbortSignal.timeout(
          Math.max(1, deadline - Date.now()),
        );
        const expected = input.refinement ? modelInputs.length : group.count;
        const eligible = new Set(modelInputs.map((row) => row.id));
        priorResult = prior?.result_ref
          ? (JSON.parse(
              (await artifacts.readBytes(prior.result_ref, 100000000)).toString(
                "utf8",
              ),
            ) as ProcessingResult)
          : undefined;
        const groupOffset = groups
          .slice(0, index)
          .reduce((n, g) => n + g.count, 0);
        const groupPositions = generation?.positions.slice(
          groupOffset,
          groupOffset + group.count,
        );
        const saved =
          priorResult?.records.filter(
            (row) =>
              run.options.operation === "generate" ||
              eligible.has(row.sourceId),
          ) ?? [];
        const diagnostics = (priorResult?.issues ?? []).filter((issue) =>
          [
            "invalid_output",
            "unknown_source",
            "duplicate_source",
            "excess_output",
          ].includes(issue.code),
        );
        const modelRows = (rows: ProcessingResult["records"]) =>
          run.options.operation === "generate"
            ? rows.map(({ sourceId: _id, ...row }) => row)
            : rows;
        result = validateModelRows(
          { records: modelRows(saved) },
          modelInputs,
          run.options,
          expected,
          generation ? saved.map((row) => generationPosition(row)!) : undefined,
        );
        // Preserve every valid result, including from a previous attempt. Only request missing output.
        for (
          let attempt = deduplication ? Number(prior?.model_attempts ?? 0) : 0;
          result.records.length < expected &&
          attempt < run.execution_config.maxAttempts;
          attempt++
        ) {
          // New runs keep one existing call for initial review once any product exists.
          if (evidenceReview && result.records.length) {
            const shared = generation
              ? await generationBudget(db, run.id)
              : null;
            if (
              Math.min(
                run.execution_config.maxAttempts - attempt,
                shared?.remaining ?? Infinity,
              ) <= 1
            )
              break;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          await fence(db, job);
          await processingAccess(db, scope);
          await processingSourceAvailable(db, job.project_id, run.source);
          const missing = expected - result.records.length;
          const acceptedIds = new Set(
            result.records.map((row) => row.sourceId),
          );
          const remaining = generatesRecords(run.options.operation)
            ? modelInputs
            : modelInputs.filter((row) => !acceptedIds.has(row.id));
          const missingPositions = groupPositions?.filter(
            (position) => !acceptedIds.has(`generated:${position}`),
          );
          const prompt = modelRequest(
            remaining,
            run.options,
            expected,
            missing,
            input.background,
            result.records,
            quotaInput
              ? {
                  offset: groups
                    .slice(0, index)
                    .reduce((n, g) => n + g.count, 0),
                  total:
                    generation?.total ??
                    run.options.outputCount ??
                    input.records.length,
                  ...(missingPositions ? { positions: missingPositions } : {}),
                }
              : undefined,
            dataOnly,
            distinctBatches,
            deduplication ? acceptedRows : [],
            recovery ? feedback : undefined,
            generation,
            questionPolicy,
          );
          if (
            Buffer.byteLength(prompt.system + prompt.prompt) >
            run.execution_config.maxInputBytesPerBatch
          )
            throw new ProcessingError(422, "processing_record_too_large");
          const call: CallDiagnostic = {
            attempt: attempt + 1,
            durationMs: 0,
            code: "ok",
            generated: 0,
            validated: 0,
            duplicates: 0,
            invalid: 0,
            accepted: 0,
          };
          let calledAt: number | undefined;
          try {
            let sharedDeadline: number | null | undefined;
            if (deduplication) {
              // Reserve before calling the model; a crash/retry cannot reset the call or time budget.
              const reserved = await reserveModelCall(
                db,
                job,
                run,
                index,
                Boolean(generation),
              );
              if (!reserved) break;
              sharedDeadline = reserved.deadline;
            }
            calledAt = Date.now();
            const extra = await generateText({
              model: model.model,
              ...([
                "processing-v4",
                "processing-v5",
                "processing-v6",
                "processing-v7",
                "processing-v8",
                "processing-v9",
                CONTENT_RECIPE,
                GENERATION_RECIPE,
              ].includes(run.execution_config.recipeVersion)
                ? {
                    temperature: [
                      "processing-v8",
                      "processing-v9",
                      GENERATION_RECIPE,
                    ].includes(run.execution_config.recipeVersion)
                      ? 0.7
                      : 0.2,
                  }
                : {}),
              system: prompt.system,
              prompt: prompt.prompt,
              maxOutputTokens: run.execution_config.maxOutputTokens,
              maxRetries: 0,
              abortSignal: sharedDeadline
                ? AbortSignal.any([
                    batchSignal,
                    AbortSignal.timeout(
                      Math.max(1, sharedDeadline - Date.now()),
                    ),
                  ])
                : batchSignal,
              experimental_telemetry: { isEnabled: false },
            });
            call.finishReason = [
              "stop",
              "length",
              "content-filter",
              "tool-calls",
              "error",
              "other",
              "unknown",
            ].includes(extra.finishReason)
              ? extra.finishReason
              : "unknown";
            if (recovery && extra.finishReason === "length") {
              call.code = "output_truncated";
              throw new Error("output_truncated");
            }
            const value = JSON.parse(
              extra.text
                .trim()
                .replace(/^```(?:json)?\s*/u, "")
                .replace(/\s*```$/u, ""),
            );
            call.generated =
              generation && Array.isArray(value)
                ? value.length
                : Array.isArray(value?.records)
                  ? value.records.length
                  : 0;
            const validated = validateModelRows(
              value,
              remaining,
              run.options,
              missing,
              missingPositions,
            );
            call.validated = validated.records.length;
            call.invalid = call.generated - call.validated;
            diagnostics.push(
              ...validated.issues.filter((issue) =>
                [
                  "invalid_output",
                  "unknown_source",
                  "duplicate_source",
                  "excess_output",
                ].includes(issue.code),
              ),
            );
            const seen = new Set([
              ...(deduplication ? acceptedContent : []),
              ...result.records.map(recordKey),
            ]);
            const added = validated.records.filter((row) => {
              if (!generatesRecords(run.options.operation)) return true;
              if (deduplication && !row.question.trim()) {
                diagnostics.push({
                  code: "empty_question",
                  sourceId: row.sourceId,
                });
                call.invalid++;
                return false;
              }
              const key = recordKey(row);
              if (seen.has(key)) {
                call.duplicates++;
                if (questionPolicy === "distinct-v1")
                  call.questionCollisions = (call.questionCollisions ?? 0) + 1;
                feedback.rejectedDuplicates.push({
                  question: row.question.slice(0, 300),
                  expectedOutput: row.expectedOutput.slice(0, 300),
                });
                feedback.rejectedDuplicates =
                  feedback.rejectedDuplicates.slice(-5);
                return false;
              }
              seen.add(key);
              return true;
            });
            call.accepted = added.length;
            call.code = call.invalid
              ? "invalid_fields"
              : call.duplicates
                ? "duplicate_content"
                : added.length < missing
                  ? "insufficient_output"
                  : "ok";
            result = validateModelRows(
              { records: modelRows([...result.records, ...added]) },
              modelInputs,
              run.options,
              expected,
              generation
                ? [...result.records, ...added].map(
                    (row) => generationPosition(row)!,
                  )
                : undefined,
            );
          } catch (error) {
            if (!recovery) {
              if (!result.records.length) throw error;
              break;
            }
            if (call.code === "ok")
              call.code = modelFailure(error, Date.now() >= deadline);
          } finally {
            if (recovery && calledAt !== undefined) {
              call.durationMs = Date.now() - calledAt;
              trace.calls.push(call);
              trace.calls = trace.calls.slice(
                -run.execution_config.maxAttempts,
              );
              trace.accepted = result.records.length;
              trace.missing = Math.max(0, expected - trace.accepted);
              feedback.lastFailure = call.code;
              await fence(db, job);
              await db.query(
                `UPDATE processing_batch SET diagnostics=$3 WHERE run_id=$1 AND ordinal=$2
                AND EXISTS(SELECT 1 FROM job WHERE id=$4 AND lease_owner=$5 AND attempt=$6 AND status='running' AND lease_expires_at>now())`,
                [
                  run.id,
                  index,
                  JSON.stringify(trace),
                  job.id,
                  job.lease_owner,
                  job.attempt,
                ],
              );
            }
          }
          if (recovery && call.code === "provider_rejected") break;
        }
        if (recovery) {
          trace.accepted = result.records.length;
          trace.missing = Math.max(0, expected - trace.accepted);
          trace.stopReason = trace.missing
            ? feedback.lastFailure === "provider_rejected"
              ? "provider_rejected"
              : "budget_exhausted"
            : undefined;
        } else result.issues.push(...diagnostics);
      }
      if (
        model &&
        (modelInputs.length > 0 || run.options.operation === "generate") &&
        result.records.length &&
        [CONTENT_RECIPE, GENERATION_RECIPE].includes(
          run.execution_config.recipeVersion,
        )
      ) {
        const rulesHash = reviewRulesHash(run.options, input.background);
        result.contentReview =
          priorResult?.contentReview?.rulesHash === rulesHash
            ? priorResult.contentReview
            : undefined;
        if (evidenceReview && result.contentReview?.recheckAttempted) {
          for (const item of result.contentReview.items)
            if (item.proposal) {
              delete item.proposal;
              item.repairStatus = "response_unknown";
              item.repairReason = repairReasons.response_unknown;
            }
        }
        const reviewIndices = result.records.map((row, i) =>
          input.refinement
            ? positions.get(row.sourceId)!
            : generatesRecords(run.options.operation)
              ? i
              : group.inputs.findIndex((input) => input.id === row.sourceId),
        );
        const sources = new Map(
          result.records.map((row, i) => [
            `review:${index}:${reviewIndices[i]}`,
            row.sourceId,
          ]),
        );
        let qualityRows = result.records.map((row, i) => ({
          ...row,
          sourceId: `review:${index}:${reviewIndices[i]}`,
        }));
        const saveReview = async () => {
          result.records = qualityRows.map((row) => ({
            ...row,
            sourceId: sources.get(row.sourceId)!,
          }));
          const indices = result.records.map((row, i) =>
            input.refinement
              ? positions.get(row.sourceId)!
              : generatesRecords(run.options.operation)
                ? i
                : group.inputs.findIndex((input) => input.id === row.sourceId),
          );
          const ref = await checkpointReview(
            db,
            artifacts,
            job,
            run,
            index,
            result,
            indices,
          );
          // Final commit replaces this checkpoint, including after a recovered lease.
          prior ??= {};
          prior.result_ref = ref;
          prior.error_code = "content_review_in_progress";
          prior.result_indices = indices;
          priorResult = structuredClone(result);
        };
        const stopProposals = (
          status: "no_recheck_budget" | "response_unknown",
        ) => {
          for (const item of result.contentReview?.items ?? [])
            if (item.proposal) {
              delete item.proposal;
              item.repairStatus = status;
              item.repairReason = repairReasons[status];
            }
        };
        for (const phase of ["initial", "recheck"] as const) {
          if (phase === "initial" && result.contentReview?.initialAttempted)
            continue;
          if (
            phase === "recheck" &&
            (!result.contentReview || result.contentReview.recheckAttempted)
          )
            continue;
          const candidates =
            phase === "initial"
              ? qualityRows
              : evidenceReview
                ? qualityRows.flatMap(
                    (row) =>
                      result.contentReview?.items.find(
                        (item) => item.sourceId === row.sourceId,
                      )?.proposal ?? [],
                  )
                : qualityRows.filter((row) => {
                    const item = contentVerdict(
                      row,
                      result.contentReview,
                      rulesHash,
                    );
                    return item.repaired && item.verdict === "pending";
                  });
          if (!candidates.length) continue;
          result.contentReview ??= {
            version: evidenceReview ? 2 : 1,
            ...(evidenceReview
              ? {
                  policy: "evidence-v1" as const,
                  pendingCode: "response_unknown" as const,
                }
              : {}),
            rulesHash,
            initialAttempted: true,
            items: [],
          };
          if (phase === "recheck") result.contentReview.recheckAttempted = true;
          result.contentReview.pendingReason = "内容核对未完成，候选已保留";
          await saveReview();
          await fence(db, job);
          await processingAccess(db, scope);
          await processingSourceAvailable(db, job.project_id, run.source);
          const originals = new Map(
            candidates.flatMap((row) => {
              const original = modelInputs.find(
                (input) => input.id === sources.get(row.sourceId),
              );
              return original ? [[row.sourceId, original] as const] : [];
            }),
          );
          const prompt = contentReviewPrompt(
            candidates,
            run.options,
            input.background,
            phase === "initial",
            originals,
            acceptedRows,
          );
          const oversized =
            Buffer.byteLength(prompt.system + prompt.prompt) >
            run.execution_config.maxInputBytesPerBatch;
          const reserved = !oversized
            ? await reserveModelCall(db, job, run, index, Boolean(generation))
            : null;
          if (!reserved) {
            if (evidenceReview) {
              result.contentReview.pendingCode = oversized
                ? "input_too_large"
                : "budget_exhausted";
              stopProposals("no_recheck_budget");
            }
            result.contentReview.pendingReason = oversized
              ? "本批内容超出核对长度，待人工核对"
              : "本轮核对额度不足，待人工核对";
            break;
          }
          const batch = (
            await db.query(
              "SELECT model_started_at,model_attempts FROM processing_batch WHERE run_id=$1 AND ordinal=$2",
              [run.id, index],
            )
          ).rows[0];
          const deadline = Math.min(
            new Date(batch.model_started_at).getTime() +
              run.execution_config.batchTimeoutMs,
            reserved.deadline ?? Infinity,
          );
          const calledAt = Date.now();
          const call: CallDiagnostic = {
            attempt: Number(batch.model_attempts),
            purpose:
              phase === "initial" ? "content_initial" : "content_recheck",
            durationMs: 0,
            code: "ok",
            generated: 0,
            validated: 0,
            duplicates: 0,
            invalid: 0,
            accepted: 0,
          };
          try {
            const response = await generateText({
              model: model.model,
              ...prompt,
              temperature: 0.1,
              maxOutputTokens: run.execution_config.maxOutputTokens,
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(
                Math.max(1, deadline - Date.now()),
              ),
              experimental_telemetry: { isEnabled: false },
            });
            call.finishReason = response.finishReason;
            if (response.finishReason === "length")
              throw new Error("model_output_invalid");
            const value = JSON.parse(
              response.text
                .trim()
                .replace(/^```(?:json)?\s*/u, "")
                .replace(/\s*```$/u, ""),
            );
            const checked = applyContentReview(
              value,
              candidates,
              run.options,
              input.background,
              result.contentReview,
              phase === "initial",
              originals,
            );
            if (evidenceReview) {
              const initialReview = result.contentReview;
              if (phase === "initial") {
                const seen = new Set(qualityRows.map(recordKey));
                for (const item of checked.review.items)
                  if (item.proposal) {
                    const original = candidates.find(
                      (row) => row.sourceId === item.sourceId,
                    )!;
                    const key = recordKey(item.proposal);
                    if (
                      (questionPolicy !== "distinct-v1" ||
                        key !== recordKey(original)) &&
                      (seen.has(key) ||
                        (generatesRecords(run.options.operation) &&
                          acceptedContent.has(key)))
                    ) {
                      delete item.proposal;
                      item.repairStatus = "validation_rejected";
                      item.repairReason = repairReasons.validation_rejected;
                    } else seen.add(key);
                  }
                result.contentReview = checked.review;
              } else {
                qualityRows = qualityRows.map((row) => {
                  const prior = initialReview.items.find(
                    (item) => item.sourceId === row.sourceId,
                  );
                  if (!prior?.proposal) return row;
                  const proposed = prior.proposal;
                  const review = checked.review.items.find(
                    (item) =>
                      item.sourceId === row.sourceId &&
                      item.contentHash === contentHash(proposed),
                  );
                  delete prior.proposal;
                  if (review?.verdict === "conforms") {
                    Object.assign(prior, review, {
                      repaired: true,
                      initialReason: prior.reason,
                      repairStatus: "accepted",
                      repairReason: repairReasons.accepted,
                    });
                    return proposed;
                  }
                  prior.repairStatus =
                    review?.verdict === "nonconforms"
                      ? "recheck_nonconforms"
                      : review?.verdict === "uncertain"
                        ? "recheck_uncertain"
                        : "response_unknown";
                  prior.repairReason = repairReasons[prior.repairStatus];
                  if (review)
                    prior.recheck = {
                      verdict: review.verdict,
                      reason: review.reason,
                      ...(review.checks ? { checks: review.checks } : {}),
                    };
                  return row;
                });
              }
              call.validated = candidates.filter((row) =>
                checked.review.items.some(
                  (item) =>
                    item.sourceId === row.sourceId &&
                    item.contentHash === contentHash(row) &&
                    item.verdict !== "pending",
                ),
              ).length;
              call.generated = candidates.length;
              call.invalid = candidates.length - call.validated;
              if (call.invalid) {
                call.code = "invalid_fields";
                result.contentReview.pendingCode = "invalid_response";
              } else delete result.contentReview.pendingCode;
            } else {
              const seen = new Set(qualityRows.map(recordKey));
              const replacements = new Map(
                checked.records.map((row, i) => {
                  const key = recordKey(row),
                    changed = contentHash(row) !== contentHash(candidates[i]!);
                  // A repair cannot trade quality for a collision or erase an existing row.
                  if (
                    changed &&
                    (questionPolicy !== "distinct-v1" ||
                      key !== recordKey(candidates[i]!)) &&
                    (seen.has(key) ||
                      (generatesRecords(run.options.operation) &&
                        acceptedContent.has(key)))
                  ) {
                    const item = checked.review.items.find(
                      (item) => item.sourceId === row.sourceId,
                    )!;
                    delete item.repaired;
                    delete item.initialReason;
                    Object.assign(item, {
                      contentHash: contentHash(candidates[i]!),
                      verdict: "nonconforms",
                      reason: "局部修复产生重复，保留原候选",
                    });
                    row = candidates[i]!;
                  }
                  seen.add(recordKey(row));
                  return [row.sourceId, row] as const;
                }),
              );
              qualityRows = qualityRows.map(
                (row) => replacements.get(row.sourceId) ?? row,
              );
              result.contentReview = checked.review;
              call.validated = candidates.filter((row) =>
                checked.review.items.some(
                  (item) => item.sourceId === row.sourceId,
                ),
              ).length;
              call.generated = candidates.length;
              call.invalid = candidates.length - call.validated;
            }
          } catch (error) {
            call.code = modelFailure(error, Date.now() >= deadline);
            if (evidenceReview) {
              result.contentReview.pendingCode = "response_unknown";
              stopProposals("response_unknown");
            }
            result.contentReview.pendingReason =
              call.code === "timeout"
                ? "内容核对超时，候选已保留"
                : "未取得有效内容核对结果，候选已保留";
          }
          call.durationMs = Date.now() - calledAt;
          trace.calls.push(call);
          await fence(db, job);
          await saveReview();
        }
      }
      if (input.refinement && modelInputs.length) {
        const changed = new Map(
          result.records.map((row) => [row.sourceId, row]),
        );
        const retained = cleanRecords(group.inputs, {
          ...run.options,
          allowedFields: [],
        }).records;
        result = {
          ...result,
          records: retained.flatMap((row) =>
            selected.has(row.sourceId)
              ? changed.has(row.sourceId)
                ? [changed.get(row.sourceId)!]
                : []
              : [row],
          ),
        };
      }
      if (!generatesRecords(run.options.operation))
        result.records.sort(
          (a, b) => positions.get(a.sourceId)! - positions.get(b.sourceId)!,
        );
      count = result.records.length;
      const groupPositions = new Map(group.inputs.map((row, i) => [row.id, i]));
      // Old incomplete batches numbered only the returned rows. Preserve those public IDs as well.
      const savedPositions = new Map(
        (priorResult?.records ?? []).map(
          (row, i) => [row.sourceId, prior.result_indices?.[i] ?? i] as const,
        ),
      );
      const usedPositions = new Set(savedPositions.values());
      resultIndices = result.records.map((row, i) => {
        if (input.refinement) return positions.get(row.sourceId)!;
        if (generatesRecords(run.options.operation)) return i;
        const saved = savedPositions.get(row.sourceId);
        if (saved !== undefined) return saved;
        let position = groupPositions.get(row.sourceId)!;
        while (usedPositions.has(position)) position++;
        usedPositions.add(position);
        return position;
      });
      issues = result.issues;
      if (result.issues.some((issue) => issue.code === "missing_output")) {
        errorCode = "processing_output_incomplete";
        failed++;
      }
      body = Buffer.from(canonicalJson(result));
      if (body.byteLength > 100000000)
        throw new Error("processing_output_too_large");
      const used = (
        await db.query(
          "SELECT coalesce(sum(output_bytes),0)::bigint AS bytes FROM processing_batch WHERE run_id=$1 AND ordinal<>$2",
          [run.id, index],
        )
      ).rows[0];
      if (Number(used.bytes) + body.byteLength > 100000000)
        throw new ProcessingError(422, "processing_capacity_exceeded");
      outputBytes = body.byteLength;
    } catch (error) {
      if (
        error instanceof ProcessingError ||
        prior?.error_code === "content_review_in_progress"
      )
        throw error;
      errorCode = "processing_batch_failed";
      failed++;
      if (input.refinement) {
        const retained = cleanRecords(
          group.inputs.filter((row) => !selected.has(row.id)),
          { ...run.options, allowedFields: [] },
        );
        issues = modelInputs.map((row) => ({
          code: "missing_output",
          sourceId: row.id,
        }));
        body = Buffer.from(canonicalJson({ ...retained, issues }));
        count = retained.records.length;
        resultIndices = retained.records.map(
          (row) => positions.get(row.sourceId)!,
        );
        outputBytes = body.byteLength;
      }
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await fence(client, job, true);
      // The run lock also serializes permanent-deletion cleanup with batch completion.
      const current = await client.query(
        "SELECT input_ref FROM processing_run WHERE id=$1 FOR UPDATE",
        [run.id],
      );
      if (!current.rows[0]?.input_ref)
        throw new ProcessingError(404, "processing_not_found");
      await processingAccess(client, scope, true);
      await processingSourceAvailable(client, job.project_id, run.source, true);
      if (body)
        stored = await artifacts.storeProcessing(
          body,
          run.id,
          `batch-${index}`,
        );
      await client.query(
        `INSERT INTO processing_batch(run_id,ordinal,result_ref,output_count,issues,error_code,output_bytes,result_indices,diagnostics)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(run_id,ordinal) DO UPDATE SET result_ref=excluded.result_ref,
        output_count=excluded.output_count,issues=excluded.issues,error_code=excluded.error_code,output_bytes=excluded.output_bytes,result_indices=excluded.result_indices,diagnostics=excluded.diagnostics
        WHERE processing_batch.result_ref IS NULL OR processing_batch.error_code IS NOT NULL
        OR processing_batch.issues @> '[{"code":"missing_output"}]'::jsonb`,
        [
          run.id,
          index,
          stored?.objectRef ?? null,
          count,
          JSON.stringify(issues),
          errorCode,
          outputBytes,
          resultIndices,
          recovery && model
            ? JSON.stringify(trace)
            : (prior?.diagnostics ?? null),
        ],
      );
      await client.query(
        "UPDATE job SET stage='processing',progress=$2,updated_at=now() WHERE id=$1",
        [job.id, Math.floor(((index + 1) * 100) / groups.length)],
      );
      if (prior?.result_ref && prior.result_ref !== stored?.objectRef)
        await client.query(
          "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [job.project_id, prior.result_ref],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (stored) {
        await db.query(
          "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [job.project_id, stored.objectRef],
        );
        await cleanupProcessingObjects(db, artifacts, job.project_id);
      }
      throw error;
    } finally {
      client.release();
    }
    if (deduplication && generatesRecords(run.options.operation) && body) {
      const saved = JSON.parse(body.toString("utf8")) as ProcessingResult;
      for (const row of saved.records) {
        const key = recordKey(row);
        if (!acceptedContent.has(key)) acceptedRows.push(row);
        acceptedContent.add(key);
      }
    }
    output += count;
    warningCount += issues.length;
  }
  await fence(db, job);
  if (failed) {
    const state = await processingRecovery(db, {
      ...run,
      status: "failed",
      output_count: output,
    });
    if (!state.canRetry)
      throw new ProcessingError(422, "processing_batch_failed");
    throw new Error("processing_batch_failed");
  }
  return {
    runId: run.id,
    partial: warningCount > 0,
    counts: {
      input: input.records.length,
      output,
      batches: groups.length,
      warnings: warningCount,
    },
  };
}
