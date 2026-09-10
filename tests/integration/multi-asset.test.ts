import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

async function waitFor(
  request: () => Promise<{ json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await request().then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public multi-asset state");
}

describe("Ticket 07 multi-asset v2", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let extraWorker: ChildProcess | undefined;
  let db: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
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
    for (const process of [worker, extraWorker]) {
      if (!process || process.exitCode !== null) continue;
      process.kill("SIGTERM");
      await new Promise((resolve) => process.once("exit", resolve));
    }
    await app.close();
    await db.end();
  });

  async function upload(
    fileName: string,
    payload: Buffer,
    contentType: string,
  ) {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": contentType,
        "x-file-name": fileName,
        "x-source-type": "synthetic",
        "x-source-name": `Ticket 07 ${fileName}`,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic multi-asset test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    const preview = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${assetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    return { assetId, parsedViewId: preview.parsedView.id as string };
  }

  async function publishV1() {
    const first = await upload(
      "ticket07-v1.csv",
      Buffer.from(
        "question,answer,category\nHow do I reset my password?,Use the reset link,account\nCan I get a refund?,Contact support,billing\n",
      ),
      "text/csv; charset=utf-8",
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
        name: `Ticket 07 v1 ${randomUUID()}`,
        purpose: "Synthetic multi-asset v2",
        assetId: first.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const { testSet, draft } = created.json();
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
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
        versionDescription: "Ticket 07 synthetic v1 baseline",
        steps: [
          {
            kind: "filter",
            filter: { field: "/category", operator: "eq", value: "billing" },
          },
        ],
        mapping,
        unmappedFields: ["/category"],
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
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const candidate = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${candidate.candidate.id}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(published.statusCode).toBe(202);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${published.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    const versionId = job.job.result.versionId as string;
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSet.id}/versions/${versionId}`,
      headers: { cookie },
    });
    return {
      testSetId: testSet.id,
      versionId,
      version: version.json().version,
    };
  }

  it(
    "derives a draft from v1 and saves an independent second-source mapping",
    { timeout: 120_000 },
    async () => {
      const base = await publishV1();
      const second = await upload(
        "ticket07-second.jsonl",
        Buffer.from(
          '{"prompt":"Check this refund","result":"Refund allowed","category":"billing"}\n',
        ),
        "application/x-ndjson",
      );
      const third = await upload(
        "ticket07-third.json",
        Buffer.from(
          '[{"prompt":"Check this invoice","result":"Invoice allowed","category":"billing"}]',
        ),
        "application/json",
      );
      const opened = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${base.testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: { baseVersionId: base.versionId },
      });
      expect(opened.statusCode).toBe(201);
      expect(opened.json().draft).toMatchObject({
        baseVersionId: base.versionId,
        status: "editing",
      });
      const attached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: second.assetId,
          leaseToken: opened.json().draft.leaseToken,
          expectedRevision: opened.json().draft.revision,
        },
      });
      expect(attached.statusCode).toBe(201);
      const source = attached.json().source;
      const secondMapping = {
        input: { object: { message: { source: "/prompt" } } },
        expectedOutput: { source: "/result" },
        metadata: { object: { sourceCategory: { source: "/category" } } },
      };
      const savedMapping = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources/${source.id}/mapping`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: attached.json().draft.leaseToken,
          expectedRevision: attached.json().draft.revision,
          mapping: secondMapping,
          unmappedFields: [],
          unmappedConfirmed: true,
        },
      });
      expect(savedMapping.statusCode).toBe(200);
      const attachedThird = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: third.assetId,
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: savedMapping.json().draft.revision,
        },
      });
      expect(attachedThird.statusCode).toBe(201);
      const savedThirdMapping = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources/${attachedThird.json().source.id}/mapping`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: attachedThird.json().draft.leaseToken,
          expectedRevision: attachedThird.json().draft.revision,
          mapping: secondMapping,
          unmappedFields: [],
          unmappedConfirmed: true,
        },
      });
      expect(savedThirdMapping.statusCode).toBe(200);
      const preview = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/mapping/preview`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().pairs).toEqual([
        expect.objectContaining({
          sourceId: source.id,
          ordinal: 1,
          item: {
            input: { message: "Check this refund" },
            expected_output: "Refund allowed",
            metadata: { sourceCategory: "billing" },
          },
        }),
        expect.objectContaining({
          sourceId: attachedThird.json().source.id,
          ordinal: 1,
          item: {
            input: { message: "Check this invoice" },
            expected_output: "Invoice allowed",
            metadata: { sourceCategory: "billing" },
          },
        }),
      ]);
      expect(preview.json().unmappedFields).toEqual([]);
      const selectedSourcePreview = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/mapping/preview`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: { sourceId: attachedThird.json().source.id },
      });
      expect(selectedSourcePreview.statusCode).toBe(200);
      expect(selectedSourcePreview.json().pairs).toEqual([
        expect.objectContaining({
          sourceId: attachedThird.json().source.id,
          item: {
            input: { message: "Check this invoice" },
            expected_output: "Invoice allowed",
            metadata: { sourceCategory: "billing" },
          },
        }),
      ]);
      const described = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/recipe`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedThirdMapping.json().draft.leaseToken,
          expectedRevision: savedThirdMapping.json().draft.revision,
          versionDescription: "Ticket 07 synthetic multi-source v2",
          steps: [
            {
              kind: "filter",
              filter: { field: "/category", operator: "eq", value: "billing" },
            },
          ],
        },
      });
      expect(described.statusCode).toBe(200);
      const proposal = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/mapping/schema-suggestion`,
        headers: { cookie },
      });
      expect(proposal.statusCode).toBe(200);
      const configured = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedThirdMapping.json().draft.leaseToken,
          expectedRevision: described.json().draft.revision,
          proposalId: proposal.json().proposalId,
          filter: { field: "/category", operator: "eq", value: "billing" },
          mapping: {
            input: { object: { message: { source: "/prompt" } } },
            expectedOutput: { source: "/result" },
            metadata: { object: { sourceCategory: { source: "/category" } } },
          },
          unmappedFields: [],
          unmappedConfirmed: true,
          formalSchema: base.version.evidence.schema,
        },
      });
      expect(configured.statusCode).toBe(200);
      const mappingValidation = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/mapping/validation`,
        headers: { cookie },
      });
      expect(mappingValidation.statusCode).toBe(200);
      expect(mappingValidation.json()).toEqual({ valid: true, errors: [] });
      const evaluation = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/evaluate`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(evaluation.statusCode).toBe(200);
      expect(
        evaluation.json().evaluation.records.map((record: any) => record.id),
      ).toEqual([`${second.parsedViewId}:1`, `${third.parsedViewId}:1`]);
      expect(evaluation.json().evaluation.steps).toEqual([
        {
          kind: "filter",
          inputCount: 2,
          outputCount: 2,
          excludedCount: 0,
          errorCount: 0,
        },
      ]);
      const invalidMetadata = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: configured.json().draft.revision,
          input: { message: "Invalid metadata" },
          expectedOutput: "Rejected",
          metadata: [],
          reason: "Reject invalid synthetic envelope",
        },
      });
      expect(invalidMetadata.statusCode).toBe(422);
      expect(invalidMetadata.json()).toMatchObject({
        error: { code: "manual_case_metadata_invalid" },
      });
      const missingReason = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: configured.json().draft.revision,
          input: { message: "Manual synthetic case" },
          expectedOutput: "Manual result",
          metadata: {},
        },
      });
      expect(missingReason.statusCode).toBe(422);
      expect(missingReason.json()).toMatchObject({
        error: { code: "manual_reason_required" },
      });
      const manualCase = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: configured.json().draft.revision,
          input: { message: "Manual synthetic case" },
          expectedOutput: "Manual result",
          metadata: { origin: "manual" },
          reason: "Add a synthetic edge case",
        },
      });
      expect(manualCase.statusCode).toBe(201);
      const metadataUpdate = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases/${manualCase.json().case.id}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: manualCase.json().draft.leaseToken,
          expectedRevision: manualCase.json().draft.revision,
          metadata: { origin: "manual-updated" },
        },
      });
      expect(metadataUpdate.statusCode).toBe(200);
      const audit = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/audit`,
        headers: { cookie },
      });
      expect(audit.statusCode).toBe(200);
      expect(audit.json().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "manual_case_revised",
            actorId: "user_owner",
            details: expect.objectContaining({
              diff: {
                metadata: {
                  before: { origin: "manual" },
                  after: { origin: "manual-updated" },
                },
              },
            }),
          }),
        ]),
      );
      const baseCaseId = base.version.lineage[0].caseId;
      const conflict = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: metadataUpdate.json().draft.revision,
          caseId: baseCaseId,
          input: { message: "Injected identity" },
          expectedOutput: "Conflict",
          metadata: {},
          reason: "Try to take over an existing identity",
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({
        error: { code: "case_id_conflict" },
      });
      const updateWithoutReason = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases/${baseCaseId}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken:
            configured.json().draft.leaseToken ??
            savedMapping.json().draft.leaseToken,
          expectedRevision: metadataUpdate.json().draft.revision,
          expectedOutput: "Corrected billing result",
        },
      });
      expect(updateWithoutReason.statusCode).toBe(422);
      expect(updateWithoutReason.json()).toMatchObject({
        error: { code: "manual_reason_required" },
      });
      const updatedCase = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/cases/${baseCaseId}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: updateWithoutReason.json().error.currentRevision,
          expectedOutput: "Corrected billing result",
          reason: "Correct the synthetic gold answer",
        },
      });
      expect(updatedCase.statusCode).toBe(200);
      const secondAsset = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${second.assetId}`,
        headers: { cookie },
      });
      const originalSecondAttributionId = secondAsset.json().attribution
        .id as string;
      worker.kill("SIGTERM");
      await new Promise((resolve) => worker.once("exit", resolve));
      const materialized = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: updatedCase.json().draft.revision,
        },
      });
      expect(materialized.statusCode).toBe(202);
      await db.query(
        `UPDATE draft_case_operation
         SET operation = 'delete', input = NULL, expected_output = NULL,
             metadata = NULL, reason = NULL, previous_content = NULL, diff = NULL
         WHERE draft_id = $1 AND case_id = $2`,
        [opened.json().draft.id, manualCase.json().case.id],
      );
      const replayedMaterialization = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: updatedCase.json().draft.revision,
        },
      });
      expect(replayedMaterialization.statusCode).toBe(202);
      expect(replayedMaterialization.json()).toMatchObject({
        replayed: true,
        candidate: { id: materialized.json().candidate.id },
      });
      const revisedAttribution = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/assets/${second.assetId}/attribution`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          sourceType: "synthetic",
          sourceName: "Ticket 07 revised after candidate freeze",
          responsiblePerson: "Project Owner",
          purpose: "Verify candidate source snapshot",
          licenseStatus: "not_applicable",
          sensitivity: "non_sensitive",
          sourceAddress: null,
          acquiredAt: null,
          deidentificationConfirmed: false,
        },
      });
      expect(revisedAttribution.statusCode).toBe(200);
      const candidateSnapshot = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
        headers: { cookie },
      });
      expect(candidateSnapshot.statusCode).toBe(200);
      expect(candidateSnapshot.json().candidate.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assetId: second.assetId,
            parsedViewId: second.parsedViewId,
            mapping: secondMapping,
            attribution: expect.objectContaining({
              id: originalSecondAttributionId,
            }),
          }),
          expect.objectContaining({
            assetId: third.assetId,
            parsedViewId: third.parsedViewId,
            mapping: secondMapping,
          }),
        ]),
      );
      const duplicateJobId = materialized.json().job.id as string;
      await db.query(
        `UPDATE job SET status = 'queued', stage = 'queued', progress = 0,
            attempt = 0, result = NULL, counts = '{}'::jsonb,
            lease_owner = NULL, lease_expires_at = NULL, next_run_at = now()
         WHERE id = $1`,
        [duplicateJobId],
      );
      worker = spawn(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
        { stdio: "inherit" },
      );
      extraWorker = spawn(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
        { stdio: "inherit" },
      );
      const candidate = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
            headers: { cookie },
          }),
        (body) =>
          ["ready_to_publish", "failed"].includes(body.candidate?.status),
      );
      expect(candidate.candidate).toMatchObject({
        status: "ready_to_publish",
        itemCount: 4,
      });
      const duplicateJob = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${duplicateJobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "succeeded",
      );
      expect(duplicateJob.job.status).toBe("succeeded");
      expect(Number(duplicateJob.job.attempt)).toBe(1);
      const logicalJobs = await db.query(
        `SELECT count(*)::int AS count FROM job
         WHERE kind = 'materialize_candidate'
           AND payload ->> 'candidateId' = $1`,
        [materialized.json().candidate.id],
      );
      expect(logicalJobs.rows[0].count).toBe(1);
      const bindings = await db.query(
        `SELECT case_id FROM draft_case_binding
         WHERE draft_source_id = $1 AND source_id IN ($2, $3)
         ORDER BY source_id, source_record_ordinal`,
        [opened.json().draft.id, source.id, attachedThird.json().source.id],
      );
      expect(bindings.rowCount).toBe(2);
      expect(new Set(bindings.rows.map((row) => row.case_id)).size).toBe(2);
      const candidateItems = await db.query(
        `SELECT ordinal, case_id FROM candidate_item
         WHERE candidate_id = $1 ORDER BY ordinal`,
        [materialized.json().candidate.id],
      );
      expect(candidateItems.rowCount).toBe(4);
      expect(new Set(candidateItems.rows.map((row) => row.case_id)).size).toBe(
        4,
      );
      extraWorker.kill("SIGTERM");
      await new Promise((resolve) => extraWorker?.once("exit", resolve));
      extraWorker = undefined;
      const published = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${candidate.candidate.id}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(published.statusCode).toBe(202);
      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${published.json().job.id}`,
            headers: { cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(job.job.status).toBe("succeeded");
      const v2 = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${base.testSetId}/versions/${job.job.result.versionId}`,
        headers: { cookie },
      });
      expect(v2.json().version).toMatchObject({
        number: 2,
        parentVersionId: base.versionId,
        itemCount: 4,
      });
      expect(v2.json().version.lineage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assetId: second.assetId }),
          expect.objectContaining({ assetId: third.assetId }),
        ]),
      );
      expect(v2.json().testSet.defaultVersionId).toBe(base.versionId);
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}`,
        headers: { cookie },
      });
      expect(draft.json().draft.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: source.id,
            assetId: second.assetId,
            parsedViewId: second.parsedViewId,
            position: 1,
            mapping: secondMapping,
            unmappedFields: [],
            unmappedConfirmed: true,
          }),
          expect.objectContaining({
            id: attachedThird.json().source.id,
            assetId: third.assetId,
            parsedViewId: third.parsedViewId,
            position: 2,
            mapping: secondMapping,
            unmappedFields: [],
            unmappedConfirmed: true,
          }),
        ]),
      );
      const unchanged = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${base.testSetId}/versions/${base.versionId}`,
        headers: { cookie },
      });
      expect(unchanged.json().version).toMatchObject(base.version);
    },
  );

  it(
    "requires an explicit decision for exact duplicate content",
    { timeout: 120_000 },
    async () => {
      const base = await publishV1();
      const second = await upload(
        "ticket07-duplicate.jsonl",
        Buffer.from(
          '{"question":"Can I get a refund?","answer":"Contact support","category":"billing"}\n',
        ),
        "application/x-ndjson",
      );
      const opened = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${base.testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: { baseVersionId: base.versionId },
      });
      expect(opened.statusCode).toBe(201);
      const draftId = opened.json().draft.id;
      const attached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draftId}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: second.assetId,
          leaseToken: opened.json().draft.leaseToken,
          expectedRevision: opened.json().draft.revision,
        },
      });
      expect(attached.statusCode).toBe(201);
      const mapping = {
        input: { object: { message: { source: "/question" } } },
        expectedOutput: { source: "/answer" },
        metadata: { object: {} },
      };
      const savedMapping = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${draftId}/sources/${attached.json().source.id}/mapping`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: attached.json().draft.leaseToken,
          expectedRevision: attached.json().draft.revision,
          mapping,
          unmappedFields: ["/category"],
          unmappedConfirmed: true,
        },
      });
      expect(savedMapping.statusCode).toBe(200);
      const described = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draftId}/recipe`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: savedMapping.json().draft.revision,
          versionDescription: "Ticket 07 synthetic duplicate decision",
          steps: [
            {
              kind: "filter",
              filter: { field: "/category", operator: "eq", value: "billing" },
            },
          ],
        },
      });
      expect(described.statusCode).toBe(200);
      const proposal = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${draftId}/mapping/schema-suggestion`,
        headers: { cookie },
      });
      expect(proposal.statusCode).toBe(200);
      const configured = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${draftId}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: described.json().draft.revision,
          proposalId: proposal.json().proposalId,
          filter: { field: "/category", operator: "eq", value: "billing" },
          mapping,
          unmappedFields: ["/category"],
          unmappedConfirmed: true,
          formalSchema: base.version.evidence.schema,
        },
      });
      expect(configured.statusCode).toBe(200);
      const firstAttempt = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draftId}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: configured.json().draft.revision,
        },
      });
      expect(firstAttempt.statusCode).toBe(202);
      const blocked = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${firstAttempt.json().candidate.id}`,
            headers: { cookie },
          }),
        (body) =>
          ["ready_to_publish", "failed"].includes(body.candidate?.status),
      );
      expect(blocked.candidate.status).toBe("failed");
      expect(blocked.candidate.validationReport).toMatchObject({
        valid: false,
        errorCode: "duplicate_content_requires_decision",
      });
      const duplicateCaseIds =
        blocked.candidate.validationReport.duplicateCaseIds;
      const baseCaseId = base.version.lineage[0].caseId;
      const decisions = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draftId}/recipe`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: savedMapping.json().draft.leaseToken,
          expectedRevision: configured.json().draft.revision,
          steps: [
            {
              kind: "filter",
              filter: { field: "/category", operator: "eq", value: "billing" },
            },
          ],
          mapping,
          unmappedFields: ["/category"],
          unmappedConfirmed: true,
          duplicateDecisions: Object.fromEntries(
            duplicateCaseIds.map((caseId: string) => [
              caseId,
              caseId === baseCaseId ? "include" : "exclude",
            ]),
          ),
        },
      });
      expect(decisions.statusCode).toBe(200);
      const secondAttempt = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draftId}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: decisions.json().draft.leaseToken,
          expectedRevision: decisions.json().draft.revision,
        },
      });
      expect(secondAttempt.statusCode).toBe(202);
      const resolved = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${secondAttempt.json().candidate.id}`,
            headers: { cookie },
          }),
        (body) =>
          ["ready_to_publish", "failed"].includes(body.candidate?.status),
      );
      expect(resolved.candidate).toMatchObject({
        status: "ready_to_publish",
        itemCount: 1,
        validationReport: {
          warnings: [{ code: "duplicate_content_included" }],
        },
      });
    },
  );

  it(
    "removes an appended source without changing the parent version",
    { timeout: 120_000 },
    async () => {
      const base = await publishV1();
      const second = await upload(
        "ticket07-removable.jsonl",
        Buffer.from(
          '{"prompt":"Remove this source","result":"Allowed","category":"billing"}\n',
        ),
        "application/x-ndjson",
      );
      const opened = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${base.testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: { baseVersionId: base.versionId },
      });
      expect(opened.statusCode).toBe(201);
      const attached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: second.assetId,
          leaseToken: opened.json().draft.leaseToken,
          expectedRevision: opened.json().draft.revision,
        },
      });
      expect(attached.statusCode).toBe(201);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources/${attached.json().source.id}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: attached.json().draft.leaseToken,
          expectedRevision: attached.json().draft.revision,
        },
      });
      expect(removed.statusCode).toBe(200);
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}`,
        headers: { cookie },
      });
      expect(draft.json().draft.sources).toEqual([]);
      expect(draft.json().draft.capacity).toMatchObject({ attachedAssets: 0 });
      const unchanged = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${base.testSetId}/versions/${base.versionId}`,
        headers: { cookie },
      });
      expect(unchanged.json().version).toMatchObject(base.version);
      const reattached = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/sources`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          assetId: second.assetId,
          leaseToken: removed.json().draft.leaseToken,
          expectedRevision: removed.json().draft.revision,
        },
      });
      expect(reattached.statusCode).toBe(201);
      expect(reattached.json().source).toMatchObject({
        assetId: second.assetId,
        ordinal: 2,
      });
      const activeDraft = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}`,
        headers: { cookie },
      });
      expect(activeDraft.json().draft.sources).toHaveLength(1);
    },
  );
});
