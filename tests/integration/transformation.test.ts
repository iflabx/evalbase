import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";
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
  throw new Error("Timed out waiting for public state");
}

describe("Ticket 10 Transformation Runs and lineage", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let db: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  let leaseToken = "";

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
    csrf = login.json<{ csrfToken: string }>().csrfToken;
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
  });

  async function upload(fileName: string, payload: Buffer) {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": fileName,
        "x-source-type": "synthetic",
        "x-source-name": `Ticket 10 ${fileName}`,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic transformation evidence",
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
    return {
      assetId,
      sha256: uploaded.json().asset.sha256 as string,
      parsedViewId: preview.parsedView.id as string,
      recordCount: preview.parsedView.recordCount as number,
    };
  }

  async function publishV1() {
    const source = await upload(
      "ticket10-v1.csv",
      Buffer.from(
        [
          "question,answer,category",
          "How do refunds work?,Refunds use the policy,billing",
        ].join("\n"),
      ),
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
        name: `Ticket 10 lineage ${randomUUID()}`,
        purpose: "Synthetic transformation scenario",
        assetId: source.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    leaseToken = draft.leaseToken;
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
        leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Ticket 10 synthetic v1",
        steps: [],
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(recipe.statusCode).toBe(200);
    leaseToken = recipe.json().draft.leaseToken;
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
        leaseToken,
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
        leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialized.statusCode, JSON.stringify(materialized.json())).toBe(
      202,
    );
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
    const versionId = job.job.result.versionId as string;
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${created.json().testSet.id}/versions/${versionId}`,
      headers: { cookie },
    });
    expect(version.statusCode).toBe(200);
    return {
      testSetId: created.json().testSet.id as string,
      versionId,
      version: version.json().version,
      source,
    };
  }

  async function prepareAgentDerivedDraft(v1: any, output: any) {
    const opened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { baseVersionId: v1.versionId },
    });
    expect(opened.statusCode).toBe(201);
    const draft = opened.json().draft;
    leaseToken = draft.leaseToken;
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
        assetId: output.assetId,
        leaseToken,
        expectedRevision: draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    leaseToken = attached.json().draft.leaseToken;
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
    const savedMapping = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources/${attached.json().source.id}/mapping`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken,
        expectedRevision: attached.json().draft.revision,
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(savedMapping.statusCode).toBe(200);
    leaseToken = savedMapping.json().draft.leaseToken;
    const described = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken,
        expectedRevision: savedMapping.json().draft.revision,
        versionDescription: "Ticket 10 Agent augmentation v2",
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
    expect(described.statusCode).toBe(200);
    leaseToken = described.json().draft.leaseToken;
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
        leaseToken,
        expectedRevision: described.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: v1.version.evidence.schema,
      },
    });
    expect(configured.statusCode).toBe(200);
    return { ...configured.json().draft, leaseToken };
  }

  it("registers an immutable Agent asset-level Transformation Run", async () => {
    const v1 = await publishV1();
    const output = await upload(
      "ticket10-agent-output.csv",
      Buffer.from(
        [
          "question,answer,category",
          "Explain refund delays in detail,Refunds may wait for policy review,billing",
        ].join("\n"),
      ),
    );
    const promptContent =
      "Expand billing refund questions without changing policy facts.";
    const promptSha256 = createHash("sha256")
      .update(promptContent, "utf8")
      .digest("hex");
    const manifest = {
      schemaVersion: "1.0",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      purpose: "Expand refund questions",
      tool: {
        name: "dataset-expander",
        version: "0.3.1",
        codeRef: "git:abcdef1",
      },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: { temperature: 0.2, seed: 42 },
      },
      prompt: {
        version: "refund-expand-v2",
        sha256: promptSha256,
        content: promptContent,
      },
      parameters: { language: "en" },
      inputs: [
        {
          objectType: "test_set_version",
          id: v1.versionId,
          sha256: v1.version.manifestHash,
          scope: { category: "billing" },
        },
      ],
      outputs: [
        {
          assetId: output.assetId,
          sha256: output.sha256,
          recordCount: output.recordCount,
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T02:10:00.000Z",
      finishedAt: "2026-08-22T02:14:00.000Z",
    };

    const registered = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: manifest,
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().run).toMatchObject({
      id: expect.stringMatching(/^run_/),
      status: "complete",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifest: {
        inputs: [
          {
            objectType: "test_set_version",
            id: v1.versionId,
            sha256: v1.version.manifestHash,
            scope: { category: "billing" },
          },
        ],
      },
      validationReport: { valid: true },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: manifest,
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({
      error: { code: "transformation_output_already_registered" },
    });

    const fetched = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}`,
      headers: { cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().run).toMatchObject(registered.json().run);
  });

  it("returns stable validation errors for non-object Transformation Run bodies", async () => {
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const registered = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers,
      payload: "null",
    });
    expect(registered.statusCode).toBe(422);
    expect(registered.json()).toMatchObject({
      error: {
        valid: false,
        errors: [expect.objectContaining({ path: "/" })],
      },
    });

    const completed = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs/run_missing/complete",
      headers,
      payload: "null",
    });
    expect(completed.statusCode).toBe(422);
    expect(completed.json()).toMatchObject({
      error: {
        valid: false,
        errors: [expect.objectContaining({ path: "/" })],
      },
    });
  });

  it("completes an incomplete Agent Run with a verified immutable Prompt reference", async () => {
    const v1 = await publishV1();
    const output = await upload(
      "ticket10-reference-output.csv",
      Buffer.from(
        "question,answer,category\nReference output,Reference answer,billing",
      ),
    );
    const prompt = await upload(
      "ticket10-reference-prompt.csv",
      Buffer.from("prompt\nSynthetic immutable prompt reference"),
    );
    const manifest = {
      schemaVersion: "1.0",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      purpose: "Complete a referenced synthetic prompt run",
      tool: { name: "dataset-expander", version: "0.3.1" },
      prompt: {
        version: "reference-prompt-v1",
        sha256: prompt.sha256,
        immutableRef: { assetId: prompt.assetId, sha256: prompt.sha256 },
      },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: v1.versionId,
          sha256: v1.version.manifestHash,
          scope: { category: "billing" },
        },
      ],
      outputs: [
        {
          assetId: output.assetId,
          sha256: output.sha256,
          recordCount: output.recordCount,
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T06:00:00.000Z",
      finishedAt: "2026-08-22T06:01:00.000Z",
    };
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const registered = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers,
      payload: manifest,
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().run.status).toBe("incomplete");

    const completed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}/complete`,
      headers,
      payload: {
        ...manifest,
        model: {
          provider: "synthetic-provider",
          name: "synthetic-model",
          parameters: {},
        },
      },
    });
    expect(completed.statusCode).toBe(200);
    const completedRun = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}`,
      headers: { cookie },
    });
    expect(completedRun.json().run).toMatchObject({
      status: "complete",
      operationType: "agent_augmentation",
      manifest: {
        prompt: {
          immutableRef: { assetId: prompt.assetId, sha256: prompt.sha256 },
        },
      },
    });
  });

  it("rejects completion that changes the frozen operation type", async () => {
    const v1 = await publishV1();
    const output = await upload(
      "ticket10-operation-lock.csv",
      Buffer.from(
        "question,answer,category\nOperation lock,Operation answer,billing",
      ),
    );
    const manifest = {
      schemaVersion: "1.0",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      purpose: "Lock the synthetic operation",
      tool: { name: "dataset-expander", version: "0.3.1" },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: v1.versionId,
          sha256: v1.version.manifestHash,
          scope: { category: "billing" },
        },
      ],
      outputs: [
        {
          assetId: output.assetId,
          sha256: output.sha256,
          recordCount: output.recordCount,
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T07:00:00.000Z",
      finishedAt: "2026-08-22T07:01:00.000Z",
    };
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const registered = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers,
      payload: manifest,
    });
    expect(registered.statusCode).toBe(201);
    const completed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}/complete`,
      headers,
      payload: {
        ...manifest,
        operationType: "agent_generation",
        model: {
          provider: "synthetic-provider",
          name: "synthetic-model",
          parameters: {},
        },
        prompt: {
          version: "operation-lock-v1",
          content: "Synthetic operation lock prompt",
        },
      },
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json()).toMatchObject({
      error: { code: "transformation_run_not_completable" },
    });
  });

  it("rejects an invalid lineage level before database persistence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        schemaVersion: "1.0",
        operationType: "agent_augmentation",
        lineageLevel: "invalid_level",
        purpose: "Reject an invalid level",
        tool: { name: "dataset-expander", version: "0.3.1" },
        parameters: {},
        inputs: [
          {
            objectType: "data_asset",
            id: "asset_missing",
            sha256: "a".repeat(64),
            scope: { entireAsset: true },
          },
        ],
        outputs: [
          {
            assetId: "asset_missing_output",
            sha256: "b".repeat(64),
            recordCount: 1,
          },
        ],
        executedBy: "user_owner",
        startedAt: "2026-08-22T08:00:00.000Z",
        finishedAt: "2026-08-22T08:01:00.000Z",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: "/lineageLevel" }),
        ]),
      },
    });
  });

  it("validates and registers record-level parent references", async () => {
    const v1 = await publishV1();
    const output = await upload(
      "ticket10-agent-rewrite.csv",
      Buffer.from(
        [
          "question,answer,category",
          "Rewritten refund question,Rewritten refund answer,billing",
        ].join("\n"),
      ),
    );
    const caseId = v1.version.lineage[0].caseId as string;
    const caseDetail = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/cases/${caseId}`,
      headers: { cookie },
    });
    expect(caseDetail.statusCode).toBe(200);
    const parentRevisionId = caseDetail.json().testCase.revisionId as string;
    const manifest = {
      schemaVersion: "1.0",
      operationType: "agent_rewrite",
      lineageLevel: "record_level",
      purpose: "Rewrite refund questions",
      tool: {
        name: "dataset-rewriter",
        version: "0.4.0",
        codeRef: "git:2345678",
      },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: { temperature: 0 },
      },
      prompt: {
        version: "refund-rewrite-v1",
        sha256: v1.source.sha256,
        immutableRef: {
          assetId: v1.source.assetId,
          sha256: v1.source.sha256,
        },
      },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: v1.versionId,
          sha256: v1.version.manifestHash,
          scope: { category: "billing" },
        },
      ],
      outputs: [
        {
          assetId: output.assetId,
          sha256: output.sha256,
          recordCount: output.recordCount,
        },
      ],
      recordEdges: [
        {
          outputOrdinal: 1,
          inputs: [
            {
              objectType: "case_revision",
              id: "revision_does_not_exist",
              contentHash: "d".repeat(64),
            },
          ],
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T03:10:00.000Z",
      finishedAt: "2026-08-22T03:11:00.000Z",
    };

    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: manifest,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: { code: "transformation_input_invalid" },
    });

    manifest.recordEdges[0].inputs[0].id = parentRevisionId;
    manifest.recordEdges[0].inputs[0].contentHash =
      caseDetail.json().testCase.contentHash;
    const registered = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: manifest,
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().run).toMatchObject({
      status: "complete",
      lineageLevel: "record_level",
    });

    const draft = await prepareAgentDerivedDraft(v1, output);
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
        expectedRevision: draft.revision,
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
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate.status).toBe("ready_to_publish");
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
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${job.job.result.versionId}`,
      headers: { cookie },
    });
    expect(version.statusCode).toBe(200);
    expect(version.json().version.lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "record_level",
          transformationRunId: registered.json().run.id,
          transformationRun: expect.objectContaining({
            id: registered.json().run.id,
            operationType: "agent_rewrite",
          }),
        }),
      ]),
    );
    const transformedLineage = version
      .json()
      .version.lineage.find(
        (item: any) => item.transformationRunId === registered.json().run.id,
      );
    expect(transformedLineage.origin.parent_inputs).toEqual([
      expect.objectContaining({
        objectType: "case_revision",
        id: parentRevisionId,
      }),
    ]);
    const transformedCaseDetail = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${job.job.result.versionId}/cases/${transformedLineage.caseId}`,
      headers: { cookie },
    });
    const trace = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/lineage/trace?subjectType=case_revision&subjectId=${transformedCaseDetail.json().testCase.revisionId}`,
      headers: { cookie },
    });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "transformation_run",
          id: registered.json().run.id,
        }),
        expect.objectContaining({
          type: "case_revision",
          id: parentRevisionId,
        }),
        expect.objectContaining({
          type: "source_record",
          parsedViewId: v1.source.parsedViewId,
        }),
      ]),
    );
  });

  it("publishes Agent asset-level output as honest v2 lineage evidence", async () => {
    const v1 = await publishV1();
    const output = await upload(
      "ticket10-scenario-d.csv",
      Buffer.from(
        [
          "question,answer,category",
          "Explain refund delays,Refunds may wait for policy review,billing",
        ].join("\n"),
      ),
    );
    const promptContent =
      "Expand billing refund questions with synthetic facts.";
    const manifest = {
      schemaVersion: "1.0",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      purpose: "Scenario D synthetic augmentation",
      tool: { name: "dataset-expander", version: "0.3.1" },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: { seed: 7 },
      },
      prompt: {
        version: "scenario-d-v1",
        sha256: createHash("sha256").update(promptContent).digest("hex"),
        content: promptContent,
      },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: v1.versionId,
          sha256: v1.version.manifestHash,
          scope: { category: "billing" },
        },
      ],
      outputs: [
        {
          assetId: output.assetId,
          sha256: output.sha256,
          recordCount: output.recordCount,
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T04:00:00.000Z",
      finishedAt: "2026-08-22T04:01:00.000Z",
    };
    const run = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: manifest,
    });
    expect(run.statusCode).toBe(201);

    const draft = await prepareAgentDerivedDraft(v1, output);
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
        expectedRevision: draft.revision,
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
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate.status).toBe("ready_to_publish");
    expect(candidate.candidate.validationReport).toMatchObject({
      lineageLevels: { recordLevel: 1, assetLevel: 1 },
    });

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
    const versionId = job.job.result.versionId as string;
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${versionId}`,
      headers: { cookie },
    });
    expect(version.statusCode).toBe(200);
    expect(version.json().version).toMatchObject({
      itemCount: 2,
      lineageLevels: { recordLevel: 1, assetLevel: 1 },
    });
    expect(version.json().version.lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "record_level" }),
        expect.objectContaining({
          level: "asset_level",
          transformationRun: expect.objectContaining({
            id: run.json().run.id,
            operationType: "agent_augmentation",
            tool: { name: "dataset-expander", version: "0.3.1" },
            prompt: expect.objectContaining({ version: "scenario-d-v1" }),
          }),
        }),
      ]),
    );

    const delivery = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/package`,
      headers: { cookie },
    });
    expect(delivery.statusCode).toBe(200);
    const archive = unzipSync(delivery.rawPayload);
    const runs = strFromU8(archive["transformation-runs.jsonl"])
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const exportedLineage = strFromU8(archive["lineage.jsonl"])
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: run.json().run.id,
          lineageLevel: "asset_level",
        }),
      ]),
    );
    expect(exportedLineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "asset_level" }),
      ]),
    );

    const fullRequest = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(fullRequest.statusCode).toBe(202);
    const fullJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${fullRequest.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(fullJob.job.status).toBe("succeeded");
    const fullDelivery = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${fullJob.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    expect(fullDelivery.statusCode).toBe(200);
    const fullArchive = unzipSync(fullDelivery.rawPayload);
    const assetPaths = Object.keys(fullArchive)
      .filter((name) => name.startsWith("assets/"))
      .sort();
    expect(assetPaths).toEqual(
      [
        `assets/${output.assetId}/asset.bin`,
        `assets/${v1.source.assetId}/asset.bin`,
      ].sort(),
    );

    const assetCase = version
      .json()
      .version.lineage.find((item: any) => item.level === "asset_level");
    const assetCaseDetail = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${versionId}/cases/${assetCase.caseId}`,
      headers: { cookie },
    });
    expect(assetCaseDetail.statusCode).toBe(200);
    expect(assetCaseDetail.json().testCase.sourceRecord).toBeNull();
    const trace = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/lineage/trace?subjectType=case_revision&subjectId=${assetCaseDetail.json().testCase.revisionId}`,
      headers: { cookie },
    });
    expect(trace.statusCode).toBe(200);
    expect(trace.json()).toMatchObject({
      maxHops: 3,
      subject: {
        type: "case_revision",
        id: assetCaseDetail.json().testCase.revisionId,
      },
      nodes: expect.arrayContaining([
        expect.objectContaining({
          type: "transformation_run",
          id: run.json().run.id,
          lineageLevel: "asset_level",
        }),
        expect.objectContaining({
          type: "test_set_version",
          id: v1.versionId,
        }),
        expect.objectContaining({
          type: "source_record",
          id: `${v1.source.parsedViewId}:1`,
        }),
      ]),
    });

    const annotated = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/transformation-runs/${run.json().run.id}/annotations`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        note: "Synthetic clarification only; core evidence is unchanged.",
      },
    });
    expect(annotated.statusCode).toBe(201);
    const runAfterAnnotation = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/transformation-runs/${run.json().run.id}`,
      headers: { cookie },
    });
    expect(runAfterAnnotation.json().run).toMatchObject({
      manifestHash: run.json().run.manifestHash,
      annotations: [
        {
          note: "Synthetic clarification only; core evidence is unchanged.",
        },
      ],
    });
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/project_demo/transformation-runs/${run.json().run.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { purpose: "rewritten" },
    });
    expect(patch.statusCode).toBe(404);
  });

  it("blocks publication when an Agent manifest is incomplete", async () => {
    const v1 = await publishV1();
    const output = await upload(
      "ticket10-incomplete-agent.csv",
      Buffer.from(
        [
          "question,answer,category",
          "Incomplete synthetic expansion,Incomplete synthetic answer,billing",
        ].join("\n"),
      ),
    );
    const registered = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        schemaVersion: "1.0",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
        purpose: "Incomplete synthetic expansion",
        tool: { name: "dataset-expander", version: "0.3.1" },
        parameters: {},
        inputs: [
          {
            objectType: "test_set_version",
            id: v1.versionId,
            sha256: v1.version.manifestHash,
            scope: { category: "billing" },
          },
        ],
        outputs: [
          {
            assetId: output.assetId,
            sha256: output.sha256,
            recordCount: output.recordCount,
          },
        ],
        executedBy: "user_owner",
        startedAt: "2026-08-22T05:00:00.000Z",
        finishedAt: "2026-08-22T05:01:00.000Z",
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().run).toMatchObject({
      status: "incomplete",
      validationReport: {
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ path: "/prompt" }),
        ]),
      },
    });
    const outsiderId = `user_ticket10_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO app_user (id, username, password_hash, role)
       VALUES ($1, $2, $3, 'owner')`,
      [outsiderId, outsiderId, await hashPassword("ticket10-outside")],
    );
    const outsiderLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: outsiderId, password: "ticket10-outside" },
    });
    expect(outsiderLogin.statusCode).toBe(200);
    const outsiderComplete = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}/complete`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: `${outsiderLogin.cookies[0]?.name}=${outsiderLogin.cookies[0]?.value}`,
        "x-csrf-token": outsiderLogin.json().csrfToken,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(outsiderComplete.statusCode).toBe(404);

    const draft = await prepareAgentDerivedDraft(v1, output);
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
        expectedRevision: draft.revision,
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
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate).toMatchObject({
      status: "failed",
      validationReport: {
        valid: false,
        errorCode: "transformation_run_incomplete",
        blockingPhase: "candidate_materialization",
        object: {
          type: "transformation_run",
          id: registered.json().run.id,
        },
        retry:
          "Complete the Transformation Run manifest, then materialize a new Candidate.",
      },
    });
    const draftAfterFailure = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie },
    });
    expect(draftAfterFailure.json().draft.status).toBe("editing");
    const publish = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${candidate.candidate.id}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(publish.statusCode).toBe(422);
    expect(publish.json()).toMatchObject({
      error: { code: "candidate_not_ready" },
    });

    const completed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}/complete`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        schemaVersion: "1.0",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
        purpose: "Incomplete synthetic expansion",
        tool: { name: "dataset-expander", version: "0.3.1" },
        model: {
          provider: "synthetic-provider",
          name: "synthetic-model",
          parameters: {},
        },
        prompt: {
          version: "incomplete-completion-v1",
          content: "Complete the synthetic expansion manifest.",
        },
        parameters: {},
        inputs: [
          {
            objectType: "test_set_version",
            id: v1.versionId,
            sha256: v1.version.manifestHash,
            scope: { category: "billing" },
          },
        ],
        outputs: [
          {
            assetId: output.assetId,
            sha256: output.sha256,
            recordCount: output.recordCount,
          },
        ],
        executedBy: "user_owner",
        startedAt: "2026-08-22T05:00:00.000Z",
        finishedAt: "2026-08-22T05:01:00.000Z",
      },
    });
    expect(completed.statusCode).toBe(200);
    const completedRun = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/transformation-runs/${registered.json().run.id}`,
      headers: { cookie },
    });
    expect(completedRun.json().run).toMatchObject({
      status: "complete",
      validationReport: { valid: true },
    });

    const rematerialized = await app.inject({
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
        expectedRevision: draft.revision,
      },
    });
    expect(rematerialized.statusCode).toBe(202);
    const recovered = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${rematerialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(recovered.candidate.status).toBe("ready_to_publish");
  });

  it("rejects a cyclic Transformation Run dependency", async () => {
    const assetA = await upload(
      "ticket10-cycle-a.csv",
      Buffer.from("question,answer\nfirst,answer\n"),
    );
    const assetX = await upload(
      "ticket10-cycle-x.csv",
      Buffer.from("question,answer\nsecond,answer\n"),
    );
    const promptContent = "Synthetic cycle fixture";
    const baseManifest = {
      schemaVersion: "1.0",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      purpose: "Synthetic cycle fixture",
      tool: { name: "synthetic-tool", version: "1.0" },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: {},
      },
      prompt: {
        version: "cycle-v1",
        sha256: createHash("sha256").update(promptContent).digest("hex"),
        content: promptContent,
      },
      parameters: {},
      outputs: [] as any[],
      executedBy: "user_owner",
      startedAt: "2026-08-22T06:00:00.000Z",
      finishedAt: "2026-08-22T06:01:00.000Z",
    };
    const register = (input: any, output: any) =>
      app.inject({
        method: "POST",
        url: "/api/projects/project_demo/transformation-runs",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          ...baseManifest,
          inputs: [
            {
              objectType: "data_asset",
              id: input.assetId,
              sha256: input.sha256,
              scope: { entireAsset: true },
            },
          ],
          outputs: [
            {
              assetId: output.assetId,
              sha256: output.sha256,
              recordCount: output.recordCount,
            },
          ],
        },
      });
    const [first, cyclic] = await Promise.all([
      register(assetA, assetX),
      register(assetX, assetA),
    ]);
    expect([first.statusCode, cyclic.statusCode].sort()).toEqual([201, 422]);
    expect(
      [first, cyclic].find((response) => response.statusCode === 422)!.json(),
    ).toMatchObject({
      error: { code: "lineage_cycle" },
    });
  });

  it("rejects a cross-project input reference without creating a Run", async () => {
    const output = await upload(
      "ticket10-cross-project.csv",
      Buffer.from("question,answer\ncross,answer\n"),
    );
    const otherProjectId = `project_other_${randomUUID().replaceAll("-", "")}`;
    const otherAssetId = `asset_other_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO project (id, name, owner_id)
       VALUES ($1, 'Ticket 10 other project', 'user_owner')`,
      [otherProjectId],
    );
    await db.query(
      `INSERT INTO data_asset
       (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
        file_name, format, status, uploaded_by)
       VALUES ($1, $2, $3, $4, 1, 'text/csv', 'other.csv', 'csv', 'stored', 'user_owner')`,
      [otherAssetId, otherProjectId, "f".repeat(64), `blobs/${otherAssetId}`],
    );
    try {
      const promptContent = "Synthetic cross-project fixture";
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/transformation-runs",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          schemaVersion: "1.0",
          operationType: "agent_augmentation",
          lineageLevel: "asset_level",
          purpose: "Synthetic cross-project fixture",
          tool: { name: "synthetic-tool", version: "1.0" },
          model: {
            provider: "synthetic-provider",
            name: "synthetic-model",
            parameters: {},
          },
          prompt: {
            version: "cross-project-v1",
            sha256: createHash("sha256").update(promptContent).digest("hex"),
            content: promptContent,
          },
          parameters: {},
          inputs: [
            {
              objectType: "data_asset",
              id: otherAssetId,
              sha256: "f".repeat(64),
              scope: { entireAsset: true },
            },
          ],
          outputs: [
            {
              assetId: output.assetId,
              sha256: output.sha256,
              recordCount: output.recordCount,
            },
          ],
          executedBy: "user_owner",
          startedAt: "2026-08-22T07:00:00.000Z",
          finishedAt: "2026-08-22T07:01:00.000Z",
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { code: "transformation_input_invalid" },
      });
      const runs = await db.query(
        "SELECT count(*)::int AS count FROM transformation_run_output WHERE asset_id = $1",
        [output.assetId],
      );
      expect(runs.rows[0].count).toBe(0);
    } finally {
      // Remove the intentionally unbacked cross-project fixture before consistency scans run.
      await db.query("DELETE FROM data_asset WHERE id = $1", [otherAssetId]);
      await db.query("DELETE FROM project WHERE id = $1", [otherProjectId]);
    }
  });
});
