import {
  DIMENSIONS,
  SCALE_MAPS,
  type CalcRun,
  type CorrelationStats,
  type DimensionKey,
  type DimensionResult,
  type EvaluatedSample,
  type RunParams,
  type SampleResult,
  type StageLatency,
} from "@/types";

/** 等级 -> 映射值；无法识别返回 null（缺失，不填 0） */
export function mapGrade(scale: RunParams["scale"], grade?: string): number | null {
  if (!grade) return null;
  const value = SCALE_MAPS[scale][grade];
  return value === undefined ? null : value;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null; // 常量序列，无定义
  return num / Math.sqrt(da * db);
}

function pairedTTest(a: number[], b: number[]): { t: number | null; p: number | null } {
  const n = a.length;
  if (n < 2) return { t: null, p: null };
  const diffs = a.map((v, i) => v - b[i]!);
  const md = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - md) ** 2, 0) / (n - 1));
  if (sd === 0) return { t: null, p: null };
  const t = md / (sd / Math.sqrt(n));
  // 正态近似的双尾 p 值（展示用途足够）
  const z = Math.abs(t);
  const p = 2 * (1 - normalCdf(z));
  return { t, p };
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 近似
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const prob =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - prob;
}

export function computeRun(
  samples: EvaluatedSample[],
  params: RunParams,
): Pick<
  CalcRun,
  | "overallScore"
  | "dimensions"
  | "correlation"
  | "totalLatency"
  | "stageLatency"
  | "counts"
  | "samples"
> {
  const source = params.scoreSource;

  const sampleResults: SampleResult[] = samples.map((s) => {
    const grades = source === "human" ? s.humanScores : s.judgeScores;
    const dimensionValues: Partial<Record<DimensionKey, number | null>> = {};
    let weighted = 0;
    let weightSum = 0;
    for (const dim of DIMENSIONS) {
      const v = mapGrade(params.scale, grades[dim]);
      dimensionValues[dim] = v;
      if (v !== null) {
        weighted += v * params.weights[dim];
        weightSum += params.weights[dim];
      }
    }
    const hasAny = weightSum > 0;
    return {
      sampleId: s.id,
      traceId: s.traceId,
      question: s.question,
      expectedOutput: s.expectedOutput,
      actualOutput: s.actualOutput,
      dimensionValues,
      weightedScore: hasAny ? weighted / weightSum : null,
      reasons: s.reasons,
      latencyMs: s.latencyMs,
      traceUrl: s.traceUrl,
      status: hasAny ? "valid" : "skipped",
    };
  });

  const dimensions: DimensionResult[] = DIMENSIONS.map((dim) => {
    const values = sampleResults
      .map((r) => r.dimensionValues[dim])
      .filter((v): v is number => typeof v === "number");
    return {
      dimension: dim,
      score: values.length ? mean(values) : null,
      validCount: values.length,
      missingRate: samples.length ? 1 - values.length / samples.length : 0,
    };
  });

  // 总体分：Σ(维度分 × 权重)，缺失维度从权重中剔除后归一化
  let overallNum = 0;
  let overallWeight = 0;
  for (const d of dimensions) {
    if (d.score !== null) {
      overallNum += d.score * params.weights[d.dimension];
      overallWeight += params.weights[d.dimension];
    }
  }
  const overallScore = overallWeight > 0 ? overallNum / overallWeight : null;

  // 人机对比：仅在同一样本同时有人工与 Judge 评分时统计
  const humanVals: number[] = [];
  const judgeVals: number[] = [];
  for (const s of samples) {
    for (const dim of DIMENSIONS) {
      const h = mapGrade(params.scale, s.humanScores[dim]);
      const j = mapGrade(params.scale, s.judgeScores[dim]);
      if (h !== null && j !== null) {
        humanVals.push(h);
        judgeVals.push(j);
      }
    }
  }
  const n = humanVals.length;
  let correlation: CorrelationStats;
  if (n < 3) {
    correlation = {
      pearson: null,
      rmse: null,
      mae: null,
      tStat: null,
      pValue: null,
      n,
      note: "配对样本不足（<3），指标无定义",
    };
  } else {
    const diffs = humanVals.map((v, i) => v - judgeVals[i]!);
    const r = pearson(humanVals, judgeVals);
    const { t, p } = pairedTTest(humanVals, judgeVals);
    correlation = {
      pearson: r,
      rmse: Math.sqrt(mean(diffs.map((d) => d * d))),
      mae: mean(diffs.map(Math.abs)),
      tStat: t,
      pValue: p,
      n,
      ...(r === null ? { note: "存在常量序列，Pearson 无定义" } : {}),
    };
  }

  const latencies = samples.map((s) => s.latencyMs).filter((v) => v > 0);
  const totalLatency: StageLatency = {
    stage: "总延迟",
    mean: latencies.length ? mean(latencies) : 0,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    missingRate: samples.length ? 1 - latencies.length / samples.length : 0,
  };

  const stageNames = Array.from(new Set(samples.flatMap((s) => Object.keys(s.stageLatencyMs))));
  const stageLatency: StageLatency[] = stageNames.map((stage) => {
    const vals = samples
      .map((s) => s.stageLatencyMs[stage])
      .filter((v): v is number => typeof v === "number");
    return {
      stage,
      mean: vals.length ? mean(vals) : 0,
      p50: percentile(vals, 50),
      p95: percentile(vals, 95),
      missingRate: samples.length ? 1 - vals.length / samples.length : 0,
    };
  });

  return {
    overallScore,
    dimensions,
    correlation,
    totalLatency,
    stageLatency,
    counts: {
      valid: sampleResults.filter((r) => r.status === "valid").length,
      skipped: sampleResults.filter((r) => r.status === "skipped").length,
      failed: sampleResults.filter((r) => r.status === "failed").length,
    },
    samples: sampleResults,
  };
}
