// Ordinary test Workers do not need a health listener; keep parallel spawns isolated.
process.env.WORKER_HEALTH_PORT ??= "0";

// Unit tests have no live services. Integration runs supply their own isolated endpoints.
process.env.DATABASE_URL ??= "postgresql://unit:unit-only@127.0.0.1:1/unit";
process.env.MINIO_ACCESS_KEY ??= "unit-only";
process.env.MINIO_SECRET_KEY ??= "unit-only-not-a-live-service";
process.env.OWNER_PASSWORD ||= "owner-test-password";
process.env.EDITOR_PASSWORD ||= "editor-test-password";
process.env.VIEWER_PASSWORD ||= "viewer-test-password";
