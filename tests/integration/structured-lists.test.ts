import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPACITY_LIMITS } from "../../src/capacity.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 13 structured lists and audit", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let worker: ChildProcess;
  let cookie: string;
  let csrf: string;
  let publishedTestSetId: string;
  let publishedVersionId: string;
  let publishedCaseId: string;
  let archivedVersionId: string;
  let confirmedDeliveryId: string;
  let revisedAttributionId: string;
  let publicAssetId: string;
  let isolatedAssetId: string;
  let isolatedTestSetId: string;
  let isolatedVersionId: string;
  let isolatedCaseId: string;
  let viewerCookie: string;
  let editorCookie: string;
  const isolatedProjectId = `project_ticket13_${randomUUID().replaceAll("-", "")}`;
  const auditCanary = "synthetic-audit-canary-SESSION=prompt/raw-record";
  const auditCorrelationCanary =
    "synthetic-correlation-canary-SESSION=prompt/raw-record";
  const assetIds = [
    randomUUID().replaceAll("-", ""),
    randomUUID().replaceAll("-", ""),
  ];
  const attributionIds = [
    randomUUID().replaceAll("-", ""),
    randomUUID().replaceAll("-", ""),
  ];

  async function waitFor(
    request: () => Promise<{ statusCode: number; json: () => any }>,
    ready: (body: any) => boolean,
  ) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = await request().then((response) => response.json());
      if (ready(body)) return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for public resource state");
  }

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    db = createPool(loadConfig().databaseUrl);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(login.statusCode).toBe(200);
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    csrf = login.json().csrfToken;

    for (const [index, assetId] of assetIds.entries()) {
      await db.query(
        `INSERT INTO data_asset
         (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
          file_name, format, status, uploaded_by, uploaded_at)
         VALUES ($1,'project_demo',$2,$3,1,$4,$5,$6,$7,'user_owner',
                 now() - ($8 || ' hours')::interval)`,
        [
          assetId,
          randomUUID().replaceAll("-", ""),
          `blobs/${randomUUID()}`,
          index === 0 ? "text/csv" : "application/json",
          index === 0 ? "alpha.csv" : "beta.csv",
          "csv",
          "stored",
          String(index + 1),
        ],
      );
    }
    await db.query(
      `INSERT INTO source_attribution_revision
       (id, asset_id, source_type, source_name, purpose, responsible_actor,
        responsible_person, license_status, sensitivity)
       VALUES
       ($3,$1,'synthetic','Alpha Synthetic','Structured list test','user_owner',
         'Project Owner','not_applicable','non_sensitive'),
       ($4,$2,'synthetic','Beta Public','Structured list test','user_owner',
         'Project Owner','not_applicable','non_sensitive')`,
      [...assetIds, ...attributionIds],
    );
    await db.query(
      `INSERT INTO project (id, name, owner_id)
       VALUES ($1, 'Ticket 13 isolated project', 'user_owner')`,
      [isolatedProjectId],
    );
    await db.query(
      `INSERT INTO project_member (project_id, user_id, role)
       VALUES ($1, 'user_owner', 'owner')`,
      [isolatedProjectId],
    );
    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "viewer", password: "viewer-test-password" },
    });
    expect(viewerLogin.statusCode).toBe(200);
    viewerCookie = `${viewerLogin.cookies[0]?.name}=${viewerLogin.cookies[0]?.value}`;
    const editorLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "editor", password: "editor-test-password" },
    });
    expect(editorLogin.statusCode).toBe(200);
    editorCookie = `${editorLogin.cookies[0]?.name}=${editorLogin.cookies[0]?.value}`;

    const csv = await readFile(
      new URL("../fixtures/owner.csv", import.meta.url),
    );
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "ticket13-owner.csv",
      "x-source-type": "synthetic",
      "x-source-name": "Ticket 13 structured list fixture",
      "x-responsible-person": "Project Owner",
      "x-source-purpose": "Synthetic structured list test",
      "x-license-status": "not_applicable",
      "x-sensitivity": "non_sensitive",
    };
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: csv,
    });
    expect(upload.statusCode).toBe(201);
    publicAssetId = upload.json().asset.id;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${publicAssetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
      payload: {
        name: `Ticket 13 summary ${randomUUID()}`,
        purpose: "Synthetic structured list test",
        assetId: publicAssetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const { testSet, draft } = created.json();
    publishedTestSetId = testSet.id;
    const mapping = {
      input: {
        object: { message: { source: "/question" } },
      },
      expectedOutput: { source: "/answer" },
      metadata: { object: { source: { constant: "owner-fixture" } } },
    };
    const savedRecipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Ticket 13 synthetic version",
        mapping,
        unmappedFields: ["category", "internal_note"],
        unmappedConfirmed: true,
        steps: [
          {
            kind: "filter",
            filter: { field: "category", operator: "eq", value: "billing" },
          },
        ],
      },
    });
    expect(savedRecipe.statusCode).toBe(200);
    const schemaProposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(schemaProposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: savedRecipe.json().draft.revision,
        proposalId: schemaProposal.json().proposalId,
        filter: { field: "category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["category", "internal_note"],
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
    const materialize = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialize.statusCode).toBe(202);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialize.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialize.json().candidate.id}/publish`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(publish.statusCode).toBe(202);
    const published = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${publish.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    publishedVersionId = published.job.result.versionId;
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}`,
      headers: { cookie },
    });
    publishedCaseId = version.json().version.lineage[0].caseId;

    const revisedAttribution = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/assets/${publicAssetId}/attribution`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        sourceType: "synthetic",
        sourceName: "Ticket 13 revised synthetic fixture",
        responsiblePerson: "Project Owner",
        purpose: "Synthetic structured list revision test",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        sourceAddress: null,
        acquiredAt: null,
        deidentificationConfirmed: false,
      },
    });
    expect(revisedAttribution.statusCode).toBe(200);
    revisedAttributionId = revisedAttribution.json().attribution.id;
    const rawDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${publicAssetId}/download`,
      headers: { cookie },
    });
    expect(rawDownload.statusCode).toBe(200);

    const derivedUpload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        ...headers,
        "idempotency-key": randomUUID(),
        "x-file-name": "ticket13-v2.csv",
      },
      payload: Buffer.from(
        "prompt,result,category\nUnique Ticket 13 v2 question,Unique synthetic answer,billing\n",
      ),
    });
    expect(derivedUpload.statusCode).toBe(201);
    const derivedAssetId = derivedUpload.json().asset.id;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${derivedAssetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    const derivedDraft = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/drafts`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { baseVersionId: publishedVersionId },
    });
    expect(derivedDraft.statusCode).toBe(201);
    const reattachedSource = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${derivedDraft.json().draft.id}/sources`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        assetId: derivedAssetId,
        leaseToken: derivedDraft.json().draft.leaseToken,
        expectedRevision: derivedDraft.json().draft.revision,
      },
    });
    expect(reattachedSource.statusCode).toBe(201);
    const derivedMapping = {
      input: { object: { message: { source: "/prompt" } } },
      expectedOutput: { source: "/result" },
      metadata: { object: { source: { constant: "ticket13-v2" } } },
    };
    const savedDerivedMapping = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${derivedDraft.json().draft.id}/sources/${reattachedSource.json().source.id}/mapping`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: reattachedSource.json().draft.leaseToken,
        expectedRevision: reattachedSource.json().draft.revision,
        mapping: derivedMapping,
        unmappedFields: ["category"],
        unmappedConfirmed: true,
      },
    });
    expect(savedDerivedMapping.statusCode).toBe(200);
    const derivedRecipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${derivedDraft.json().draft.id}/recipe`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: savedDerivedMapping.json().draft.leaseToken,
        expectedRevision: savedDerivedMapping.json().draft.revision,
        versionDescription: "Ticket 13 ordinary archive v2",
        mapping: derivedMapping,
        unmappedFields: ["category"],
        unmappedConfirmed: true,
        steps: [
          {
            kind: "filter",
            filter: { field: "/category", operator: "eq", value: "billing" },
          },
        ],
      },
    });
    expect(derivedRecipe.statusCode).toBe(200);
    const derivedProposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${derivedDraft.json().draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(derivedProposal.statusCode).toBe(200);
    const derivedConfigured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${derivedDraft.json().draft.id}`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: derivedRecipe.json().draft.leaseToken,
        expectedRevision: derivedRecipe.json().draft.revision,
        proposalId: derivedProposal.json().proposalId,
        filter: { field: "/category", operator: "eq", value: "billing" },
        unmappedFields: ["category"],
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
    expect(derivedConfigured.statusCode).toBe(200);
    const derivedMaterialization = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${derivedDraft.json().draft.id}/candidates`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: derivedDraft.json().draft.leaseToken,
        expectedRevision: derivedConfigured.json().draft.revision,
      },
    });
    expect(derivedMaterialization.statusCode).toBe(202);
    const derivedCandidateId = derivedMaterialization.json().candidate.id;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${derivedCandidateId}`,
          headers: { cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    const derivedPublish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${derivedCandidateId}/publish`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(derivedPublish.statusCode).toBe(202);
    const derivedPublished = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${derivedPublish.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    archivedVersionId = derivedPublished.job.result.versionId;

    const defaultAdvanced = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${archivedVersionId}/default`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        reason: "Review v2 before restoring v1",
        expectedDefaultVersionId: publishedVersionId,
        correlationId: randomUUID(),
      },
    });
    expect(defaultAdvanced.statusCode).toBe(200);
    const defaultRestored = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}/default`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        reason: "Keep reviewed v1 as default",
        expectedDefaultVersionId: archivedVersionId,
        correlationId: randomUUID(),
      },
    });
    expect(defaultRestored.statusCode).toBe(200);
    const archived = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${archivedVersionId}/archive`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        reason: auditCanary,
        expectedDefaultVersionId: publishedVersionId,
        correlationId: auditCorrelationCanary,
      },
    });
    expect(archived.statusCode).toBe(200);

    const csvJob = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${publishedVersionId}/langfuse-csv`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(csvJob.statusCode).toBe(202);
    const csvReady = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${csvJob.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    confirmedDeliveryId = csvReady.job.result.deliveryId;
    const csvDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${confirmedDeliveryId}/download`,
      headers: { cookie },
    });
    expect(csvDownload.statusCode).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deliveries/${confirmedDeliveryId}/imported`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);

    const summaryBeforeCapacity = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/audit/summary",
      headers: { cookie },
    });
    expect(summaryBeforeCapacity.statusCode).toBe(200);
    const capacityBlocked = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        ...headers,
        "idempotency-key": randomUUID(),
        "x-file-name": "ticket13-over-capacity.csv",
      },
      payload: Buffer.alloc(CAPACITY_LIMITS.dataAssetBytes + 1, "a"),
    });
    expect(capacityBlocked.statusCode).toBe(413);
    const summaryAfterCapacity = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/audit/summary",
      headers: { cookie },
    });
    expect(summaryAfterCapacity.statusCode).toBe(200);
    const count = (body: any) =>
      body.summary.events
        .filter(
          (event: { action: string; outcome: string }) =>
            event.action === "asset_upload_capacity_blocked" &&
            event.outcome === "failed",
        )
        .reduce(
          (total: number, event: { count: number }) => total + event.count,
          0,
        );
    expect(count(summaryAfterCapacity.json())).toBe(
      count(summaryBeforeCapacity.json()) + 1,
    );
    expect(summaryAfterCapacity.json().summary.total).toBeGreaterThan(
      summaryBeforeCapacity.json().summary.total,
    );

    const isolatedUpload = await app.inject({
      method: "POST",
      url: `/api/projects/${isolatedProjectId}/assets`,
      headers: {
        ...headers,
        "idempotency-key": randomUUID(),
        "x-file-name": "ticket13-isolated.csv",
      },
      payload: csv,
    });
    expect(isolatedUpload.statusCode).toBe(201);
    isolatedAssetId = isolatedUpload.json().asset.id;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/assets/${isolatedAssetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    const isolatedTestSet = await app.inject({
      method: "POST",
      url: `/api/projects/${isolatedProjectId}/test-sets`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        name: `Ticket 13 isolated ${randomUUID()}`,
        purpose: "Cross-project structured query rejection",
        assetId: isolatedAssetId,
      },
    });
    expect(isolatedTestSet.statusCode).toBe(201);
    isolatedTestSetId = isolatedTestSet.json().testSet.id;
    const isolatedRecipe = await app.inject({
      method: "POST",
      url: `/api/projects/${isolatedProjectId}/drafts/${isolatedTestSet.json().draft.id}/recipe`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: isolatedTestSet.json().draft.leaseToken,
        expectedRevision: isolatedTestSet.json().draft.revision,
        versionDescription: "Ticket 13 isolated v1",
        mapping,
        unmappedFields: ["category", "internal_note"],
        unmappedConfirmed: true,
        steps: [
          {
            kind: "filter",
            filter: { field: "category", operator: "eq", value: "billing" },
          },
        ],
      },
    });
    expect(isolatedRecipe.statusCode).toBe(200);
    const isolatedProposal = await app.inject({
      method: "GET",
      url: `/api/projects/${isolatedProjectId}/drafts/${isolatedTestSet.json().draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(isolatedProposal.statusCode).toBe(200);
    const isolatedConfigured = await app.inject({
      method: "PUT",
      url: `/api/projects/${isolatedProjectId}/drafts/${isolatedTestSet.json().draft.id}`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: isolatedRecipe.json().draft.leaseToken,
        expectedRevision: isolatedRecipe.json().draft.revision,
        proposalId: isolatedProposal.json().proposalId,
        filter: { field: "category", operator: "eq", value: "billing" },
        unmappedFields: ["category", "internal_note"],
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
    expect(isolatedConfigured.statusCode).toBe(200);
    const isolatedMaterialization = await app.inject({
      method: "POST",
      url: `/api/projects/${isolatedProjectId}/drafts/${isolatedTestSet.json().draft.id}/candidates`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        leaseToken: isolatedRecipe.json().draft.leaseToken,
        expectedRevision: isolatedConfigured.json().draft.revision,
      },
    });
    expect(isolatedMaterialization.statusCode).toBe(202);
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/candidates/${isolatedMaterialization.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    const isolatedPublish = await app.inject({
      method: "POST",
      url: `/api/projects/${isolatedProjectId}/candidates/${isolatedMaterialization.json().candidate.id}/publish`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(isolatedPublish.statusCode).toBe(202);
    const isolatedPublished = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/jobs/${isolatedPublish.json().job.id}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "succeeded",
    );
    isolatedVersionId = isolatedPublished.job.result.versionId;
    const isolatedVersion = await app.inject({
      method: "GET",
      url: `/api/projects/${isolatedProjectId}/test-sets/${isolatedTestSetId}/versions/${isolatedVersionId}`,
      headers: { cookie },
    });
    isolatedCaseId = isolatedVersion.json().version.lineage[0].caseId;
  });

  afterAll(async () => {
    await db.query(
      "DELETE FROM source_attribution_revision WHERE asset_id=ANY($1)",
      [assetIds],
    );
    await db.query("DELETE FROM data_asset WHERE id=ANY($1)", [assetIds]);
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
  });

  it("lists Data Assets only through allowlisted structured filters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/assets?name=Alpha%20Synthetic&sourceType=synthetic&format=csv&status=stored&uploadedBy=owner&sensitivity=non_sensitive",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().assets).toEqual([
      expect.objectContaining({
        id: assetIds[0],
        name: "Alpha Synthetic",
        sourceType: "synthetic",
        format: "csv",
        status: "stored",
        uploadedBy: "owner",
        sensitivity: "non_sensitive",
      }),
    ]);

    const rejected = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/assets?q=anything",
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "query_parameter_invalid" },
    });

    const paged = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/assets?sourceType=synthetic&format=csv&status=stored&limit=1&offset=0",
      headers: { cookie },
    });
    expect(paged.statusCode).toBe(200);
    expect(paged.json().assets).toHaveLength(1);
    expect(paged.json().pagination).toMatchObject({
      limit: 1,
      offset: 0,
    });
    expect(paged.json().pagination.total).toBeGreaterThan(1);
  });

  it("filters Data Assets by upload time boundaries", async () => {
    const from = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    const returnedIds: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const response = await app.inject({
        method: "GET",
        url:
          "/api/projects/project_demo/assets?sourceType=synthetic&format=csv&status=stored" +
          `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200&offset=${offset}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      returnedIds.push(...body.assets.map((asset: { id: string }) => asset.id));
      if (offset + 200 >= body.pagination.total) break;
    }
    const fixtureIds = returnedIds.filter((id: string) =>
      assetIds.includes(id),
    );
    expect(fixtureIds).toEqual([assetIds[0]]);
  });

  it("summarizes Test Sets with version and delivery state", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/test-sets?limit=200",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    let summary = response
      .json()
      .testSets.find((item: { id: string }) => item.id === publishedTestSetId);
    for (
      let offset = 200;
      offset < response.json().pagination.total && !summary;
      offset += 200
    ) {
      const page = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets?limit=200&offset=${offset}`,
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      summary = page
        .json()
        .testSets.find(
          (item: { id: string }) => item.id === publishedTestSetId,
        );
    }
    expect(summary).toMatchObject({
      id: publishedTestSetId,
      availability: "available",
      defaultVersion: {
        id: publishedVersionId,
        number: 1,
        status: "published",
      },
      latestVersion: {
        id: archivedVersionId,
        number: 2,
        status: "archived",
      },
      testCaseCount: 3,
      lastPublisher: "owner",
      recentDeliveryState: "user_confirmed_imported",
    });
    expect(publishedCaseId).toMatch(/^case_/);
  });

  it("returns a truthful overview for a Test Set with no published versions", async () => {
    const emptyTestSetId = `test_set_empty_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Empty Test Set', 'Awaiting raw asset', 'user_owner')`,
      [emptyTestSetId],
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${emptyTestSetId}/versions`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        testSet: {
          id: emptyTestSetId,
          name: "Empty Test Set",
          purpose: "Awaiting raw asset",
          ownerId: "user_owner",
          owner: "owner",
          availability: "available",
          defaultVersion: null,
          latestVersion: null,
        },
        versions: [],
        pagination: { total: 0, offset: 0 },
      });
    } finally {
      await db.query("DELETE FROM test_set WHERE id = $1", [emptyTestSetId]);
    }
  });

  it("bounds Test Set version history and preserves totals on empty pages", async () => {
    const firstPage = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions?limit=1&offset=0`,
      headers: { cookie },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().versions).toHaveLength(1);
    expect(firstPage.json().pagination).toMatchObject({
      limit: 1,
      offset: 0,
      total: expect.any(Number),
    });
    expect(firstPage.json().pagination.total).toBeGreaterThan(1);

    const emptyPage = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions?limit=1&offset=10000`,
      headers: { cookie },
    });
    expect(emptyPage.statusCode).toBe(200);
    expect(emptyPage.json().versions).toEqual([]);
    expect(emptyPage.json().pagination).toMatchObject({
      limit: 1,
      offset: 10000,
      total: firstPage.json().pagination.total,
    });

    const rejected = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions?limit=101`,
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "query_parameter_invalid" },
    });
  });

  it("bounds version detail lineage and preserves totals on an empty page", async () => {
    const page = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}?limit=1&offset=10000`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().version.lineage).toEqual([]);
    expect(page.json().version.lineagePagination).toEqual({
      limit: 1,
      offset: 10000,
      total: 2,
    });
    expect(page.json().version.lineageLevels).toEqual({
      recordLevel: 2,
      assetLevel: 0,
    });
  });

  it("projects bounded downstream lineage and delivery validation evidence", async () => {
    const assetDetail = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${publicAssetId}`,
      headers: { cookie },
    });
    expect(assetDetail.statusCode).toBe(200);
    expect(assetDetail.json().lineage).toEqual(
      expect.objectContaining({
        drafts: expect.any(Array),
        versions: expect.arrayContaining([
          expect.objectContaining({
            versionId: publishedVersionId,
            testSetId: publishedTestSetId,
          }),
        ]),
        transformationRuns: expect.any(Array),
      }),
    );

    const deliveries = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${publishedVersionId}/deliveries`,
      headers: { cookie },
    });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: confirmedDeliveryId,
          offlineValidation: expect.any(Object),
        }),
      ]),
    );
  });

  it("queries fixed-version Test Cases by exact identity and metadata", async () => {
    const byCaseId = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}/cases?caseId=${publishedCaseId}`,
      headers: { cookie },
    });
    expect(byCaseId.statusCode).toBe(200);
    expect(byCaseId.json().cases).toHaveLength(1);
    expect(byCaseId.json().cases[0]).toMatchObject({
      caseId: publishedCaseId,
      metadata: { source: "owner-fixture" },
    });

    const byMetadata = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}/cases?metadataKey=source&metadataValue=owner-fixture`,
      headers: { cookie },
    });
    expect(byMetadata.statusCode).toBe(200);
    expect(byMetadata.json().cases).toHaveLength(2);
    expect(
      byMetadata.json().cases.map((item: { caseId: string }) => item.caseId),
    ).toContain(publishedCaseId);
    expect(byMetadata.json().cases[0]).not.toHaveProperty("input");
    expect(byMetadata.json().cases[0]).not.toHaveProperty("expected_output");
    expect(byMetadata.json().cases[0]).not.toHaveProperty("contentHash");
    expect(byMetadata.json().cases[0]).not.toHaveProperty("reason");

    const rejected = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}/cases?q=refund`,
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "query_parameter_invalid" },
    });

    const bounded = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}/cases?limit=1&offset=10000`,
      headers: { cookie },
    });
    expect(bounded.statusCode).toBe(200);
    expect(bounded.json().cases).toEqual([]);
    expect(bounded.json().pagination).toMatchObject({
      limit: 1,
      offset: 10000,
      total: 2,
    });
  });

  it("exposes filtered project Audit Events without raw details", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/api/projects/project_demo/audit?objectType=test_set_version` +
        `&objectId=${publishedVersionId}&action=test_set_version_published&actorId=user_owner`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pagination).toMatchObject({
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(response.json().events).toEqual([
      expect.objectContaining({
        action: "test_set_version_published",
        actorId: "user_owner",
        actor: "owner",
        objectType: "test_set_version",
        objectId: publishedVersionId,
        outcome: "succeeded",
        occurredAt: expect.stringMatching(/Z$/),
        reference: expect.objectContaining({
          correlationId: expect.any(String),
        }),
      }),
    ]);
    expect(JSON.stringify(response.json())).not.toContain("manifestHash");

    const byTime = await app.inject({
      method: "GET",
      url:
        `/api/projects/project_demo/audit?objectType=test_set_version` +
        `&objectId=${publishedVersionId}&action=test_set_version_published` +
        `&from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z&limit=1`,
      headers: { cookie },
    });
    expect(byTime.statusCode).toBe(200);
    expect(byTime.json().events).toHaveLength(1);
    expect(byTime.json().pagination).toMatchObject({
      total: 1,
      limit: 1,
      offset: 0,
    });

    const rejected = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/audit?q=secret",
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "query_parameter_invalid" },
    });
  });

  it("summarizes product funnel events from structured outcomes", async () => {
    for (const [action, objectType] of [
      ["project_membership_changed", "project_member"],
      ["job_cancel_requested", "job"],
      ["job_retry_requested", "job"],
      ["job_retry_scheduled", "job"],
    ] as const) {
      await db.query(
        `INSERT INTO audit_event
         (project_id, actor_id, action, object_type, object_id, details)
         VALUES ('project_demo', 'user_owner', $1, $2, $3, '{}'::jsonb)`,
        [action, objectType, randomUUID()],
      );
    }
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/audit/summary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const summary = response.json().summary;
    const publication = summary.events.find(
      (event: { action: string }) =>
        event.action === "test_set_version_published",
    );
    expect(publication).toMatchObject({
      outcome: "succeeded",
      count: expect.any(Number),
    });
    expect(publication.count).toBeGreaterThan(0);
    expect(summary.total).toBe(
      summary.events.reduce(
        (total: number, event: { count: number }) => total + event.count,
        0,
      ),
    );
    expect(Object.keys(summary)).toEqual(["total", "events"]);
    for (const action of [
      "asset_upload_completed",
      "parse_attempt_requested",
      "draft_recipe_saved",
      "candidate_materialization_requested",
      "publication_requested",
      "test_set_version_published",
      "package_generated",
      "source_attribution_revised",
      "asset_downloaded",
      "test_set_default_selected",
      "test_set_version_archived",
      "delivery_downloaded",
      "delivery_import_attested",
    ]) {
      expect(
        summary.events.find(
          (event: { action: string }) => event.action === action,
        ),
      ).toMatchObject({ count: expect.any(Number) });
    }
    expect(
      summary.events.find(
        (event: { action: string }) =>
          event.action === "asset_upload_capacity_blocked",
      ),
    ).toMatchObject({ outcome: "failed", count: expect.any(Number) });
    expect(summary.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "project_membership_changed",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          action: "job_cancel_requested",
          outcome: "requested",
        }),
        expect.objectContaining({
          action: "job_retry_requested",
          outcome: "requested",
        }),
        expect.objectContaining({
          action: "job_retry_scheduled",
          outcome: "scheduled",
        }),
      ]),
    );

    const rejected = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/audit/summary?stage=upload",
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({
      error: { code: "query_parameter_invalid" },
    });

    const mutation = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/audit",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      payload: {},
    });
    expect(mutation.statusCode).toBe(404);
  });

  it("locates key responsibility facts through the public audit seam", async () => {
    const facts = [
      [
        "source_attribution_revision",
        revisedAttributionId,
        "source_attribution_revised",
      ],
      ["data_asset", publicAssetId, "asset_downloaded"],
      ["test_set_version", publishedVersionId, "test_set_default_selected"],
      ["test_set_version", archivedVersionId, "test_set_version_archived"],
      ["delivery_record", confirmedDeliveryId, "delivery_downloaded"],
      ["delivery_record", confirmedDeliveryId, "delivery_import_attested"],
    ] as const;
    for (const [objectType, objectId, action] of facts) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/audit?objectType=${objectType}&objectId=${objectId}&action=${action}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().events.length).toBeGreaterThan(0);
      expect(response.json().events[0]).toMatchObject({
        actor: "owner",
        action,
        objectType,
        objectId,
      });
    }
  });

  it("keeps archive reasons and audit canaries out of projections", async () => {
    const query = `/api/projects/project_demo/audit?objectType=test_set_version&objectId=${archivedVersionId}&action=test_set_version_archived`;
    for (const requestCookie of [cookie, editorCookie, viewerCookie]) {
      const response = await app.inject({
        method: "GET",
        url: query,
        headers: { cookie: requestCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().events.length).toBeGreaterThan(0);
      expect(response.body).not.toContain(auditCanary);
      expect(response.body).not.toContain("synthetic-audit-canary");
      expect(response.body).not.toContain(auditCorrelationCanary);
      expect(response.body).not.toContain("SESSION=");
      expect(JSON.stringify(response.json())).not.toContain("reason");
    }
  });

  it("keeps structured read seams project-scoped", async () => {
    const readPaths = [
      "/api/projects/project_demo/assets?name=Alpha%20Synthetic",
      "/api/projects/project_demo/test-sets",
      `/api/projects/project_demo/test-sets/${publishedTestSetId}/versions/${publishedVersionId}/cases?caseId=${publishedCaseId}`,
      "/api/projects/project_demo/deliveries?limit=1",
      "/api/projects/project_demo/audit?limit=1",
      "/api/projects/project_demo/audit/summary",
    ];
    for (const requestCookie of [viewerCookie, editorCookie]) {
      for (const path of readPaths) {
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: { cookie: requestCookie },
        });
        expect(response.statusCode).toBe(200);
      }
    }
    const deliveries = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/deliveries?limit=100",
      headers: { cookie },
    });
    expect(deliveries.statusCode).toBe(200);
    const deliveryBody = deliveries.json();
    expect(deliveryBody.pagination).toMatchObject({
      limit: 100,
      offset: 0,
      total: expect.any(Number),
    });
    expect(deliveryBody.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: confirmedDeliveryId,
          testSetId: publishedTestSetId,
          versionId: publishedVersionId,
          remoteVerified: false,
        }),
      ]),
    );
    for (const delivery of deliveryBody.deliveries) {
      expect(delivery).not.toHaveProperty("objectRef");
      expect(delivery).not.toHaveProperty("deliveryHash");
    }
    const emptyPage = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/deliveries?limit=100&offset=10000",
      headers: { cookie },
    });
    expect(emptyPage.statusCode).toBe(200);
    expect(emptyPage.json().deliveries).toEqual([]);
    expect(emptyPage.json().pagination.total).toBe(
      deliveryBody.pagination.total,
    );
    for (const path of readPaths) {
      const anonymous = await app.inject({ method: "GET", url: path });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({
        error: { code: "authentication_required" },
      });
      const crossProject = await app.inject({
        method: "GET",
        url: path.replaceAll("project_demo", isolatedProjectId),
        headers: { cookie: viewerCookie },
      });
      expect(crossProject.statusCode).toBe(404);
      expect(crossProject.json()).toMatchObject({
        error: { code: "project_not_found" },
      });
    }

    const mismatchedCase = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${isolatedTestSetId}/versions/${isolatedVersionId}/cases?caseId=${isolatedCaseId}`,
      headers: { cookie: viewerCookie },
    });
    expect(mismatchedCase.statusCode).toBe(404);
    expect(mismatchedCase.json()).toMatchObject({
      error: { code: "version_not_found" },
    });

    const mismatchedCaseDetail = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${isolatedTestSetId}/versions/${isolatedVersionId}/cases/${isolatedCaseId}`,
      headers: { cookie: viewerCookie },
    });
    expect(mismatchedCaseDetail.statusCode).toBe(404);
    expect(mismatchedCaseDetail.body).not.toContain("Can I get a refund?");

    const mismatchedAsset = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${isolatedAssetId}`,
      headers: { cookie: viewerCookie },
    });
    expect(mismatchedAsset.statusCode).toBe(404);

    const mismatchedAudit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/audit?objectType=data_asset&objectId=${isolatedAssetId}`,
      headers: { cookie: viewerCookie },
    });
    expect(mismatchedAudit.statusCode).toBe(200);
    expect(mismatchedAudit.json().events).toEqual([]);
  });
});
