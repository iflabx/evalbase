import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const origin = "http://127.0.0.1:4217";
const databaseName = `model_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);
const modelEncryptionKey = Buffer.alloc(32, 7).toString("base64");
describe("administrator model connection", () => {
  let app: AgentBenchApp;
  let model: Server;
  let endpoint: string;
  let headers: Record<string, string>;
  let requestAuthorization = "";
  let requests = 0;
  let holdResponse = false;
  let releaseResponse: (() => void) | undefined;
  beforeAll(async () => {
    const db = createPool(baseUrl);
    try {
      await db.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await db.end();
    }
    await migrate(databaseUrl);
    app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
        modelEncryptionKey,
      },
      { disableLegacyTestBootstrap: true },
    );
    const password = "TestModelAdmin123";
    await app.inject({
      method: "POST",
      url: "/api/installation/administrator",
      headers: { origin },
      payload: {
        email: "model-admin@example.test",
        password,
        confirmPassword: password,
        displayName: "管理员",
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { email: "model-admin@example.test", password },
    });
    headers = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    model = createServer((request, response) => {
      requests++;
      requestAuthorization = request.headers.authorization ?? "";
      if (request.url?.startsWith("/redirect")) {
        response.writeHead(302, { location: endpoint + "/chat/completions" });
        response.end();
        return;
      }
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const finish = () =>
        response.end(
          JSON.stringify({
            id: "test-completion",
            object: "chat.completion",
            created: 1,
            model: "synthetic-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      if (holdResponse) releaseResponse = finish;
      else finish();
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => model?.close(() => resolve()));
    const db = createPool(baseUrl);
    try {
      await db.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await db.end();
    }
  });
  it("encrypts credentials, preserves blank keys and tests the saved chat provider", async () => {
    const url = "/api/settings/model-connection";
    const saved = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        revision: 0,
        name: "测试模型",
        endpoint,
        model: "synthetic-model",
        apiKey: "synthetic-secret-token",
        enabled: true,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain("synthetic-secret-token");
    expect(saved.json().connection).toMatchObject({
      revision: 1,
      hasKey: true,
      enabled: true,
      name: "测试模型",
      testedAt: null,
    });
    const db = createPool(databaseUrl);
    try {
      const stored = await db.query(
        "SELECT credential FROM model_connection WHERE revision=1",
      );
      expect(JSON.stringify(stored.rows)).not.toContain(
        "synthetic-secret-token",
      );
    } finally {
      await db.end();
    }
    const tested = await app.inject({
      method: "POST",
      url: `${url}/test`,
      headers,
      payload: { revision: 1 },
    });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json().test.ok).toBe(true);
    expect(requestAuthorization).toBe("Bearer synthetic-secret-token");
    expect(requests).toBe(1);
    const update = {
      revision: 1,
      name: "已更新",
      endpoint,
      model: "synthetic-model",
      apiKey: "",
      enabled: true,
    };
    const updated = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: update,
    });
    expect(updated.json().connection).toMatchObject({
      revision: 2,
      hasKey: true,
      testedAt: null,
    });
    const stale = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: update,
    });
    expect(stale.statusCode).toBe(409);
    const invalid = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        ...update,
        revision: 2,
        endpoint: "https://user:pass@example.test/v1",
      },
    });
    expect(invalid.statusCode).toBe(422);
  });
  it("restricts administration, fails closed without encryption and never follows redirects", async () => {
    const registration = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: {
        email: "model-user@example.test",
        password: "TestUser123",
        confirmPassword: "TestUser123",
      },
    });
    expect(registration.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { email: "model-user@example.test", password: "TestUser123" },
    });
    const ordinary = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const denied = await app.inject({
      method: "GET",
      url: "/api/settings/model-connection",
      headers: ordinary,
    });
    expect(denied.statusCode).toBe(403);
    const unconfigured = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
        modelEncryptionKey: "",
      },
      { disableLegacyTestBootstrap: true },
    );
    try {
      const failure = await unconfigured.inject({
        method: "POST",
        url: "/api/settings/model-connection/test",
        headers,
        payload: { revision: 2 },
      });
      expect(failure.statusCode, failure.body).toBe(503);
    } finally {
      await unconfigured.close();
    }
    const redirected = await app.inject({
      method: "PUT",
      url: "/api/settings/model-connection",
      headers,
      payload: {
        revision: 2,
        name: "重定向测试",
        endpoint: endpoint.replace("/v1", "/redirect"),
        model: "synthetic-model",
        enabled: true,
      },
    });
    expect(redirected.statusCode).toBe(200);
    const before = requests;
    const failure = await app.inject({
      method: "POST",
      url: "/api/settings/model-connection/test",
      headers,
      payload: { revision: 3 },
    });
    expect(failure.json().test.ok).toBe(false);
    expect(requests - before).toBe(1);
    expect(failure.body).not.toContain("synthetic-secret-token");
  });
  it("requires a fresh key for a different origin and binds delayed test results to their revision", async () => {
    const url = "/api/settings/model-connection";
    const config = {
      revision: 3,
      name: "并发测试",
      endpoint,
      model: "synthetic-model",
      enabled: true,
    };
    const moved = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        ...config,
        endpoint: "https://another-provider.example.test/v1",
        apiKey: "",
      },
    });
    expect(moved.statusCode, moved.body).toBe(422);
    const saved = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: config,
    });
    expect(saved.statusCode).toBe(200);
    holdResponse = true;
    const pending = app
      .inject({
        method: "POST",
        url: `${url}/test`,
        headers,
        payload: { revision: 4 },
      })
      .then((result) => result);
    await expect.poll(() => !!releaseResponse).toBe(true);
    try {
      const changed = await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { ...config, revision: 4, name: "另一个窗口保存" },
      });
      expect(changed.statusCode).toBe(200);
    } finally {
      holdResponse = false;
      releaseResponse?.();
    }
    const tested = await pending;
    expect(tested.statusCode, tested.body).toBe(409);
    const latest = await app.inject({ method: "GET", url, headers });
    expect(latest.json().connection).toMatchObject({
      revision: 5,
      testedAt: null,
      testOk: null,
    });
  });
});
