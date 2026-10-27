import { BusinessError } from "./errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "../db/pool.js";
import { hasProjectCapability } from "../security/project-access.js";
import type { BackgroundSnapshot } from "../processing/background.js";
import type {
  ProcessingInput,
  ProcessingOptions,
} from "../processing/protocol.js";
import type { ProcessingSource } from "../processing/store.js";
import type { RuntimeGuard } from "./runtime-guard.js";

/** Legacy wire shape only; interpretation stays in the legacy adapter. */
export type AssistantGuard = {
  sessionId: string;
  revision: number;
  turnId?: string;
  token?: string;
  proposalId?: string;
  leaseToken?: string;
};
export type OperationScope = {
  projectId: string;
  actorId: string;
  operation?: object;
  assistantGuard?: AssistantGuard;
  runtimeGuard?: RuntimeGuard;
};
export type BackgroundRequest = {
  options: ProcessingOptions;
  records: ProcessingInput[];
  source: ProcessingSource;
  rootOperation?: string;
  parentRunId?: string;
};
export type CommitAction = "processing" | "selection" | "publish" | "cancel";
type Query = Pick<Database, "query">;
type Adapter = {
  origin: "legacy" | "runtime";
  sessionId: string;
  guard: (db: Query, action?: CommitAction) => Promise<void>;
  link: (db: Query, runId: string) => Promise<void>;
  background: (
    db: Query,
    request: BackgroundRequest,
  ) => Promise<BackgroundSnapshot | undefined>;
  results?: (
    db: Query,
    runIds: string[],
    scope: OperationScope,
  ) => Promise<void>;
};
type Caller = Adapter & { projectId: string; actorId: string };
const trusted = new WeakMap<object, Caller>();
const active = new AsyncLocalStorage<Caller | undefined>();
export class OperationCommitError extends BusinessError {
  constructor(code: string, status = 409) {
    super(status, code);
  }
}
/** Internal server capability: JSON/request bodies cannot manufacture its WeakMap entry. */
export function operationScope<T extends OperationScope>(
  scope: T,
  adapter: Adapter,
): T & { operation: object } {
  const operation = Object.freeze({ origin: adapter.origin });
  trusted.set(operation, {
    ...adapter,
    projectId: scope.projectId,
    actorId: scope.actorId,
  });
  return { ...scope, operation };
}
function caller(scope: OperationScope) {
  const ambient = active.getStore();
  const explicit = scope.operation && trusted.get(scope.operation);
  if (scope.operation !== undefined && !explicit)
    throw new OperationCommitError("operation_context_invalid");
  if (
    ambient &&
    explicit &&
    (ambient.sessionId !== explicit.sessionId ||
      ambient.origin !== explicit.origin ||
      ambient.projectId !== explicit.projectId ||
      ambient.actorId !== explicit.actorId)
  )
    throw new OperationCommitError("operation_context_invalid");
  const context = explicit || ambient;
  if (
    context &&
    (context.projectId !== scope.projectId || context.actorId !== scope.actorId)
  )
    throw new OperationCommitError("operation_context_invalid");
  if (!context && (scope.assistantGuard || scope.runtimeGuard))
    throw new OperationCommitError("operation_context_required");
  return context;
}
export function withOperationScope<T>(
  scope: OperationScope,
  action: () => T,
): T {
  return active.run(caller(scope), action);
}
export const operationOrigin = (scope: OperationScope) =>
  caller(scope)?.origin ?? "manual";
export const operationSession = (scope: OperationScope) =>
  caller(scope)?.sessionId;
export const legacySession = (scope: OperationScope) => {
  const c = caller(scope);
  return c?.origin === "legacy" ? c.sessionId : null;
};
/** Run inside the domain transaction, after its object locks and before COMMIT. */
export async function guardOperationCommit(
  db: Query,
  scope: OperationScope,
  action?: CommitAction,
) {
  const context = caller(scope);
  await db.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
    scope.actorId,
  ]);
  await db.query(
    "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
    [scope.projectId, scope.actorId],
  );
  if (
    !(await hasProjectCapability(db, scope.projectId, scope.actorId, "write"))
  )
    throw new OperationCommitError("project_not_found", 404);
  await context?.guard(db, action);
}
export async function linkOperationProcessing(
  db: Query,
  scope: OperationScope,
  runId: string,
) {
  await guardOperationCommit(db, scope);
  await caller(scope)?.link(db, runId);
}
export async function freezeOperationBackground(
  db: Query,
  scope: OperationScope,
  request: BackgroundRequest,
) {
  return caller(scope)?.background(db, request);
}
export async function guardOperationResults(
  db: Query,
  scope: OperationScope,
  runIds: string[],
) {
  await guardOperationCommit(db, scope);
  const context = caller(scope);
  if (!context?.results)
    throw new OperationCommitError("processing_result_scope_required");
  await context.results(db, runIds, scope);
}
