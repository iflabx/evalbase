import { describe, it, expect } from "vitest";
import {
  executionReadiness,
  type SessionRequirements,
} from "../../src/assistant-rebuild/session-contract.js";
const req = (): SessionRequirements => ({
  mode: "execute",
  objective: "不得包含个人信息",
  deliveries: [
    {
      id: "d1",
      status: "active",
      name: "三条",
      operation: "clean",
      count: 3,
      source: { kind: "assets", assetIds: ["a"], recordIds: ["1", "2", "3"] },
      allowedFields: ["question"],
      instructions: "",
      saveTarget: { kind: "newDraft", name: "三条" },
    },
  ],
});
describe("shared current execution readiness", () => {
  it("separates a saved plan from execution authority", () => {
    expect(executionReadiness(req()).ready).toBe(true);
    expect(executionReadiness({ ...req(), mode: "plan" })).toMatchObject({
      ready: false,
      complete: true,
    });
  });
  it.each(["operation", "source", "count", "allowedFields", "saveTarget"])(
    "rejects an incomplete %s before execution",
    (field) => {
      const r = req();
      delete (r.deliveries[0] as any)[field];
      expect(executionReadiness(r).ready).toBe(false);
      expect(executionReadiness(r).issues.some((i) => i.field === field)).toBe(
        true,
      );
    },
  );
  it("allows complete multi-delivery execution while keeping planning non-executable", () => {
    const r = req();
    r.deliveries.push({ ...r.deliveries[0]!, id: "d2" });
    r.mode = "plan";
    expect(executionReadiness(r).ready).toBe(false);
    expect(r.deliveries).toHaveLength(2);
    r.mode = "execute";
    expect(executionReadiness(r).ready).toBe(true);
  });
  it("blocks uncommitted amendments without changing the requirement revision", () => {
    const r = req(),
      before = structuredClone(r);
    expect(executionReadiness(r, true).ready).toBe(false);
    expect(r).toEqual(before);
  });
});
