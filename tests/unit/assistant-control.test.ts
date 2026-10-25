import { describe, it, expect } from "vitest";
import { isPauseRequest } from "../../src/shared/assistant-control.js";
describe("standalone pause control", () => {
  it.each(["先停一下。", "暂停", "请暂停当前任务", "先停止吧"])(
    "accepts %s",
    (text) => expect(isPauseRequest(text)).toBe(true),
  );
  it.each([
    "不要暂停",
    "暂停是什么意思？",
    "把‘先停一下’改写得礼貌一点",
    "先停一下，然后生成10条",
    "继续",
  ])("does not reinterpret %s", (text) =>
    expect(isPauseRequest(text)).toBe(false),
  );
});
