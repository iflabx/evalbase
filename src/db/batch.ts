import type { PoolClient } from "pg";

/** Bound JSON encoding and statement size while retaining the caller's transaction. */
export async function writeBatches(
  client: PoolClient,
  sql: string,
  parameters: unknown[],
  rows: readonly unknown[],
): Promise<number> {
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const result = await client.query(sql, [
      ...parameters,
      JSON.stringify(rows.slice(offset, offset + 500)),
    ]);
    written += result.rowCount ?? 0;
  }
  return written;
}
