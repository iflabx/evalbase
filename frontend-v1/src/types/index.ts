// 领域类型定义（MVP：数据集 / 发布 / 导入 / 端到端计算）

/** 作业状态：与后端契约一致的正式枚举 */
export type JobStatus =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIAL_SUCCEEDED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED";

/** 数据集类型：test_set 只能发布到 Langfuse；evaluated_result 才能进入端到端计算 */
export type DatasetKind = "test_set" | "evaluated_result";

export const DATASET_KIND_LABELS: Record<DatasetKind, string> = {
  test_set: "测试集",
  evaluated_result: "评测结果集",
};

/** 数据集版本状态机 */
export type VersionStatus = "DRAFT" | "VALIDATING" | "READY" | "INVALID" | "ARCHIVED";

export const VERSION_STATUS_LABELS: Record<VersionStatus, string> = {
  DRAFT: "草稿",
  VALIDATING: "校验中",
  READY: "已固化可用",
  INVALID: "校验未通过",
  ARCHIVED: "已归档",
};

export type DatasetStatus = "ACTIVE" | "ARCHIVED";
export type DatasetSource = "file" | "langfuse_api" | "langfuse_export";

export const DATASET_SOURCE_LABELS: Record<DatasetSource, string> = {
  file: "文件导入",
  langfuse_api: "Langfuse API",
  langfuse_export: "Langfuse 导出文件",
};

export type UserRole = "admin" | "analyst" | "viewer";

export const DIMENSIONS = [
  "information_efficiency",
  "professionalism",
  "accuracy",
  "timeliness",
  "relevance",
  "engagingness",
  "coherence",
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  information_efficiency: "信息效率",
  professionalism: "专业性",
  accuracy: "准确性",
  timeliness: "时效性",
  relevance: "相关性",
  engagingness: "吸引力",
  coherence: "连贯性",
};

export const DEFAULT_WEIGHTS: Record<DimensionKey, number> = {
  information_efficiency: 0.1,
  professionalism: 0.2,
  accuracy: 0.3,
  timeliness: 0.15,
  relevance: 0.1,
  engagingness: 0.05,
  coherence: 0.1,
};

export type ScaleType = "scale3" | "scale5";

/** 3 级 / 5 级量表的等级 -> 映射值 */
export const SCALE_MAPS: Record<ScaleType, Record<string, number>> = {
  scale3: { 优秀: 1, 合格: 0.5, 较差: 0 },
  scale5: { 满分: 1, 优秀: 0.75, 良好: 0.5, 合格: 0.25, 不合格: 0 },
};

// ---------- 数据集 ----------

export interface DatasetSample {
  id: string;
  question: string;
  expected_output: string;
  metadata: Record<string, string>;
}

export interface ValidationIssue {
  row: number;
  field: string;
  level: "error" | "warning";
  message: string;
}

export interface DatasetVersion {
  id: string;
  datasetId: string;
  version: string;
  contentHash: string;
  sampleCount: number;
  createdAt: string;
  createdBy: string;
  frozen: true;
  /** 版本状态机：只有 READY 版本可用于发布或计算 */
  status: VersionStatus;
  isDefault?: boolean;
  samples: DatasetSample[];
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  kind: DatasetKind;
  source: DatasetSource;
  owner: string;
  status: DatasetStatus;
  currentVersion: string | null;
  sampleCount: number;
  updatedAt: string;
  tags: string[];
}

export type FieldTarget = "question" | "expected_output" | "metadata" | "ignore";

export interface FieldMapping {
  sourceColumn: string;
  target: FieldTarget;
  metadataKey?: string;
}

export interface ParsedFile {
  fileName: string;
  format: "csv" | "jsonl";
  columns: string[];
  rows: Record<string, string>[];
}

// ---------- 发布到 Langfuse ----------

export interface PublishItemResult {
  sampleId: string;
  ok: boolean;
  reason?: string;
}

export interface PublishJob {
  id: string;
  datasetId: string;
  datasetName: string;
  versionId: string;
  version: string;
  langfuseProject: string;
  langfuseDatasetName: string;
  status: JobStatus;
  progress: number;
  total: number;
  succeeded: number;
  failed: number;
  createdAt: string;
  externalUrl: string | null;
  items: PublishItemResult[];
  error?: string;
}

export interface LangfuseProject {
  id: string;
  name: string;
  region: string;
}

// ---------- 导入 Experiment ----------

export interface LangfuseExperiment {
  id: string;
  name: string;
  projectId: string;
  itemCount: number;
  scoreCount: number;
  completedAt: string;
  scaleHint: ScaleType;
}

export interface PreflightReport {
  experimentId: string;
  detectedScale: ScaleType;
  coverage: { dimension: DimensionKey; covered: number; total: number }[];
  traceCoverage: number;
  observationCoverage: number;
  issues: ValidationIssue[];
}

export interface EvaluatedSample {
  id: string;
  traceId: string;
  observationName: string;
  question: string;
  expectedOutput: string | null;
  actualOutput: string;
  humanScores: Partial<Record<DimensionKey, string>>;
  judgeScores: Partial<Record<DimensionKey, string>>;
  reasons: Partial<Record<DimensionKey, string>>;
  latencyMs: number;
  stageLatencyMs: Record<string, number>;
  traceUrl: string;
}

export interface ImportJob {
  id: string;
  experimentId: string;
  experimentName: string;
  projectId: string;
  projectName: string;
  status: JobStatus;
  createdAt: string;
  sampleCount: number;
  failedCount: number;
  failures: { sampleId: string; reason: string }[];
  resultVersionId: string | null;
}

export interface EvaluatedResultVersion {
  id: string;
  label: string;
  importJobId: string;
  experimentName: string;
  scale: ScaleType;
  sampleCount: number;
  createdAt: string;
  frozen: true;
  status: VersionStatus;
  samples: EvaluatedSample[];
}

// ---------- 计算运行 ----------

export interface RunParams {
  resultVersionId: string;
  calculatorVersion: string;
  scale: ScaleType;
  weights: Record<DimensionKey, number>;
  scoreSource: "human" | "judge";
}

export interface DimensionResult {
  dimension: DimensionKey;
  score: number | null;
  validCount: number;
  missingRate: number;
}

export interface StageLatency {
  stage: string;
  mean: number;
  p50: number;
  p95: number;
  missingRate: number;
}

export interface CorrelationStats {
  pearson: number | null;
  rmse: number | null;
  mae: number | null;
  tStat: number | null;
  pValue: number | null;
  n: number;
  note?: string;
}

export interface SampleResult {
  sampleId: string;
  traceId: string;
  question: string;
  expectedOutput: string | null;
  actualOutput: string;
  dimensionValues: Partial<Record<DimensionKey, number | null>>;
  weightedScore: number | null;
  reasons: Partial<Record<DimensionKey, string>>;
  latencyMs: number;
  traceUrl: string;
  status: "valid" | "skipped" | "failed";
}

export interface CalcRun {
  id: string;
  name: string;
  params: RunParams;
  resultVersionLabel: string;
  status: JobStatus;
  createdAt: string;
  createdBy: string;
  overallScore: number | null;
  dimensions: DimensionResult[];
  correlation: CorrelationStats;
  totalLatency: StageLatency;
  stageLatency: StageLatency[];
  counts: { valid: number; skipped: number; failed: number };
  samples: SampleResult[];
  error?: string;
}
