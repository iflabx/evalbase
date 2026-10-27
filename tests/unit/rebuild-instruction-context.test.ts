import { describe, it, expect } from "vitest";
import {
  assertInstructionsCurrent,
  instructionContext,
  deliveryExecution,
  type Delivery,
} from "../../src/assistant-rebuild/session-contract.js";
const rules = (): Delivery => ({
  id: "delivery-a",
  status: "active",
  operation: "clean",
  count: 5,
  source: {
    kind: "assets",
    assetIds: ["a"],
    recordIds: ["1", "2", "3", "4", "5"],
  },
  allowedFields: ["question"],
  instructions: "保留题目中的5个步骤，整理首尾空白。",
  saveTarget: { kind: "newDraft", name: "原版" },
});
describe("processing rule dependency context", () => {
  it.each([
    { count: 3 },
    {
      source: {
        kind: "assets",
        assetIds: ["b"],
        recordIds: ["1", "2", "3", "4", "5"],
      },
    },
    { operation: "rewrite" },
    { allowedFields: ["question", "metadata"] },
    { allowedFields: ["question", "metadata"], metadataKeys: ["类别"] },
    { classifications: [{ field: "expectedOutput", allowedValues: ["a"] }] },
  ])("invalidates real semantic changes %j", (patch) => {
    const before = rules(),
      after = { ...before, ...patch } as Delivery;
    after.instructionsContext = instructionContext(before);
    expect(() => assertInstructionsCurrent(after)).toThrowError();
  });
  it("retains rule identity for labels, save-as and exact unchanged scope", () => {
    const d = rules();
    d.instructionsContext = instructionContext(d);
    const renamed = {
      ...d,
      name: "新版",
      saveTarget: { kind: "newDraft" as const, name: "另存版" },
    };
    expect(() => assertInstructionsCurrent(renamed)).not.toThrow();
    expect(instructionContext(renamed)).toBe(d.instructionsContext);
    expect(deliveryExecution(renamed).summary).toContain("另存版");
    expect(deliveryExecution(renamed).rules).toContain("5个步骤");
  });
  it("does not silently authorize legacy nonempty rules or rewrite completed data", () => {
    const d = rules(),
      snapshot = structuredClone(d);
    expect(() => assertInstructionsCurrent(d)).toThrowError();
    expect(d).toEqual(snapshot);
    expect(() =>
      assertInstructionsCurrent({ ...d, instructions: "" }),
    ).not.toThrow();
  });
  it("distinguishes new output count from referenced input count", () => {
    expect(
      deliveryExecution({ ...rules(), operation: "augment", count: 20 })
        .summary,
    ).toContain("新增 20 条");
  });
  it("ignores field-set ordering and unused metadata keys but binds the source snapshot", () => {
    const d = {
      ...rules(),
      allowedFields: ["question", "expectedOutput"],
    } as Delivery;
    d.instructionsContext = instructionContext(d);
    expect(() =>
      assertInstructionsCurrent({
        ...d,
        allowedFields: ["expectedOutput", "question"],
        metadataKeys: ["unused"],
      }),
    ).not.toThrow();
    expect(() =>
      assertInstructionsCurrent({
        ...d,
        sourceSnapshot: { hash: "new", revision: 2 },
      }),
    ).toThrow();
    expect(deliveryExecution({ ...d, operation: undefined }).summary).toContain(
      "待确认操作",
    );
  });
});
