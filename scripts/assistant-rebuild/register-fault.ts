import { createPool } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config.js";
const [sessionId, caseId] = process.argv.slice(2);
if (
  process.env.REBUILD_VALIDATION_ENABLED !== "true" ||
  !sessionId?.startsWith("rebuild_") ||
  !["L01", "L02"].includes(caseId ?? "")
)
  throw Error("validation_context_required");
const db = createPool(loadConfig().databaseUrl);
try {
  const s = (
    await db.query(
      "SELECT id FROM rebuild_session WHERE id=$1 AND campaign_id=$2",
      [sessionId, process.env.REBUILD_VALIDATION_CAMPAIGN_ID],
    )
  ).rows[0];
  if (!s) throw Error("validation_session_not_found");
  await db.query(
    "INSERT INTO rebuild_fault(session_id,kind,tool_name) VALUES($1,$2,$3)",
    [
      sessionId,
      caseId === "L01" ? "type" : "truncate",
      caseId === "L01" ? "read_records" : "submit_processing",
    ],
  );
  console.log(
    JSON.stringify({
      caseId,
      sessionId,
      registered: true,
      maxHttpAttempts: 10,
    }),
  );
} finally {
  await db.end();
}
