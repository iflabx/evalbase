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

/** Stable delivery identities select work; all data changes remain in the shared processing services. */
export function workspaceTools(
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
  const empty = z.object({}).strict();
  const selection = z
    .object({ deliveryId: z.string().min(1).max(250).optional() })
    .strict();
  const current = async (deliveryId?: string, saving = false) => {
    const task = await execution.processingGuard(proof);
    if (task.suspended) throw new SessionError("task_paused");
    const session = await store.get(proof, proof.sessionId);
    assertExecutionReady(session.requirements);
    const operations = await execution.processingOperations(session);
    const unfinished = [];
    for (const d of session.requirements.deliveries.filter(
      (d) => d.status === "active",
    )) {
      const op = operations.find((o: any) =>
        o.operation_key.startsWith("processing:" + d.id + ":"),
      );
      const adoptions = op
        ? (
            await store.db.query(
              "SELECT id FROM assistant_runtime_operation WHERE session_id=$1 AND kind='adopt' AND run_id=$2",
              [proof.sessionId, op.run_id],
            )
          ).rows
        : [];
      let saved = false;
      for (const a of adoptions)
        if (await execution.receipt(proof, proof.sessionId, a.id)) saved = true;
      if (!saved && (!saving || op)) unfinished.push({ d, op });
    }
    const selected = deliveryId
      ? unfinished.find((v) => v.d.id === deliveryId)
      : unfinished[0];
    if (!selected)
      throw new SessionError("delivery_already_saved_or_unavailable", 409);
    const d = assertExecutionReady(session.requirements, false, selected.d.id);
    if (d.operation !== "generate") {
      const snapshot = await store.freezeSource(proof, d.source);
      if (snapshot.sourceSnapshot.hash !== d.sourceSnapshot?.hash)
        throw new SessionError("source_revision_conflict");
    }
    return { session, d, existing: selected.op };
  };
  const definitions: {
    name: string;
    readOnly: boolean;
    description: string;
    schema: z.ZodType;
    run: (args: any) => Promise<any>;
  }[] = canWrite
    ? [
        {
          name: "read_task_progress",
          readOnly: true,
          schema: empty,
          description:
            "读取真实任务、交付、成果、保存和暂停进度；只读，不继续执行。",
          run: async () => execution.projection(proof, proof.sessionId),
        },
        {
          name: "continue_task",
          readOnly: false,
          schema: empty,
          description: "仅用户明确继续时恢复原任务；不修改要求、不重置预算。",
          run: async () => execution.requestResume(proof),
        },
        {
          name: "submit_processing",
          readOnly: false,
          schema: selection,
          description:
            "执行已保存且mode:execute的交付；可给当前deliveryId，省略时依次处理未保存交付。支持清洗/改写/扩充/文档从零生成；自动持久等待，不轮询或重复提交。",
          run: async (args) => {
            const { session, d, existing } = await current(args.deliveryId);
            if (existing) {
              await waits.processing();
              return { runId: existing.run_id, reused: true };
            }
            const source =
              d.operation === "generate"
                ? {
                    kind: "background" as const,
                    id: proof.sessionId,
                    recordIds: [],
                  }
                : d.source;
            const payload = {
              source,
              options: {
                operation: d.operation,
                instructions: d.instructions ?? "",
                allowedFields: d.allowedFields,
                ...(d.allowedFields.includes("metadata") && d.metadataKeys
                  ? { metadataKeys: d.metadataKeys }
                  : {}),
                ...(["augment", "generate"].includes(d.operation)
                  ? { outputCount: d.count }
                  : {}),
              },
            };
            const op = await execution.operation(
              proof,
              "processing:" + d.id + ":" + session.requirements_revision,
              "processing",
              payload,
            );
            const result = await createProcessingRun(
              store.db,
              artifacts,
              execution.operationScope(proof, op),
              op.id,
              payload,
            );
            await waits.processing();
            return result;
          },
        },
        {
          name: "prepare_adoption",
          readOnly: false,
          schema: selection,
          description:
            "为已完成未保存的指定交付准备固定保存确认，省略deliveryId时依次选择。支持新草稿/已有草稿/原始数据；只准备并等待，不代用户批准。",
          run: async (args) => {
            const call = (
              await store.db.query(
                "SELECT e.detail->>'id' AS id FROM assistant_runtime_event e WHERE e.session_id=$1 AND e.turn_id=$2 AND e.kind='tool_call' AND e.detail->>'name'='prepare_adoption' ORDER BY e.id DESC LIMIT 1",
                [proof.sessionId, proof.turnId],
              )
            ).rows[0];
            const binding =
              call &&
              (
                await store.db.query(
                  "SELECT e.detail->>'operationId' AS id FROM assistant_runtime_event e WHERE e.session_id=$1 AND e.turn_id=$2 AND e.kind='adoption_tool_bound' AND e.detail->>'callId'=$3 ORDER BY e.id DESC LIMIT 1",
                  [proof.sessionId, proof.turnId, call.id],
                )
              ).rows[0];
            if (binding) {
              const receipt = await execution.receipt(
                proof,
                proof.sessionId,
                binding.id,
              );
              if (receipt) return { saved: true, receipt };
              const bound = (
                await store.db.query(
                  "SELECT requirements_revision FROM assistant_runtime_operation WHERE id=$1",
                  [binding.id],
                )
              ).rows[0];
              if (
                bound?.requirements_revision ===
                (await store.get(proof, proof.sessionId)).requirements_revision
              ) {
                const card = await execution.prepare(proof, { id: binding.id });
                await waits.confirmation();
                return card;
              }
              // A paused checkpoint may resume after a save-only amendment.
              // Keep its processed run, but bind a new confirmation to the current target.
            }
            const {
              session,
              d,
              existing: op,
            } = await current(args.deliveryId, true);
            if (!op) throw new SessionError("processing_not_submitted");
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
                operation: d.operation,
                instructions: d.instructions ?? "",
                allowedFields: [],
              },
            );
            const target: any = { ...d.saveTarget };
            if (target.kind === "newDraft") target.purpose ??= "";
            if (target.kind === "draft") {
              const draft = (
                await store.db.query(
                  "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2 AND status='editing'",
                  [target.id, proof.projectId],
                )
              ).rows[0];
              if (!draft)
                throw new SessionError("save_target_unavailable", 404);
              target.expectedRevision =
                d.source?.kind === "draft" && d.source.id === target.id
                  ? d.sourceSnapshot?.revision
                  : Number(draft.revision);
            }
            const adoption = await execution.operation(
              proof,
              "adopt:" + op.id + ":" + session.requirements_revision,
              "adopt",
              {
                runId: op.run_id,
                deliveryId: d.id,
                input: { resultIds: data.records.map((r) => r.id), target },
              },
            );
            if (call)
              await store.event(proof, "adoption_tool_bound", {
                callId: call.id,
                operationId: adoption.id,
              });
            const card = await execution.prepare(proof, adoption);
            await waits.confirmation();
            return card;
          },
        },
      ]
    : [];
  return {
    schemas: new Map(definitions.map((d) => [d.name, d.schema])),
    readOnly: new Set(definitions.filter((d) => d.readOnly).map((d) => d.name)),
    tools: definitions.map((d) =>
      tool(d.run, {
        name: d.name,
        description: d.description,
        schema: d.schema,
      }),
    ),
  };
}
