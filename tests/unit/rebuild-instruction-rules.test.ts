import { it, expect } from "vitest";
import {
  instructionScopeConflict,
  instructionRuleContext,
} from "../../src/assistant-rebuild/session-contract.js";
const d: any = {
  id: "d",
  status: "active",
  operation: "rewrite",
  count: 3,
  allowedFields: ["question"],
};
it.each(["只改写前5条。", "只改写前五条！", "处理5条"])(
  "rejects stale scope %s",
  (s) => {
    expect(instructionScopeConflict({ ...d, instructions: s })).toBeTruthy();
  },
);
it.each([
  "保持原意，5字以内",
  "价格超过5万元",
  "保持答案标签不变",
  "改写前3条",
])("accepts applicable rule %s", (s) =>
  expect(instructionScopeConflict({ ...d, instructions: s })).toBeUndefined(),
);
it("does not confuse augmentation input with output", () =>
  expect(
    instructionScopeConflict({
      ...d,
      operation: "augment",
      count: 20,
      instructions: "参考前5条，扩写20条",
    }),
  ).toBeUndefined());
it("separates selection from rules", () => {
  expect(instructionRuleContext({ ...d, count: 5 })).toBe(
    instructionRuleContext(d),
  );
  expect(instructionRuleContext({ ...d, operation: "clean" })).not.toBe(
    instructionRuleContext(d),
  );
});
it.each(["前2条保留口语，后3条改正式些", "不要只处理前3条，处理全部5条"])(
  "does not treat subgroup or negation as total %s",
  (s) =>
    expect(
      instructionScopeConflict({ ...d, count: 5, instructions: s }),
    ).toBeUndefined(),
);
it.each(["改写前 5 条", "只清洗前一百条", "只处理前5行"])(
  "detects explicit whole scope %s",
  (s) =>
    expect(instructionScopeConflict({ ...d, instructions: s })).toBeTruthy(),
);
it.each(["只改写前5条，不要改变答案和标签。", "只清洗前5条，每条保留原意。"])(
  "retains explicit conflict despite unrelated prohibition %s",
  (s) =>
    expect(instructionScopeConflict({ ...d, instructions: s })).toBeTruthy(),
);
it.each(["其中改写前2条，后3条保持原文", "先改写前2条，再处理其余3条"])(
  "does not mistake internal steps for global scope %s",
  (s) =>
    expect(
      instructionScopeConflict({ ...d, count: 5, instructions: s }),
    ).toBeUndefined(),
);
