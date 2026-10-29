import type { Database } from "../db/pool.js";
import { canonicalJson } from "../package/contract.js";
export async function compatibleProcessingOperations(
  db: Pick<Database, "query">,
  session: any,
) {
  const rows = (
    await db.query(
      "SELECT o.*,j.status AS job_status,e.detail->'receipt'->'requirements' AS original_requirements,(SELECT count(DISTINCT result_id) FROM processing_acceptance a CROSS JOIN LATERAL jsonb_array_elements_text(a.result_ids) result_id WHERE a.run_id=r.id)>=coalesce((r.options->>'outputCount')::int,r.input_count) AS fully_saved FROM assistant_runtime_operation o JOIN processing_run r ON r.id=o.run_id JOIN job j ON j.id=r.job_id LEFT JOIN LATERAL (SELECT detail FROM assistant_runtime_event WHERE session_id=o.session_id AND kind='requirements_saved' AND (detail->'receipt'->>'revision')::int=o.requirements_revision ORDER BY id LIMIT 1) e ON true WHERE o.session_id=$1 AND o.kind='processing' ORDER BY o.requirements_revision DESC,o.id",
      [session.id],
    )
  ).rows;
  const fingerprint = (requirements: any, delivery: any) => {
    const processing = { ...delivery };
    delete processing.name;
    delete processing.saveTarget;
    return canonicalJson({
      processing,
    });
  };
  const selected = new Set<string>();
  return rows.filter((op) => {
    const delivery = session.requirements.deliveries.find(
      (d: any) =>
        d.status === "active" &&
        op.operation_key.startsWith("processing:" + d.id + ":"),
    );
    if (
      op.payload.taskId &&
      !op.operation_key.startsWith("processing:") &&
      session.requirements_revision === op.requirements_revision
    )
      return true;
    if (!delivery)
      return (
        session.requirements_revision === 0 &&
        session.requirements.deliveries.length === 0 &&
        op.requirements_revision === 0
      );
    const original = op.original_requirements?.deliveries?.find(
      (d: any) => d.id === delivery.id,
    );
    if (
      !original ||
      (!op.fully_saved &&
        op.original_requirements.objective !==
          session.requirements.objective) ||
      fingerprint(op.original_requirements, original) !==
        fingerprint(session.requirements, delivery) ||
      selected.has(delivery.id)
    )
      return false;
    selected.add(delivery.id);
    return true;
  });
}
