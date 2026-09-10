import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("bootstraps the sole-Owner session before loading projects", async () => {
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/session" && !init?.method) return new Response(null, { status: 401 });
    if (path === "/api/session" && init?.method === "POST")
      return Response.json({ csrfToken: "csrf" });
    if (path === "/api/projects?limit=10&offset=0")
      return Response.json({ projects: [], pagination: { total: 0 } });
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const { listProjects } = await import("./workspace");
  await expect(listProjects({ limit: 10, offset: 0 })).resolves.toEqual({ items: [], total: 0 });
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    "/api/session",
    "/api/session",
    "/api/projects?limit=10&offset=0",
  ]);
});
