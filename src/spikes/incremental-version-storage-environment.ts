import type { Config } from "../config.js";

const SPIKE_DATABASE_HOST = "postgres";
const SPIKE_DATABASE_NAME = "spike";
const SPIKE_MINIO_HOST = "minio";
const SPIKE_BUCKET = "evalbase-incremental-storage-spike";

export function assertIsolatedSpikeEnvironment(
  config: Pick<Config, "databaseUrl"> & {
    minio: Pick<Config["minio"], "endPoint" | "bucket">;
  },
  environment = process.env,
) {
  const database = new URL(config.databaseUrl);
  const isIsolated =
    environment.SPIKE_ISOLATED === "1" &&
    database.hostname === SPIKE_DATABASE_HOST &&
    database.pathname === `/${SPIKE_DATABASE_NAME}` &&
    config.minio.endPoint === SPIKE_MINIO_HOST &&
    config.minio.bucket === SPIKE_BUCKET;
  if (!isIsolated)
    throw new Error(
      "Incremental storage spike requires the isolated Compose PostgreSQL and MinIO environment",
    );
}
