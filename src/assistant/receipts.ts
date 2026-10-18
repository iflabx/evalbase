import { canonicalJson } from "../package/contract.js";
// These failures occur before a domain commit (or roll its transaction back).
// Unknown failures keep the operation binding until a real receipt is reconciled.
const validationWithoutEffect = new Set([
  "assistant_tool_input_invalid",
  "processing_scope_invalid",
  "processing_configuration_invalid",
  "processing_capacity_exceeded",
  "test_set_capacity_exceeded",
  "assistant_document_range",
  "assistant_background_required",
  "assistant_delivery_pending",
  "assistant_background_not_read",
  "assistant_background_rule_mismatch",
  "assistant_background_reference_invalid",
  "assistant_requirement_conflict",
  "assistant_candidate_selection_invalid",
  "assistant_plan_count_conflict",
  "model_connection_unavailable",
]);
export const processingProposalValidationWithoutEffect = new Set([
  "processing_result_invalid",
  "assistant_candidate_review_incomplete",
]);
export function hasNoEffect(record: Record<string, any>) {
  return (
    record.effect === "none" ||
    (record.status === "failed" &&
      (validationWithoutEffect.has(record.error?.code) ||
        // Candidate lookup 404s precede the shared refinement transaction commit;
        // its post-commit dependency checks use a different error code.
        (record.name === "refine_candidates" &&
          record.error?.code === "processing_not_found") ||
        (record.name === "request_processing_apply" &&
          processingProposalValidationWithoutEffect.has(record.error?.code))))
  );
}
export function unresolvedFailure(records: Record<string, any>[]) {
  return records.findLast(
    (record, index) =>
      record.status === "failed" &&
      !records
        .slice(index + 1)
        .some(
          (later) =>
            later.name === record.name &&
            later.status === "succeeded" &&
            (later.key === record.key ||
              (hasNoEffect(record) &&
                canonicalJson(record.binding ?? null) ===
                  canonicalJson(later.binding ?? null))),
        ),
  );
}
