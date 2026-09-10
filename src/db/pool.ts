import pg from "pg";

class RestartSafeClient extends pg.Client {
  constructor(options?: ConstructorParameters<typeof pg.Client>[0]) {
    super(options);
    this.on("error", () => undefined);
  }
}

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    Client: RestartSafeClient,
  });
  // PostgreSQL restarts invalidate idle clients; pg removes them without crashing Web/Worker.
  pool.on("error", () => undefined);
  return pool;
}

export type Database = pg.Pool;
