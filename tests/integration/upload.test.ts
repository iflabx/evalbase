import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { CAPACITY_LIMITS } from "../../src/capacity.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { buildCapacityFixture } from "../fixtures/capacity-boundaries.js";

describe("S-HTTP owner asset upload", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      {
        stdio: "inherit",
      },
    );
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
  });

  it("stores an allowed UTF-8 CSV without a pre-created schema", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(login.statusCode).toBe(200);
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const cookie = login.cookies[0]?.name + "=" + login.cookies[0]?.value;
    const bytes = await readFile(
      new URL("../fixtures/owner.csv", import.meta.url),
    );
    const idempotencyKey = `fixture-owner-csv-${randomUUID()}`;

    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": idempotencyKey,
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "owner.csv",
      "x-source-type": "synthetic",
      "x-source-name": "Ticket 01 fixture",
      "x-source-purpose": "Non-production tracer test",
      "x-license-status": "not_applicable",
      "x-sensitivity": "non_sensitive",
    };

    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers,
      payload: bytes,
    });

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      asset: {
        id: expect.stringMatching(/^asset_/),
        size: bytes.byteLength,
        mimeType: "text/csv; charset=utf-8",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        uploadedBy: "owner",
        status: "stored",
      },
    });
    expect(upload.json().asset.uploadedAt).toEqual(expect.any(String));

    const assetId = upload.json().asset.id;
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(bytes);

    const replay = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers,
      payload: bytes,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      asset: { id: assetId },
      attribution: { id: upload.json().attribution.id },
      parsedView: { id: upload.json().parsedView.id },
      job: { id: upload.json().job.id },
      replayed: true,
    });

    const revised = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/assets/${assetId}/attribution`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        sourceType: "synthetic",
        sourceName: "Revised synthetic source",
        responsiblePerson: "Project Owner",
        purpose: "Replay must preserve the original receipt",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        sourceAddress: null,
        acquiredAt: null,
        deidentificationConfirmed: false,
      },
    });
    expect(revised.statusCode).toBe(200);
    const retry = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/parse-attempts`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        config: {
          encoding: "utf8",
          delimiter: ";",
          headerRow: 1,
          quote: '"',
        },
      },
    });
    expect(retry.statusCode).toBe(202);

    const replayAfterRevisions = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers,
      payload: bytes,
    });
    expect(replayAfterRevisions.statusCode).toBe(200);
    expect(replayAfterRevisions.json()).toMatchObject({
      asset: { id: assetId },
      attribution: {
        id: upload.json().attribution.id,
        sourceName: "Ticket 01 fixture",
        purpose: "Non-production tracer test",
      },
      parsedView: { id: upload.json().parsedView.id },
      job: { id: upload.json().job.id },
      replayed: true,
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "x-file-name": "different.csv" },
      payload: bytes,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const changedBytes = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers },
      payload: Buffer.concat([bytes, Buffer.from("\n")]),
    });
    expect(changedBytes.statusCode).toBe(409);
    expect(changedBytes.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const changedAttribution = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        ...headers,
        "x-source-purpose": "Different logical upload request",
      },
      payload: bytes,
    });
    expect(changedAttribution.statusCode).toBe(409);
    expect(changedAttribution.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const independent = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: bytes,
    });
    expect(independent.statusCode).toBe(201);
    expect(independent.json().asset).toMatchObject({
      sha256: upload.json().asset.sha256,
    });
    expect(independent.json().asset.id).not.toBe(assetId);

    const concurrentKey = randomUUID();
    const slowBody = new PassThrough();
    const firstConcurrent = app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "idempotency-key": concurrentKey },
      payload: slowBody,
    });
    slowBody.write(bytes.subarray(0, 32));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondConcurrent = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "idempotency-key": concurrentKey },
      payload: bytes,
    });
    expect(secondConcurrent.statusCode).toBe(409);
    expect(secondConcurrent.json()).toMatchObject({
      error: {
        code: "idempotency_in_progress",
        operationId: expect.stringMatching(/^upload_/),
      },
    });
    slowBody.end(bytes.subarray(32));
    expect((await firstConcurrent).statusCode).toBe(201);
    let preview;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      preview = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records?limit=100&parsedViewId=${upload.json().parsedView.id}`,
        headers: { cookie },
      });
      if (preview.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(preview?.statusCode).toBe(200);
    expect(["ready", "superseded"]).toContain(
      preview?.json().parsedView.status,
    );
    expect(preview?.json()).toMatchObject({
      parsedView: { recordCount: 3 },
      records: expect.arrayContaining([
        expect.objectContaining({
          ordinal: 1,
          value: expect.objectContaining({
            question: "How do I reset my password?",
            answer: "Use the reset link",
          }),
          locator: expect.objectContaining({ physicalLine: 2 }),
        }),
      ]),
    });
  });

  it("round-trips Unicode upload metadata encoded for HTTP headers", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const encode = encodeURIComponent;
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": `unicode-upload-${randomUUID()}`,
        "content-type": "text/csv; charset=utf-8",
        "x-agentbench-upload-encoding": "percent-utf8",
        "x-file-name": encode("原始资产.csv"),
        "x-source-type": "synthetic",
        "x-source-name": encode("中文来源"),
        "x-responsible-person": encode("项目负责人"),
        "x-source-purpose": encode("中文测试用途"),
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
        "x-source-address": encode("北京市"),
        "x-acquired-at": encode("2026-08-27T00:00:00.000Z"),
      },
      payload: Buffer.from("id,name\n1,测试\n"),
    });

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      asset: { fileName: "原始资产.csv" },
      attribution: {
        sourceName: "中文来源",
        responsiblePerson: "项目负责人",
        purpose: "中文测试用途",
        sourceAddress: "北京市",
        acquiredAt: "2026-08-27T00:00:00.000Z",
      },
    });
  });

  it("rejects oversized ordinary JSON requests at the public HTTP seam", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
        "content-length": String(CAPACITY_LIMITS.dataAssetBytes + 1),
      },
      payload: "{}",
    });

    expect(response.statusCode).toBe(413);
  });

  it("accepts exactly 50,000,000 bytes and rejects one byte more", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const bytes = buildCapacityFixture("upload-exact-50mb-csv").bytes;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "exact-50mb.csv",
      "x-source-type": "synthetic",
      "x-source-name": "Exact boundary fixture",
      "x-source-purpose": "Non-production upload boundary test",
      "x-license-status": "not_applicable",
      "x-sensitivity": "non_sensitive",
    };
    const exact = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: bytes,
    });
    expect(exact.statusCode).toBe(201);
    expect(exact.json().asset.size).toBe(50_000_000);

    const overKey = randomUUID();
    const over = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: { ...headers, "idempotency-key": overKey },
      payload: buildCapacityFixture("upload-over-50mb-csv").bytes,
    });
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({
      error: {
        code: "asset_too_large",
        actualBytes: 50_000_001,
        limitBytes: 50_000_000,
      },
    });
    const db = createPool(loadConfig().databaseUrl);
    const operation = await db.query(
      `SELECT operation_id FROM upload_idempotency
       WHERE project_id = 'project_demo' AND actor_id = 'user_owner'
         AND operation = 'asset_upload' AND idempotency_key = $1`,
      [overKey],
    );
    expect(operation.rowCount).toBe(1);
    const audit = await db.query(
      `SELECT action, object_type, object_id, details
       FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = $1
       ORDER BY id DESC LIMIT 1`,
      [operation.rows[0].operation_id],
    );
    await db.end();
    expect(audit.rows[0]).toMatchObject({
      action: "asset_upload_capacity_blocked",
      object_type: "asset_upload",
      object_id: operation.rows[0].operation_id,
      details: {
        errorCode: "asset_too_large",
        blockingPhase: "data_asset_upload",
        actualBytes: 50_000_001,
        limitBytes: 50_000_000,
      },
    });
  }, 120_000);

  it("lets an interrupted upload be retried with the same key", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const bytes = Buffer.from("value\n");
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": randomUUID(),
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "interrupted.csv",
      "x-source-type": "synthetic",
      "x-source-name": "Interrupted upload fixture",
      "x-responsible-person": "Project Owner",
      "x-source-purpose": "Capacity interruption test",
      "x-license-status": "not_applicable",
      "x-sensitivity": "non_sensitive",
    };
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server did not allocate a port");
    const interrupted = new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/api/projects/project_demo/assets",
          headers,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 500);
        },
      );
      request.on("error", reject);
      request.write(bytes.subarray(0, 3));
      setTimeout(
        () => request.destroy(new Error("synthetic interruption")),
        100,
      );
    });
    await interrupted.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const db = createPool(loadConfig().databaseUrl);
    const initialOperation = await db.query(
      `SELECT operation_id FROM upload_idempotency
       WHERE project_id = 'project_demo' AND actor_id = 'user_owner'
         AND operation = 'asset_upload' AND idempotency_key = $1`,
      [headers["idempotency-key"]],
    );
    await db.end();
    expect(initialOperation.rowCount).toBe(1);

    const requestJson = (
      requestBody: Buffer | PassThrough,
      writePartial = false,
    ) =>
      new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/api/projects/project_demo/assets",
            headers,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                statusCode: response.statusCode ?? 500,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
          },
        );
        request.on("error", reject);
        if (writePartial) {
          request.write(bytes.subarray(0, 3));
          setTimeout(() => request.end(bytes.subarray(3)), 250);
        } else {
          request.end(requestBody);
        }
      });

    const firstRetry = requestJson(new PassThrough(), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondRetry = await requestJson(bytes);
    expect(secondRetry.statusCode).toBe(409);
    expect(secondRetry.body).toMatchObject({
      error: { code: "idempotency_in_progress" },
    });
    expect(secondRetry.body.error.operationId).not.toBe(
      initialOperation.rows[0].operation_id,
    );
    const ownership = createPool(loadConfig().databaseUrl);
    const currentOperation = await ownership.query(
      `SELECT status, operation_id, asset_id FROM upload_idempotency
       WHERE project_id = 'project_demo' AND actor_id = 'user_owner'
         AND operation = 'asset_upload' AND idempotency_key = $1`,
      [headers["idempotency-key"]],
    );
    const first = await firstRetry;
    expect(first.statusCode).toBe(201);
    expect(first.body.asset.size).toBe(bytes.byteLength);
    const committedOperation = await ownership.query(
      `SELECT status, operation_id, asset_id FROM upload_idempotency
       WHERE project_id = 'project_demo' AND actor_id = 'user_owner'
         AND operation = 'asset_upload' AND idempotency_key = $1`,
      [headers["idempotency-key"]],
    );
    await ownership.end();
    expect(currentOperation.rows[0]).toMatchObject({
      status: "receiving",
      operation_id: secondRetry.body.error.operationId,
    });
    expect(committedOperation.rows[0]).toMatchObject({
      status: "committed",
      operation_id: secondRetry.body.error.operationId,
      asset_id: first.body.asset.id,
    });
  }, 30_000);
});
