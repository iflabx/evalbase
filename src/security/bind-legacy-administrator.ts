import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";

export async function bindLegacyAdministrator(
  databaseUrl: string,
  emailInput: string,
) {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254)
    throw new Error("Invalid administrator email");
  await migrate(databaseUrl);
  const db = createPool(databaseUrl);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(91827463)");
    const state = await client.query(
      "SELECT 1 FROM installation_state LIMIT 1",
    );
    if (state.rowCount) throw new Error("Installation is already initialized");
    const owner = await client.query(
      "SELECT id, password_hash FROM app_user WHERE id = 'user_owner' AND role = 'owner' FOR UPDATE",
    );
    if (owner.rowCount !== 1)
      throw new Error("Legacy Owner identity is ambiguous or missing");
    const ambiguous = await client.query(
      `SELECT 1 FROM app_user WHERE id NOT IN ('user_owner', 'user_editor', 'user_viewer') LIMIT 1`,
    );
    if (ambiguous.rowCount)
      throw new Error("Other accounts require manual identity audit");
    const conflict = await client.query(
      "SELECT 1 FROM app_user WHERE lower(email) = $1 AND id <> 'user_owner' LIMIT 1",
      [email],
    );
    if (conflict.rowCount)
      throw new Error("Administrator email already belongs to another account");
    await client.query(
      `UPDATE app_user SET email = $1, display_name = coalesce(display_name, '管理员'), role = 'admin'
       WHERE id = 'user_owner'`,
      [email],
    );
    await client.query("INSERT INTO installation_state (id) VALUES (true)");
    await client.query("COMMIT");
    return { id: "user_owner", email };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.env.LEGACY_ADMIN_EMAIL;
  if (!email)
    throw new Error("Set LEGACY_ADMIN_EMAIL before running the migration");
  const result = await bindLegacyAdministrator(loadConfig().databaseUrl, email);
  process.stdout.write(`Bound ${result.id} to ${result.email}\n`);
}
