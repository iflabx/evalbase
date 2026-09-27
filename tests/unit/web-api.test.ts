import { describe, expect, it, vi } from "vitest";

import { api } from "../../src/web/api.js";

describe("browser API requests", () => {
  it("requests a project delivery page with its bounded query", async () => {
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ deliveries: [], pagination: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      api.deliveries("project_demo", {
        limit: "20",
        offset: "40",
        status: "generated",
      }),
    ).resolves.toEqual({ deliveries: [], pagination: {} });
    expect(requestedUrl).toBe(
      "/api/projects/project_demo/deliveries?limit=20&offset=40&status=generated",
    );
  });

  it("requests a bounded Test Set version history page", async () => {
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({ versions: [], pagination: { total: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      api.versions("project_demo", "test_set_1", {
        limit: "20",
        offset: "40",
      }),
    ).resolves.toMatchObject({ versions: [] });
    expect(requestedUrl).toBe(
      "/api/projects/project_demo/test-sets/test_set_1/versions?limit=20&offset=40",
    );
  });
});
