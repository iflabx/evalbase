import pg from "pg";
import type { RuntimeMetrics } from "../observability/runtime.js";

class RestartSafeClient extends pg.Client {
  constructor(options?: ConstructorParameters<typeof pg.Client>[0]) {
    super(options);
    this.on("error", () => undefined);
  }
}

export function createPool(
  databaseUrl: string,
  metrics?: RuntimeMetrics,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    Client: RestartSafeClient,
  });
  metrics?.instrument(pool);
  // PostgreSQL restarts invalidate idle clients; pg removes them without crashing Web/Worker.
  pool.on("error", () => undefined);
  return pool;
}

export type Database = pg.Pool;
