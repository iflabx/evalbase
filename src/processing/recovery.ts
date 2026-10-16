import { CONTENT_RECIPE } from "./content-review.js";
import type { Database } from "../db/pool.js";
import type { ProcessingRun } from "./store.js";
import { isGenerationRecipe, generationBudget } from "./generation.js";

export type FailureCode =
  | "temporary_service"
  | "network_error"
  | "timeout"
  | "provider_rejected"
  | "output_truncated"
  | "invalid_json"
  | "invalid_fields"
  | "duplicate_content"
  | "insufficient_output"
  | "budget_exhausted"
  | "ok";
export type CallDiagnostic = {
  attempt: number;
  durationMs: number;
  code: FailureCode;
  finishReason?: string;
  purpose?: "content_initial" | "content_recheck";
  generated: number;
  validated: number;
  duplicates: number;
  invalid: number;
  accepted: number;
};
export type BatchDiagnostic = {
  calls: CallDiagnostic[];
  accepted: number;
  missing: number;
  stopReason?: FailureCode;
};

// Only our classifications are persisted; provider error bodies never become UI text/logs.
export function modelFailure(error: unknown, expired = false): FailureCode {
  if (expired) return "timeout";
  if (error instanceof SyntaxError) return "invalid_json";
  const e = error as {
    statusCode?: number;
    name?: string;
    cause?: unknown;
    message?: string;
  } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  if (e?.statusCode === 429 || (e?.statusCode ?? 0) >= 500)
    return "temporary_service";
  if (e?.statusCode && e.statusCode >= 400) return "provider_rejected";
  if (e?.name === "AI_JSONParseError") return "invalid_json";
  if (
    [
      "AI_TypeValidationError",
      "AI_InvalidResponseDataError",
      "AI_NoContentGeneratedError",
    ].includes(e?.name ?? "")
  )
    return "invalid_fields";
  if (e?.message === "model_output_invalid") return "invalid_fields";
  return "network_error";
}

/** Shared by the worker, API and assistant. No resets of a reserved model budget. */
export async function processingRecovery(
  db: Pick<Database, "query">,
  run: ProcessingRun,
) {
  const batches = (
    await db.query(
      "SELECT ordinal,result_ref,error_code,issues,model_attempts,model_started_at,diagnostics FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
      [run.id],
    )
  ).rows;
  const job = (
    await db.query("SELECT counts FROM job WHERE id=$1", [run.job_id])
  ).rows[0];
  const planned = Number(job?.counts?.processingBatches ?? 0);
  const pending = batches.filter(
    (b) =>
      !b.result_ref ||
      b.error_code ||
      b.issues.some((i: { code: string }) => i.code === "missing_output"),
  );
  const bounded =
    isGenerationRecipe(run.execution_config.recipeVersion) ||
    [
      "processing-v6",
      "processing-v7",
      "processing-v8",
      CONTENT_RECIPE,
    ].includes(run.execution_config.recipeVersion);
  const available = pending.some(
    (b) =>
      b.diagnostics?.stopReason !== "provider_rejected" &&
      (!bounded ||
        (Number(b.model_attempts) < run.execution_config.maxAttempts &&
          (!b.model_started_at ||
            new Date(b.model_started_at).getTime() +
              run.execution_config.batchTimeoutMs >
              Date.now()))),
  );
  const unstarted = !batches.length || planned > batches.length;
  const missing = Math.max(
    0,
    (run.options.outputCount ?? run.input_count) -
      Number(run.output_count ?? 0),
  );
  const incomplete = missing > 0 || pending.length > 0;
  const terminal = ["failed", "cancelled", "succeeded"].includes(run.status);
  const businessFailure =
    !!run.error_code &&
    ![
      "processing_batch_failed",
      "processing_output_incomplete",
      "processing_retry_unavailable",
      "infrastructure_unavailable",
      "job_lease_expired",
    ].includes(run.error_code);
  const canRetry =
    terminal && incomplete && !businessFailure && (unstarted || available);
  const budget = await generationBudget(db, run.id);
  const sharedGeneration = isGenerationRecipe(
    run.execution_config.recipeVersion,
  );
  const retryAllowed =
    canRetry && !(sharedGeneration && (budget?.exhausted || budget?.blocked));
  return {
    canRetry: retryAllowed,
    canContinue:
      terminal &&
      run.status !== "cancelled" &&
      missing > 0 &&
      !businessFailure &&
      !pending.some((b) => b.diagnostics?.stopReason === "provider_rejected") &&
      !retryAllowed &&
      !(sharedGeneration && (budget?.exhausted || budget?.blocked)),
    ...(budget ? { generationBudget: budget } : {}),
    reason: !incomplete
      ? null
      : businessFailure
        ? "source_or_configuration"
        : sharedGeneration && budget?.exhausted
          ? "budget_exhausted"
          : retryAllowed
            ? "remaining_budget"
            : pending.some(
                  (b) => b.diagnostics?.stopReason === "provider_rejected",
                )
              ? "provider_rejected"
              : terminal && bounded && pending.length
                ? "budget_exhausted"
                : "not_available",
    diagnostics: batches
      .filter((b) => b.diagnostics)
      .map((b) => ({
        batch: b.ordinal,
        attempts: b.model_attempts,
        ...(b.diagnostics as BatchDiagnostic),
      })),
  };
}
