import { describe, it, expect } from "vitest";
import { registerAssistantFlush, flushAssistantInput } from "./assistant-page-bridge";
describe("assistant input flush bridge", () => {
  it("waits for the registered editor and propagates save failure without navigation", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((r) => (release = r));
    const cleanup = registerAssistantFlush("p", "a", () => pending);
    let settled = false;
    const result = flushAssistantInput("p", "a").then((v) => {
      settled = true;
      return v;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(false);
    expect(await result).toBe(false);
    cleanup();
  });
  it("does not flush another project or actor and stale cleanup cannot remove the current editor", async () => {
    const old = registerAssistantFlush("p", "a", async () => false);
    const current = registerAssistantFlush("p2", "b", async () => false);
    old();
    expect(await flushAssistantInput("p", "a")).toBe(true);
    expect(await flushAssistantInput("p2", "b")).toBe(false);
    current();
    expect(await flushAssistantInput("p2", "b")).toBe(true);
  });
});
