import { afterEach, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/workspace", () => ({ request: requestMock }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it("loads collaboration over HTTP and keeps a stable presence client ID", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: (bytes: Uint8Array) => bytes.fill(17),
  });

  const { heartbeat, leavePresence } = await import("./collaboration");
  await heartbeat("project_demo");
  const payload = JSON.parse(requestMock.mock.calls[0]![1].body);
  expect(payload.clientId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await leavePresence("project_demo");
  expect(requestMock).toHaveBeenLastCalledWith(
    `/api/projects/project_demo/presence/${payload.clientId}`,
    { method: "DELETE" },
  );
});
