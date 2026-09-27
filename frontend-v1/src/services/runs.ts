import { db, delay, fail, nowIso, uid } from "./store";
import { computeRun } from "@/lib/e2e-calculator";
import { DEFAULT_WEIGHTS, type CalcRun, type RunParams } from "@/types";

export const CALCULATOR_VERSIONS = ["e2e-quality@1.0.0", "e2e-quality@1.1.0-rc1"];

export async function listRuns(): Promise<CalcRun[]> {
  return delay(
    db.runs.map((r) => ({ ...r })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export async function getRun(id: string): Promise<CalcRun> {
  const run = db.runs.find((r) => r.id === id);
  if (!run) return fail(`计算运行 ${id} 不存在`);
  return delay({ ...run }, 250);
}

export async function createRun(params: RunParams): Promise<CalcRun> {
  const version = db.evaluatedVersions.find((v) => v.id === params.resultVersionId);
  if (!version) return fail("请选择一个有效的评测结果版本");
  if (version.status !== "READY") {
    return fail("仅 READY 状态的 evaluated_result 版本可进入端到端计算");
  }

  const weightSum = Object.values(params.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 0.001) {
    return fail(`七维权重合计必须为 1，当前为 ${weightSum.toFixed(3)}`);
  }

  const run: CalcRun = {
    id: uid("run"),
    name: `${version.experimentName} · ${params.scoreSource === "human" ? "人工评分" : "LLM Judge"}`,
    params,
    resultVersionLabel: version.label,
    status: "RUNNING",
    createdAt: nowIso(),
    createdBy: "current.user",
    overallScore: null,
    dimensions: [],
    correlation: { pearson: null, rmse: null, mae: null, tStat: null, pValue: null, n: 0 },
    totalLatency: { stage: "总延迟", mean: 0, p50: 0, p95: 0, missingRate: 0 },
    stageLatency: [],
    counts: { valid: 0, skipped: 0, failed: 0 },
    samples: [],
  };
  db.runs = [run, ...db.runs];

  setTimeout(() => {
    try {
      const result = computeRun(version.samples, params);
      Object.assign(run, result);
      run.status = result.counts.skipped > 0 ? "PARTIAL_SUCCEEDED" : "SUCCEEDED";
    } catch (err) {
      run.status = "FAILED";
      run.error = err instanceof Error ? err.message : "计算失败";
    }
  }, 2200);

  return delay(run, 400);
}

export function defaultParams(resultVersionId: string): RunParams {
  return {
    resultVersionId,
    calculatorVersion: CALCULATOR_VERSIONS[0]!,
    scale: "scale5",
    weights: { ...DEFAULT_WEIGHTS },
    scoreSource: "judge",
  };
}
