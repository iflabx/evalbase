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
    requirements: session.requirements,
    inputContext: input.context ?? null,
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
