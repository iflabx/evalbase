import { deliveryExecution } from "./session-contract.js";
import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { ExecutionStore } from "./execution-store.js";
import { WorkspaceStore } from "./workspace-store.js";

/** Rebuild on every model/repair call. No cross-call cache or authorization grant. */
export async function sessionModelFacts(
  store: SessionStore,
  execution: ExecutionStore,
  workspace: WorkspaceStore,
  proof: TurnProof,
) {
  const session = await store.get(proof, proof.sessionId);
  const input = await store.guard(proof);
  const task = await execution.guard(proof);
  const facts = {
    sessionId: session.id,
    requirementsRevision: session.requirements_revision,
    requirements: {
      ...session.requirements,
      objective: undefined,
      initialGoal: session.requirements.objective,
      initialGoalRole:
        "历史需求叙述，名称、数量、范围与保存状态以当前交付和业务回执为准。",
    },
    inputContext: input.context ?? null,
    draftContext: await (async () => {
      const ref = (
        await store.db.query(
          "SELECT detail->'source'->>'id' AS id FROM assistant_runtime_event WHERE session_id=$1 AND kind='source_read' AND detail->'source'->>'kind'='draft' ORDER BY assistant_runtime_event.id DESC LIMIT 1",
          [proof.sessionId],
        )
      ).rows[0];
      if (!ref) return null;
      const draft = (
        await store.db.query(
          "SELECT id,name,purpose,revision,name_revision,purpose_revision,status,published_version_id FROM collaborative_draft WHERE id=$1 AND project_id=$2",
          [ref.id, proof.projectId],
        )
      ).rows[0];
      const preview = (
        await store.db.query(
          "SELECT id,configuration,draft_revision,target_count,receipt FROM selection_preview WHERE draft_id=$1 AND creator_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [ref.id, proof.actorId],
        )
      ).rows[0];
      if (draft)
        for (const key of ["revision", "name_revision", "purpose_revision"])
          draft[key] = Number(draft[key]);
      return {
        draft,
        preview,
        saveTarget: { kind: "sourceDraft", draftId: ref.id },
        selectedRecordIds:
          input.context?.kind === "draft" && input.context.id === ref.id
            ? input.context.recordIds
            : undefined,
      };
    })(),
    status: session.status,
    ...(await execution.projection(proof, proof.sessionId)),
    pausedTask: task.suspended
      ? {
          status: "paused",
          turnId: task.suspended.turnId,
        }
      : null,
    businessExecutionAvailable: true,
    currentExecution: {
      mode: session.requirements.mode,
      summaries: session.requirements.deliveries
        .filter((d) => d.status === "active")
        .map((d) => ({ id: d.id, ...deliveryExecution(d) })),
      goalTextRole:
        "原始目标叙述保留语义约束；范围、数量和执行授权由结构事实决定，勿从旧叙述恢复过时控制条件。",
    },
    attachments: await workspace.attachments(proof, proof.sessionId),
  };
  const current = await store.get(proof, proof.sessionId);
  if (
    current.revision !== session.revision ||
    current.requirements_revision !== session.requirements_revision
  )
    throw new SessionError("context_revision_conflict");
  await execution.guard(proof);
  return facts;
}
