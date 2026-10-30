import { createPool } from "../db/pool.js";
import { loadConfig } from "../config.js";
import { changeAssistantMode } from "../assistant-rebuild/cutover.js";

const mode = process.argv[2];
if (!["manual", "rebuild", "status"].includes(mode ?? ""))
  throw Error("usage: assistant-mode status|manual|rebuild");
const db = createPool(loadConfig().databaseUrl);
try {
  console.log(
    JSON.stringify(
      mode === "status"
        ? (
            await db.query(
              "SELECT mode,changed_at FROM assistant_runtime_mode WHERE id=true",
            )
          ).rows[0]
        : await changeAssistantMode(db, mode as "manual" | "rebuild"),
    ),
  );
} finally {
  await db.end();
}
