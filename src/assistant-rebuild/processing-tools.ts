import { tool } from "langchain";
import { z } from "zod";
import { canonicalJson, sha256 } from "../package/contract.js";
import {
  listProcessingTasks,
  readProcessingTask,
  previewTaskInput,
  processingTaskHistory,
  createProcessingTaskRound,
  deduplicateTask,
} from "../processing/tasks.js";
import { controlProcessingRun, getProcessingRun } from "../processing/store.js";
import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { ExecutionStore } from "./execution-store.js";
import type { ArtifactRepository } from "../storage/artifacts.js";

const id = z.string().min(1).max(250);
const options = z
  .object({
    operation: z.enum(["clean", "rewrite", "augment", "generate"]),
    instructions: z.string().max(8000),
    allowedFields: z
      .array(z.enum(["question", "expectedOutput", "metadata"]))
      .min(1)
      .max(3),
    metadataKeys: z.array(z.string().max(250)).max(100).optional(),
    outputCount: z.number().int().min(1).max(10000).optional(),
    scenarios: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict();
const target = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("newDraft"),
      name: z.string().min(1).max(200),
      purpose: z.string().max(2000).default(""),
    })
    .strict(),
  z.object({ kind: z.literal("asset") }).strict(),
  z
    .object({
      kind: z.literal("draft"),
      id,
      expectedRevision: z.number().int().min(0),
    })
    .strict(),
]);
export function processingTools(
  store: SessionStore,
  execution: ExecutionStore,
  proof: TurnProof,
  artifacts: ArtifactRepository,
  canWrite: boolean,
  waits: {
    processing: () => Promise<unknown>;
    confirmation: () => Promise<unknown>;
  },
) {
  const mutable = async () => {
    await store.access(proof, true);
    const state = await execution.processingGuard(proof);
    if (state.suspended) throw new SessionError("task_paused");
  };
  const defs: {
    name: string;
    description: string;
    schema: z.ZodType;
    readOnly: boolean;
    run: (a: any) => Promise<any>;
  }[] = canWrite
    ? [
        {
          name: "list_processing_tasks",
          description: "列出当前项目真实处理任务，支持搜索、状态和分页。",
          readOnly: true,
          schema: z
            .object({
              search: z.string().max(200).optional(),
              status: z
                .enum(["all", "active", "complete", "attention", "cancelled"])
                .optional(),
              offset: z.number().int().min(0).default(0),
              limit: z.number().int().min(1).max(100).default(20),
            })
            .strict(),
          run: (a) =>
            listProcessingTasks(store.db, artifacts, proof, {
              ...a,
              offset: String(a.offset),
              limit: String(a.limit),
            }),
        },
        {
          name: "read_processing_task",
          description:
            "读取真实任务当前结果、候选ID、Metadata、来源、保存状态与结构核对；view可筛选，不把当前页当全部。",
          readOnly: true,
          schema: z
            .object({
              taskId: id,
              search: z.string().max(200).optional(),
              view: z
                .enum(["all", "changed", "duplicates", "issues"])
                .optional(),
              offset: z.number().int().min(0).default(0),
              limit: z.number().int().min(1).max(100).default(20),
            })
            .strict(),
          run: async ({ taskId, ...a }) => {
            const result = await readProcessingTask(
              store.db,
              artifacts,
              proof,
              taskId,
              { ...a, offset: String(a.offset), limit: String(a.limit) },
            );
            return {
              ...result,
              nativeAction: {
                kind: "navigation",
                name: "查看处理任务",
                href: `/projects/${proof.projectId}/processing?run=${encodeURIComponent(result.run.id)}`,
              },
            };
          },
        },
        {
          name: "read_processing_history",
          description: "读取指定任务各历史轮次，历史只读。",
          readOnly: true,
          schema: z
            .object({
              taskId: id,
              offset: z.number().int().min(0).default(0),
              limit: z.number().int().min(1).max(100).default(20),
            })
            .strict(),
          run: (a) =>
            processingTaskHistory(store.db, artifacts, proof, a.taskId, {
              offset: String(a.offset),
              limit: String(a.limit),
            }),
        },
        {
          name: "preview_processing_round",
          description:
            "预览继续当前结果/原冻结输入重跑/基于已保存范围继续的真实输入、可用性及任务修订，不执行。",
          readOnly: true,
          schema: z
            .object({
              taskId: id,
              mode: z.enum(["continue", "rerun", "saved"]),
              search: z.string().max(200).optional(),
              conditions: z
                .array(
                  z
                    .object({
                      field: z.enum(["question", "expectedOutput", "metadata"]),
                      key: z.string().max(250).optional(),
                      operator: z.enum([
                        "contains",
                        "equals",
                        "empty",
                        "filled",
                      ]),
                      value: z.string().max(1000).optional(),
                    })
                    .strict(),
                )
                .max(100)
                .optional(),
              resultIds: z.array(id).max(10000).optional(),
              offset: z.number().int().min(0).default(0),
              limit: z.number().int().min(1).max(100).default(20),
            })
            .strict(),
          run: ({ taskId, ...a }) =>
            previewTaskInput(store.db, artifacts, proof, taskId, {
              ...a,
              offset: String(a.offset),
              limit: String(a.limit),
            }),
        },
        {
          name: "submit_processing_round",
          description:
            "提交同一任务新轮次：continue仅所选未保存结果，未选保留；rerun重跑完整冻结输入；saved基于已保存草稿真实范围；complete只补缺且不传options/resultIds。必须先读任务核对expectedRevision，已有成功部分不得重试。自动持久等待。",
          readOnly: false,
          schema: z
            .object({
              taskId: id,
              expectedRevision: z.number().int().min(0),
              mode: z.enum(["continue", "rerun", "saved", "complete"]),
              resultIds: z.array(id).min(1).max(10000).optional(),
              options: options.optional(),
            })
            .strict(),
          run: async ({ taskId, ...body }) => {
            const key =
              "round:" +
              taskId +
              ":" +
              proof.turnId +
              ":" +
              sha256(canonicalJson(body));
            const submitted = (
              await store.db.query(
                "SELECT run_id FROM assistant_runtime_operation WHERE session_id=$1 AND operation_key=$2",
                [proof.sessionId, key],
              )
            ).rows[0];
            if (!submitted?.run_id)
              await execution.beginProcessingRound(proof, taskId);
            const op = await execution.operation(proof, key, "processing", {
              taskId,
              ...body,
            });
            const result = await createProcessingTaskRound(
              store.db,
              artifacts,
              execution.operationScope(proof, op),
              taskId,
              op.id,
              body,
            );
            await waits.processing();
            return result;
          },
        },
        {
          name: "deduplicate_processing_task",
          description:
            "预览指定结果的精确重复组；action:exclude排除重复候选、restore恢复排除。操作只影响候选，不删除原始数据。写操作必须用读取到的expectedRevision。",
          readOnly: false,
          schema: z
            .object({
              taskId: id,
              resultIds: z.array(id).min(1).max(10000).optional(),
              action: z.enum(["exclude", "restore"]).optional(),
              expectedRevision: z.number().int().min(0).optional(),
            })
            .strict(),
          run: async ({ taskId, ...body }) => {
            if (!body.action)
              return deduplicateTask(store.db, artifacts, proof, taskId, body);
            await mutable();
            const op = await execution.operation(
              proof,
              "dedup:" + taskId + ":" + sha256(canonicalJson(body)),
              "processing_mutation",
              { taskId, ...body },
            );
            return deduplicateTask(
              store.db,
              artifacts,
              execution.operationScope(proof, op),
              taskId,
              body,
            );
          },
        },
        {
          name: "control_processing_run",
          description:
            "按用户明确要求取消运行或重试失败批次；保留成功部分，不能用重跑代替失败重试。助手暂停另用停止任务。",
          readOnly: false,
          schema: z
            .object({ runId: id, action: z.enum(["cancel", "retry"]) })
            .strict(),
          run: async (a) => {
            const run = await getProcessingRun(store.db, proof, a.runId);
            const other = (
              await store.db.query(
                "SELECT session_id FROM assistant_runtime_operation WHERE run_id=$1 AND kind='processing' LIMIT 1",
                [a.runId],
              )
            ).rows[0];
            if (other && other.session_id !== proof.sessionId)
              throw new SessionError("processing_run_not_owned");
            const key =
              "control:" + proof.turnId + ":" + a.runId + ":" + a.action;
            const submitted = (
              await store.db.query(
                "SELECT run_id FROM assistant_runtime_operation WHERE session_id=$1 AND operation_key=$2",
                [proof.sessionId, key],
              )
            ).rows[0];
            if (a.action === "retry") {
              if (!submitted?.run_id)
                await execution.beginProcessingRound(
                  proof,
                  (run as any).task_id,
                );
            } else await mutable();
            const op = await execution.operation(
              proof,
              key,
              a.action === "retry" ? "processing" : "processing_control",
              { taskId: (run as any).task_id, ...a },
            );
            if (a.action === "retry" && submitted?.run_id) {
              await waits.processing();
              return { runId: submitted.run_id, reused: true };
            }
            const result = await controlProcessingRun(
              store.db,
              execution.operationScope(proof, op),
              a.runId,
              a.action,
            );
            if (a.action === "retry") await waits.processing();
            return result;
          },
        },
        {
          name: "prepare_processing_task_save",
          description:
            "为任务当前明确选中的结果准备固定保存确认。先读任务取得真实结果ID/expectedRevision；target可原草稿、已有草稿、新草稿或原始数据，草稿修订必须来自可信读取。不自动同意。",
          readOnly: false,
          schema: z
            .object({
              taskId: id,
              expectedRevision: z.number().int().min(0),
              resultIds: z.array(id).min(1).max(10000),
              target,
            })
            .strict(),
          run: async ({ taskId, ...input }) => {
            await mutable();
            const task = await readProcessingTask(
              store.db,
              artifacts,
              proof,
              taskId,
              { limit: "1" },
            );
            const op = await execution.operation(
              proof,
              "task-save:" +
                taskId +
                ":" +
                proof.turnId +
                ":" +
                sha256(canonicalJson(input)),
              "adopt",
              { taskId, runId: task.run.id, input },
            );
            const card = await execution.prepare(proof, op);
            await waits.confirmation();
            return card;
          },
        },
      ]
    : [];
  return {
    schemas: new Map(defs.map((d) => [d.name, d.schema])),
    readOnly: new Set(defs.filter((d) => d.readOnly).map((d) => d.name)),
    tools: defs.map((d) =>
      tool(
        async (args) => {
          await store.guard(proof, !d.readOnly);
          const reading =
            d.readOnly ||
            (d.name === "deduplicate_processing_task" && !(args as any).action);
          if (!reading && (args as any).taskId)
            await store.processingRead(proof, [(args as any).taskId]);
          const result = await d.run(args);
          if (reading) {
            const tasks =
              d.name === "list_processing_tasks"
                ? (result.runs ?? []).map((row: any) => row.id)
                : (args as any).taskId
                  ? [(args as any).taskId]
                  : [];
            if (tasks.length) await store.processingRead(proof, tasks);
            if (d.name === "preview_processing_round" && result.source)
              await store.event(proof, "source_read", {
                source: result.source,
              });
          }
          return result;
        },
        {
          name: d.name,
          description: d.description,
          schema: d.schema,
        },
      ),
    ),
  };
}
