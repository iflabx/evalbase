import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 15 security hardening", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let artifacts: ArtifactRepository;
  let worker: ChildProcess | undefined;
  let cookie: string;
  const secretCanary = "synthetic-password-SESSION-raw-record-prompt";

  async function waitForJob(jobId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/jobs/${jobId}`,
        headers: { cookie },
      });
      const body = response.json();
      if (["failed", "retry_wait"].includes(body.job?.status)) return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for public Job failure state");
  }

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(login.statusCode).toBe(200);
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
  });

  afterAll(async () => {
    const child = worker;
    if (child) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await app.close();
    await db.end();
  });

  it("does not echo request paths or secret canaries in HTTP errors", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/not-found-${encodeURIComponent(secretCanary)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "route_not_found" },
    });
    expect(response.body).not.toContain(secretCanary);
    expect(response.body).not.toContain("not-found-synthetic");
  });

  it("maps malformed JSON requests to a stable safe error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        cookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
        "x-csrf-token": "invalid-for-parser-test",
      },
      payload: `{"password":"${secretCanary}"`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "request_body_invalid" },
    });
    expect(response.body).not.toContain(secretCanary);
  });

  it("rejects every Controlled Deletion mutation before object lookup on forged CSRF", async () => {
    const paths = [
      "/api/projects/project_demo/deletions/preview",
      "/api/projects/project_demo/deletions/event_does_not_exist/confirm",
      "/api/projects/project_demo/deletions/event_does_not_exist/retry",
    ];
    for (const path of paths) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: {
          cookie,
          origin: "https://evil.example",
          "content-type": "application/json",
          "x-csrf-token": `forged-${secretCanary}`,
        },
        payload: {
          targetType: "data_asset",
          targetId: secretCanary,
          previewHash: secretCanary,
          reasonCode: "other",
          reasonNote: secretCanary,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "csrf_rejected" },
      });
      expect(response.body).not.toContain(secretCanary);
    }
  });

  it("keeps secret canaries out of Worker, Job, and Audit failure outputs", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        cookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "text/csv; charset=utf-8",
        "x-csrf-token": "",
        "idempotency-key": randomUUID(),
        "x-file-name": `${secretCanary}.csv`,
        "x-source-type": "synthetic",
        "x-source-name": secretCanary,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": secretCanary,
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from(
        `question,answer,category\n${secretCanary},safe answer,billing\n`,
      ),
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.body).not.toContain(secretCanary);

    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const authorizedUpload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        cookie,
        origin: "http://127.0.0.1:3000",
        "content-type": "text/csv; charset=utf-8",
        "x-csrf-token": login.json().csrfToken,
        "idempotency-key": randomUUID(),
        "x-file-name": `${secretCanary}.csv`,
        "x-source-type": "synthetic",
        "x-source-name": secretCanary,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": secretCanary,
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from(
        `question,answer,category\n${secretCanary},safe answer,billing\n`,
      ),
    });
    expect(authorizedUpload.statusCode).toBe(201);
    const assetId = authorizedUpload.json().asset.id;
    const jobId = authorizedUpload.json().job.id;
    const successfulDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/download`,
      headers: { cookie },
    });
    expect(successfulDownload.statusCode).toBe(200);
    expect(successfulDownload.rawPayload.toString("utf8")).toContain(
      secretCanary,
    );
    expect(JSON.stringify(successfulDownload.headers)).not.toContain(
      secretCanary,
    );
    const asset = await db.query(
      "SELECT object_ref FROM data_asset WHERE id=$1",
      [assetId],
    );
    await artifacts.remove(asset.rows[0].object_ref);

    const workerOutput: Buffer[] = [];
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, JOB_CLAIM_DELAY_MS: "1" },
      },
    );
    worker = child;
    child.stdout?.on("data", (chunk: Buffer) => workerOutput.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => workerOutput.push(chunk));
    const job = await waitForJob(jobId);

    const workerText = Buffer.concat(workerOutput).toString("utf8");
    expect(workerText).toContain("parse_asset:failure");
    expect(workerText).not.toContain(secretCanary);
    expect(JSON.stringify(job)).not.toContain(secretCanary);

    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/audit?objectType=data_asset&objectId=${assetId}`,
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).not.toContain(secretCanary);
  });

  it("rejects resource-unsafe Formal Schemas through the draft S-HTTP seam", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const ownerCookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken as string;
    const headers = {
      cookie: ownerCookie,
      origin: "http://127.0.0.1:3000",
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
    const assetId = `asset_security_${randomUUID().replaceAll("-", "")}`;
    const viewId = `view_security_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO data_asset
       (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
        file_name, format, status, uploaded_by)
       VALUES ($1,'project_demo',$2,$3,1,'text/csv','security-schema.csv',
               'csv','stored','user_owner')`,
      [assetId, randomUUID().replaceAll("-", ""), `security/${randomUUID()}`],
    );
    await db.query(
      `INSERT INTO source_attribution_revision
       (id, asset_id, source_type, source_name, purpose, responsible_actor,
        responsible_person, license_status, sensitivity)
       VALUES ($1,$2,'synthetic','Synthetic Formal Schema fixture',
               'Synthetic security validation','user_owner','Project Owner',
               'not_applicable','non_sensitive')`,
      [`attr_security_${randomUUID().replaceAll("-", "")}`, assetId],
    );
    await db.query(
      `INSERT INTO parsed_view
       (id, asset_id, format, parser_name, parser_version, parser_config,
        parser_config_hash, status, record_count, success_count, failure_count,
        boundary_trusted, draft_eligible, is_current)
       VALUES ($1,$2,'csv','format-adapter','parser-contract-v1','{}'::jsonb,
               'security-fixture','ready',1,1,0,true,true,true)`,
      [viewId, assetId],
    );
    await db.query(
      `INSERT INTO source_record
       (parsed_view_id, ordinal, value, locator, record_hash, parse_status)
       VALUES ($1,1,$2,$3,$4,'valid')`,
      [
        viewId,
        JSON.stringify({
          question: "safe question",
          answer: "safe answer",
          category: "billing",
        }),
        JSON.stringify({ kind: "csv_row", dataRow: 1, physicalLine: 2 }),
        randomUUID().replaceAll("-", ""),
      ],
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers,
      payload: {
        name: `Security Formal Schema ${randomUUID()}`,
        purpose: "Synthetic security validation",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const savedRecipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Synthetic Formal Schema security validation",
        mapping: {
          input: { object: { message: { source: "/question" } } },
          expectedOutput: { source: "/answer" },
          metadata: { object: {} },
        },
        unmappedFields: ["category"],
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
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie: ownerCookie },
    });
    expect(proposal.statusCode).toBe(200);

    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 10; depth += 1)
      nested = { type: "object", properties: { child: nested } };
    const tooManyProperties = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [
          `field_${index}`,
          {
            type: "string",
          },
        ]),
      ),
    };
    const invalidSchemas: Array<[string, Record<string, unknown>]> = [
      ["remote-ref", { $ref: `https://example.invalid/${secretCanary}.json` }],
      ["dangerous-regex", { type: "string", pattern: "(a+)+$" }],
      ["depth", nested],
      ["property-count", tooManyProperties],
      ["byte-size", { type: "string", const: secretCanary.repeat(1_000) }],
    ];
    for (const [name, inputSchema] of invalidSchemas) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${draft.id}`,
        headers,
        payload: {
          leaseToken: draft.leaseToken,
          expectedRevision: savedRecipe.json().draft.revision,
          proposalId: proposal.json().proposalId,
          filter: { field: "category", operator: "eq", value: "billing" },
          mapping: {
            input: { object: { message: { source: "/question" } } },
            expectedOutput: { source: "/answer" },
            metadata: { object: {} },
          },
          unmappedFields: ["category"],
          unmappedConfirmed: true,
          formalSchema: {
            mode: "gold_required",
            input: inputSchema,
            expectedOutput: { type: "string" },
          },
        },
      });

      expect(response.statusCode, name).toBe(422);
      expect(response.json()).toMatchObject({
        error: { code: "formal_schema_unsupported" },
      });
      expect(response.body).not.toContain(secretCanary);
    }
  });
});
