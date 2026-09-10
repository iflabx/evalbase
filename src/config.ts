export interface Config {
  databaseUrl: string;
  minio: {
    endPoint: string;
    port: number;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  appOrigin: string;
  gitSha: string;
  soloOwnerMode: boolean;
  ownerPassword: string;
  editorPassword: string;
  viewerPassword: string;
  allowTestIdentity: boolean;
  host: string;
  port: number;
  workerHealthHost: string;
  workerHealthPort: number;
  consistencyScanCadenceMs: number;
  draftLeaseDurationMs: number;
  draftLeaseRenewIntervalMs: number;
  draftTakeoverGraceMs: number;
  jobMaxAttempts: number;
  jobClaimDelayMs: number;
  jobInitialBackoffMs: number;
  jobBackoffMultiplier: number;
  jobLeaseDurationMs: number;
  jobHeartbeatIntervalMs: number;
  jobOrphanGraceMs: number;
  orphanScanCadenceMs: number;
}

export type JobPolicy = Pick<
  Config,
  | "jobMaxAttempts"
  | "jobClaimDelayMs"
  | "jobInitialBackoffMs"
  | "jobBackoffMultiplier"
  | "jobLeaseDurationMs"
  | "jobHeartbeatIntervalMs"
  | "jobOrphanGraceMs"
  | "orphanScanCadenceMs"
>;

export function jobRetryDelayMs(policy: JobPolicy, attempt: number): number {
  return (
    policy.jobInitialBackoffMs *
    policy.jobBackoffMultiplier ** (Number(attempt) - 1)
  );
}

export function jobRetrySchedule(policy: JobPolicy, clockMs = 0): number[] {
  let retryAtMs = clockMs;
  return Array.from({ length: policy.jobMaxAttempts - 1 }, (_, index) => {
    retryAtMs += jobRetryDelayMs(policy, index + 1);
    return retryAtMs;
  });
}

export function loadConfig(env = process.env): Config {
  const jobConfig = {
    jobMaxAttempts: Number(env.JOB_MAX_ATTEMPTS ?? 3),
    jobClaimDelayMs: Number(env.JOB_CLAIM_DELAY_MS ?? 250),
    jobInitialBackoffMs: Number(env.JOB_INITIAL_BACKOFF_MS ?? 1_000),
    jobBackoffMultiplier: Number(env.JOB_BACKOFF_MULTIPLIER ?? 4),
    jobLeaseDurationMs: Number(env.JOB_LEASE_DURATION_MS ?? 30_000),
    jobHeartbeatIntervalMs: Number(env.JOB_HEARTBEAT_INTERVAL_MS ?? 10_000),
    jobOrphanGraceMs: Number(env.JOB_ORPHAN_GRACE_MS ?? 120_000),
    orphanScanCadenceMs: Number(env.ORPHAN_SCAN_CADENCE_MS ?? 3_600_000),
  };
  const retryWindowMs = jobRetrySchedule(jobConfig).at(-1) ?? 0;
  if (
    !Number.isInteger(jobConfig.jobMaxAttempts) ||
    jobConfig.jobMaxAttempts < 1 ||
    !Number.isInteger(jobConfig.jobClaimDelayMs) ||
    jobConfig.jobClaimDelayMs < 0 ||
    !Number.isInteger(jobConfig.jobInitialBackoffMs) ||
    jobConfig.jobInitialBackoffMs < 1 ||
    !Number.isFinite(jobConfig.jobBackoffMultiplier) ||
    jobConfig.jobBackoffMultiplier < 1 ||
    !Number.isInteger(jobConfig.jobLeaseDurationMs) ||
    jobConfig.jobLeaseDurationMs < 1 ||
    !Number.isInteger(jobConfig.jobHeartbeatIntervalMs) ||
    jobConfig.jobHeartbeatIntervalMs < 1 ||
    jobConfig.jobHeartbeatIntervalMs > jobConfig.jobLeaseDurationMs ||
    !Number.isInteger(jobConfig.jobOrphanGraceMs) ||
    jobConfig.jobOrphanGraceMs <=
      jobConfig.jobLeaseDurationMs +
        retryWindowMs +
        jobConfig.jobClaimDelayMs ||
    !Number.isInteger(jobConfig.orphanScanCadenceMs) ||
    jobConfig.orphanScanCadenceMs < 1
  )
    throw new RangeError(
      `Invalid EvalBase job policy configuration: ${JSON.stringify(
        jobConfig,
      )}, retryWindowMs=${retryWindowMs}`,
    );

  const workerHealthPort = Number(env.WORKER_HEALTH_PORT ?? 3001);
  const consistencyScanCadenceMs = Number(
    env.CONSISTENCY_SCAN_CADENCE_MS ?? 3_600_000,
  );
  if (
    !Number.isInteger(workerHealthPort) ||
    workerHealthPort < 0 ||
    workerHealthPort > 65_535
  ) {
    throw new RangeError(
      `Invalid Worker health port: ${JSON.stringify(workerHealthPort)}`,
    );
  }
  if (
    !Number.isInteger(consistencyScanCadenceMs) ||
    consistencyScanCadenceMs < 1
  ) {
    throw new RangeError(
      `Invalid consistency scan cadence: ${JSON.stringify(
        consistencyScanCadenceMs,
      )}`,
    );
  }

  return {
    databaseUrl:
      env.DATABASE_URL ??
      "postgresql://evalbase_phase1a:synthetic-nonproduction-only@postgres:5432/evalbase_phase1a",
    minio: {
      endPoint: env.MINIO_ENDPOINT ?? "minio",
      port: Number(env.MINIO_PORT ?? 9000),
      accessKey: env.MINIO_ACCESS_KEY ?? "evalbase-phase1a",
      secretKey: env.MINIO_SECRET_KEY ?? "synthetic-nonproduction-only",
      bucket: env.MINIO_BUCKET ?? "evalbase-phase1a",
    },
    appOrigin: env.APP_ORIGIN ?? "http://127.0.0.1:3000",
    gitSha: env.GIT_SHA ?? "unknown",
    soloOwnerMode:
      typeof env.NODE_ENV === "string" &&
      env.NODE_ENV !== "production" &&
      env.SOLO_OWNER_MODE === "true",
    ownerPassword: env.OWNER_PASSWORD ?? "owner-test-password",
    editorPassword: env.EDITOR_PASSWORD ?? "editor-test-password",
    viewerPassword: env.VIEWER_PASSWORD ?? "viewer-test-password",
    allowTestIdentity: env.ALLOW_TEST_IDENTITY === "true",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    workerHealthHost: env.WORKER_HEALTH_HOST ?? "127.0.0.1",
    workerHealthPort,
    consistencyScanCadenceMs,
    draftLeaseDurationMs: Number(env.DRAFT_LEASE_DURATION_MS ?? 30_000),
    draftLeaseRenewIntervalMs: Number(
      env.DRAFT_LEASE_RENEW_INTERVAL_MS ?? 10_000,
    ),
    draftTakeoverGraceMs: Number(env.DRAFT_TAKEOVER_GRACE_MS ?? 5_000),
    ...jobConfig,
  };
}
