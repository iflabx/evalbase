import { operationScope, type OperationScope } from "../operations/commit.js";
import {
  guardRuntimeCommit,
  RuntimeCommitError,
  linkRuntimeProcessing,
  type RuntimeGuard,
} from "../operations/runtime-guard.js";
import { freezeRuntimeBackground } from "./background.js";
/** Server-only runtime adapter; no legacy task, planner or repair dependency. */
export function runtimeOperationScope<
  T extends OperationScope & { runtimeGuard: RuntimeGuard },
>(scope: T) {
  const proof = { ...scope.runtimeGuard };
  const fixed = { ...scope, runtimeGuard: proof };
  return operationScope(scope, {
    origin: "runtime",
    sessionId: proof.sessionId,
    guard: (db, action) => {
      if (proof.control && action !== "cancel")
        throw new RuntimeCommitError("runtime_interrupted");
      return guardRuntimeCommit(
        db,
        fixed,
        action === "cancel" ? undefined : action,
      );
    },
    link: (db, runId) =>
      linkRuntimeProcessing(
        db,
        {
          ...fixed,
          runtimeGuard: {
            ...proof,
            operationId: scope.runtimeGuard.operationId,
          },
        },
        runId,
      ),
    background: (db, request) =>
      freezeRuntimeBackground(db, fixed, request.options.instructions),
  });
}
