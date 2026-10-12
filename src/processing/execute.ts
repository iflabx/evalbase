import { generateText } from "ai";
import { contentKey } from "./deduplication.js";
import { cleanupProcessingObjects } from "./cleanup.js";
import type { Config } from "../config.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { configuredModel } from "../model/connection.js";
import {
  cleanRecords,
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
// Bounded batches keep context and retries small; one model consumer is sufficient for the current ten-user ceiling.
function modelRequest(
  inputs: ProcessingInput[],
  options: ProcessingOptions,
  expected: number,
  missing: number,
  background: InputSnapshot["background"],
  accepted: ProcessingResult["records"] = [],
  batch?: { offset: number; total: number },
  dataOnly = false,
  distinctBatches = false,
  previous: ProcessingResult["records"] = [],
) {
  const base = processingPrompt(
    inputs,
    options,
    missing,
    background,
    batch ? { ...batch, originalCount: expected, accepted } : undefined,
    dataOnly,
  );
  const correction = {
    ...JSON.parse(base.prompt),
    ...(distinctBatches && options.operation === "augment" && batch
      ? {
          augmentationBatch: { ...batch, count: expected },
          augmentationRule:
            "This is the given global output range, not a new task. Allocate requested topics and taxonomy across the full total using this range. Vary scenarios and questions meaningfully across ranges; do not restart the first topics for every batch.",
        }
      : {}),
    originalOutputCount: expected,
    acceptedCount: accepted.length,
    alreadyAccepted: accepted.map((row) => ({
      question: row.question.slice(0, 300),
      expectedOutput: row.expectedOutput.slice(0, 300),
    })),
    ...(previous.length
      ? {
          previousBatchExamples: previous.slice(-20).map((row) => ({
            question: row.question.slice(0, 300),
            expectedOutput: row.expectedOutput.slice(0, 300),
          })),
        }
      : {}),
    correctionRule:
      options.operation === "augment"
        ? "Return only the missing new records. Do not repeat or rewrite accepted candidates. Count alreadyAccepted toward any category quotas in the original instructions."
        : "Return exactly one record for each supplied remaining input id. Do not regenerate already accepted records.",
  };
  let prompt = JSON.stringify(correction);
  // Correction hints may shrink; confirmed requirements, background and source records never do.
  while (
    Buffer.byteLength(base.system + prompt) >
      PROCESSING_EXECUTION.maxInputBytesPerBatch &&
    (correction.alreadyAccepted.length ||
      correction.previousBatchExamples?.length)
  ) {
    if (correction.previousBatchExamples?.length)
      correction.previousBatchExamples.shift();
    else correction.alreadyAccepted.shift();
    prompt = JSON.stringify(correction);
  }
  return { system: base.system, prompt };
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
      quotaInput ? { offset, total: outputCount ?? inputs.length } : undefined,
      dataOnly,
      distinctBatches,
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
  const legacyRecipe = run.execution_config.recipeVersion === "processing-v1";
  const distinctBatches = ["processing-v5", "processing-v6"].includes(
    run.execution_config.recipeVersion,
  );
  const deduplication = run.execution_config.recipeVersion === "processing-v6";
  const dataOnly = [
    "processing-v3",
    "processing-v4",
    "processing-v5",
    "processing-v6",
  ].includes(run.execution_config.recipeVersion);
  if (
    ![
      "processing-v1",
      "processing-v2",
      "processing-v3",
      "processing-v4",
      "processing-v5",
      "processing-v6",
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
  );
  let model: Awaited<ReturnType<typeof configuredModel>> | undefined;
  if (run.model_revision !== null)
    model = await configuredModel(db, config, run.model_revision);
  let output = 0,
    failed = 0,
    warningCount = 0;
  const acceptedContent = new Set<string>();
  const acceptedRows: ProcessingResult["records"] = [];
  if (deduplication && run.options.operation === "augment") {
    for (const row of [
      ...input.records,
      ...(input.deduplicationBaseline ?? []),
    ])
      acceptedContent.add(contentKey(row));
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
        const key = contentKey(row);
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
    const prior = (
      await db.query(
        "SELECT result_ref,output_count,issues,error_code,result_indices,model_attempts,model_started_at FROM processing_batch WHERE run_id=$1 AND ordinal=$2",
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
    try {
      let result;
      if (!model) result = cleanRecords(group.inputs, run.options);
      else if (!modelInputs.length)
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
        const saved =
          priorResult?.records.filter((row) => eligible.has(row.sourceId)) ??
          [];
        const diagnostics = (priorResult?.issues ?? []).filter((issue) =>
          [
            "invalid_output",
            "unknown_source",
            "duplicate_source",
            "excess_output",
          ].includes(issue.code),
        );
        result = validateModelRows(
          { records: saved },
          modelInputs,
          run.options,
          expected,
        );
        // Preserve every valid result, including from a previous attempt. Only request missing output.
        for (
          let attempt = deduplication ? Number(prior?.model_attempts ?? 0) : 0;
          result.records.length < expected &&
          attempt < run.execution_config.maxAttempts;
          attempt++
        ) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          await fence(db, job);
          await processingAccess(db, scope);
          await processingSourceAvailable(db, job.project_id, run.source);
          const missing = expected - result.records.length;
          const acceptedIds = new Set(
            result.records.map((row) => row.sourceId),
          );
          const remaining =
            run.options.operation === "augment"
              ? modelInputs
              : modelInputs.filter((row) => !acceptedIds.has(row.id));
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
                  total: run.options.outputCount ?? input.records.length,
                }
              : undefined,
            dataOnly,
            distinctBatches,
            deduplication ? acceptedRows : [],
          );
          if (
            Buffer.byteLength(prompt.system + prompt.prompt) >
            run.execution_config.maxInputBytesPerBatch
          )
            throw new ProcessingError(422, "processing_record_too_large");
          try {
            if (deduplication) {
              // Reserve before calling the model; a crash/retry cannot reset the call or time budget.
              const reserved = await db.query(
                `INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at)
                SELECT $1,$2,1,now() WHERE EXISTS(SELECT 1 FROM job WHERE id=$3 AND lease_owner=$4 AND attempt=$5 AND status='running' AND lease_expires_at>now())
                ON CONFLICT(run_id,ordinal) DO UPDATE SET model_attempts=processing_batch.model_attempts+1,
                  model_started_at=coalesce(processing_batch.model_started_at,now())
                WHERE processing_batch.model_attempts<$6 AND (processing_batch.model_started_at IS NULL OR processing_batch.model_started_at>now()-($7::int * interval '1 millisecond')) RETURNING ordinal`,
                [
                  run.id,
                  index,
                  job.id,
                  job.lease_owner,
                  job.attempt,
                  run.execution_config.maxAttempts,
                  run.execution_config.batchTimeoutMs,
                ],
              );
              if (!reserved.rowCount) break;
            }
            const extra = await generateText({
              model: model.model,
              ...(["processing-v4", "processing-v5", "processing-v6"].includes(
                run.execution_config.recipeVersion,
              )
                ? { temperature: 0.2 }
                : {}),
              system: prompt.system,
              prompt: prompt.prompt,
              maxOutputTokens: run.execution_config.maxOutputTokens,
              maxRetries: 0,
              abortSignal: batchSignal,
              experimental_telemetry: { isEnabled: false },
            });
            const validated = validateModelRows(
              JSON.parse(
                extra.text
                  .trim()
                  .replace(/^```(?:json)?\s*/u, "")
                  .replace(/\s*```$/u, ""),
              ),
              remaining,
              run.options,
              missing,
            );
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
              ...result.records.map(contentKey),
            ]);
            const added = validated.records.filter((row) => {
              if (run.options.operation !== "augment") return true;
              if (deduplication && !row.question.trim()) {
                diagnostics.push({
                  code: "empty_question",
                  sourceId: row.sourceId,
                });
                return false;
              }
              const key = contentKey(row);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            result = validateModelRows(
              { records: [...result.records, ...added] },
              modelInputs,
              run.options,
              expected,
            );
          } catch (error) {
            if (!result.records.length) throw error;
            // A failed correction must not discard valid output already persisted or generated.
            break;
          }
        }
        result.issues.push(...diagnostics);
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
      if (run.options.operation !== "augment")
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
        if (run.options.operation === "augment") return i;
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
      if (error instanceof ProcessingError) throw error;
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
        `INSERT INTO processing_batch(run_id,ordinal,result_ref,output_count,issues,error_code,output_bytes,result_indices)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id,ordinal) DO UPDATE SET result_ref=excluded.result_ref,
        output_count=excluded.output_count,issues=excluded.issues,error_code=excluded.error_code,output_bytes=excluded.output_bytes,result_indices=excluded.result_indices
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
    if (deduplication && run.options.operation === "augment" && body) {
      const saved = JSON.parse(body.toString("utf8")) as ProcessingResult;
      for (const row of saved.records) {
        const key = contentKey(row);
        if (!acceptedContent.has(key)) acceptedRows.push(row);
        acceptedContent.add(key);
      }
    }
    output += count;
    warningCount += issues.length;
  }
  await fence(db, job);
  if (failed) throw new Error("processing_batch_failed");
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
