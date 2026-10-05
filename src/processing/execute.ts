import { generateText } from "ai";
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
function batches(
  inputs: ProcessingInput[],
  outputCount: number | undefined,
  modelInput = true,
) {
  const result: { inputs: ProcessingInput[]; count: number }[] = [];
  if (outputCount !== undefined) {
    for (let i = 0; i < outputCount; i += 20) {
      const start = i % inputs.length,
        group: ProcessingInput[] = [];
      let bytes = 0;
      for (let j = 0; j < Math.min(20, inputs.length); j++) {
        const row = inputs[(start + j) % inputs.length],
          size = Buffer.byteLength(JSON.stringify(row));
        if (modelInput && size > PROCESSING_EXECUTION.maxInputBytesPerBatch)
          throw new ProcessingError(422, "processing_record_too_large");
        if (bytes + size > 40000) break;
        group.push(row);
        bytes += size;
      }
      result.push({ inputs: group, count: Math.min(20, outputCount - i) });
    }
  } else {
    let group: ProcessingInput[] = [],
      bytes = 0;
    for (const row of inputs) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (modelInput && size > PROCESSING_EXECUTION.maxInputBytesPerBatch)
        throw new ProcessingError(422, "processing_record_too_large");
      if (
        group.length === PROCESSING_EXECUTION.batchSize ||
        (group.length > 0 &&
          bytes + size > PROCESSING_EXECUTION.maxInputBytesPerBatch)
      ) {
        result.push({ inputs: group, count: group.length });
        group = [];
        bytes = 0;
      }
      group.push(row);
      bytes += size;
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
  if (
    canonicalJson(run.execution_config) !== canonicalJson(PROCESSING_EXECUTION)
  )
    throw new ProcessingError(409, "processing_recipe_unavailable");
  const groups = batches(
    input.records,
    run.options.outputCount,
    run.model_revision !== null,
  );
  let model: Awaited<ReturnType<typeof configuredModel>> | undefined;
  if (run.model_revision !== null)
    model = await configuredModel(db, config, run.model_revision);
  let output = 0,
    failed = 0,
    warningCount = 0;
  const positions = new Map(input.records.map((row, index) => [row.id, index]));
  for (let index = 0; index < groups.length; index++) {
    await fence(db, job);
    await processingAccess(db, scope);
    await processingSourceAvailable(db, job.project_id, run.source);
    const prior = (
      await db.query(
        "SELECT result_ref,output_count,issues,error_code FROM processing_batch WHERE run_id=$1 AND ordinal=$2",
        [run.id, index],
      )
    ).rows[0];
    if (prior?.result_ref && !prior.error_code) {
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
    try {
      let result;
      if (!model) result = cleanRecords(group.inputs, run.options);
      else if (!modelInputs.length)
        result = cleanRecords(group.inputs, {
          ...run.options,
          allowedFields: [],
        });
      else {
        const deadline = Date.now() + run.execution_config.batchTimeoutMs;
        const response = await generateText({
          model: model.model,
          ...processingPrompt(
            modelInputs,
            run.options,
            input.refinement ? modelInputs.length : group.count,
          ),
          maxOutputTokens: run.execution_config.maxOutputTokens,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(run.execution_config.batchTimeoutMs),
          experimental_telemetry: { isEnabled: false },
        });
        const text = response.text
          .trim()
          .replace(/^```(?:json)?\s*/u, "")
          .replace(/\s*```$/u, "");
        result = validateModelRows(
          JSON.parse(text),
          modelInputs,
          run.options,
          input.refinement ? modelInputs.length : group.count,
        );
        // Only fill missing augmentation rows. Accepted candidates are never regenerated.
        for (
          let attempt = 1;
          run.options.operation === "augment" &&
          result.records.length < group.count &&
          attempt < run.execution_config.maxAttempts;
          attempt++
        ) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          await fence(db, job);
          await processingAccess(db, scope);
          await processingSourceAvailable(db, job.project_id, run.source);
          const missing = group.count - result.records.length;
          const prompt = processingPrompt(modelInputs, run.options, missing);
          const correction = {
            ...JSON.parse(prompt.prompt),
            originalOutputCount: group.count,
            alreadyAccepted: result.records.map((row) => ({
              question: row.question.slice(0, 300),
              expectedOutput: row.expectedOutput.slice(0, 300),
            })),
            rule: "Return only the missing new records. Do not repeat or rewrite accepted candidates. Count alreadyAccepted toward any category quotas in the original instructions.",
          };
          try {
            const extra = await generateText({
              model: model.model,
              system: prompt.system,
              prompt: JSON.stringify(correction),
              maxOutputTokens: run.execution_config.maxOutputTokens,
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(remainingMs),
              experimental_telemetry: { isEnabled: false },
            });
            const validated = validateModelRows(
              JSON.parse(
                extra.text
                  .trim()
                  .replace(/^```(?:json)?\s*/u, "")
                  .replace(/\s*```$/u, ""),
              ),
              modelInputs,
              run.options,
              missing,
            );
            const seen = new Set(
              result.records.map((row) =>
                canonicalJson({
                  question: row.question,
                  expectedOutput: row.expectedOutput,
                  metadata: row.metadata,
                }),
              ),
            );
            const added = validated.records.filter((row) => {
              const key = canonicalJson({
                question: row.question,
                expectedOutput: row.expectedOutput,
                metadata: row.metadata,
              });
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            result = validateModelRows(
              { records: [...result.records, ...added] },
              modelInputs,
              run.options,
              group.count,
            );
          } catch {
            // A failed correction must not discard valid output from the first response.
            break;
          }
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
      count = result.records.length;
      resultIndices = result.records.map((row, i) =>
        input.refinement ? positions.get(row.sourceId)! : i,
      );
      issues = result.issues;
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
        WHERE processing_batch.result_ref IS NULL OR processing_batch.error_code IS NOT NULL`,
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
