import type { Database } from "../db/pool.js";
import type { FailureCode } from "./recovery.js";
import { candidateKey, type QuestionPolicy } from "./deduplication.js";
import { PROCESSING_EXECUTION, type ProcessingOutput } from "./protocol.js";

export const GENERATION_RECIPE = "processing-v10";
export function isGenerationRecipe(version: string | undefined) {
  return version === GENERATION_RECIPE || version === "processing-v9";
}
export type GenerationPlan = {
  rootRunId: string;
  total: number;
  scenarios: string[];
  positions: number[];
  previousFailure?: FailureCode;
};
export function createGenerationPlan(
  rootRunId: string,
  total: number,
  scenarios?: string[],
): GenerationPlan {
  return {
    rootRunId,
    total,
    scenarios: scenarios?.length
      ? [...scenarios]
      : ["当前要求下的不同具体使用情境"],
    positions: Array.from({ length: total }, (_, i) => i),
  };
}
export function generationPosition(row: {
  generationPosition?: number;
  sourceId?: string;
  result?: { sourceId?: string };
  original?: { id?: string; baseline?: { id?: string } };
}) {
  if (row.generationPosition !== undefined) return row.generationPosition;
  const id =
    row.original?.baseline?.id ??
    row.original?.id ??
    row.result?.sourceId ??
    row.sourceId;
  return /^generated:\d+$/u.test(id ?? "") ? Number(id!.slice(10)) : undefined;
}
export function remainingGenerationPositions(
  plan: GenerationPlan,
  rows: (
    | ProcessingOutput
    | {
        result: ProcessingOutput;
        generationPosition?: number;
        rootOperation?: string;
        original?: { id?: string; baseline?: { id?: string } };
      }
  )[],
  policy?: QuestionPolicy,
) {
  const used = new Set<number>(),
    seen = new Set<string>();
  for (const row of rows) {
    if ("rootOperation" in row && row.rootOperation === "augment") continue;
    const result = "result" in row ? row.result : row;
    if (!result.question.trim() || seen.has(candidateKey(result, policy)))
      continue;
    const position = generationPosition(row);
    // Later augmentation/saved rounds may contain additional records outside this generation goal.
    if (position === undefined) continue;
    if (position < 0 || position >= plan.total)
      throw new Error("processing_input_corrupt");
    seen.add(candidateKey(result, policy));
    used.add(position);
  }
  return plan.positions.filter((position) => !used.has(position));
}
export function generationContext(
  plan: GenerationPlan,
  positions: number[],
  accepted: ProcessingOutput[],
) {
  const scenarioIndex = (position: number) =>
    Math.min(
      plan.scenarios.length - 1,
      Math.floor((position * plan.scenarios.length) / plan.total),
    );
  const counts = Array.from({ length: plan.scenarios.length }, () => 0);
  const used = new Set<number>();
  for (const row of accepted) {
    const position = generationPosition(row);
    if (
      position !== undefined &&
      position >= 0 &&
      position < plan.total &&
      !used.has(position)
    ) {
      counts[scenarioIndex(position)]!++;
      used.add(position);
    }
  }
  return {
    total: plan.total,
    scenarios: plan.scenarios.map((scenario, i) => ({
      scenario,
      accepted: counts[i],
    })),
    slots: positions.map((position) => ({
      position: position + 1,
      scenario: plan.scenarios[scenarioIndex(position)],
    })),
    rule: "Return records in exactly this slots order, one NEW complete question per slot. Each slot uses a different concrete situation, actor/context or natural phrasing within its assigned scenario and the current requirements. Do not emit slot IDs or extra fields. Previously accepted questions are exclusions, not templates. Only these missing slots are requested; do not restart the plan or fill other scenarios.",
  };
}

/** A new completion round shares the original task's reserved call/time budget. */
export async function generationBudget(
  db: Pick<Database, "query">,
  runId: string,
) {
  const row = (
    await db.query(
      `SELECT root.id,root.options,
      coalesce(sum(pb.model_attempts),0)::int AS used,min(pb.model_started_at) AS started,
      coalesce(bool_or(pb.diagnostics->>'stopReason'='provider_rejected'),false) AS blocked
    FROM processing_run cur JOIN processing_task t ON t.id=cur.task_id
    JOIN processing_run root ON root.id=t.root_run_id
    LEFT JOIN processing_run family ON family.task_id=t.id AND family.execution_config->>'recipeVersion'=root.execution_config->>'recipeVersion'
    LEFT JOIN processing_batch pb ON pb.run_id=family.id
    WHERE cur.id=$1 AND root.execution_config->>'recipeVersion'=ANY($2::text[])
    GROUP BY root.id`,
      [runId, [GENERATION_RECIPE, "processing-v9"]],
    )
  ).rows[0];
  if (!row) return undefined;
  const targetCount = Number(row.options.outputCount);
  const batches = Math.ceil(targetCount / (targetCount > 20 ? 10 : 20));
  const limit = batches * PROCESSING_EXECUTION.maxAttempts;
  const deadline = row.started
    ? new Date(row.started).getTime() +
      batches * PROCESSING_EXECUTION.batchTimeoutMs
    : null;
  return {
    rootRunId: row.id as string,
    targetCount,
    limit,
    used: Number(row.used),
    remaining: Math.max(0, limit - Number(row.used)),
    deadline,
    blocked: Boolean(row.blocked),
    exhausted:
      Number(row.used) >= limit ||
      (deadline !== null && deadline <= Date.now()),
  };
}
