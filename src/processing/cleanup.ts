import type { ArtifactRepository } from "../storage/artifacts.js";

/** Durable cleanup queue: inaccessible bodies are erased before a deletion is acknowledged. */
export async function cleanupProcessingObjects(
  db: {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
  },
  artifacts: ArtifactRepository,
  projectId?: string,
) {
  for (;;) {
    const rows = await db.query(
      "SELECT project_id,object_ref FROM processing_cleanup WHERE ($1::text IS NULL OR project_id=$1) ORDER BY created_at LIMIT 1000",
      [projectId ?? null],
    );
    if (!rows.rows.length) return;
    for (const row of rows.rows) {
      const references = await db.query(
        `SELECT 1 FROM (
      SELECT input_ref AS ref FROM processing_run UNION ALL SELECT result_ref FROM processing_batch
      UNION ALL SELECT object_ref FROM data_asset WHERE status<>'tombstoned'
      UNION ALL SELECT object_ref FROM pending_upload WHERE status IN('previewable','confirmed')
      UNION ALL SELECT object_ref FROM candidate_snapshot WHERE status<>'tombstoned'
      UNION ALL SELECT evidence_object_ref FROM candidate_snapshot WHERE status<>'tombstoned'
      UNION ALL SELECT manifest_object_ref FROM test_set_version WHERE status NOT IN('tombstoned','permanently_deleted')
      UNION ALL SELECT object_ref FROM delivery_record WHERE status<>'tombstoned'
    ) refs WHERE ref=$1 LIMIT 1`,
        [row.object_ref],
      );
      if (!references.rowCount) await artifacts.remove(row.object_ref);
      await db.query(
        "DELETE FROM processing_cleanup WHERE project_id=$1 AND object_ref=$2",
        [row.project_id, row.object_ref],
      );
    }
  }
}
