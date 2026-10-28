import {
  assertExecutionReady,
  validateDeliveryResults,
} from "./session-contract.js";
import { tool } from "langchain";
import { z } from "zod";
import { createProcessingRun, readProcessingRun } from "../processing/store.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { ExecutionStore } from "./execution-store.js";

/** R04 vertical slice: arguments and save target come from the saved authoritative requirements. */
export function workspaceTools(
  store: SessionStore,
  execution: ExecutionStore,
  proof: TurnProof,
  artifacts: ArtifactRepository,
  canWrite: boolean,
) {
  const schema = z.object({}).strict();
  const current = async () => {
    const task = await execution.processingGuard(proof);
    if (task.suspended) throw new SessionError("task_paused");
    const session = await store.get(proof, proof.sessionId);
    const d = assertExecutionReady(session.requirements);
    const snapshot = await store.freezeSource(proof, d.source);
    if (snapshot.sourceSnapshot.hash !== d.sourceSnapshot?.hash)
      throw new SessionError("source_revision_conflict");
    return { session, d };
  };
  const definitions = canWrite
    ? [
        {
          name: "read_task_progress",
          readOnly: true,
          description:
            "查询当前后台作业、保存回执和暂停状态。只读，不恢复、不重新提交。",
          run: async () => {
            const task = await execution.guard(proof);
            return {
              ...(await execution.projection(proof, proof.sessionId)),
              ...(task.suspended
                ? {
                    status: "paused",
                    message: "原任务保持暂停，查看进度不会继续执行。",
                  }
                : {}),
            };
          },
        },
        {
          name: "continue_task",
          readOnly: false,
          description:
            "仅在用户明确要求继续时，恢复原暂停任务，不新建处理、不重置预算、不更改要求。成功后用一句话说明已安排继续，不再调用其他工具。",
          run: async () => execution.requestResume(proof),
        },
        {
          name: "submit_processing",
          readOnly: false,
          description:
            "执行已经保存的单份清洗或改写方案，无参数。必须mode:execute，固定source.recordIds与count一致，allowedFields明确，saveTarget:newDraft。会创建真实后台作业，后续只用wait_processing等待，禁止重复提交。",
          run: async () => {
            const { session, d } = await current();
            const payload = {
              source: d.source,
              options: {
                operation: d.operation,
                instructions: d.instructions ?? "",
                allowedFields: d.allowedFields,
                ...(d.allowedFields!.includes("metadata") && d.metadataKeys
                  ? { metadataKeys: d.metadataKeys }
                  : {}),
              },
            };
            const op = await execution.operation(
              proof,
              "processing:" + d.id + ":" + session.requirements_revision,
              "processing",
              payload,
            );
            await execution.admitRows(
              proof,
              op.id,
              d.operation === "clean" && !(d.instructions ?? "").trim()
                ? d.source!.recordIds!.length
                : 0,
            );
            const result = await createProcessingRun(
              store.db,
              artifacts,
              execution.operationScope(proof, op),
              op.id,
              payload,
            );
            return result;
          },
        },
        {
          name: "prepare_adoption",
          readOnly: false,
          description:
            "为本次已完成的处理结果准备固定的保存确认卡，无参数。不会保存或代用户确认；必须随后wait_confirmation。保存目标从当前已保存要求取得。",
          run: async () => {
            const { session, d } = await current();
            const op = (
              await store.db.query(
                "SELECT * FROM assistant_runtime_operation WHERE session_id=$1 AND turn_id=$2 AND requirements_revision=$3 AND kind='processing' AND run_id IS NOT NULL ORDER BY id LIMIT 1",
                [proof.sessionId, proof.turnId, session.requirements_revision],
              )
            ).rows[0];
            if (!op) throw new SessionError("processing_not_submitted", 422);
            const data = await readProcessingRun(
              store.db,
              artifacts,
              proof,
              op.run_id,
              { limit: "10000" },
              true,
            );
            if (
              data.run.status !== "succeeded" ||
              data.records.length !== d.count
            )
              throw new SessionError("processing_not_complete", 422);
            validateDeliveryResults(
              d,
              data.records.map((r) => ({ ...r.result, id: r.id })),
              {
                operation: d.operation!,
                instructions: d.instructions ?? "",
                allowedFields: [],
              },
            );
            const adoption = await execution.operation(
              proof,
              "adopt:" + op.id,
              "adopt",
              {
                runId: op.run_id,
                input: {
                  resultIds: data.records.map((r) => r.id),
                  target: {
                    ...d.saveTarget,
                    purpose:
                      d.saveTarget?.kind === "newDraft"
                        ? (d.saveTarget.purpose ?? "")
                        : undefined,
                  },
                },
              },
            );
            return execution.prepare(proof, adoption);
          },
        },
      ]
    : [];
  return {
    schemas: new Map(definitions.map((d) => [d.name, schema])),
    readOnly: new Set(definitions.filter((d) => d.readOnly).map((d) => d.name)),
    tools: definitions.map((d) =>
      tool(d.run, { name: d.name, description: d.description, schema }),
    ),
  };
}
