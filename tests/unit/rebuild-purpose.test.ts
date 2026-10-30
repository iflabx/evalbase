import { describe, expect, it } from "vitest";
import {
  purposeQuantityConflict,
  type Delivery,
} from "../../src/assistant-rebuild/session-contract.js";
describe("delivery purpose quantity", () => {
  const delivery = (purpose: string): Delivery => ({
    id: "d",
    status: "active",
    count: 3,
    saveTarget: { kind: "newDraft", name: "咨询", purpose },
  });
  it.each([
    "预约咨询场景测试数据，2条。",
    "共2条测试数据",
    "生成 2 条",
    "保存2条记录",
  ])("rejects a conflicting whole-delivery clause: %s", (purpose) =>
    expect(purposeQuantityConflict(delivery(purpose))).toBeTruthy(),
  );
  it.each([
    "预约咨询场景测试数据，3条。",
    "覆盖2条业务规则",
    "每类2条",
    "例如生成2条",
    "用于2026年测试",
    "含2条咨询及1条变更",
  ])("preserves other numeric meanings: %s", (purpose) =>
    expect(purposeQuantityConflict(delivery(purpose))).toBeUndefined(),
  );
  it("does not reinterpret cancelled deliveries", () =>
    expect(
      purposeQuantityConflict({ ...delivery("2条"), status: "cancelled" }),
    ).toBeUndefined());
});
