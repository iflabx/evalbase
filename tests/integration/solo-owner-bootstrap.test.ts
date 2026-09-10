import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("S-HTTP non-interactive Owner bootstrap", () => {
  let app: AgentBenchApp;

  beforeAll(async () => {
    app = await buildApp({
      appOrigin: "http://127.0.0.1:3000",
      soloOwnerMode: true,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("creates an Owner session without a credential form", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actor: { id: "user_owner", username: "owner", role: "owner" },
      csrfToken: expect.any(String),
    });
    expect(response.cookies[0]?.name).toBe("agentbench_session");
  });

  it("rejects a bootstrap request from another Origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://untrusted.example",
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "origin_rejected" } });
  });

  it.each([
    ["a non-string username", { username: 123 }],
    ["a non-string password", { password: false }],
    ["an unexpected field", { note: "not credentials" }],
  ])("retires credential-shaped %s", async (_case, payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "route_not_found" } });
  });

  it("does not expose credential login in sole Owner mode", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: { username: "owner", password: "owner-test-password" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "route_not_found" } });
  });
});
