import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { handoffInputContext, inputContextKey, readInputContext } from "./assistant-input-context";

afterEach(() => vi.unstubAllGlobals());

it("hands off selected records over HTTP without widening their project or actor scope", () => {
  vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(17) });
  const saved = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    setItem: (key: string, value: string) => saved.set(key, value),
    getItem: (key: string) => saved.get(key) ?? null,
  });
  const client = new QueryClient();
  const context = {
    kind: "asset",
    id: "asset-http",
    inputSelection: { recordIds: ["record-1"], sourceRevision: "revision-1", total: 1 },
  };
  client.setQueryData(inputContextKey("project-http", "actor-http"), context);
  const result = handoffInputContext(client, "project-http", "actor-http")!;
  expect(result.token).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(readInputContext(result.token, "project-http", "actor-http")).toEqual(context);
  expect(readInputContext(result.token, "another-project", "actor-http")).toBeUndefined();
  expect(readInputContext(result.token, "project-http", "another-actor")).toBeUndefined();
});
