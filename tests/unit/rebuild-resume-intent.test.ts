import { describe, expect, it } from "vitest";
import { explicitResumeRequest } from "../../src/assistant-rebuild/control-intent.js";

describe("continuation authorization", () => {
  it.each([
    "继续",
    "请现在继续，并让我确认保存“客服整理版补验”。",
    "先把保存名称改为“客服整理版”，然后继续。",
    "继续保存已经完成的结果。",
    "继续，完成后保存成“客服整理版”。",
    "请继续执行原任务",
  ])("accepts explicit imperative %s", (text) => {
    expect(explicitResumeRequest(text)).toBe(true);
  });
  it.each([
    "现在做到哪了？",
    "继续处理“另一份.csv”",
    "继续处理“前3条”",
    "继续保存“另一个草稿”。",
    "继续处理前3条",
    "继续执行之前先让我确认。",
    "继续保存，先给我解释一下。",
    "只改名，先不要继续",
    "继续是什么意思",
    "继续执行是什么意思",
    "继续保存可以吗",
    "如果继续，是否会重复保存",
    "“继续”只是示例，不执行",
    "先改名为继续",
    "继续，只查询进度，暂不执行处理",
    "继续，先只改保存名称，暂不处理。",
    "继续，我们讨论一下保存名称",
    "继续，先给我看看处理结果",
  ])("does not infer authority from %s", (text) => {
    expect(explicitResumeRequest(text)).toBe(false);
  });
});
