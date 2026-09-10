import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPACITY_LIMITS } from "../../src/capacity.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { canonicalJson } from "../../src/package/contract.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import {
  CAPACITY_BOUNDARY_FIXTURES,
  buildCapacityFixture,
  buildCapacityFixtureValue,
} from "../fixtures/capacity-boundaries.js";

async function waitFor(
  request: () => Promise<{ statusCode: number; json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await request().then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public capacity state");
}

function normalizeCandidateCaseIds(
  bytes: Buffer,
  stableCaseId: string,
): Buffer {
  const normalized = bytes
    .toString("utf8")
    .replace(/"case_id":"case_[0-9a-f]{32}"/g, `"case_id":"${stableCaseId}"`);
  return Buffer.from(normalized, "utf8");
}

describe("Ticket 06 S-HTTP capacity boundaries", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let db: ReturnType<typeof createPool>;
  let artifacts: ArtifactRepository;
  let cookie: string;
  let csrf: string;
  let workerApplicationName: string;

  function startWorker(
    applicationName = `agentbench-capacity-${randomUUID()}`,
  ) {
    workerApplicationName = applicationName;
    const databaseUrl = loadConfig().databaseUrl;
    const separator = databaseUrl.includes("?") ? "&" : "?";
    return spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: `${databaseUrl}${separator}application_name=${encodeURIComponent(applicationName)}`,
        },
      },
    );
  }

  async function stopWorker() {
    if (worker.exitCode !== null) return;
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
  }

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    worker = startWorker();
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
    await stopWorker();
    await app.close();
    await db.end();
  });

  async function uploadAsset(index: number, bytes?: Buffer) {
    const content = bytes ?? Buffer.from(`${JSON.stringify({ id: index })}\n`);
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": `capacity-${randomUUID()}`,
        "content-type": "application/x-ndjson",
        "x-file-name": `capacity-${index}-${randomUUID()}.jsonl`,
        "x-source-type": "synthetic",
        "x-source-name": `Ticket 06 fixture ${index}`,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Capacity boundary test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: content,
    });
    expect(upload.statusCode).toBe(201);
    const assetId = upload.json().asset.id;
    const preview = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${assetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    return {
      assetId,
      parsedViewId: preview.parsedView.id,
      size: content.byteLength,
    };
  }

  async function configureConstantInputCandidate(
    assetId: string,
    inputConstant: string,
  ) {
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
        name: `Input capacity ${randomUUID()}`,
        purpose: "Synthetic capacity boundary",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const mapping = {
      input: { constant: inputConstant },
      expectedOutput: { constant: "ok" },
      metadata: { constant: {} },
    };
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        steps: [],
        versionDescription: "Input capacity boundary",
        mapping,
        unmappedFields: ["/id"],
        unmappedConfirmed: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: saved.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/id", operator: "eq", value: "cap" },
        mapping,
        unmappedFields: ["/id"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: { type: "string" },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);
    return app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
  }

  async function configureEmptyCandidate(
    assetId: string,
    beforeMaterialize?: (draftId: string) => Promise<void>,
    filterValue = "none",
  ) {
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
        name: `Empty candidate ${randomUUID()}`,
        purpose: "Synthetic capacity boundary",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const steps = [
      {
        kind: "filter",
        filter: { field: "/id", operator: "eq", value: filterValue },
      },
    ];
    const mapping = {
      input: { source: "/id" },
      expectedOutput: { constant: "ok" },
      metadata: { constant: {} },
    };
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        steps,
        versionDescription: "Empty capacity boundary",
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: saved.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/id", operator: "eq", value: filterValue },
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: { type: "string" },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);
    if (beforeMaterialize) await beforeMaterialize(draft.id);
    return app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
  }

  async function prepareSmallReadyCandidate() {
    const asset = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
    let draftId = "";
    const materialized = await configureEmptyCandidate(
      asset.assetId,
      async (configuredDraftId) => {
        draftId = configuredDraftId;
      },
      "cap",
    );
    const ready = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    const context = await db.query(
      `SELECT ts.id AS test_set_id
       FROM test_set ts JOIN working_draft wd ON wd.test_set_id = ts.id
       WHERE wd.id = $1`,
      [draftId],
    );
    return {
      asset,
      candidateId: materialized.json().candidate.id,
      candidate: ready.candidate,
      draftId,
      testSetId: context.rows[0].test_set_id,
    };
  }

  async function candidateStorageRefsForFaultInjection(candidateId: string) {
    const result = await db.query(
      "SELECT object_ref, evidence_object_ref FROM candidate_snapshot WHERE id = $1",
      [candidateId],
    );
    return result.rows[0] as {
      object_ref: string;
      evidence_object_ref: string;
    };
  }

  async function expectPublicationCapacityDrift(
    ready: Awaited<ReturnType<typeof prepareSmallReadyCandidate>>,
    drift: () => Promise<void>,
    expectedReport: Record<string, unknown>,
    expectedErrorCode = "publication_capacity_exceeded",
  ) {
    const original = await db.query(
      `SELECT status, item_count, object_ref, payload_hash,
              evidence_object_ref, evidence_hash, sources
       FROM candidate_snapshot WHERE id = $1`,
      [ready.candidateId],
    );
    try {
      await drift();
      const publishing = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(publishing.statusCode).toBe(202);
      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${publishing.json().job.id}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job).toMatchObject({
        status: "failed",
        errorCode: expectedErrorCode,
        result: {
          publicationReport: expect.objectContaining({
            errorCode: expectedErrorCode,
            ...expectedReport,
          }),
        },
      });
      const failed = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
        headers: { cookie },
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.json().candidate).toBeDefined();
      expect(failed.json().candidate.status).toBe("publish_failed");
      expect(failed.json().candidate.validationReport).toEqual(
        ready.candidate.validationReport,
      );
      expect(job.job.result.publicationReport).toMatchObject({
        valid: false,
        ...(expectedErrorCode === "publication_capacity_exceeded"
          ? { capacityBlock: true }
          : {}),
        errorCode: expectedErrorCode,
        object: { type: "candidate_snapshot", id: ready.candidateId },
        blockingPhase: "publication_transaction",
        retry: expect.any(String),
        errors: [
          expect.objectContaining({
            code: expectedErrorCode,
          }),
        ],
        ...expectedReport,
      });
      if (expectedErrorCode === "publication_capacity_exceeded") {
        const audit = await app.inject({
          method: "GET",
          url: `/api/projects/project_demo/drafts/${ready.draftId}/audit`,
          headers: { cookie },
        });
        expect(audit.json().events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: "candidate_capacity_blocked",
              details: expect.objectContaining({
                errorCode: "publication_capacity_exceeded",
                blockingPhase: "publication_transaction",
                ...expectedReport,
              }),
            }),
          ]),
        );
      }
    } finally {
      const current = await db.query(
        `SELECT object_ref, evidence_object_ref
         FROM candidate_snapshot WHERE id = $1`,
        [ready.candidateId],
      );
      const originalRow = original.rows[0];
      const currentRow = current.rows[0];
      await db.query(
        `UPDATE candidate_snapshot
         SET status=$2, item_count=$3, object_ref=$4, payload_hash=$5,
             evidence_object_ref=$6, evidence_hash=$7, sources=$8
         WHERE id=$1`,
        [
          ready.candidateId,
          originalRow.status,
          originalRow.item_count,
          originalRow.object_ref,
          originalRow.payload_hash,
          originalRow.evidence_object_ref,
          originalRow.evidence_hash,
          JSON.stringify(originalRow.sources),
        ],
      );
      for (const ref of [
        currentRow?.object_ref,
        currentRow?.evidence_object_ref,
      ]) {
        if (
          typeof ref === "string" &&
          ref !== originalRow.object_ref &&
          ref !== originalRow.evidence_object_ref
        ) {
          await artifacts.remove(ref).catch(() => undefined);
          const hash = ref.split("/").at(-1);
          if (hash)
            await artifacts
              .remove(`markers/sha256/${hash}.json`)
              .catch(() => undefined);
        }
      }
    }
  }

  async function publishAfterHoldingCandidateLock(
    candidateId: string,
    updateSql: string,
  ) {
    await stopWorker();
    const publishing = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${candidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publishing.statusCode).toBe(202);
    const jobId = publishing.json().job.id as string;

    const lock = await db.connect();
    let committed = false;
    try {
      await lock.query("BEGIN");
      await lock.query(updateSql, [candidateId]);
      worker = startWorker(`agentbench-capacity-race-${randomUUID()}`);
      await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "running",
      );
      await waitForWorkerLock("candidate_snapshot", "Candidate");
      await lock.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await lock.query("ROLLBACK").catch(() => undefined);
      await lock.release();
    }
    return jobId;
  }

  async function waitForWorkerLock(
    queryFragment: string,
    label: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await db.query(
        `SELECT 1
         FROM pg_stat_activity
         WHERE application_name = $1
           AND wait_event_type = 'Lock'
           AND query ILIKE $2
         LIMIT 1`,
        [workerApplicationName, `%${queryFragment}%`],
      );
      if (waiting.rowCount) return;
      if (attempt === 99)
        throw new Error(`Worker did not wait on the locked ${label} row`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function materializeExactItemsCandidate() {
    const fieldCount = 20;
    const source = buildCapacityFixture(
      "candidate-exact-source-10000-jsonl",
    ).bytes;
    const asset = await uploadAsset(1, source);
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
        name: `Exact publish ${randomUUID()}`,
        purpose: "Synthetic exact publication boundary",
        assetId: asset.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const mapping = {
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
    };
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        steps: [],
        versionDescription: "Exact 100,000,000-byte publication",
        mapping,
        unmappedFields: ["/id"],
        unmappedConfirmed: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: saved.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/id", operator: "eq", value: "cap" },
        mapping,
        unmappedFields: ["/id"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: { type: "object" },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    const ready = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(ready.candidate.status).toBe("ready_to_publish");
    return {
      candidate: ready.candidate,
      testSetId: created.json().testSet.id,
    };
  }

  it("allows five attached assets and atomically rejects the sixth", async () => {
    const first = await uploadAsset(1);
    const second = await uploadAsset(2);
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
        name: `Capacity asset count ${randomUUID()}`,
        purpose: "Synthetic capacity boundary",
        assetId: first.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const draftId = draft.id;
    const writeHeaders = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };

    const attachSecond = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draftId}/sources`,
      headers: writeHeaders,
      payload: {
        assetId: second.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
      },
    });
    expect(attachSecond.statusCode).toBe(201);

    for (const index of [3, 4, 5]) {
      const asset = await uploadAsset(index);
      const current = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${draftId}`,
        headers: { cookie },
      });
      const attached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draftId}/sources`,
        headers: writeHeaders,
        payload: {
          assetId: asset.assetId,
          leaseToken: draft.leaseToken,
          expectedRevision: current.json().draft.revision,
        },
      });
      expect(attached.statusCode).toBe(201);
      expect(attached.json().draft.capacity).toMatchObject({
        attachedAssets: index,
        assetLimit: 5,
      });
    }

    const sixth = await uploadAsset(6);
    const before = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}`,
      headers: { cookie },
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draftId}/sources`,
      headers: writeHeaders,
      payload: {
        assetId: sixth.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: before.json().draft.revision,
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: {
        code: "draft_capacity_exceeded",
        blockingPhase: "draft_attachment",
        limit: { assets: 5 },
        actual: { assets: 6 },
        object: { type: "working_draft", id: draftId },
        retry:
          "Remove or replace a Working Draft attachment, then retry with an eligible Data Asset.",
      },
    });

    const after = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}`,
      headers: { cookie },
    });
    expect(after.json().draft.capacity).toMatchObject({
      attachedAssets: 5,
      assetLimit: 5,
    });
    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}/audit`,
      headers: { cookie },
    });
    expect(audit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "draft_capacity_blocked",
          details: expect.objectContaining({
            errorCode: "draft_capacity_exceeded",
            blockingPhase: "draft_attachment",
            exceededDimension: "assets",
          }),
        }),
      ]),
    );
  });

  it("allows exactly 100,000,000 draft bytes and rejects one byte more", async () => {
    const exactDraftFixture = buildCapacityFixture(
      "draft-exact-50mb-jsonl",
    ).bytes;
    const first = await uploadAsset(1, exactDraftFixture);
    const exact = await uploadAsset(2, exactDraftFixture);
    const overflow = await uploadAsset(
      3,
      buildCapacityFixture("draft-overflow-byte").bytes,
    );
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
        name: `Capacity exact bytes ${randomUUID()}`,
        purpose: "Synthetic capacity boundary",
        assetId: first.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const exactAttach = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources`,
      headers,
      payload: {
        assetId: exact.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
      },
    });
    expect(exactAttach.statusCode).toBe(201);
    expect(exactAttach.json().draft.capacity).toMatchObject({
      originalBytes: 100_000_000,
      originalByteLimit: 100_000_000,
    });

    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources`,
      headers,
      payload: {
        assetId: overflow.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: exactAttach.json().draft.revision,
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: {
        code: "draft_capacity_exceeded",
        blockingPhase: "draft_attachment",
        limit: { originalBytes: 100_000_000 },
        actual: { originalBytes: 100_000_001 },
      },
    });
  });

  it("allows 10,000 attached Source Records and rejects one more", async () => {
    const first = await uploadAsset(
      1,
      buildCapacityFixture("source-exact-5000-jsonl").bytes,
    );
    const exactSecond = await uploadAsset(
      2,
      buildCapacityFixture("source-exact-5000-jsonl").bytes,
    );
    const overflow = await uploadAsset(
      3,
      Buffer.from(`${JSON.stringify({ id: "overflow" })}\n`),
    );
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
        name: `Capacity records ${randomUUID()}`,
        purpose: "Synthetic capacity boundary",
        assetId: first.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        assetId: exactSecond.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    expect(attached.json().draft.capacity).toMatchObject({
      sourceRecords: 10_000,
      sourceRecordLimit: 10_000,
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        assetId: overflow.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: attached.json().draft.revision,
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: {
        code: "draft_capacity_exceeded",
        actual: { sourceRecords: 10_001 },
        limit: { sourceRecords: 10_000 },
      },
    });
    const retained = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie },
    });
    expect(retained.json().draft.capacity).toMatchObject({
      attachedAssets: 2,
      sourceRecords: 10_000,
      sourceRecordLimit: 10_000,
    });
  });

  it(
    "allows five assets, 100,000,000 bytes, and 10,000 records together",
    { timeout: 180_000 },
    async () => {
      const fixtureIds = [
        "draft-combined-asset-1",
        "draft-combined-asset-2",
        "draft-combined-asset-3",
        "draft-combined-asset-4",
        "draft-combined-asset-5",
      ] as const;
      const assets = [];
      for (const [index, fixtureId] of fixtureIds.entries())
        assets.push(
          await uploadAsset(index + 1, buildCapacityFixture(fixtureId).bytes),
        );
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
          name: `Combined capacity boundary ${randomUUID()}`,
          purpose: "Synthetic combined capacity boundary",
          assetId: assets[0].assetId,
        },
      });
      expect(created.statusCode).toBe(201);
      const draft = created.json().draft;
      const headers = {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      };
      let revision = draft.revision;
      for (const asset of assets.slice(1)) {
        const attached = await app.inject({
          method: "POST",
          url: `/api/projects/project_demo/drafts/${draft.id}/sources`,
          headers,
          payload: {
            assetId: asset.assetId,
            leaseToken: draft.leaseToken,
            expectedRevision: revision,
          },
        });
        expect(attached.statusCode).toBe(201);
        revision = attached.json().draft.revision;
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/project_demo/drafts/${draft.id}`,
            headers: { cookie },
          })
        ).json().draft.capacity,
      ).toMatchObject({
        attachedAssets: 5,
        assetLimit: 5,
        originalBytes: 100_000_000,
        originalByteLimit: 100_000_000,
        sourceRecords: 10_000,
        sourceRecordLimit: 10_000,
      });
    },
  );

  it("blocks one input above the frozen per-item cap and preserves the draft", async () => {
    const asset = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
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
        name: `Input capacity ${randomUUID()}`,
        purpose: "Synthetic capacity boundary",
        assetId: asset.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const mapping = {
      input: { constant: buildCapacityFixtureValue("g02-over-input") },
      expectedOutput: { constant: "ok" },
      metadata: { constant: {} },
    };
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        steps: [],
        versionDescription: "Input capacity boundary",
        mapping,
        unmappedFields: ["/id"],
        unmappedConfirmed: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: saved.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/id", operator: "eq", value: "cap" },
        mapping,
        unmappedFields: ["/id"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: { type: "string" },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);

    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const failed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(failed.candidate.validationReport).toMatchObject({
      valid: false,
      errors: [
        {
          code: "input_capacity_exceeded",
          ordinal: 1,
          actualBytes: 10_000_003,
          limitBytes: 10_000_000,
        },
      ],
    });

    const retained = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie },
    });
    expect(retained.json().draft).toMatchObject({
      status: "editing",
      recipe: { mapping },
    });
  });

  it("allows one canonical input of exactly 10,000,000 bytes", async () => {
    const asset = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
    const materialized = await configureConstantInputCandidate(
      asset.assetId,
      buildCapacityFixtureValue("g02-exact-input"),
    );
    expect(materialized.statusCode).toBe(202);
    const candidate = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate.status).toBe("ready_to_publish");
  }, 60_000);

  it("blocks an empty candidate with a stable capacity report", async () => {
    const asset = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
    let draftId = "";
    const materialized = await configureEmptyCandidate(
      asset.assetId,
      async (configuredDraftId) => {
        draftId = configuredDraftId;
      },
    );
    expect(materialized.statusCode).toBe(202);
    const failed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(failed.candidate.status).toBe("failed");
    expect(failed.candidate.validationReport).toMatchObject({
      valid: false,
      errorCode: "candidate_empty",
      capacityBlock: true,
      blockingPhase: "candidate_materialization",
      exceededDimension: "candidate_minimum_items",
      actual: 0,
      limit: 1,
      minimumItems: 1,
      maximumItems: 10_000,
      actualItems: 0,
      limitItems: 10_000,
      retry: expect.stringContaining("at least one item"),
      errors: [
        {
          code: "candidate_empty",
          retry: expect.stringContaining("at least one item"),
        },
      ],
    });
    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}/audit`,
      headers: { cookie },
    });
    expect(audit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "candidate_capacity_blocked",
          details: expect.objectContaining({
            errorCode: "candidate_empty",
            blockingPhase: "candidate_materialization",
            exceededDimension: "candidate_minimum_items",
            actual: 0,
            limit: 1,
            minimumItems: 1,
            maximumItems: 10_000,
            actualItems: 0,
            limitItems: 10_000,
          }),
        }),
      ]),
    );
  });

  it("checks draft aggregate capacity before materialization work", async () => {
    const asset = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
    let draftId = "";
    const materialized = await configureEmptyCandidate(
      asset.assetId,
      async (configuredDraftId) => {
        draftId = configuredDraftId;
        await db.query(
          "UPDATE data_asset SET size_bytes = 100000001 WHERE id = $1",
          [asset.assetId],
        );
      },
      "cap",
    );
    expect(materialized.statusCode).toBe(202);
    const failed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(failed.candidate.status).toBe("failed");
    expect(failed.candidate.validationReport).toMatchObject({
      valid: false,
      blockingPhase: "candidate_materialization",
      errorCode: "draft_capacity_exceeded",
      object: {
        type: "candidate_snapshot",
        id: materialized.json().candidate.id,
      },
      actual: { originalBytes: 100_000_001 },
      limit: { originalBytes: 100_000_000 },
    });

    const draft = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}`,
      headers: { cookie },
    });
    expect(draft.json().draft.status).toBe("editing");
    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}/audit`,
      headers: { cookie },
    });
    expect(audit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "candidate_capacity_blocked",
          details: expect.objectContaining({
            errorCode: "draft_capacity_exceeded",
          }),
        }),
      ]),
    );
  });

  it("uses frozen Candidate sources for materialization capacity", async () => {
    const primary = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
    const activeExtra = await uploadAsset(
      2,
      Buffer.from(`${JSON.stringify({ id: "extra" })}\n`),
    );
    await stopWorker();
    let draftId = "";
    const materialized = await configureEmptyCandidate(
      primary.assetId,
      async (configuredDraftId) => {
        draftId = configuredDraftId;
      },
      "cap",
    );
    expect(materialized.statusCode).toBe(202);
    await db.query(
      "UPDATE data_asset SET size_bytes = 100000001 WHERE id = $1",
      [activeExtra.assetId],
    );
    await db.query(
      `INSERT INTO draft_source
       (id, draft_id, asset_id, parsed_view_id, position, created_by,
        mapping, unmapped_fields, unmapped_confirmed)
       VALUES ($1, $2, $3, $4, 2, 'user_owner', '{}'::jsonb, '[]'::jsonb, true)`,
      [
        `draftsource_${randomUUID().replaceAll("-", "")}`,
        draftId,
        activeExtra.assetId,
        activeExtra.parsedViewId,
      ],
    );
    worker = startWorker();
    const candidate = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate).toMatchObject({
      status: "ready_to_publish",
      itemCount: 1,
    });
  });

  it("replays the newest active publication job while a Candidate is publishing", async () => {
    const asset = await uploadAsset(
      1,
      Buffer.from(`${JSON.stringify({ id: "cap" })}\n`),
    );
    const materialized = await configureEmptyCandidate(
      asset.assetId,
      undefined,
      "cap",
    );
    const ready = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    expect(ready.candidate.status).toBe("ready_to_publish");

    const jobId = `job_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `UPDATE candidate_snapshot SET status = 'publishing' WHERE id = $1`,
      [materialized.json().candidate.id],
    );
    await db.query(
      `INSERT INTO job
       (id, project_id, actor_id, kind, payload, status, created_at,
        correlation_id, idempotency_key)
       VALUES ($1, 'project_demo', 'user_owner', 'publish_version', $2, 'running',
               now(), $1, $3)`,
      [
        jobId,
        { candidateId: materialized.json().candidate.id },
        `publication:${materialized.json().candidate.id}`,
      ],
    );

    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers,
    });
    const third = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({
      job: { id: jobId, status: "running" },
      replayed: true,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({
      job: { id: jobId, status: "running" },
      replayed: true,
    });
    expect(third.statusCode).toBe(202);
    expect(third.json()).toEqual({
      job: { id: jobId, status: "running" },
      replayed: true,
    });
    const jobs = await db.query(
      `SELECT id, status FROM job
       WHERE project_id = 'project_demo' AND kind = 'publish_version'
         AND payload ->> 'candidateId' = $1
       ORDER BY created_at`,
      [materialized.json().candidate.id],
    );
    expect(jobs.rows).toEqual([{ id: jobId, status: "running" }]);
    await db.query("UPDATE job SET status = 'failed' WHERE id = $1", [jobId]);
    const noActiveJob = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers,
    });
    expect(noActiveJob.statusCode).toBe(409);
    expect(noActiveJob.json()).toEqual({
      error: { code: "publication_job_not_active" },
    });
  });

  it("reports recorded item-count drift in the publication transaction", async () => {
    const ready = await prepareSmallReadyCandidate();
    await expectPublicationCapacityDrift(
      ready,
      async () => {
        await db.query(
          "UPDATE candidate_snapshot SET item_count = 10001 WHERE id = $1",
          [ready.candidateId],
        );
      },
      {
        exceededDimension: "candidate_item_count",
        actual: 10_001,
        payloadItems: 1,
        recordedItems: 10_001,
        limit: 10_000,
      },
    );
  });

  it("reports under-limit item-count drift as publication integrity failure", async () => {
    const ready = await prepareSmallReadyCandidate();
    await expectPublicationCapacityDrift(
      ready,
      async () => {
        await db.query(
          "UPDATE candidate_snapshot SET item_count = 2 WHERE id = $1",
          [ready.candidateId],
        );
      },
      {
        payloadItems: 1,
        recordedItems: 2,
      },
      "publication_item_count_mismatch",
    );
  });

  it("keeps the frozen Candidate report when publication fails and is retried", async () => {
    const ready = await prepareSmallReadyCandidate();
    const originalReport = ready.candidate.validationReport;
    await db.query(
      "UPDATE candidate_snapshot SET item_count = 10001 WHERE id = $1",
      [ready.candidateId],
    );
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${ready.candidateId}/publish`,
      headers,
    });
    expect(first.statusCode).toBe(202);
    const failedJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${first.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "failed",
    );
    expect(failedJob.job.result.publicationReport).toMatchObject({
      errorCode: "publication_capacity_exceeded",
    });
    const afterFailure = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
      headers: { cookie },
    });
    expect(afterFailure.json().candidate.validationReport).toEqual(
      originalReport,
    );

    await db.query(
      "UPDATE candidate_snapshot SET item_count = 1 WHERE id = $1",
      [ready.candidateId],
    );
    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${ready.candidateId}/publish`,
      headers,
    });
    expect(retry.statusCode).toBe(202);
    const succeededJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${retry.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${ready.testSetId}/versions/${succeededJob.job.result.versionId}`,
      headers: { cookie },
    });
    expect(version.json().version.evidence.validationReport).toEqual(
      originalReport,
    );
    const publishedCandidate = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
      headers: { cookie },
    });
    expect(publishedCandidate.json().candidate.validationReport).toEqual(
      originalReport,
    );
  });

  it("rejects Candidate identity drift observed after the publication precheck", async () => {
    const ready = await prepareSmallReadyCandidate();
    try {
      const jobId = await publishAfterHoldingCandidateLock(
        ready.candidateId,
        "UPDATE candidate_snapshot SET payload_hash = repeat('d', 64) WHERE id = $1",
      );

      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job).toMatchObject({
        status: "failed",
        errorCode: "publication_candidate_drift",
        result: {
          publicationReport: expect.objectContaining({
            errorCode: "publication_candidate_drift",
            expected: expect.objectContaining({
              payloadHash: ready.candidate.payloadHash,
            }),
            actual: expect.objectContaining({
              payloadHash: "d".repeat(64),
            }),
          }),
        },
      });
      const candidate = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
        headers: { cookie },
      });
      expect(candidate.json().candidate).toMatchObject({
        status: "publish_failed",
        validationReport: ready.candidate.validationReport,
      });
    } finally {
      // Restore the injected identity drift so later full consistency scans see a healthy fixture.
      await db.query(
        "UPDATE candidate_snapshot SET status = $2, payload_hash = $3 WHERE id = $1",
        [
          ready.candidateId,
          ready.candidate.status,
          ready.candidate.payloadHash,
        ],
      );
    }
  });

  it("rejects Candidate evidence drift observed after the publication precheck", async () => {
    const ready = await prepareSmallReadyCandidate();
    const originalRefs = await candidateStorageRefsForFaultInjection(
      ready.candidateId,
    );
    try {
      const jobId = await publishAfterHoldingCandidateLock(
        ready.candidateId,
        `UPDATE candidate_snapshot
         SET evidence_object_ref = 'evidence_drift', evidence_hash = repeat('e', 64)
         WHERE id = $1`,
      );

      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job).toMatchObject({
        status: "failed",
        errorCode: "publication_candidate_drift",
        result: {
          publicationReport: expect.objectContaining({
            errorCode: "publication_candidate_drift",
            expected: expect.objectContaining({
              evidenceHash: ready.candidate.evidenceHash,
            }),
            actual: expect.objectContaining({
              evidenceHash: "e".repeat(64),
              evidenceObjectRef: "evidence_drift",
            }),
          }),
        },
      });
    } finally {
      // Restore the injected evidence drift so later full consistency scans see a healthy fixture.
      await db.query(
        "UPDATE candidate_snapshot SET status = $2, evidence_object_ref = $3, evidence_hash = $4 WHERE id = $1",
        [
          ready.candidateId,
          ready.candidate.status,
          originalRefs.evidence_object_ref,
          ready.candidate.evidenceHash,
        ],
      );
    }
  });

  it("rejects Candidate source drift observed after the publication precheck", async () => {
    const ready = await prepareSmallReadyCandidate();
    const original = await db.query(
      "SELECT status, sources FROM candidate_snapshot WHERE id = $1",
      [ready.candidateId],
    );
    try {
      const jobId = await publishAfterHoldingCandidateLock(
        ready.candidateId,
        `UPDATE candidate_snapshot
         SET sources = '[]'::jsonb
         WHERE id = $1`,
      );

      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job).toMatchObject({
        status: "failed",
        errorCode: "publication_candidate_drift",
        result: {
          publicationReport: expect.objectContaining({
            errorCode: "publication_candidate_drift",
            expected: expect.objectContaining({
              sourcesHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
            actual: expect.objectContaining({
              sourcesHash: createHash("sha256").update("[]").digest("hex"),
            }),
          }),
        },
      });
    } finally {
      await db.query(
        "UPDATE candidate_snapshot SET status=$2, sources=$3 WHERE id=$1",
        [
          ready.candidateId,
          original.rows[0].status,
          JSON.stringify(original.rows[0].sources),
        ],
      );
    }
  });

  it(
    "serializes publication capacity recheck before a concurrent attachment",
    { timeout: 120_000 },
    async () => {
      const ready = await prepareSmallReadyCandidate();
      const second = await uploadAsset(
        2,
        Buffer.from(`${JSON.stringify({ id: "concurrent" })}\n`),
      );
      await stopWorker();
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${ready.draftId}`,
        headers: { cookie },
      });
      const lock = await db.connect();
      let committed = false;
      try {
        await lock.query("BEGIN");
        await lock.query(
          "SELECT id FROM working_draft WHERE id = $1 FOR UPDATE",
          [ready.draftId],
        );
        const publishing = await app.inject({
          method: "POST",
          url: `/api/projects/project_demo/candidates/${ready.candidateId}/publish`,
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
          },
        });
        expect(publishing.statusCode).toBe(202);
        const jobId = publishing.json().job.id as string;
        worker = startWorker(`ab-draft-${randomUUID()}`);
        await waitFor(
          () =>
            app.inject({
              method: "GET",
              url: `/api/projects/project_demo/jobs/${jobId}`,
              headers: { cookie },
            }),
          (body) => body.job?.status === "running",
        );
        await waitForWorkerLock("working_draft", "Working Draft");
        const attachment = app.inject({
          method: "POST",
          url: `/api/projects/project_demo/drafts/${ready.draftId}/sources`,
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          payload: {
            assetId: second.assetId,
            leaseToken: draft.json().draft.leaseToken,
            expectedRevision: draft.json().draft.revision,
          },
        });
        await lock.query("COMMIT");
        committed = true;
        const [attached, job] = await Promise.all([
          attachment,
          waitFor(
            () =>
              app.inject({
                method: "GET",
                url: `/api/projects/project_demo/jobs/${jobId}`,
                headers: { cookie },
              }),
            (body) => ["succeeded", "failed"].includes(body.job?.status),
          ),
        ]);
        expect(job.job.status).toBe("succeeded");
        expect(attached.statusCode).toBe(404);
        const candidate = await app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
          headers: { cookie },
        });
        expect(candidate.json().candidate.status).toBe("published_as_version");
      } finally {
        if (!committed) await lock.query("ROLLBACK").catch(() => undefined);
        await lock.release();
      }
    },
  );

  it(
    "uses frozen Candidate capacity when an attachment commits before the Worker lock",
    { timeout: 120_000 },
    async () => {
      const ready = await prepareSmallReadyCandidate();
      const second = await uploadAsset(
        2,
        Buffer.from(`${JSON.stringify({ id: "source-first" })}\n`),
      );
      await stopWorker();
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${ready.draftId}`,
        headers: { cookie },
      });
      const publishing = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(publishing.statusCode).toBe(202);
      const attached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${ready.draftId}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: second.assetId,
          leaseToken: draft.json().draft.leaseToken,
          expectedRevision: draft.json().draft.revision,
        },
      });
      expect(attached.statusCode).toBe(201);
      await db.query(
        "UPDATE parsed_view SET record_count = 10001 WHERE id = $1",
        [attached.json().source.parsedViewId],
      );
      worker = startWorker(`ab-source-first-${randomUUID()}`);
      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${publishing.json().job.id}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job.status).toBe("succeeded");
      const candidate = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
        headers: { cookie },
      });
      expect(candidate.json().candidate.status).toBe("published_as_version");
    },
  );

  it(
    "uses frozen Candidate capacity when a source removal commits first",
    { timeout: 120_000 },
    async () => {
      const ready = await prepareSmallReadyCandidate();
      const extra = await uploadAsset(
        2,
        Buffer.from(`${JSON.stringify({ id: "removal-first" })}\n`),
      );
      await stopWorker();
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${ready.draftId}`,
        headers: { cookie },
      });
      const source = draft.json().draft.sources[0];
      const publishing = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(publishing.statusCode).toBe(202);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/projects/project_demo/drafts/${ready.draftId}/sources/${source.id}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
        payload: {
          leaseToken: draft.json().draft.leaseToken,
          expectedRevision: draft.json().draft.revision,
        },
      });
      expect(removed.statusCode).toBe(200);
      const attached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${ready.draftId}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: extra.assetId,
          leaseToken: removed.json().draft.leaseToken,
          expectedRevision: removed.json().draft.revision,
        },
      });
      expect(attached.statusCode).toBe(201);
      await db.query(
        "UPDATE parsed_view SET record_count = 10001 WHERE id = $1",
        [attached.json().source.parsedViewId],
      );
      worker = startWorker(`ab-removal-first-${randomUUID()}`);
      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${publishing.json().job.id}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job.status).toBe("succeeded");
      const candidate = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${ready.candidateId}`,
        headers: { cookie },
      });
      expect(candidate.json().candidate.status).toBe("published_as_version");
    },
  );

  it("reports per-item input drift in the publication transaction", async () => {
    const ready = await prepareSmallReadyCandidate();
    await expectPublicationCapacityDrift(
      ready,
      async () => {
        const refs = await candidateStorageRefsForFaultInjection(
          ready.candidateId,
        );
        const original = await artifacts.readBytes(
          refs.object_ref,
          CAPACITY_LIMITS.itemsBytes,
        );
        const lines = original
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        lines[0].input = "x".repeat(CAPACITY_LIMITS.inputBytes - 1);
        const drifted = await artifacts.storeImmutable(
          Buffer.from(
            `${lines.map((line) => canonicalJson(line)).join("\n")}\n`,
          ),
        );
        await db.query(
          `UPDATE candidate_snapshot
           SET object_ref = $2, payload_hash = $3 WHERE id = $1`,
          [ready.candidateId, drifted.objectRef, drifted.sha256],
        );
      },
      {
        object: {
          type: "candidate_item",
          id: expect.any(String),
        },
        ordinal: 1,
        exceededDimension: "candidate_item_input_bytes",
        actual: CAPACITY_LIMITS.inputBytes + 1,
        limit: CAPACITY_LIMITS.inputBytes,
      },
    );
  });

  it("reports a one-byte MinIO object-size drift before publication", async () => {
    const ready = await prepareSmallReadyCandidate();
    await expectPublicationCapacityDrift(
      ready,
      async () => {
        const oversized = await artifacts.storeImmutable(
          Buffer.alloc(CAPACITY_LIMITS.itemsBytes + 1, "x"),
        );
        await db.query(
          `UPDATE candidate_snapshot
           SET object_ref = $2, payload_hash = $3 WHERE id = $1`,
          [ready.candidateId, oversized.objectRef, oversized.sha256],
        );
      },
      {
        exceededDimension: "candidate_object_bytes",
        actual: CAPACITY_LIMITS.itemsBytes + 1,
        limit: CAPACITY_LIMITS.itemsBytes,
      },
    );
  });

  it("materializes and publishes exactly 100,000,000 bytes as default v1", async () => {
    const ready = await materializeExactItemsCandidate();
    const exactFixture =
      CAPACITY_BOUNDARY_FIXTURES["candidate-exact-source-10000-jsonl"];
    expect(ready.candidate).toMatchObject({
      status: "ready_to_publish",
      itemCount: CAPACITY_LIMITS.candidateItems,
    });
    const publishing = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${ready.candidate.id}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publishing.statusCode).toBe(202);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${publishing.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(job.job.status).toBe("succeeded");
    const versionId = job.job.result.versionId as string;
    const packageResponse = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/package`,
      headers: { cookie },
    });
    expect(packageResponse.statusCode).toBe(200);
    const packageFiles = unzipSync(packageResponse.rawPayload);
    const payload = Buffer.from(packageFiles["items.jsonl"]);
    expect(payload.byteLength).toBe(CAPACITY_LIMITS.itemsBytes);
    const normalizedPayload = normalizeCandidateCaseIds(
      payload,
      exactFixture.normalizedCaseId as string,
    );
    expect(normalizedPayload.byteLength).toBe(exactFixture.normalizedBytes);
    expect(createHash("sha256").update(normalizedPayload).digest("hex")).toBe(
      exactFixture.normalizedSha256,
    );
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${ready.testSetId}/versions/${versionId}`,
      headers: { cookie },
    });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      testSet: { defaultVersionId: versionId },
      version: {
        id: versionId,
        number: 1,
        itemCount: CAPACITY_LIMITS.candidateItems,
        payloadHash: ready.candidate.payloadHash,
        manifestHash: expect.any(String),
      },
    });
    const candidate = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${ready.candidate.id}`,
      headers: { cookie },
    });
    expect(candidate.json().candidate.status).toBe("published_as_version");
  }, 180_000);

  it(
    "allows exactly 100,000,000 item bytes and rejects one byte more",
    { timeout: 180_000 },
    async () => {
      const source = buildCapacityFixture(
        "candidate-overflow-source-10000-jsonl",
      ).bytes;
      const fieldCount = 20;
      const asset = await uploadAsset(1, source);
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
          name: `Items capacity ${randomUUID()}`,
          purpose: "Synthetic capacity boundary",
          assetId: asset.assetId,
        },
      });
      expect(created.statusCode).toBe(201);
      const initialDraft = created.json().draft;
      const headers = {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      };

      async function materializeWith(
        tailSource: string,
        unmapped: string[],
        expectedRevision: number,
      ) {
        const input = {
          object: {
            ...Object.fromEntries(
              Array.from({ length: fieldCount }, (_, index) => [
                `field${index}`,
                { source: "/base" },
              ]),
            ),
            tail: { source: tailSource },
          },
        };
        const mapping = {
          input,
          expectedOutput: { constant: "ok" },
          metadata: { constant: {} },
        };
        const saved = await app.inject({
          method: "POST",
          url: `/api/projects/project_demo/drafts/${initialDraft.id}/recipe`,
          headers,
          payload: {
            leaseToken: initialDraft.leaseToken,
            expectedRevision,
            steps: [],
            versionDescription: "Items capacity boundary",
            mapping,
            unmappedFields: unmapped,
            unmappedConfirmed: true,
          },
        });
        expect(saved.statusCode).toBe(200);
        const proposal = await app.inject({
          method: "GET",
          url: `/api/projects/project_demo/drafts/${initialDraft.id}/mapping/schema-suggestion`,
          headers: { cookie },
        });
        expect(proposal.statusCode).toBe(200);
        const configured = await app.inject({
          method: "PUT",
          url: `/api/projects/project_demo/drafts/${initialDraft.id}`,
          headers,
          payload: {
            leaseToken: initialDraft.leaseToken,
            expectedRevision: saved.json().draft.revision,
            proposalId: proposal.json().proposalId,
            filter: { field: "/id", operator: "eq", value: "cap" },
            mapping,
            unmappedFields: unmapped,
            unmappedConfirmed: true,
            formalSchema: {
              mode: "gold_required",
              input: { type: "object" },
              expectedOutput: { type: "string" },
            },
          },
        });
        expect(configured.statusCode).toBe(200);
        return app.inject({
          method: "POST",
          url: `/api/projects/project_demo/drafts/${initialDraft.id}/candidates`,
          headers,
          payload: {
            leaseToken: initialDraft.leaseToken,
            expectedRevision: configured.json().draft.revision,
          },
        });
      }

      const exact = await materializeWith(
        "/exactTail",
        ["/id", "/overflowTail"],
        initialDraft.revision,
      );
      expect(exact.statusCode).toBe(202);
      const exactCandidate = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${exact.json().candidate.id}`,
            headers: { cookie },
          }),
        (body) =>
          ["ready_to_publish", "failed"].includes(body.candidate?.status),
      );
      expect(exactCandidate.candidate).toMatchObject({
        status: "ready_to_publish",
        itemCount: 10_000,
      });

      const between = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${initialDraft.id}`,
        headers: { cookie },
      });
      const renewed = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${initialDraft.id}/lease/renew`,
        headers,
        payload: {
          leaseToken: initialDraft.leaseToken,
          expectedRevision: between.json().draft.revision,
        },
      });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().draft.leaseToken).toBe(initialDraft.leaseToken);

      const overflow = await materializeWith(
        "/overflowTail",
        ["/id", "/exactTail"],
        renewed.json().draft.revision,
      );
      expect(overflow.statusCode).toBe(202);
      const overflowCandidate = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${overflow.json().candidate.id}`,
            headers: { cookie },
          }),
        (body) =>
          ["ready_to_publish", "failed"].includes(body.candidate?.status),
      );
      expect(overflowCandidate.candidate.status).toBe("failed");
      expect(overflowCandidate.candidate.validationReport).toMatchObject({
        valid: false,
        blockingPhase: "candidate_materialization_projection",
        actualBytes: 100_000_001,
        limitBytes: 100_000_000,
      });

      await db.query(
        `INSERT INTO source_record
         (parsed_view_id, ordinal, value, locator, record_hash, parse_status)
         SELECT parsed_view_id, 10001,
                jsonb_set(value, '{base}', to_jsonb(rpad('b', 446, 'b') || '9999')),
                '{"kind":"jsonl_line","physicalLine":10001}'::jsonb,
                record_hash, 'valid'
         FROM source_record WHERE parsed_view_id = $1 AND ordinal = 1`,
        [asset.parsedViewId],
      );
      const afterOverflow = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${initialDraft.id}`,
        headers: { cookie },
      });
      const renewedAgain = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${initialDraft.id}/lease/renew`,
        headers,
        payload: {
          leaseToken: initialDraft.leaseToken,
          expectedRevision: afterOverflow.json().draft.revision,
        },
      });
      expect(renewedAgain.statusCode).toBe(200);
      const tooMany = await materializeWith(
        "/overflowTail",
        ["/id", "/exactTail"],
        renewedAgain.json().draft.revision,
      );
      expect(tooMany.statusCode).toBe(202);
      const tooManyCandidate = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${tooMany.json().candidate.id}`,
            headers: { cookie },
          }),
        (body) =>
          ["ready_to_publish", "failed"].includes(body.candidate?.status),
      );
      expect(tooManyCandidate.candidate.status).toBe("failed");
      expect(tooManyCandidate.candidate.validationReport).toMatchObject({
        actualItems: 10_001,
        limitItems: 10_000,
        errors: [{ code: "candidate_item_count_exceeded" }],
      });
    },
  );
});
