import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { buildCapacityFixture } from "../fixtures/capacity-boundaries.js";

async function waitFor(
  request: () => Promise<{ statusCode: number; json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await request();
    const body = await response.json();
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public job state");
}

describe("Ticket 09 PostgreSQL-backed job coordination", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let workers: ChildProcess[] = [];
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    csrf = login.json().csrfToken;
  });

  afterAll(async () => {
    await stopWorkers();
    await app.close();
    await db.end();
  });

  async function stopWorkers() {
    for (const runningWorker of workers)
      if (runningWorker.exitCode === null) {
        runningWorker.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    workers = [];
  }

  async function isolateJobQueue() {
    await db.query(
      `UPDATE job SET status = 'cancelled', stage = 'cancelled',
          progress = 100, lease_owner = NULL, lease_expires_at = NULL,
          next_run_at = NULL, updated_at = now()
       WHERE status IN ('queued', 'running', 'retry_wait', 'cancel_requested')`,
    );
  }

  async function uploadQueuedParseJob(
    source: {
      bytes: Buffer;
      fileName: string;
      contentType: string;
    } = {
      bytes: Buffer.from(
        "question,answer\nSynthetic question,Synthetic answer\n",
      ),
      fileName: "ticket09-cancel.csv",
      contentType: "text/csv; charset=utf-8",
    },
  ) {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": `ticket09-${randomUUID()}`,
        "content-type": source.contentType,
        "x-file-name": source.fileName,
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 09 job coordination",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic job coordination test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: source.bytes,
    });
    expect(uploaded.statusCode).toBe(201);
    return {
      bytes: source.bytes,
      assetId: uploaded.json().asset.id as string,
      jobId: uploaded.json().job.id as string,
      parsedViewId: uploaded.json().parsedView.id as string,
    };
  }

  async function prepareConfiguredDraft(source?: {
    bytes: Buffer;
    fileName: string;
    contentType: string;
    mapping: Record<string, unknown>;
    filter: Record<string, unknown>;
    formalSchema: Record<string, unknown>;
    unmappedFields: string[];
  }) {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob(
      source && {
        bytes: source.bytes,
        fileName: source.fileName,
        contentType: source.contentType,
      },
    );
    startWorker(`ticket09-parse-${randomUUID()}`);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    await stopWorkers();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 09 jobs ${randomUUID()}`,
        purpose: "Synthetic job coordination test",
        assetId: upload.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const mapping = (source?.mapping ?? {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    }) as Record<string, unknown>;
    const filter = (source?.filter ?? {
      field: "question",
      operator: "eq",
      value: "Synthetic question",
    }) as Record<string, unknown>;
    const formalSchema = (source?.formalSchema ?? {
      mode: "gold_required",
      input: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
      expectedOutput: { type: "string" },
    }) as Record<string, unknown>;
    const recipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Ticket 09 synthetic job fixture",
        steps: [
          {
            kind: "filter",
            filter,
          },
        ],
        mapping,
        unmappedFields: source?.unmappedFields ?? [],
        unmappedConfirmed: true,
      },
    });
    expect(recipe.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: recipe.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter,
        mapping,
        unmappedFields: source?.unmappedFields ?? [],
        unmappedConfirmed: true,
        formalSchema,
      },
    });
    expect(configured.statusCode).toBe(200);
    return {
      ...upload,
      testSetId: created.json().testSet.id,
      draft,
      configuredRevision: configured.json().draft.revision,
    };
  }

  async function createReadyCandidate() {
    const fixture = await prepareConfiguredDraft();
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: fixture.draft.leaseToken,
        expectedRevision: fixture.configuredRevision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const jobId = materialized.json().job.id as string;
    startWorker(`ticket09-ready-${randomUUID()}`);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    await stopWorkers();
    return {
      ...fixture,
      candidateId: materialized.json().candidate.id as string,
      materializationJobId: jobId,
    };
  }

  function startWorker(name: string, environment: Record<string, string> = {}) {
    const databaseUrl = loadConfig().databaseUrl;
    const separator = databaseUrl.includes("?") ? "&" : "?";
    const worker = spawn(process.execPath, ["dist/server/src/worker/main.js"], {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: `${databaseUrl}${separator}application_name=${encodeURIComponent(name)}`,
        JOB_LEASE_DURATION_MS: "200",
        JOB_HEARTBEAT_INTERVAL_MS: "100",
        ...environment,
      },
    });
    workers.push(worker);
    return worker;
  }

  it("audits initial materialization and publication commands with their jobs", async () => {
    const fixture = await prepareConfiguredDraft();
    const parseAudit = await db.query(
      `SELECT details FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = $1
         AND action = 'parse_attempt_requested'
       ORDER BY created_at DESC LIMIT 1`,
      [fixture.parsedViewId],
    );
    expect(parseAudit.rows[0].details).toMatchObject({
      correlationId: fixture.jobId,
    });
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: fixture.draft.leaseToken,
        expectedRevision: fixture.configuredRevision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const materializationAudit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}/audit`,
      headers: { cookie },
    });
    expect(materializationAudit.statusCode).toBe(200);
    expect(materializationAudit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "candidate_materialization_requested",
          details: {
            candidateId: materialized.json().candidate.id,
            correlationId: materialized.json().job.id,
          },
        }),
      ]),
    );

    startWorker(`ticket09-command-audit-${randomUUID()}`);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${materialized.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    await stopWorkers();
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(published.statusCode).toBe(202);
    const publicationAudit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}/audit`,
      headers: { cookie },
    });
    expect(publicationAudit.statusCode).toBe(200);
    expect(publicationAudit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "publication_requested",
          details: {
            candidateId: materialized.json().candidate.id,
            correlationId: published.json().job.id,
          },
        }),
      ]),
    );
    await stopWorkers();
  });

  it("cancels a queued parse job before a Worker claims it and preserves the asset", async () => {
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    const cancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${upload.jobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json().job).toMatchObject({
      id: upload.jobId,
      status: "cancel_requested",
      correlationId: upload.jobId,
    });

    startWorker(`ticket09-cancel-${randomUUID()}`);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(job.job).toMatchObject({
      id: upload.jobId,
      kind: "parse_asset",
      status: "cancelled",
      stage: "cancelled",
      progress: 100,
      attempt: 0,
      correlationId: upload.jobId,
    });

    const parsedView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/records`,
      headers: { cookie },
    });
    expect(parsedView.statusCode).toBe(200);
    expect(parsedView.json().parsedView).toMatchObject({
      id: upload.parsedViewId,
      status: "cancelled",
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(createHash("sha256").update(download.rawPayload).digest("hex")).toBe(
      createHash("sha256").update(upload.bytes).digest("hex"),
    );
    await stopWorkers();
  });

  it("cancels a claimed parse Job without rewriting the Parsed View as failed", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob({
      bytes: Buffer.from(
        `question,answer\n${Array.from(
          { length: 200 },
          (_, index) => `Synthetic ${index},Answer ${index}`,
        ).join("\n")}\n`,
      ),
      fileName: "ticket09-running-cancel.csv",
      contentType: "text/csv; charset=utf-8",
    });
    const lock = await db.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM parsed_view WHERE id = $1 FOR UPDATE", [
      upload.parsedViewId,
    ]);
    startWorker(`ticket09-running-parse-cancel-${randomUUID()}`);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "running",
    );
    const cancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${upload.jobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(cancel.statusCode).toBe(202);
    await lock.query("ROLLBACK");
    lock.release();
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(job.job.status).toBe("cancelled");
    const parsedView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/records`,
      headers: { cookie },
    });
    expect(parsedView.json().parsedView).toMatchObject({
      id: upload.parsedViewId,
      status: "cancelled",
    });
    expect(parsedView.json().records).toHaveLength(0);
    await stopWorkers();
  });

  it("cancels a large JSONL parse while the source stream is being consumed", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const bytes = Buffer.from(
      `${Array.from(
        { length: 20_000 },
        (_, index) =>
          JSON.stringify({
            value: index,
            padding: "x".repeat(900),
          }) + "\n",
      ).join("")}`,
    );
    const upload = await uploadQueuedParseJob({
      bytes,
      fileName: "ticket09-running-cancel.jsonl",
      contentType: "application/x-ndjson",
    });
    startWorker(`ticket09-running-jsonl-cancel-${randomUUID()}`);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.stage === "parse:records",
    );
    const cancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${upload.jobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(cancel.statusCode).toBe(202);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(job.job).toMatchObject({
      id: upload.jobId,
      status: "cancelled",
      stage: "cancelled",
    });
    const parsedView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/records`,
      headers: { cookie },
    });
    expect(parsedView.json().parsedView).toMatchObject({
      id: upload.parsedViewId,
      status: "cancelled",
    });
    expect(parsedView.json().records).toHaveLength(0);
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(createHash("sha256").update(download.rawPayload).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    await stopWorkers();
  });

  it("reclaims an expired Worker lease without duplicating the logical parse", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    const queued = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/jobs/${upload.jobId}`,
      headers: { cookie },
    });
    expect(queued.json().job).toMatchObject({
      status: "queued",
      attempt: 0,
    });
    const lock = await db.connect();
    let locked = true;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM parsed_view WHERE id = $1 FOR UPDATE", [
        upload.parsedViewId,
      ]);
      const crashedWorker = startWorker(`ticket09-crashed-${randomUUID()}`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await db.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE application_name LIKE 'ticket09-crashed-%'
             AND wait_event_type = 'Lock' LIMIT 1`,
        );
        if (waiting.rowCount) break;
        if (attempt === 99)
          throw new Error("Crashed Worker never reached its locked parse row");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const running = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/jobs/${upload.jobId}`,
        headers: { cookie },
      });
      expect(running.json().job).toMatchObject({ status: "running" });
      crashedWorker.kill("SIGKILL");
      await new Promise((resolve) => crashedWorker.once("exit", resolve));
      await lock.query("ROLLBACK");
      locked = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      if (locked) await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }

    startWorker(`ticket09-recovery-${randomUUID()}`);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(job.job).toMatchObject({
      status: "succeeded",
      stage: "succeeded",
      progress: 100,
      correlationId: upload.jobId,
    });
    expect(Number(job.job.attempt)).toBeGreaterThanOrEqual(2);
    expect(job.job.counts).toMatchObject({ totalRecords: 1 });

    const parsedView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/records`,
      headers: { cookie },
    });
    expect(parsedView.statusCode).toBe(200);
    expect(parsedView.json().parsedView).toMatchObject({
      status: "ready",
      totalCount: 1,
      successCount: 1,
      failureCount: 0,
    });
    expect(parsedView.json().records).toHaveLength(1);
  });

  it("marks a parse view failed when its final Worker lease expires", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    await db.query(`UPDATE parsed_view SET status = 'parsing' WHERE id = $1`, [
      upload.parsedViewId,
    ]);
    await db.query(
      `UPDATE job SET status = 'running', stage = 'parse:records', attempt = 1,
          max_attempts = 1, lease_owner = 'ticket09-expired-worker',
          lease_expires_at = now() - interval '1 second', next_run_at = NULL
       WHERE id = $1`,
      [upload.jobId],
    );

    startWorker(`ticket09-expired-final-${randomUUID()}`);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "failed",
    );
    expect(job.job).toMatchObject({
      status: "failed",
      errorCode: "job_lease_expired",
      retryable: true,
    });
    const parsedView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/records`,
      headers: { cookie },
    });
    expect(parsedView.json().parsedView).toMatchObject({
      status: "parse_failed",
      recordCount: null,
    });
    await stopWorkers();
  });

  it("converges two Workers competing for one due parse Job", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    startWorker(`ticket09-competing-a-${randomUUID()}`);
    startWorker(`ticket09-competing-b-${randomUUID()}`);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    expect(job.job).toMatchObject({ id: upload.jobId, status: "succeeded" });
    const records = await db.query(
      "SELECT count(*)::int AS count FROM source_record WHERE parsed_view_id = $1",
      [upload.parsedViewId],
    );
    expect(records.rows[0].count).toBe(1);
    const jobs = await db.query(
      `SELECT count(*)::int AS count FROM job
       WHERE kind = 'parse_asset' AND payload ->> 'assetId' = $1`,
      [upload.assetId],
    );
    expect(jobs.rows[0].count).toBe(1);
    await stopWorkers();
  });

  it("retries a transient object-storage failure on the same logical job", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    const original = await db.query(
      "SELECT object_ref FROM data_asset WHERE id = $1",
      [upload.assetId],
    );
    expect(original.rowCount).toBe(1);
    await db.query(
      "UPDATE data_asset SET object_ref = 'blobs/sha256/ticket09-transient-missing' WHERE id = $1",
      [upload.assetId],
    );
    startWorker(`ticket09-retry-${randomUUID()}`, {
      JOB_INITIAL_BACKOFF_MS: "1000",
      JOB_HEARTBEAT_INTERVAL_MS: "100",
    });
    const waiting = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "retry_wait",
    );
    expect(waiting.job).toMatchObject({
      status: "retry_wait",
      stage: "retry_wait",
      maxAttempts: 3,
      retryable: true,
      errorCode: "infrastructure_unavailable",
      correlationId: upload.jobId,
    });
    expect(Number(waiting.job.attempt)).toBeGreaterThanOrEqual(1);

    await db.query("UPDATE data_asset SET object_ref = $2 WHERE id = $1", [
      upload.assetId,
      original.rows[0].object_ref,
    ]);
    const succeeded = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(succeeded.job).toMatchObject({
      status: "succeeded",
      stage: "succeeded",
      progress: 100,
      errorCode: null,
      retryable: null,
      correlationId: upload.jobId,
    });
    expect(Number(succeeded.job.attempt)).toBeGreaterThanOrEqual(2);
    const scheduledAudit = await db.query(
      `SELECT details FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = $1
         AND action = 'job_retry_scheduled'`,
      [upload.jobId],
    );
    expect(scheduledAudit.rows[0].details).toMatchObject({
      correlationId: upload.jobId,
      errorCode: "infrastructure_unavailable",
    });
  });

  it("manual retry reuses the failed job id and converges to one parse result", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    const original = await db.query(
      "SELECT object_ref FROM data_asset WHERE id = $1",
      [upload.assetId],
    );
    await db.query(
      "UPDATE data_asset SET object_ref = 'blobs/sha256/ticket09-manual-missing' WHERE id = $1",
      [upload.assetId],
    );
    await db.query("UPDATE job SET max_attempts = 1 WHERE id = $1", [
      upload.jobId,
    ]);
    startWorker(`ticket09-manual-failure-${randomUUID()}`, {
      JOB_MAX_ATTEMPTS: "1",
    });
    const failed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "failed",
    );
    expect(failed.job).toMatchObject({
      id: upload.jobId,
      status: "failed",
      errorCode: "infrastructure_unavailable",
      retryable: false,
    });
    expect(Number(failed.job.attempt)).toBe(1);
    const failedAudit = await db.query(
      `SELECT details FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = $1
         AND action = 'job_failed'`,
      [upload.jobId],
    );
    expect(failedAudit.rows[0].details).toMatchObject({
      correlationId: upload.jobId,
      errorCode: "infrastructure_unavailable",
    });

    await db.query("UPDATE data_asset SET object_ref = $2 WHERE id = $1", [
      upload.assetId,
      original.rows[0].object_ref,
    ]);
    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${upload.jobId}/retry`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().job).toMatchObject({
      id: upload.jobId,
      status: "queued",
      attempt: 0,
      correlationId: upload.jobId,
    });

    const succeeded = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${upload.jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(succeeded.job).toMatchObject({
      id: upload.jobId,
      status: "succeeded",
      errorCode: null,
      progress: 100,
    });
    const retryAudit = await db.query(
      `SELECT details FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = $1
         AND action = 'job_retry_requested'`,
      [upload.jobId],
    );
    expect(retryAudit.rows[0].details).toMatchObject({
      correlationId: upload.jobId,
    });
    const parsedView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/records`,
      headers: { cookie },
    });
    expect(parsedView.json().parsedView).toMatchObject({
      id: upload.parsedViewId,
      status: "ready",
      totalCount: 1,
    });
    expect(parsedView.json().records).toHaveLength(1);
  });

  it("cancels materialization before visibility and preserves the editable draft", async () => {
    const fixture = await prepareConfiguredDraft();
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: fixture.draft.leaseToken,
        expectedRevision: fixture.configuredRevision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const jobId = materialized.json().job.id as string;
    const candidateId = materialized.json().candidate.id as string;

    const lock = await db.connect();
    let locked = true;
    try {
      await lock.query("BEGIN");
      await lock.query(
        "SELECT id FROM candidate_snapshot WHERE id = $1 FOR UPDATE",
        [candidateId],
      );
      startWorker(`ticket09-materialize-cancel-${randomUUID()}`);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await db.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE application_name LIKE 'ticket09-materialize-cancel-%'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%candidate_snapshot%'
           LIMIT 1`,
        );
        if (waiting.rowCount) break;
        if (attempt === 199)
          throw new Error("Worker never reached the candidate visibility lock");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const cancel = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/jobs/${jobId}/cancel`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(cancel.statusCode).toBe(202);
      expect(cancel.json().job).toMatchObject({
        id: jobId,
        status: "cancel_requested",
      });
      await lock.query("ROLLBACK");
      locked = false;
    } finally {
      if (locked) await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }

    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(job.job).toMatchObject({
      status: "cancelled",
      stage: "cancelled",
      progress: 100,
      correlationId: jobId,
    });
    const cancelAudit = await db.query(
      `SELECT details FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = $1
         AND action IN ('job_cancel_requested', 'job_cancelled')`,
      [jobId],
    );
    for (const event of cancelAudit.rows)
      expect(event.details).toMatchObject({ correlationId: jobId });
    const candidate = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${candidateId}`,
      headers: { cookie },
    });
    expect(candidate.json().candidate).toMatchObject({
      id: candidateId,
      status: "failed",
      validationReport: {
        errorCode: "job_cancelled",
        blockingPhase: "candidate_materialization",
      },
    });
    const draft = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}`,
      headers: { cookie },
    });
    expect(draft.json().draft).toMatchObject({ status: "editing" });
  });

  it("uses the frozen materialization inputs as the job idempotency key", async () => {
    const fixture = await prepareConfiguredDraft();
    const requestMaterialization = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${fixture.draft.id}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: fixture.draft.leaseToken,
          expectedRevision: fixture.configuredRevision,
        },
      });
    const [first, replay] = await Promise.all([
      requestMaterialization(),
      requestMaterialization(),
    ]);
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    const responses = [first.json(), replay.json()];
    const original = responses.find((body) => !body.replayed);
    const replayed = responses.find((body) => body.replayed);
    expect(original).toBeDefined();
    expect(replayed).toMatchObject({
      candidate: { id: original.candidate.id },
      job: { id: original.job.id },
      replayed: true,
    });
    const jobs = await db.query(
      `SELECT count(*)::int AS count FROM job
         WHERE kind = 'materialize_candidate'
         AND payload ->> 'candidateId' = $1`,
      [original.candidate.id],
    );
    expect(jobs.rows[0].count).toBe(1);
  });

  it("cancels exact-boundary materialization before the commit marker", async () => {
    const fieldCount = 20;
    const fixture = await prepareConfiguredDraft({
      bytes: buildCapacityFixture("candidate-exact-source-10000-jsonl").bytes,
      fileName: "ticket09-premarker-cancel.jsonl",
      contentType: "application/x-ndjson",
      mapping: {
        input: {
          object: {
            ...Object.fromEntries(
              Array.from({ length: fieldCount }, (_, index) => [
                `field${index}`,
                { source: "/base" },
              ]),
            ),
            tail: { source: "/tail" },
          },
        },
        expectedOutput: { constant: "ok" },
        metadata: { constant: {} },
      },
      filter: { field: "/id", operator: "eq", value: "cap" },
      formalSchema: {
        mode: "gold_required",
        input: { type: "object" },
        expectedOutput: { type: "string" },
      },
      unmappedFields: ["/id"],
    });
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: fixture.draft.leaseToken,
        expectedRevision: fixture.configuredRevision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const jobId = materialized.json().job.id as string;
    const candidateId = materialized.json().candidate.id as string;
    startWorker(`ticket09-premarker-${randomUUID()}`);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.stage === "candidate:items",
    );
    const cancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${jobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(cancel.statusCode).toBe(202);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    const candidate = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${candidateId}`,
      headers: { cookie },
    });
    expect(candidate.json().candidate).toMatchObject({
      status: "failed",
      validationReport: {
        errorCode: "job_cancelled",
        blockingPhase: "candidate_materialization",
      },
    });
    const draft = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${fixture.draft.id}`,
      headers: { cookie },
    });
    expect(draft.json().draft.status).toBe("editing");
  });

  it("cancels queued publication and returns the candidate to ready", async () => {
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    const cancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${jobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(cancel.statusCode).toBe(202);
    startWorker(`ticket09-publish-cancel-${randomUUID()}`);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(job.job).toMatchObject({ status: "cancelled", stage: "cancelled" });
    const candidate = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}`,
      headers: { cookie },
    });
    expect(candidate.json().candidate).toMatchObject({
      status: "ready_to_publish",
    });
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(404);
  });

  it("rejects cancellation after publication enters its transaction", async () => {
    const fixture = await createReadyCandidate();
    const candidateLock = await db.connect();
    const testSetLock = await db.connect();
    let candidateLocked = true;
    let testSetLocked = true;
    try {
      const publish = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(publish.statusCode).toBe(202);
      const jobId = publish.json().job.id as string;
      await candidateLock.query("BEGIN");
      await candidateLock.query(
        "SELECT id FROM candidate_snapshot WHERE id = $1 FOR UPDATE",
        [fixture.candidateId],
      );
      await testSetLock.query("BEGIN");
      await testSetLock.query(
        "SELECT id FROM test_set WHERE id = $1 FOR UPDATE",
        [fixture.testSetId],
      );
      startWorker(`ticket09-atomic-publish-${randomUUID()}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await testSetLock.query("ROLLBACK");
      testSetLocked = false;
      await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.stage === "publication_transaction",
      );
      const cancel = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/jobs/${jobId}/cancel`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json()).toMatchObject({
        error: { code: "publication_cancel_window_closed" },
      });
      await candidateLock.query("ROLLBACK");
      candidateLocked = false;
      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job.status).toBe("succeeded");
      const publishedAudit = await db.query(
        `SELECT details FROM audit_event
         WHERE project_id = 'project_demo' AND object_id = $1
           AND action = 'test_set_version_published'`,
        [job.job.result.versionId],
      );
      expect(publishedAudit.rows[0].details).toMatchObject({
        correlationId: jobId,
      });
      const history = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
        headers: { cookie },
      });
      expect(history.json().versions).toHaveLength(1);
    } finally {
      if (candidateLocked)
        await candidateLock.query("ROLLBACK").catch(() => undefined);
      if (testSetLocked)
        await testSetLock.query("ROLLBACK").catch(() => undefined);
      candidateLock.release();
      testSetLock.release();
    }
  });

  it("rolls back a failing publication transaction and retries without a version hole", async () => {
    await stopWorkers();
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    await db.query("UPDATE job SET max_attempts = 1 WHERE id = $1", [jobId]);
    await db.query(`
      CREATE OR REPLACE FUNCTION ticket09_block_publication()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.candidate_id = '${fixture.candidateId}' THEN
          RAISE EXCEPTION 'ticket09 injected publication transaction failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await db.query(
      "DROP TRIGGER IF EXISTS ticket09_block_publication ON test_set_version",
    );
    await db.query(
      `CREATE TRIGGER ticket09_block_publication
       BEFORE INSERT ON test_set_version
       FOR EACH ROW EXECUTE FUNCTION ticket09_block_publication()`,
    );
    try {
      startWorker(`ticket09-pg-failure-${randomUUID()}`, {
        JOB_MAX_ATTEMPTS: "1",
      });
      const failed = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => ["failed", "succeeded"].includes(body.job?.status),
      );
      expect(failed.job).toMatchObject({
        status: "failed",
        errorCode: "infrastructure_unavailable",
        attempt: 1,
      });
      const failureAudit = await db.query(
        `SELECT details FROM audit_event
         WHERE project_id = 'project_demo' AND object_id = $1
           AND action = 'job_failed'`,
        [jobId],
      );
      expect(failureAudit.rows[0].details).toMatchObject({
        correlationId: jobId,
        errorCode: "infrastructure_unavailable",
      });
      const candidate = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${fixture.candidateId}`,
        headers: { cookie },
      });
      expect(candidate.json().candidate.status).toBe("publish_failed");
      const history = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
        headers: { cookie },
      });
      expect(history.statusCode).toBe(404);
    } finally {
      await db.query(
        "DROP TRIGGER IF EXISTS ticket09_block_publication ON test_set_version",
      );
      await db.query("DROP FUNCTION IF EXISTS ticket09_block_publication()");
    }

    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${jobId}/retry`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(retry.statusCode).toBe(202);
    const succeeded = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(succeeded.job.status).toBe("succeeded");
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.json().versions).toHaveLength(1);
    expect(history.json().versions[0]).toMatchObject({ number: 1 });
  });

  it("replays the same committed version when a success response is lost", async () => {
    await stopWorkers();
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    startWorker(`ticket09-committed-${randomUUID()}`);
    const first = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(first.job.status).toBe("succeeded");
    const firstVersionId = first.job.result.versionId as string;
    await stopWorkers();
    await db.query(
      `UPDATE job SET status = 'queued', stage = 'queued', progress = 0,
          attempt = 0, result = NULL, counts = '{}'::jsonb,
          lease_owner = NULL, lease_expires_at = NULL, next_run_at = now()
       WHERE id = $1`,
      [jobId],
    );
    startWorker(`ticket09-recovery-committed-${randomUUID()}`);
    const recovered = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(recovered.job.status).toBe("succeeded");
    expect(recovered.job.result.versionId).toBe(firstVersionId);
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.json().versions).toHaveLength(1);
    expect(history.json().versions[0]).toMatchObject({
      id: firstVersionId,
      number: 1,
    });
  });

  it("reclaims a Worker killed after the Manifest marker and before DB commit", async () => {
    await stopWorkers();
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    const artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    const listAllMarkerKeys = async () => {
      const keys: string[] = [];
      let startAfter: string | undefined;
      for (;;) {
        const page = await artifacts.list("markers/sha256/", startAfter);
        keys.push(...page.map((marker) => marker.key));
        if (page.length < 1000) return keys;
        startAfter = page.at(-1)?.key;
      }
    };
    const beforeMarkers = new Set(await listAllMarkerKeys());
    const advisoryKey = 909001;
    const hold = await db.connect();
    let triggerInstalled = false;
    try {
      await hold.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
      await db.query(`
        CREATE OR REPLACE FUNCTION ticket09_hold_manifest_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_lock(${advisoryKey});
          RETURN NEW;
        END;
        $$;
      `);
      await db.query(
        "DROP TRIGGER IF EXISTS ticket09_hold_manifest_insert ON test_set_version",
      );
      await db.query(
        `CREATE TRIGGER ticket09_hold_manifest_insert
         BEFORE INSERT ON test_set_version
         FOR EACH ROW WHEN (NEW.candidate_id = '${fixture.candidateId}')
         EXECUTE FUNCTION ticket09_hold_manifest_insert()`,
      );
      triggerInstalled = true;

      const worker = startWorker(`ticket09-marker-crash-${randomUUID()}`);
      let markerKey: string | undefined;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        markerKey = (await listAllMarkerKeys()).find(
          (key) => !beforeMarkers.has(key),
        );
        if (markerKey) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(markerKey).toBeDefined();
      const running = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/jobs/${jobId}`,
        headers: { cookie },
      });
      expect(running.json().job).toMatchObject({
        id: jobId,
        status: "running",
        stage: "publication_transaction",
      });
      worker.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
    } finally {
      await hold
        .query("SELECT pg_advisory_unlock($1)", [advisoryKey])
        .catch(() => undefined);
      hold.release();
      if (triggerInstalled)
        await db
          .query(
            "DROP TRIGGER IF EXISTS ticket09_hold_manifest_insert ON test_set_version",
          )
          .catch(() => undefined);
      await db.query("DROP FUNCTION IF EXISTS ticket09_hold_manifest_insert()");
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    startWorker(`ticket09-marker-crash-recovery-${randomUUID()}`);
    const recovered = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(recovered.job).toMatchObject({
      id: jobId,
      status: "succeeded",
      result: { versionId: expect.any(String) },
    });
    expect(Number(recovered.job.attempt)).toBeGreaterThanOrEqual(2);
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.json().versions).toHaveLength(1);
    expect(history.json().versions[0]).toMatchObject({ number: 1 });
    const version = await db.query(
      `SELECT id, sequence FROM test_set_version WHERE candidate_id = $1`,
      [fixture.candidateId],
    );
    expect(version.rows).toHaveLength(1);
    const membership = await db.query(
      `SELECT count(*)::int AS count, count(DISTINCT case_revision_id)::int AS distinct_count
       FROM version_member WHERE version_id = $1`,
      [version.rows[0].id],
    );
    expect(membership.rows[0].count).toBeGreaterThan(0);
    expect(membership.rows[0].count).toBe(membership.rows[0].distinct_count);
    await stopWorkers();
  });

  it("reclaims a Worker killed after the publication DB commit", async () => {
    await stopWorkers();
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    const advisoryKey = 909002;
    const hold = await db.connect();
    let triggerInstalled = false;
    try {
      await hold.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
      await db.query(`
        CREATE OR REPLACE FUNCTION ticket09_hold_delivery_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_lock(${advisoryKey});
          RETURN NEW;
        END;
        $$;
      `);
      await db.query(
        "DROP TRIGGER IF EXISTS ticket09_hold_delivery_insert ON delivery_record",
      );
      await db.query(
        `CREATE TRIGGER ticket09_hold_delivery_insert
         BEFORE INSERT ON delivery_record
         FOR EACH ROW WHEN (NEW.version_id IS NOT NULL)
         EXECUTE FUNCTION ticket09_hold_delivery_insert()`,
      );
      triggerInstalled = true;
      const worker = startWorker(`ticket09-db-commit-crash-${randomUUID()}`);
      const history = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
            headers: { cookie },
          }),
        (body) => Array.isArray(body.versions) && body.versions.length === 1,
      );
      expect(history.versions[0]).toMatchObject({ number: 1 });
      const running = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/jobs/${jobId}`,
        headers: { cookie },
      });
      expect(running.json().job).toMatchObject({
        id: jobId,
        status: "running",
      });
      worker.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        worker.once("exit", () => resolve()),
      );
    } finally {
      await hold
        .query("SELECT pg_advisory_unlock($1)", [advisoryKey])
        .catch(() => undefined);
      hold.release();
      if (triggerInstalled)
        await db
          .query(
            "DROP TRIGGER IF EXISTS ticket09_hold_delivery_insert ON delivery_record",
          )
          .catch(() => undefined);
      await db.query("DROP FUNCTION IF EXISTS ticket09_hold_delivery_insert()");
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    startWorker(`ticket09-db-commit-crash-recovery-${randomUUID()}`);
    const recovered = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(recovered.job).toMatchObject({
      id: jobId,
      status: "succeeded",
      result: { versionId: expect.any(String) },
    });
    expect(Number(recovered.job.attempt)).toBeGreaterThanOrEqual(2);
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.json().versions).toHaveLength(1);
    const versionId = history.json().versions[0].id as string;
    const counts = await db.query(
      `SELECT
         (SELECT count(*) FROM test_set_version WHERE test_set_id = $1)::int AS versions,
         (SELECT count(*) FROM version_member WHERE version_id = $2)::int AS members,
         (SELECT count(*) FROM delivery_record WHERE version_id = $2)::int AS deliveries`,
      [fixture.testSetId, versionId],
    );
    expect(counts.rows[0]).toMatchObject({ versions: 1, deliveries: 1 });
    expect(counts.rows[0].members).toBeGreaterThan(0);
    await stopWorkers();
  });

  it("fails safely on a final package marker mismatch and recovers the same version", async () => {
    await stopWorkers();
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    startWorker(`ticket09-marker-success-${randomUUID()}`);
    const first = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(first.job.status).toBe("succeeded");
    const versionId = first.job.result.versionId as string;
    await stopWorkers();

    const artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    const delivery = await db.query(
      "SELECT object_ref FROM delivery_record WHERE version_id = $1",
      [versionId],
    );
    const digest = delivery.rows[0].object_ref.split("/").pop() as string;
    const markerRef = `markers/sha256/${digest}.json`;
    const validMarker = await artifacts.readBytes(markerRef, 100_000);
    await artifacts.client.putObject(
      artifacts.bucket,
      markerRef,
      Buffer.from('{"objects":[],"rootHash":"invalid"}'),
      34,
      { "Content-Type": "application/json" },
    );
    await db.query(
      `UPDATE job SET status = 'queued', stage = 'queued', progress = 0,
          attempt = 0, result = NULL, counts = '{}'::jsonb, error_code = NULL,
          retryable = NULL, lease_owner = NULL, lease_expires_at = NULL,
          next_run_at = now(), max_attempts = 1
       WHERE id = $1`,
      [jobId],
    );
    startWorker(`ticket09-marker-mismatch-${randomUUID()}`, {
      JOB_MAX_ATTEMPTS: "1",
    });
    const failed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(failed.job).toMatchObject({
      status: "failed",
      errorCode: "infrastructure_unavailable",
      attempt: 1,
    });
    const failedHistory = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(failedHistory.json().versions).toEqual([
      expect.objectContaining({ id: versionId, number: 1 }),
    ]);

    await artifacts.client.putObject(
      artifacts.bucket,
      markerRef,
      validMarker,
      validMarker.byteLength,
      { "Content-Type": "application/json" },
    );
    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${jobId}/retry`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(retry.statusCode).toBe(202);
    startWorker(`ticket09-marker-recovery-${randomUUID()}`);
    const recovered = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(recovered.job.status).toBe("succeeded");
    expect(recovered.job.result.versionId).toBe(versionId);
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.json().versions).toEqual([
      expect.objectContaining({ id: versionId, number: 1 }),
    ]);
    await stopWorkers();
  });

  it("rolls back a failed final Manifest object write and retries once storage recovers", async () => {
    await stopWorkers();
    const fixture = await createReadyCandidate();
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${fixture.candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(202);
    const jobId = publish.json().job.id as string;
    await db.query("UPDATE job SET max_attempts = 1 WHERE id = $1", [jobId]);
    const artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    let previousPolicy: string | undefined;
    try {
      previousPolicy = await artifacts.client.getBucketPolicy(artifacts.bucket);
    } catch {
      previousPolicy = undefined;
    }
    try {
      await artifacts.client.setBucketPolicy(
        artifacts.bucket,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Action: ["s3:GetObject", "s3:ListBucket"],
              Resource: [
                `arn:aws:s3:::${artifacts.bucket}`,
                `arn:aws:s3:::${artifacts.bucket}/*`,
              ],
            },
          ],
        }),
      );
      startWorker(`ticket09-object-failure-${randomUUID()}`, {
        JOB_MAX_ATTEMPTS: "1",
        MINIO_ACCESS_KEY: "",
        MINIO_SECRET_KEY: "",
      });
      const failed = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => ["failed", "succeeded"].includes(body.job?.status),
      );
      expect(failed.job).toMatchObject({
        status: "failed",
        errorCode: "infrastructure_unavailable",
      });
      const candidate = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${fixture.candidateId}`,
        headers: { cookie },
      });
      expect(candidate.json().candidate.status).toBe("publish_failed");
      const history = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
        headers: { cookie },
      });
      expect(history.statusCode).toBe(404);
    } finally {
      await artifacts.client.setBucketPolicy(
        artifacts.bucket,
        previousPolicy ??
          JSON.stringify({ Version: "2012-10-17", Statement: [] }),
      );
    }
    await stopWorkers();

    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${jobId}/retry`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(retry.statusCode).toBe(202);
    startWorker(`ticket09-object-recovery-${randomUUID()}`);
    const succeeded = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["failed", "succeeded"].includes(body.job?.status),
    );
    expect(succeeded.job.status).toBe("succeeded");
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${fixture.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.json().versions).toHaveLength(1);
  });

  it("collects only aged unreferenced staging and marker objects", async () => {
    await stopWorkers();
    await isolateJobQueue();
    const upload = await uploadQueuedParseJob();
    const artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    const activeOperationId = `ticket09-active-${randomUUID()}`;
    await artifacts.client.putObject(
      artifacts.bucket,
      `staging/${activeOperationId}/original`,
      Buffer.from("active synthetic staging object"),
    );
    const packageOperationId = `package-${upload.jobId}`;
    await artifacts.client.putObject(
      artifacts.bucket,
      `staging/${packageOperationId}/package`,
      Buffer.from("active synthetic package staging object"),
    );
    const csvJobId = `job_${randomUUID().replaceAll("-", "")}`;
    const csvOperationId = `csv-${csvJobId}`;
    await artifacts.client.putObject(
      artifacts.bucket,
      `staging/${csvOperationId}/csv`,
      Buffer.from("active synthetic csv staging object"),
    );
    const orphanOperationId = `ticket09-orphan-${randomUUID()}`;
    await artifacts.client.putObject(
      artifacts.bucket,
      `staging/${orphanOperationId}/original`,
      Buffer.from("aged synthetic staging object"),
    );
    const unreferenced = await artifacts.storeImmutable(
      Buffer.from("unreferenced synthetic marker object"),
    );
    await db.query(
      `INSERT INTO upload_idempotency
       (project_id, actor_id, operation, idempotency_key, status, operation_id)
       VALUES ('project_demo', 'user_owner', 'asset_upload', $1, 'receiving', $2)`,
      [`ticket09-active-key-${randomUUID()}`, activeOperationId],
    );
    await db.query(
      `UPDATE job SET status = 'running', stage = 'running',
          lease_owner = 'ticket09-orphan-test', lease_expires_at = now() + interval '1 hour',
          max_attempts = 0, kind = 'generate_package',
          payload = jsonb_build_object('versionId', 'version_orphan_test',
            'packageType', 'full_provenance', 'formatVersion', '1.0',
            'operationId', $2::text)
       WHERE id = $1`,
      [upload.jobId, activeOperationId],
    );
    await db.query(
      `INSERT INTO job
       (id, project_id, actor_id, kind, payload, status, stage,
        correlation_id, idempotency_key, max_attempts, next_run_at,
        lease_owner, lease_expires_at)
       VALUES ($1, 'project_demo', 'user_owner', 'generate_langfuse_csv',
               $2::jsonb, 'running', 'running', $1, $3, 3, now(),
               'ticket09-orphan-csv', now() + interval '1 hour')`,
      [
        csvJobId,
        JSON.stringify({ versionId: "version_orphan_test" }),
        `ticket09-orphan-csv-${randomUUID()}`,
      ],
    );

    startWorker(`ticket09-orphan-scan-${randomUUID()}`, {
      JOB_ORPHAN_GRACE_MS: "7000",
      ORPHAN_SCAN_CADENCE_MS: "100",
    });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    expect(await artifacts.list(`staging/${orphanOperationId}/`)).toHaveLength(
      1,
    );
    expect(
      await artifacts.size(`markers/sha256/${unreferenced.sha256}.json`),
    ).toBeGreaterThan(0);
    expect(await artifacts.list(`staging/${activeOperationId}/`)).toHaveLength(
      1,
    );
    expect(await artifacts.list(`staging/${packageOperationId}/`)).toHaveLength(
      1,
    );
    expect(await artifacts.list(`staging/${csvOperationId}/`)).toHaveLength(1);
    await db.query(
      `UPDATE upload_idempotency SET status = 'committed'
       WHERE operation_id = $1`,
      [activeOperationId],
    );
    await db.query(
      `UPDATE job SET status = 'cancelled', stage = 'cancelled', progress = 100,
          lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ANY($1::text[])`,
      [[upload.jobId, csvJobId]],
    );
    let removed = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const staging = await artifacts.list(`staging/${orphanOperationId}/`);
      const marker = await artifacts
        .size(`markers/sha256/${unreferenced.sha256}.json`)
        .then(() => true)
        .catch(() => false);
      if (!staging.length && !marker) {
        removed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(removed).toBe(true);
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${upload.assetId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(upload.bytes);
    await artifacts.remove(`staging/${activeOperationId}/original`);
    await db.query(
      `UPDATE job SET status = 'cancelled', stage = 'cancelled', progress = 100,
          lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [upload.jobId],
    );
    await artifacts.remove(`staging/${packageOperationId}/package`);
    await artifacts.remove(`staging/${csvOperationId}/csv`);
    await db.query(
      `UPDATE job SET status = 'cancelled', stage = 'cancelled', progress = 100,
          lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [csvJobId],
    );
  });
});
