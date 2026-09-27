/**
 * 活动记录与报告中心（Mock 数据服务层）
 * 数据由既有导入 / 发布 / 计算任务派生，后续可替换为审计 API。
 */
import { db, delay, fail } from "./store";
import type { JobStatus } from "@/types";

export type ActivityType = "import" | "publish" | "run" | "export";

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  title: string;
  status: JobStatus;
  actor: string;
  createdAt: string;
  target: string;
  href: string;
}

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  import: "导入",
  publish: "发布",
  run: "计算",
  export: "导出",
};

export async function listActivity(filter?: {
  type?: ActivityType | "all";
  status?: JobStatus | "all";
}): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [
    ...db.importJobs.map((j) => ({
      id: `act-${j.id}`,
      type: "import" as const,
      title: `导入 Experiment ${j.experimentName}`,
      status: j.status,
      actor: "chen.wei",
      createdAt: j.createdAt,
      target: j.experimentId,
      href: `/imports/${j.id}`,
    })),
    ...db.publishJobs.map((j) => ({
      id: `act-${j.id}`,
      type: "publish" as const,
      title: `发布 ${j.datasetName} ${j.version} → ${j.langfuseDatasetName}`,
      status: j.status,
      actor: "li.hua",
      createdAt: j.createdAt,
      target: j.langfuseDatasetName,
      href: `/publishes/${j.id}`,
    })),
    ...db.runs.map((r) => ({
      id: `act-${r.id}`,
      type: "run" as const,
      title: `端到端计算 ${r.name}`,
      status: r.status,
      actor: r.createdBy,
      createdAt: r.createdAt,
      target: r.resultVersionLabel,
      href: `/runs/${r.id}`,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const filtered = events.filter(
    (e) =>
      (!filter?.type || filter.type === "all" || e.type === filter.type) &&
      (!filter?.status || filter.status === "all" || e.status === filter.status),
  );
  return delay(filtered, 400);
}

export type ReportFormat = "csv" | "json" | "markdown";
export type ReportState = "GENERATING" | "READY" | "FAILED" | "EXPIRED";

export interface ReportRecord {
  id: string;
  runId: string;
  runName: string;
  format: ReportFormat;
  state: ReportState;
  createdAt: string;
  expiresAt: string;
  sizeKb: number;
  error?: string;
}

const reports: ReportRecord[] = [];

export async function listReports(): Promise<ReportRecord[]> {
  const derived: ReportRecord[] = db.runs
    .filter((r) => r.status === "SUCCEEDED" || r.status === "PARTIAL_SUCCEEDED")
    .map((r, i) => ({
      id: `rep-${r.id}`,
      runId: r.id,
      runName: r.name,
      format: (["csv", "json", "markdown"] as const)[i % 3]!,
      state: (i % 4 === 3 ? "EXPIRED" : "READY") as ReportState,
      createdAt: r.createdAt,
      expiresAt: "2026-09-01T00:00:00Z",
      sizeKb: 40 + i * 13,
    }));
  return delay(
    [...reports, ...derived].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    400,
  );
}

/** 生成报告：异步任务，前端只触发与展示状态 */
export async function requestReport(runId: string, format: ReportFormat): Promise<ReportRecord> {
  const run = db.runs.find((r) => r.id === runId);
  if (!run) return fail(`计算运行 ${runId} 不存在`);
  const rec: ReportRecord = {
    id: `rep-${runId}-${format}-${reports.length + 1}`,
    runId,
    runName: run.name,
    format,
    state: "GENERATING",
    createdAt: new Date().toISOString(),
    expiresAt: "2026-09-01T00:00:00Z",
    sizeKb: 0,
  };
  reports.unshift(rec);
  setTimeout(() => {
    rec.state = "READY";
    rec.sizeKb = 64;
  }, 2000);
  return delay({ ...rec }, 300);
}

export interface CalculatorInfo {
  id: string;
  name: string;
  description: string;
  versions: string[];
  inputKind: "evaluated_result";
  metrics: string[];
  status: "available" | "coming_soon";
}

export async function listCalculators(): Promise<CalculatorInfo[]> {
  return delay(
    [
      {
        id: "e2e-quality",
        name: "端到端质量计算器",
        description: "对 evaluated_result 版本计算七维得分与加权总分，并输出人机一致性与延迟统计。",
        versions: ["e2e-quality@1.0.0", "e2e-quality@1.1.0-rc1"],
        inputKind: "evaluated_result" as const,
        metrics: [
          "信息效率",
          "专业性",
          "准确性",
          "时效性",
          "相关性",
          "吸引力",
          "连贯性",
          "加权总分",
          "Pearson / RMSE / MAE",
          "延迟 Mean / P50 / P95",
        ],
        status: "available" as const,
      },
    ],
    350,
  );
}
