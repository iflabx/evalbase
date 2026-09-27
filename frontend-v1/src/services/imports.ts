import { db, delay, fail, nowIso, uid } from "./store";
import { DIMENSIONS } from "@/types";
import type {
  EvaluatedResultVersion,
  ImportJob,
  LangfuseExperiment,
  PreflightReport,
} from "@/types";

export async function listExperiments(
  projectId: string,
  query = "",
): Promise<LangfuseExperiment[]> {
  const items = db.experiments.filter(
    (e) => e.projectId === projectId && e.name.toLowerCase().includes(query.toLowerCase()),
  );
  return delay(items, 600);
}

export async function preflight(experimentId: string): Promise<PreflightReport> {
  const exp = db.experiments.find((e) => e.id === experimentId);
  if (!exp) return fail(`Experiment ${experimentId} 不存在`);
  if (exp.id === "exp-8871") {
    return fail("预检失败：该 Experiment 的 score 名称无法映射到任何七维字段");
  }
  const coverage = DIMENSIONS.map((dimension, i) => ({
    dimension,
    covered: Math.max(0, exp.itemCount - ((i * 3) % 5)),
    total: exp.itemCount,
  }));
  return delay(
    {
      experimentId,
      detectedScale: exp.scaleHint,
      coverage,
      traceCoverage: 1,
      observationCoverage: 0.94,
      issues: [
        {
          row: 12,
          field: "trace_id",
          level: "warning" as const,
          message: "缺少 trace_id，将无法关联阶段延迟",
        },
      ],
    },
    700,
  );
}

export async function listImportJobs(): Promise<ImportJob[]> {
  return delay(
    db.importJobs.map((j) => ({ ...j })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export async function getImportJob(id: string): Promise<ImportJob> {
  const job = db.importJobs.find((j) => j.id === id);
  if (!job) return fail(`导入任务 ${id} 不存在`);
  return delay({ ...job }, 250);
}

export async function listEvaluatedVersions(): Promise<EvaluatedResultVersion[]> {
  return delay([...db.evaluatedVersions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

export async function getEvaluatedVersion(id: string): Promise<EvaluatedResultVersion> {
  const v = db.evaluatedVersions.find((x) => x.id === id);
  if (!v) return fail(`评测结果版本 ${id} 不存在`);
  return delay(v, 300);
}

export async function createImportJob(input: {
  experimentId: string;
  projectId: string;
}): Promise<ImportJob> {
  const exp = db.experiments.find((e) => e.id === input.experimentId);
  const project = db.langfuseProjects.find((p) => p.id === input.projectId);
  if (!exp || !project) return fail("Experiment 或项目不存在");

  const job: ImportJob = {
    id: uid("imp"),
    experimentId: exp.id,
    experimentName: exp.name,
    projectId: project.id,
    projectName: project.name,
    status: "RUNNING",
    createdAt: nowIso(),
    sampleCount: 0,
    failedCount: 0,
    failures: [],
    resultVersionId: null,
  };
  db.importJobs = [job, ...db.importJobs];

  // 复用一份既有样本作为导入结果，固化为不可变版本
  const template = db.evaluatedVersions.find((v) => v.scale === exp.scaleHint);
  setTimeout(() => {
    if (!template) {
      job.status = "FAILED";
      job.failedCount = exp.itemCount;
      return;
    }
    const versionId = uid("er");
    const failures =
      exp.itemCount % 2 === 0
        ? []
        : [{ sampleId: `${versionId}-R007`, reason: "score name 未匹配任何已知维度" }];
    const samples = template.samples.slice(0, exp.itemCount);
    db.evaluatedVersions = [
      {
        id: versionId,
        label: `evaluated_result · ${exp.id}`,
        importJobId: job.id,
        experimentName: exp.name,
        scale: exp.scaleHint,
        sampleCount: samples.length,
        createdAt: nowIso(),
        frozen: true,
        status: "READY",
        samples,
      },
      ...db.evaluatedVersions,
    ];
    job.sampleCount = samples.length;
    job.failures = failures;
    job.failedCount = failures.length;
    job.status = failures.length ? "PARTIAL_SUCCEEDED" : "SUCCEEDED";
    job.resultVersionId = versionId;
  }, 2600);

  return delay({ ...job }, 400);
}
