import { describe, expect, it } from "vitest";

import { parseRoute } from "../../src/web/navigation.js";

describe("browser route seam", () => {
  it.each([
    ["/assets", "assets", undefined],
    ["/assets/asset_123", "asset-detail", "asset_123"],
    ["/workbench/draft_123", "workbench", "draft_123"],
    ["/test-sets", "test-sets", undefined],
    ["/test-sets/testset_123", "test-set-detail", "testset_123"],
    ["/deliveries", "deliveries", undefined],
  ])("maps %s to %s", (path, page, id) => {
    const route = parseRoute(path);
    expect(route.page).toBe(page);
    if (id) expect(route.id).toBe(id);
  });

  it("preserves query parameters for contextual details", () => {
    expect(parseRoute("/test-sets/testset_123?version=version_2")).toEqual({
      page: "test-set-detail",
      id: "testset_123",
      query: { version: "version_2" },
    });
  });

  it("uses the asset list as the root landing page", () => {
    expect(parseRoute("/")).toEqual({ page: "assets", query: {} });
  });

  it("treats malformed encoded paths as an unknown route", () => {
    expect(parseRoute("/assets/%E0%A4%A")).toEqual({
      page: "not-found",
      query: {},
    });
  });
});
