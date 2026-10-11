import type { Database } from "../db/pool.js";
import type { ProcessingOptions } from "./protocol.js";

export function processingResultName(
  operation: ProcessingOptions["operation"],
  runId: string,
) {
  const label = { clean: "清洗", rewrite: "改写", augment: "扩充" }[operation];
  const name = `${label}结果-${runId.slice(-8)}.jsonl`;
  if (Buffer.from(name, "utf8").toString("utf8") !== name)
    throw new Error("processing_name_invalid");
  return name;
}
export type NameRepair = {
  assetId: string;
  projectId: string;
  runId: string;
  before: string;
  after: string;
};
/** Only the proven legacy system prefix, never a guessed transcoding of user filenames. */
export async function processingNameRepairs(
  db: Pick<Database, "query">,
): Promise<NameRepair[]> {
  const rows = await db.query(
    `SELECT a.id,a.project_id,a.processing_run_id,a.file_name FROM data_asset a JOIN processing_run r ON r.id=a.processing_run_id AND r.project_id=a.project_id WHERE r.options->>'operation'='augment' AND a.file_name='鎵╁厖结果-' || right(r.id,8) || '.jsonl'`,
  );
  return rows.rows.map((row) => ({
    assetId: row.id,
    projectId: row.project_id,
    runId: row.processing_run_id,
    before: row.file_name,
    after: processingResultName("augment", row.processing_run_id),
  }));
}
export async function applyProcessingNameRepairs(
  db: Pick<Database, "query">,
  changes: NameRepair[],
  rollback = false,
) {
  let changed = 0;
  for (const row of changes) {
    if (
      row.before !== `鎵╁厖结果-${row.runId.slice(-8)}.jsonl` ||
      row.after !== processingResultName("augment", row.runId)
    )
      throw new Error("processing_name_repair_invalid");
    const result = await db.query(
      `UPDATE data_asset a SET file_name=$5 FROM processing_run r WHERE a.id=$1 AND a.project_id=$2 AND a.processing_run_id=$3 AND r.id=a.processing_run_id AND r.project_id=a.project_id AND r.options->>'operation'='augment' AND a.file_name=$4`,
      [
        row.assetId,
        row.projectId,
        row.runId,
        rollback ? row.after : row.before,
        rollback ? row.before : row.after,
      ],
    );
    changed += result.rowCount ?? 0;
    await db.query(
      "UPDATE processing_acceptance SET receipt=jsonb_set(receipt,'{fileName}',to_jsonb($3::text)) WHERE asset_id=$1 AND receipt->>'fileName'=$2",
      [
        row.assetId,
        rollback ? row.after : row.before,
        rollback ? row.before : row.after,
      ],
    );
  }
  return changed;
}
