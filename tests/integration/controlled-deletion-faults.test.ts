import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";

const baseConfig = loadConfig();
const db = createPool(baseConfig.databaseUrl);

type Session = { cookie: string; csrf: string };

describe("Ticket 14 deletion fault convergence at public seams", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let minioFaultAsset: { id: string; objectRef: string } | null = null;

  const mapping = {
    input: { object: { message: { source: "/question" } } },
    expectedOutput: { source: "/answer" },
    metadata: { object: {} },
  };
  const formalSchema = {
    mode: "gold_required",
    input: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    expectedOutput: { type: "string" },
  };

  async function login(): Promise<Session> {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: `${response.cookies[0]?.name}=${response.cookies[0]?.value}`,
      csrf: response.json<{ csrfToken: string }>().csrfToken,
    };
  }

  async function waitForParsed(assetId: string, cookie: string) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records`,
        headers: { cookie },
      });
      const body = response.json<any>();
      if (response.statusCode === 200 && body.parsedView?.status === "ready")
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for Ticket 14 fault fixture parse");
  }

  async function uploadAsset(session: Session): Promise<string> {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `ticket14-fault-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "ticket14-fault.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 synthetic fault fixture",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic controlled deletion fault injection",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from(`question,answer\nfault,${randomUUID()}\n`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    await waitForParsed(assetId, session.cookie);
    return assetId;
  }

  async function confirmDeletion(session: Session, assetId: string) {
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    };
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers,
      payload: { targetType: "data_asset", targetId: assetId },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    const deletion = preview.json().deletion;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${deletion.id}/confirm`,
      headers,
      payload: {
        previewHash: deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic fault injection",
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    return { deletionId: deletion.id as string, headers, preview: deletion };
  }

  async function waitForOutcome(
    deletionId: string,
    cookie: string,
    statuses: string[],
  ) {
    let last: unknown;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/deletions/${deletionId}/outcome`,
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      last = body;
      if (statuses.includes(body.deletion?.status)) return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for deletion outcome ${deletionId}: ${JSON.stringify(last)}`,
    );
  }

  async function waitForJob(jobId: string, cookie: string) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/jobs/${jobId}`,
        headers: { cookie },
      });
      const body = response.json<any>();
      if (["succeeded", "failed"].includes(body.job?.status)) return body.job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for job ${jobId}`);
  }

  async function createPublishedFixture(session: Session) {
    const assetId = await uploadAsset(session);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 14 fault ${randomUUID()}`,
        purpose: "Synthetic controlled deletion fault matrix",
        assetId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const initialDraft = created.json().draft;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    };
    const recipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${initialDraft.id}/recipe`,
      headers,
      payload: {
        leaseToken: initialDraft.leaseToken,
        expectedRevision: initialDraft.revision,
        versionDescription: "Synthetic controlled deletion fault matrix",
        steps: [],
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
      },
    });
    expect(recipe.statusCode, recipe.body).toBe(200);
    const suggestion = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${initialDraft.id}/mapping/schema-suggestion`,
      headers: { cookie: session.cookie },
    });
    expect(suggestion.statusCode, suggestion.body).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${initialDraft.id}`,
      headers,
      payload: {
        leaseToken: recipe.json().draft.leaseToken,
        expectedRevision: recipe.json().draft.revision,
        proposalId: suggestion.json().proposalId,
        filter: { field: "/question", operator: "eq", value: "fault" },
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
        formalSchema,
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const refreshed = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${initialDraft.id}`,
      headers: { cookie: session.cookie },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${initialDraft.id}/candidates`,
      headers,
      payload: {
        leaseToken: refreshed.json().draft.leaseToken,
        expectedRevision: refreshed.json().draft.revision,
      },
    });
    expect(materialized.statusCode, materialized.body).toBe(202);
    const candidate = await waitForJob(
      materialized.json().job.id,
      session.cookie,
    );
    expect(candidate.status).toBe("succeeded");
    const candidateReady = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
      headers: { cookie: session.cookie },
    });
    expect(candidateReady.statusCode, candidateReady.body).toBe(200);
    expect(candidateReady.json().candidate.status).toBe("ready_to_publish");
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers,
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(202);
    const publication = await waitForJob(
      published.json().job.id,
      session.cookie,
    );
    expect(publication.status).toBe("succeeded");
    const versionId = publication.result.versionId as string;
    const packaged = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers,
      payload: { packageType: "standard", formatVersion: "1.0" },
    });
    expect(packaged.statusCode, packaged.body).toBe(202);
    const packageJob = await waitForJob(packaged.json().job.id, session.cookie);
    expect(packageJob.status).toBe("succeeded");
    const refs = await db.query(
      `SELECT cs.id AS candidate_id, cs.object_ref AS candidate_object_ref,
              cs.evidence_object_ref, dr.id AS delivery_id, dr.object_ref AS delivery_object_ref,
              v.manifest_object_ref
       FROM candidate_snapshot cs
       JOIN test_set_version v ON v.candidate_id = cs.id
       JOIN delivery_record dr ON dr.version_id = v.id
       WHERE v.id = $1 AND v.test_set_id IN (
         SELECT id FROM test_set WHERE project_id = 'project_demo'
       )`,
      [versionId],
    );
    expect(refs.rows).toHaveLength(1);
    return {
      assetId,
      versionId,
      candidateId: refs.rows[0].candidate_id as string,
      candidateObjectRef: refs.rows[0].candidate_object_ref as string,
      evidenceObjectRef: refs.rows[0].evidence_object_ref as string,
      deliveryId: refs.rows[0].delivery_id as string,
      deliveryObjectRef: refs.rows[0].delivery_object_ref as string,
      manifestObjectRef: refs.rows[0].manifest_object_ref as string,
      headers,
    };
  }

  async function dropTombstoneFault() {
    await db.query(
      "DROP TRIGGER IF EXISTS ticket14_tombstone_fault ON deletion_tombstone",
    );
    await db.query("DROP FUNCTION IF EXISTS ticket14_fail_tombstone()");
  }

  async function dropMinioFault() {
    await db.query("DROP TRIGGER IF EXISTS ticket14_minio_fault ON data_asset");
    await db.query("DROP FUNCTION IF EXISTS ticket14_fail_minio_delete()");
  }

  async function installMinioFault(assetId: string) {
    await db.query(
      `CREATE OR REPLACE FUNCTION ticket14_fail_minio_delete() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '${assetId}' AND NEW.status = 'deletion_pending' THEN
           NEW.object_ref = repeat('x', 1025);
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await db.query(
      "CREATE TRIGGER ticket14_minio_fault BEFORE UPDATE ON data_asset FOR EACH ROW EXECUTE FUNCTION ticket14_fail_minio_delete()",
    );
  }

  beforeAll(async () => {
    app = await buildApp({
      jobMaxAttempts: 1,
      jobClaimDelayMs: 2_000,
    });
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          JOB_MAX_ATTEMPTS: "1",
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    await dropTombstoneFault();
    await dropMinioFault();
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
  });

  afterEach(async () => {
    await dropTombstoneFault();
    await dropMinioFault();
    if (minioFaultAsset) {
      await db.query("UPDATE data_asset SET object_ref = $2 WHERE id = $1", [
        minioFaultAsset.id,
        minioFaultAsset.objectRef,
      ]);
      minioFaultAsset = null;
    }
  });

  it("keeps the deletion locked across a real MinIO adapter fault and converges through public retry", async () => {
    const session = await login();
    const assetId = await uploadAsset(session);
    const asset = await db.query(
      "SELECT object_ref FROM data_asset WHERE id = $1",
      [assetId],
    );
    const objectRef = asset.rows[0].object_ref as string;
    minioFaultAsset = { id: assetId, objectRef };
    // The trigger corrupts only this asset as the public confirmation locks it;
    // the real Worker then reaches the MinIO adapter with an invalid object ref.
    await installMinioFault(assetId);
    const deletion = await confirmDeletion(session, assetId);
    expect(deletion.preview.closure.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "data_asset_blob", id: assetId }),
      ]),
    );
    const failed = await waitForOutcome(deletion.deletionId, session.cookie, [
      "failed",
    ]);
    expect(failed.deletion).toMatchObject({
      status: "failed",
      stage: "payload_removal",
      failureCode: "artifact_delete_failed",
      cancellable: false,
    });
    expect(failed.deletion.tombstones).toEqual([]);

    const lockedRead = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/records`,
      headers: { cookie: session.cookie },
    });
    expect(lockedRead.statusCode).toBe(409);
    expect(lockedRead.json()).toEqual({ error: { code: "deletion_locked" } });

    await dropMinioFault();
    await db.query("UPDATE data_asset SET object_ref = $2 WHERE id = $1", [
      assetId,
      objectRef,
    ]);
    minioFaultAsset = null;
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${deletion.deletionId}/retry`,
      headers: deletion.headers,
      payload: {},
    });
    expect(retried.statusCode, retried.body).toBe(202);
    const completed = await waitForOutcome(
      deletion.deletionId,
      session.cookie,
      ["completed"],
    );
    expect(completed.deletion.tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: "data_asset",
          opaqueObjectId: assetId,
        }),
      ]),
    );
  });

  it("rolls back tombstones on a PostgreSQL fault and converges through public retry", async () => {
    const session = await login();
    const assetId = await uploadAsset(session);
    const deletion = await confirmDeletion(session, assetId);
    await db.query(
      "CREATE OR REPLACE FUNCTION ticket14_fail_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ticket14_tombstone_insert_failed' USING ERRCODE = 'P0001'; END; $$",
    );
    await db.query(
      "CREATE TRIGGER ticket14_tombstone_fault BEFORE INSERT ON deletion_tombstone FOR EACH ROW EXECUTE FUNCTION ticket14_fail_tombstone()",
    );

    const failed = await waitForOutcome(deletion.deletionId, session.cookie, [
      "failed",
    ]);
    expect(failed.deletion).toMatchObject({
      status: "failed",
      stage: "finalize",
      failureCode: "deletion_finalize_failed",
    });
    expect(failed.deletion.tombstones).toEqual([]);
    const lockedRead = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/records`,
      headers: { cookie: session.cookie },
    });
    expect(lockedRead.statusCode).toBe(409);
    expect(lockedRead.json()).toEqual({ error: { code: "deletion_locked" } });

    await dropTombstoneFault();
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${deletion.deletionId}/retry`,
      headers: deletion.headers,
      payload: {},
    });
    expect(retried.statusCode, retried.body).toBe(202);
    const completed = await waitForOutcome(
      deletion.deletionId,
      session.cookie,
      ["completed"],
    );
    expect(completed.deletion.tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: "data_asset",
          opaqueObjectId: assetId,
        }),
      ]),
    );
  });

  it.each([
    "candidate_payload",
    "candidate_evidence",
    "delivery_package",
    "version_manifest",
  ] as const)(
    "keeps the closure locked when %s removal fails and retries the same event",
    async (faultTarget) => {
      const session = await login();
      const fixture = await createPublishedFixture(session);
      const preview = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/deletions/preview",
        headers: fixture.headers,
        payload: { targetType: "data_asset", targetId: fixture.assetId },
      });
      expect(preview.statusCode, preview.body).toBe(201);
      const deletion = preview.json().deletion;
      const invalidRef = "x".repeat(1025);

      // Private columns are changed only to inject the adapter fault. All
      // success/failure assertions below use public HTTP seams.
      if (faultTarget === "candidate_payload")
        await db.query(
          "UPDATE candidate_snapshot SET object_ref = $2 WHERE id = $1",
          [fixture.candidateId, invalidRef],
        );
      else if (faultTarget === "candidate_evidence")
        await db.query(
          "UPDATE candidate_snapshot SET evidence_object_ref = $2 WHERE id = $1",
          [fixture.candidateId, invalidRef],
        );
      else if (faultTarget === "delivery_package")
        await db.query(
          "UPDATE delivery_record SET object_ref = $2 WHERE id = $1",
          [fixture.deliveryId, invalidRef],
        );
      else
        await db.query(
          "UPDATE test_set_version SET manifest_object_ref = $2 WHERE id = $1",
          [fixture.versionId, invalidRef],
        );

      try {
        const confirmed = await app.inject({
          method: "POST",
          url: `/api/projects/project_demo/deletions/${deletion.id}/confirm`,
          headers: fixture.headers,
          payload: {
            previewHash: deletion.previewHash,
            reasonCode: "nonproduction_test",
            reasonNote: "Synthetic object-class fault",
          },
        });
        expect(confirmed.statusCode, confirmed.body).toBe(202);
        const failed = await waitForOutcome(deletion.id, session.cookie, [
          "failed",
        ]);
        expect(failed.deletion).toMatchObject({
          status: "failed",
          stage: "payload_removal",
          failureCode: "artifact_delete_failed",
          cancellable: false,
        });
        const blobLock = await db.query(
          `SELECT object_id FROM deletion_lock
           WHERE event_id = $1 AND project_id = 'project_demo'
             AND object_type = 'data_blob'`,
          [deletion.id],
        );
        expect(blobLock.rows).toEqual(
          expect.arrayContaining([
            { object_id: deletion.closure.sharedBlobs[0].sha256 },
          ]),
        );
        const lockedRead = await app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${fixture.assetId}/records`,
          headers: { cookie: session.cookie },
        });
        expect(lockedRead.statusCode).toBe(409);
        expect(lockedRead.json()).toEqual({
          error: { code: "deletion_locked" },
        });

        if (faultTarget === "candidate_payload")
          await db.query(
            "UPDATE candidate_snapshot SET object_ref = $2 WHERE id = $1",
            [fixture.candidateId, fixture.candidateObjectRef],
          );
        else if (faultTarget === "candidate_evidence")
          await db.query(
            "UPDATE candidate_snapshot SET evidence_object_ref = $2 WHERE id = $1",
            [fixture.candidateId, fixture.evidenceObjectRef],
          );
        else if (faultTarget === "delivery_package")
          await db.query(
            "UPDATE delivery_record SET object_ref = $2 WHERE id = $1",
            [fixture.deliveryId, fixture.deliveryObjectRef],
          );
        else
          await db.query(
            "UPDATE test_set_version SET manifest_object_ref = $2 WHERE id = $1",
            [fixture.versionId, fixture.manifestObjectRef],
          );

        const retried = await app.inject({
          method: "POST",
          url: `/api/projects/project_demo/deletions/${deletion.id}/retry`,
          headers: fixture.headers,
          payload: {},
        });
        expect(retried.statusCode, retried.body).toBe(202);
        const completed = await waitForOutcome(deletion.id, session.cookie, [
          "completed",
        ]);
        expect(completed.deletion.status).toBe("completed");
      } finally {
        if (faultTarget === "candidate_payload")
          await db.query(
            "UPDATE candidate_snapshot SET object_ref = $2 WHERE id = $1",
            [fixture.candidateId, fixture.candidateObjectRef],
          );
        else if (faultTarget === "candidate_evidence")
          await db.query(
            "UPDATE candidate_snapshot SET evidence_object_ref = $2 WHERE id = $1",
            [fixture.candidateId, fixture.evidenceObjectRef],
          );
        else if (faultTarget === "delivery_package")
          await db.query(
            "UPDATE delivery_record SET object_ref = $2 WHERE id = $1",
            [fixture.deliveryId, fixture.deliveryObjectRef],
          );
        else
          await db.query(
            "UPDATE test_set_version SET manifest_object_ref = $2 WHERE id = $1",
            [fixture.versionId, fixture.manifestObjectRef],
          );
      }
    },
  );
});
