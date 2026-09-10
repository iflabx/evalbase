import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 27 formal public route inventory", () => {
  let app: AgentBenchApp;

  beforeAll(async () => {
    app = await buildApp({
      appOrigin: "http://127.0.0.1:3000",
      soloOwnerMode: true,
      allowTestIdentity: false,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    "/api/projects/project_demo/assets",
    "/api/projects/project_demo/assets/asset_old",
    "/api/projects/project_demo/assets/asset_old/audit",
    "/api/projects/project_demo/assets/asset_old/parse-attempts",
    "/api/projects/project_demo/parsed-views/view_old/records/1/location",
    "/api/projects/project_demo/jobs/job_old",
    "/api/projects/project_demo/drafts/draft_old",
    "/api/projects/project_demo/test-sets/test_set_old",
    "/api/projects/project_demo/versions/version_old/packages",
  ])("does not register retired route %s", async (url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "route_not_found" } });
  });
});
