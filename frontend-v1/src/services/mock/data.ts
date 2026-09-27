import {
  DIMENSIONS,
  type Dataset,
  type DatasetSample,
  type DatasetVersion,
  type EvaluatedResultVersion,
  type EvaluatedSample,
  type ImportJob,
  type LangfuseExperiment,
  type LangfuseProject,
  type PublishJob,
  type CalcRun,
  type DimensionKey,
  type ScaleType,
} from "@/types";

const QUESTIONS = [
  "近三年新能源汽车行业的市场集中度如何变化？",
  "帮我总结这份季度财报中的主要风险提示。",
  "对比 A 股与港股当前的估值水平并说明依据。",
  "解释一下当前央行公开市场操作对流动性的影响。",
  "医药板块最近一周的资金流向说明了什么？",
  "半导体设备国产化率目前处于什么阶段？",
  "如何判断某只个股的机构持仓变化趋势？",
  "请给出光伏产业链上下游的价格传导逻辑。",
  "美联储议息结果对国内债市有何传导路径？",
  "消费板块的复苏是否已经反映在估值中？",
  "请概述这家公司的核心竞争壁垒。",
  "近期人民币汇率波动的主要驱动因素是什么？",
];

const GRADES3 = ["优秀", "合格", "较差"];
const GRADES5 = ["满分", "优秀", "良好", "合格", "不合格"];

const REASONS = [
  "回答覆盖了核心结论并给出数据来源，逻辑链条完整。",
  "结论正确但缺少关键数据支撑，论证略显单薄。",
  "存在事实性偏差，引用的时间区间与问题不一致。",
  "表述专业，术语使用准确，符合研究报告语境。",
  "信息冗余较多，关键结论被淹没在铺垫中。",
  "时效性不足，引用了超过半年的旧数据。",
];

function seeded(i: number, mod: number) {
  return (i * 7919 + 104729) % mod;
}

function makeSamples(count: number, prefix: string): DatasetSample[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-S${String(i + 1).padStart(3, "0")}`,
    question: QUESTIONS[i % QUESTIONS.length]!,
    expected_output: `期望答案 ${i + 1}：应包含结论、数据来源与时间区间说明。`,
    metadata: {
      category: ["宏观", "行业", "个股", "策略"][seeded(i, 4)]!,
      difficulty: ["easy", "medium", "hard"][seeded(i, 3)]!,
    },
  }));
}

export const datasets: Dataset[] = [
  {
    id: "ds-001",
    name: "端到端问答基线集",
    description: "覆盖宏观、行业、个股三类问题的端到端回答质量评测集。",
    kind: "test_set",
    source: "file",
    owner: "chen.wei",
    status: "ACTIVE",
    currentVersion: "v2",
    sampleCount: 48,
    updatedAt: "2026-07-28T09:12:00Z",
    tags: ["端到端", "基线"],
  },
  {
    id: "ds-002",
    name: "投研摘要压力集",
    description: "长文摘要与多轮追问场景，用于检验信息效率与连贯性。",
    kind: "test_set",
    source: "file",
    owner: "li.hua",
    status: "ACTIVE",
    currentVersion: "v1",
    sampleCount: 24,
    updatedAt: "2026-07-19T03:40:00Z",
    tags: ["摘要", "压力"],
  },
  {
    id: "ds-003",
    name: "时效性专项集（草稿）",
    description: "尚未固化版本的草稿数据集。",
    kind: "evaluated_result",
    source: "langfuse_api",
    owner: "zhao.min",
    status: "ACTIVE",
    currentVersion: null,
    sampleCount: 0,
    updatedAt: "2026-08-02T11:05:00Z",
    tags: ["草稿"],
  },
  {
    id: "ds-004",
    name: "大规模回归集（10k）",
    description: "1 万条样本的回归评测集，用于验证服务端分页与异步任务。",
    kind: "test_set",
    source: "langfuse_export",
    owner: "chen.wei",
    status: "ACTIVE",
    currentVersion: "v3",
    sampleCount: 10000,
    updatedAt: "2026-08-04T02:15:00Z",
    tags: ["大规模", "回归"],
  },
  {
    id: "ds-005",
    name: "旧版意图集（已归档）",
    description: "历史遗留数据集，仅供追溯，不可作为计算输入。",
    kind: "evaluated_result",
    source: "file",
    owner: "li.hua",
    status: "ARCHIVED",
    currentVersion: "v1",
    sampleCount: 120,
    updatedAt: "2026-05-20T06:00:00Z",
    tags: ["归档"],
  },
];

export const datasetVersions: DatasetVersion[] = [
  {
    id: "dv-001",
    datasetId: "ds-001",
    version: "v1",
    contentHash: "sha256:1f3a9c0b7e",
    sampleCount: 36,
    createdAt: "2026-07-11T08:00:00Z",
    createdBy: "chen.wei",
    frozen: true,
    status: "READY",
    samples: makeSamples(36, "ds001v1"),
  },
  {
    id: "dv-002",
    datasetId: "ds-001",
    version: "v2",
    contentHash: "sha256:8b2d40fae1",
    sampleCount: 48,
    createdAt: "2026-07-28T09:12:00Z",
    createdBy: "chen.wei",
    frozen: true,
    status: "READY",
    isDefault: true,
    samples: makeSamples(48, "ds001v2"),
  },
  {
    id: "dv-003",
    datasetId: "ds-002",
    version: "v1",
    contentHash: "sha256:c40e17bb92",
    sampleCount: 24,
    createdAt: "2026-07-19T03:40:00Z",
    createdBy: "li.hua",
    frozen: true,
    status: "READY",
    isDefault: true,
    samples: makeSamples(24, "ds002v1"),
  },
];

export const langfuseProjects: LangfuseProject[] = [
  { id: "lf-prod", name: "agent-eval-prod", region: "EU" },
  { id: "lf-staging", name: "agent-eval-staging", region: "EU" },
  { id: "lf-sandbox", name: "agent-eval-sandbox", region: "US" },
];

export const publishJobs: PublishJob[] = [
  {
    id: "pub-001",
    datasetId: "ds-001",
    datasetName: "端到端问答基线集",
    versionId: "dv-002",
    version: "v2",
    langfuseProject: "agent-eval-prod",
    langfuseDatasetName: "e2e-baseline-v2",
    status: "SUCCEEDED",
    progress: 48,
    total: 48,
    succeeded: 48,
    failed: 0,
    createdAt: "2026-07-28T10:02:00Z",
    externalUrl: "https://cloud.langfuse.com/project/lf-prod/datasets/e2e-baseline-v2",
    items: [],
  },
  {
    id: "pub-002",
    datasetId: "ds-002",
    datasetName: "投研摘要压力集",
    versionId: "dv-003",
    version: "v1",
    langfuseProject: "agent-eval-staging",
    langfuseDatasetName: "summary-stress-v1",
    status: "PARTIAL_SUCCEEDED",
    progress: 24,
    total: 24,
    succeeded: 21,
    failed: 3,
    createdAt: "2026-07-19T05:10:00Z",
    externalUrl: "https://cloud.langfuse.com/project/lf-staging/datasets/summary-stress-v1",
    items: [
      { sampleId: "ds002v1-S004", ok: false, reason: "expectedOutput 超过长度上限（8000 字符）" },
      { sampleId: "ds002v1-S011", ok: false, reason: "metadata.category 含非法字符" },
      { sampleId: "ds002v1-S018", ok: false, reason: "上游 429 限流，重试 3 次后失败" },
    ],
  },
  {
    id: "pub-003",
    datasetId: "ds-001",
    datasetName: "端到端问答基线集",
    versionId: "dv-001",
    version: "v1",
    langfuseProject: "agent-eval-sandbox",
    langfuseDatasetName: "e2e-baseline-v1",
    status: "FAILED",
    progress: 0,
    total: 36,
    succeeded: 0,
    failed: 36,
    createdAt: "2026-07-11T09:20:00Z",
    externalUrl: null,
    items: [],
    error: "Langfuse 凭据无效（401 Unauthorized），请检查项目密钥配置。",
  },
];

export const experiments: LangfuseExperiment[] = [
  {
    id: "exp-9182",
    name: "e2e-baseline-v2 / gpt-judge-0725",
    projectId: "lf-prod",
    itemCount: 48,
    scoreCount: 336,
    completedAt: "2026-08-01T14:22:00Z",
    scaleHint: "scale5",
  },
  {
    id: "exp-9166",
    name: "e2e-baseline-v2 / human-panel-0722",
    projectId: "lf-prod",
    itemCount: 48,
    scoreCount: 312,
    completedAt: "2026-07-26T02:11:00Z",
    scaleHint: "scale3",
  },
  {
    id: "exp-8871",
    name: "summary-stress-v1 / judge-0719",
    projectId: "lf-staging",
    itemCount: 24,
    scoreCount: 154,
    completedAt: "2026-07-20T18:45:00Z",
    scaleHint: "scale5",
  },
];

function makeEvaluatedSamples(count: number, scale: ScaleType, prefix: string): EvaluatedSample[] {
  const grades = scale === "scale3" ? GRADES3 : GRADES5;
  return Array.from({ length: count }, (_, i) => {
    const human: Partial<Record<DimensionKey, string>> = {};
    const judge: Partial<Record<DimensionKey, string>> = {};
    const reasons: Partial<Record<DimensionKey, string>> = {};
    DIMENSIONS.forEach((dim, di) => {
      // 少量维度刻意缺失，用于验证缺失率与 N/A 显示
      const missHuman = (i + di) % 17 === 0;
      const missJudge = (i + di) % 23 === 0;
      if (!missHuman) human[dim] = grades[seeded(i * 7 + di, grades.length)]!;
      if (!missJudge) judge[dim] = grades[seeded(i * 11 + di * 3, grades.length)]!;
      reasons[dim] = REASONS[seeded(i * 5 + di, REASONS.length)]!;
    });
    const plan = 320 + seeded(i, 400);
    const exec = 900 + seeded(i * 3, 2400);
    const adjust = 120 + seeded(i * 5, 260);
    const answer = 600 + seeded(i * 7, 1100);
    return {
      id: `${prefix}-R${String(i + 1).padStart(3, "0")}`,
      traceId: `trace_${(1000000 + seeded(i * 13, 800000)).toString(16)}`,
      observationName: "answer-generation",
      question: QUESTIONS[i % QUESTIONS.length]!,
      expectedOutput:
        i % 5 === 0 ? null : `期望答案 ${i + 1}：应包含结论、数据来源与时间区间说明。`,
      actualOutput: `实际回答 ${i + 1}：给出了结论与三点论据，并附带数据区间与来源链接。`,
      humanScores: human,
      judgeScores: judge,
      reasons,
      latencyMs: plan + exec + adjust + answer,
      stageLatencyMs: { 规划: plan, 任务执行: exec, 计划调整: adjust, 答案生成: answer },
      traceUrl: `https://cloud.langfuse.com/project/lf-prod/traces/trace_${i + 1}`,
    };
  });
}

export const evaluatedVersions: EvaluatedResultVersion[] = [
  {
    id: "er-001",
    label: "evaluated_result v1 · exp-9182",
    importJobId: "imp-001",
    experimentName: "e2e-baseline-v2 / gpt-judge-0725",
    scale: "scale5",
    sampleCount: 48,
    createdAt: "2026-08-01T15:04:00Z",
    frozen: true,
    status: "READY",
    samples: makeEvaluatedSamples(48, "scale5", "er001"),
  },
  {
    id: "er-002",
    label: "evaluated_result v2 · exp-9166",
    importJobId: "imp-002",
    experimentName: "e2e-baseline-v2 / human-panel-0722",
    scale: "scale3",
    sampleCount: 48,
    createdAt: "2026-07-26T03:30:00Z",
    frozen: true,
    status: "READY",
    samples: makeEvaluatedSamples(48, "scale3", "er002"),
  },
];

export const importJobs: ImportJob[] = [
  {
    id: "imp-001",
    experimentId: "exp-9182",
    experimentName: "e2e-baseline-v2 / gpt-judge-0725",
    projectId: "lf-prod",
    projectName: "agent-eval-prod",
    status: "SUCCEEDED",
    createdAt: "2026-08-01T15:00:00Z",
    sampleCount: 48,
    failedCount: 0,
    failures: [],
    resultVersionId: "er-001",
  },
  {
    id: "imp-002",
    experimentId: "exp-9166",
    experimentName: "e2e-baseline-v2 / human-panel-0722",
    projectId: "lf-prod",
    projectName: "agent-eval-prod",
    status: "PARTIAL_SUCCEEDED",
    createdAt: "2026-07-26T03:24:00Z",
    sampleCount: 48,
    failedCount: 2,
    failures: [
      { sampleId: "er002-R012", reason: "缺少 trace_id，无法关联 Observation" },
      { sampleId: "er002-R031", reason: "score name 未匹配任何已知维度" },
    ],
    resultVersionId: "er-002",
  },
  {
    id: "imp-003",
    experimentId: "exp-8871",
    experimentName: "summary-stress-v1 / judge-0719",
    projectId: "lf-staging",
    projectName: "agent-eval-staging",
    status: "FAILED",
    createdAt: "2026-07-20T19:02:00Z",
    sampleCount: 0,
    failedCount: 24,
    failures: [],
    resultVersionId: null,
  },
];

export const initialRuns: CalcRun[] = [];
