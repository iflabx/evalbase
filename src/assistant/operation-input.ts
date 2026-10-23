import { randomUUID } from "node:crypto";
import { canonicalJson } from "../package/contract.js";
/** Freeze the effective random seed before the operation key. Never guess an old contract. */
export function effectiveOperationInput(
  name: string,
  input: Record<string, any>,
  operation: Record<string, any> | undefined,
  currentContract: boolean,
  candidateScope?: Record<string, any>,
): Record<string, any> {
  if (
    !currentContract ||
    (operation && operation.parameterContractVersion !== 1)
  )
    return input;
  const next = structuredClone(input),
    saved = operation?.input;
  const selection = next.selection;
  if (
    selection?.method === "random" &&
    selection.seed === undefined &&
    saved?.selection?.seed
  ) {
    const prior = { ...saved.selection };
    delete prior.seed;
    if (canonicalJson(prior) === canonicalJson(selection))
      selection.seed = saved.selection.seed;
  }
  if (name === "select_candidates" && (next.selection || next.groups)) {
    next.seed ??=
      next.selection?.seed ??
      saved?.seed ??
      (next.reselect === true ? undefined : candidateScope?.seed) ??
      randomUUID();
    if (
      next.selection?.method === "random" &&
      next.selection.seed === undefined
    )
      next.selection.seed = next.seed;
  }
  return next;
}
