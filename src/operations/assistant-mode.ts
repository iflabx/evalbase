import type { Database } from "../db/pool.js";
import { BusinessError } from "./errors.js";

export const assistantModeSchema = `
CREATE TABLE IF NOT EXISTS assistant_runtime_mode(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  mode text NOT NULL CHECK(mode IN ('rebuild','manual')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO assistant_runtime_mode(id,mode) VALUES(true,'rebuild') ON CONFLICT DO NOTHING;
INSERT INTO schema_migration(id) VALUES('assistant-runtime-mode-v1') ON CONFLICT DO NOTHING;
`;
export async function assistantEnabled(db: Pick<Database, "query">) {
  return (
    (await db.query("SELECT mode FROM assistant_runtime_mode WHERE id=true"))
      .rows[0]?.mode === "rebuild"
  );
}
/** Hold the shared row lock through the caller's transaction: a mode change waits for committed writes. */
export async function guardAssistantMode(db: Pick<Database, "query">) {
  const row = (
    await db.query(
      "SELECT mode FROM assistant_runtime_mode WHERE id=true FOR SHARE",
    )
  ).rows[0];
  if (row?.mode !== "rebuild")
    throw new BusinessError(
      409,
      "assistant_runtime_disabled",
      "项目助手暂时停用，已有成果和人工页面仍可查看使用。",
    );
}
