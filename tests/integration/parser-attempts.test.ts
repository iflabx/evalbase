import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { buildCapacityFixture } from "../fixtures/capacity-boundaries.js";

describe("Ticket 02 Parsed View attempts", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
  });

  it("exposes valid and invalid JSONL lines through one located Source Record contract", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const source = Buffer.from(
      '{"question":"one","answer":"1"}\n{"broken":}\n{"question":"three","answer":"3"}',
    );
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "application/x-ndjson",
        "x-file-name": "three-lines.jsonl",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 02 synthetic JSONL",
        "x-source-purpose": "Parser recovery acceptance",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: source,
    });

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      asset: { format: "jsonl" },
      parsedView: { id: expect.stringMatching(/^view_/), status: "queued" },
    });
    const assetId = upload.json().asset.id;
    let preview;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      preview = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records`,
        headers: { cookie },
      });
      if (preview.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(preview?.statusCode).toBe(200);
    expect(preview?.json()).toMatchObject({
      parsedView: {
        status: "ready",
        totalCount: 3,
        successCount: 2,
        failureCount: 1,
        boundaryTrusted: true,
        draftEligible: false,
      },
      records: [
        expect.objectContaining({
          ordinal: 1,
          fields: { question: "one", answer: "1" },
          locator: { kind: "jsonl_line", physicalLine: 1 },
          parseStatus: "valid",
        }),
        expect.objectContaining({
          ordinal: 2,
          locator: { kind: "jsonl_line", physicalLine: 2 },
          parseStatus: "invalid",
          error: expect.objectContaining({ code: "malformed_json" }),
        }),
        expect.objectContaining({
          ordinal: 3,
          fields: { question: "three", answer: "3" },
          locator: { kind: "jsonl_line", physicalLine: 3 },
          parseStatus: "valid",
        }),
      ],
    });

    const blockedDraft = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Blocked JSONL ${randomUUID()}`,
        purpose: "Verify parse-error boundary",
        assetId,
      },
    });
    expect(blockedDraft.statusCode).toBe(422);
    expect(blockedDraft.json()).toMatchObject({
      error: {
        code: "parsed_view_not_draft_eligible",
        blockingPhase: "parsed_view",
      },
    });

    const excluded = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/parsed-views/${upload.json().parsedView.id}/exclusions`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        locators: [{ kind: "jsonl_line", physicalLine: 2 }],
      },
    });
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json()).toMatchObject({
      report: {
        excludedCount: 1,
        eligibleRecordCount: 2,
        draftEligible: true,
        exclusions: [
          expect.objectContaining({
            locator: { kind: "jsonl_line", physicalLine: 2 },
            reason: "Malformed JSON on this physical line.",
          }),
        ],
      },
    });

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
        name: `Eligible JSONL ${randomUUID()}`,
        purpose: "Verify explicit parse-error exclusion",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
  });

  it("creates a new configured attempt while preserving raw bytes and the failed view", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const source = Buffer.from('question,answer\n"unterminated,A\n');
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": "recoverable.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 02 recovery fixture",
        "x-source-purpose": "Parser recovery acceptance",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: source,
    });
    expect(upload.statusCode).toBe(201);
    const assetId = upload.json().asset.id;
    const originalViewId = upload.json().parsedView.id;

    let failed;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      failed = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records?parsedViewId=${originalViewId}`,
        headers: { cookie },
      });
      if (failed.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(failed?.json()).toMatchObject({
      parsedView: {
        id: originalViewId,
        status: "parse_failed",
        boundaryTrusted: false,
        errors: [expect.objectContaining({ code: "malformed_csv" })],
      },
    });
    const boundaryBlocked = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Boundary blocked ${randomUUID()}`,
        purpose: "Untrusted boundary must not enter a draft",
        assetId,
      },
    });
    expect(boundaryBlocked.statusCode).toBe(422);
    expect(boundaryBlocked.json()).toMatchObject({
      error: {
        code: "parsed_view_not_draft_eligible",
        blockingPhase: "parsed_view",
      },
    });

    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/parse-attempts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        config: {
          encoding: "utf8",
          delimiter: ",",
          headerRow: 1,
          quote: "'",
        },
      },
    });
    expect(retry.statusCode).toBe(202);
    const recoveredViewId = retry.json().parsedView.id;
    expect(recoveredViewId).not.toBe(originalViewId);

    let recovered;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      recovered = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records?parsedViewId=${recoveredViewId}`,
        headers: { cookie },
      });
      if (recovered.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(recovered?.json()).toMatchObject({
      parsedView: {
        id: recoveredViewId,
        status: "ready",
        parserConfig: { quote: "'" },
      },
      records: [
        expect.objectContaining({
          fields: { question: '"unterminated', answer: "A" },
        }),
      ],
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/parse-attempts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        config: {
          encoding: "utf8",
          delimiter: ",",
          headerRow: 1,
          quote: "'",
        },
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      parsedView: { id: recoveredViewId, status: "ready" },
      replayed: true,
    });

    const attempts = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/parse-attempts`,
      headers: { cookie },
    });
    expect(attempts.statusCode).toBe(200);
    expect(attempts.json().attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: originalViewId,
          status: "parse_failed",
        }),
        expect.objectContaining({
          id: recoveredViewId,
          status: "ready",
          parserConfig: expect.objectContaining({ quote: "'" }),
          isCurrent: true,
        }),
      ]),
    );

    const location = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/parsed-views/${recoveredViewId}/records/1/location`,
      headers: { cookie },
    });
    expect(location.statusCode).toBe(200);
    expect(location.json()).toMatchObject({
      object: {
        type: "source_record",
        parsedViewId: recoveredViewId,
        ordinal: 1,
      },
      locator: { kind: "csv_row", dataRow: 1, physicalLine: 2 },
      rawAssetDownloadUrl: `/api/projects/project_demo/assets/${assetId}/download`,
    });

    const oldView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/records?parsedViewId=${originalViewId}`,
      headers: { cookie },
    });
    expect(oldView.json().parsedView).toMatchObject({
      id: originalViewId,
      status: "parse_failed",
    });
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/download`,
      headers: { cookie },
    });
    expect(download.rawPayload).toEqual(source);
  });

  it("keeps superseded ready views readable and lets the owner select one as current", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const source = Buffer.from('{"rows":[{"value":1}],"label":"synthetic"}');
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "application/octet-stream",
        "x-file-name": "nested.json",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 02 nested JSON",
        "x-source-purpose": "Parsed View selection acceptance",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: source,
    });
    const assetId = upload.json().asset.id;
    const originalViewId = upload.json().parsedView.id;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records?parsedViewId=${originalViewId}`,
        headers: { cookie },
      });
      if (current.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/parse-attempts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { config: { recordPath: "/rows" } },
    });
    const nestedViewId = retry.json().parsedView.id;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records?parsedViewId=${nestedViewId}`,
        headers: { cookie },
      });
      if (current.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const superseded = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/records?parsedViewId=${originalViewId}`,
      headers: { cookie },
    });
    expect(superseded.json()).toMatchObject({
      parsedView: { id: originalViewId, status: "superseded" },
      records: [
        expect.objectContaining({
          fields: { rows: [{ value: 1 }], label: "synthetic" },
        }),
      ],
    });

    const selected = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/parsed-views/${originalViewId}/select`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      parsedView: {
        id: originalViewId,
        status: "superseded",
        isCurrent: true,
      },
    });
    const current = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/records`,
      headers: { cookie },
    });
    expect(current.json().parsedView).toMatchObject({
      id: originalViewId,
      status: "superseded",
    });

    const draft = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Selected view ${randomUUID()}`,
        purpose: "Use the explicitly selected Parsed View",
        assetId,
      },
    });
    expect(draft.statusCode).toBe(201);
  });

  it("keeps a 10,001-record asset downloadable but blocks its Parsed View from drafts", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const source = buildCapacityFixture("source-over-10000-jsonl").bytes;
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "application/x-ndjson",
        "x-file-name": "over-limit.jsonl",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 02 10,001 boundary",
        "x-source-purpose": "Record capacity acceptance",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: source,
    });
    const assetId = upload.json().asset.id;
    let preview;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      preview = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records`,
        headers: { cookie },
      });
      if (preview.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(preview?.json()).toMatchObject({
      parsedView: {
        status: "ready",
        totalCount: 10_001,
        draftEligible: false,
        errors: [
          expect.objectContaining({ code: "source_record_limit_exceeded" }),
        ],
      },
    });
    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/audit`,
      headers: { cookie },
    });
    expect(audit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "parsed_view_capacity_blocked" }),
      ]),
    );
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/download`,
      headers: { cookie },
    });
    expect(download.rawPayload).toEqual(source);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Over limit ${randomUUID()}`,
        purpose: "Capacity block",
        assetId,
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({
      error: {
        code: "parsed_view_not_draft_eligible",
        blockingPhase: "parsed_view",
        actualRecords: 10_001,
        limitRecords: 10_000,
        retry: "Use an asset with at most 10,000 Source Records.",
      },
    });
  }, 60_000);
});
