import { db, delay, fail, nowIso, uid } from "./store";
import type { LangfuseProject, PublishJob } from "@/types";

export async function listProjects(): Promise<LangfuseProject[]> {
  return delay(db.langfuseProjects, 350);
}

export async function listPublishJobs(datasetId?: string): Promise<PublishJob[]> {
  const jobs = datasetId ? db.publishJobs.filter((j) => j.datasetId === datasetId) : db.publishJobs;
  return delay(jobs.map((j) => ({ ...j })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

export async function getPublishJob(id: string): Promise<PublishJob> {
  const job = db.publishJobs.find((j) => j.id === id);
  if (!job) return fail(`发布任务 ${id} 不存在`);
  return delay({ ...job }, 250);
}

/** 幂等检查：同一版本是否已发布到同一目标 */
export async function checkIdempotency(
  versionId: string,
  langfuseDatasetName: string,
): Promise<PublishJob | null> {
  const found = db.publishJobs.find(
    (j) =>
      j.versionId === versionId &&
      j.langfuseDatasetName === langfuseDatasetName &&
      j.status !== "FAILED",
  );
  return delay(found ?? null, 300);
}

export async function createPublishJob(input: {
  datasetId: string;
  datasetName: string;
  versionId: string;
  version: string;
  sampleCount: number;
  projectName: string;
  langfuseDatasetName: string;
}): Promise<PublishJob> {
  if (!input.langfuseDatasetName.trim()) return fail("Langfuse Dataset 名称不能为空");
  const job: PublishJob = {
    id: uid("pub"),
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    versionId: input.versionId,
    version: input.version,
    langfuseProject: input.projectName,
    langfuseDatasetName: input.langfuseDatasetName,
    status: "QUEUED",
    progress: 0,
    total: input.sampleCount,
    succeeded: 0,
    failed: 0,
    createdAt: nowIso(),
    externalUrl: null,
    items: [],
  };
  db.publishJobs = [job, ...db.publishJobs];
  simulate(job);
  return delay({ ...job }, 400);
}

function simulate(job: PublishJob) {
  const steps = 8;
  let step = 0;
  job.status = "RUNNING";
  const timer = setInterval(() => {
    step += 1;
    job.progress = Math.min(job.total, Math.round((job.total * step) / steps));
    if (step >= steps) {
      clearInterval(timer);
      // 演示部分成功：样本数能被 7 整除时注入一条失败
      const failed = job.total % 7 === 0 ? 1 : 0;
      job.failed = failed;
      job.succeeded = job.total - failed;
      job.status = failed ? "PARTIAL_SUCCEEDED" : "SUCCEEDED";
      job.externalUrl = `https://cloud.langfuse.com/project/${job.langfuseProject}/datasets/${job.langfuseDatasetName}`;
      job.items = failed
        ? [{ sampleId: "S001", ok: false, reason: "上游 429 限流，重试 3 次后失败" }]
        : [];
    }
  }, 700);
}

export async function retryPublishJob(id: string): Promise<PublishJob> {
  const job = db.publishJobs.find((j) => j.id === id);
  if (!job) return fail(`发布任务 ${id} 不存在`);
  job.status = "QUEUED";
  job.progress = 0;
  job.succeeded = 0;
  job.failed = 0;
  job.items = [];
  delete job.error;
  simulate(job);
  return delay({ ...job }, 300);
}
