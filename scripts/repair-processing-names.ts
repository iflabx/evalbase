import { readFile, writeFile } from "node:fs/promises";
import { createPool } from "../src/db/pool.js";
import { loadConfig } from "../src/config.js";
import {
  processingNameRepairs,
  applyProcessingNameRepairs,
  type NameRepair,
} from "../src/processing/names.js";

const [mode = "preview", backup] = process.argv.slice(2);
if (
  !["preview", "apply", "rollback"].includes(mode) ||
  (mode !== "preview" && !backup)
)
  throw new Error(
    "usage: repair-processing-names.ts preview | apply BACKUP.json | rollback BACKUP.json",
  );
const db = createPool(loadConfig().databaseUrl);
const client = await db.connect();
try {
  await client.query("BEGIN");
  const changes: NameRepair[] =
    mode === "rollback"
      ? JSON.parse(await readFile(backup!, "utf8"))
      : await processingNameRepairs(client);
  if (mode === "apply")
    await writeFile(backup!, JSON.stringify(changes, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  const changed =
    mode === "preview"
      ? 0
      : await applyProcessingNameRepairs(client, changes, mode === "rollback");
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ mode, changes, changed }) + "\n");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await db.end();
}
