import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("lists projects without creating an implicit Owner session", async () => {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/projects?limit=10&offset=0")
      return Response.json({ projects: [], pagination: { total: 0 } });
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { listProjects } = await import("./workspace");
  await expect(listProjects({ limit: 10, offset: 0 })).resolves.toEqual({ items: [], total: 0 });
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/projects?limit=10&offset=0"]);
});
