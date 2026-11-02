// Explicit synthetic configuration for pure config tests; no live endpoints.
export const configEnv = {
  DATABASE_URL: "postgresql://unit:unit-only@127.0.0.1:1/unit",
  MINIO_ACCESS_KEY: "unit-only",
  MINIO_SECRET_KEY: "unit-only-not-a-live-service",
  OWNER_PASSWORD: "unit-owner-only",
};
