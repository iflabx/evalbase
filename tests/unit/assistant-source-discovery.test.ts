import { describe, expect, it, vi } from "vitest";
import {
  discoverSources,
  sourceReply,
} from "../../src/assistant/source-discovery.js";

vi.mock("../../src/security/project-access.js", () => ({
  hasProjectCapability: async () => true,
}));
vi.mock("../../src/assistant/store.js", () => ({
  assistantAccess: async () => {},
}));
const items = [
  { kind: "asset", id: "source-A", name: "客服清洗测试.jsonl", count: 2 },
  { kind: "asset", id: "source-B", name: "客户整理数据.jsonl", count: 3 },
];
const sourceA = { kind: "assets", assetIds: ["source-A"] };
const sourceB = { kind: "assets", assetIds: ["source-B"] };
function task() {
  return {
    goal: "帮我清洗这些资料",
    target: sourceA,
    processingClarification: { kind: "source" },
    sourceDiscovery: {
      query: "",
      offset: 0,
      nextOffset: null,
      reads: 1,
      items,
      requestId: "before",
      requestText: "帮我清洗这些资料",
      question: "请选择要处理的资料",
    },
  };
}
function database(catalogue = items) {
  return {
    query: vi.fn(async (_sql: string, params: any[]) => {
      const rows = catalogue
        .filter((i) => !params[6] || params[6].includes(i.id))
        .filter((i) => !params[2] || i.name.includes(params[2]));
      return { rows, rowCount: rows.length };
    }),
  } as any;
}
describe("merge review: source choice authority", () => {
  it.each([
    "不要用第1份，用第2份",
    "不要用客服清洗测试.jsonl",
    "第1份和第2份都要",
    "不选第1份",
    "第1份，不要用第1份",
    "选择第6份",
  ])(
    "does not resolve a negated, compound or unavailable choice: %s",
    async (request) => {
      const current = task();
      expect(sourceReply(current, request)).toBeUndefined();
      const result = await discoverSources(
        database(),
        { projectId: "project", actorId: "actor" },
        {
          task: current,
          request,
          requestId: "now",
          input: { kind: "files", search: "客服清洗测试.jsonl" },
          preferred: sourceA,
        },
      );
      expect(result.resolvedSource).toBeUndefined();
      expect(result.requiresClarification).toBe(true);
      expect(result.items).toHaveLength(2);
      const repeated = await discoverSources(
        database(),
        { projectId: "project", actorId: "actor" },
        {
          task: { ...current, sourceDiscovery: result.state },
          request: "继续",
          requestId: "next",
          input: { kind: "files" },
          preferred: sourceA,
        },
      );
      expect(repeated.resolvedSource).toBeUndefined();
      expect(repeated.requiresClarification).toBe(true);
    },
  );
  it.each([
    "选择第2份",
    "第2份，全部三条，只去掉问题前后的空格",
    "用客户整理数据.jsonl",
  ])(
    "shares an affirmative choice across reply and discovery: %s",
    async (request) => {
      const current = task();
      expect(sourceReply(current, request)).toEqual(sourceB);
      const result = await discoverSources(
        database(),
        { projectId: "project", actorId: "actor" },
        {
          task: current,
          request,
          requestId: "now",
          input: { kind: "files" },
          preferred: sourceA,
        },
      );
      expect(result.resolvedSource).toEqual(sourceB);
      expect(result.question).toBeUndefined();
    },
  );
  it.each([
    "不要用新文件.jsonl",
    "请不要用新文件.jsonl",
    "麻烦你不要使用新文件.jsonl",
  ])(
    "a negative search for an unseen name cannot authorize its single hit: %s",
    async (request) => {
      const current = { ...task(), target: undefined };
      const third = {
        kind: "asset",
        id: "source-C",
        name: "新文件.jsonl",
        count: 2,
      };
      const result = await discoverSources(
        database([...items, third]),
        { projectId: "project", actorId: "actor" },
        {
          task: current,
          request,
          requestId: "new",
          input: { kind: "files", search: "新文件.jsonl" },
        },
      );
      expect(result.resolvedSource).toBeUndefined();
      expect(result.requiresClarification).toBe(true);
      expect(result.items).toHaveLength(3);
    },
  );
  it.each([
    "请用新文件.jsonl，不要用新文件.jsonl",
    "请用新文件.jsonl，请用另新文件.jsonl",
  ])(
    "a searched name cannot discard a conflicting or second unseen reference: %s",
    async (request) => {
      const current = { ...task(), target: undefined };
      const extra = [
        { kind: "asset", id: "source-C", name: "新文件.jsonl", count: 2 },
        { kind: "asset", id: "source-D", name: "另新文件.jsonl", count: 2 },
      ];
      const result = await discoverSources(
        database([...items, ...extra]),
        { projectId: "project", actorId: "actor" },
        {
          task: current,
          request,
          requestId: "new",
          input: { kind: "files", search: "新文件.jsonl" },
        },
      );
      expect(result.resolvedSource).toBeUndefined();
      expect(result.requiresClarification).toBe(true);
    },
  );
  it("a searched positive source clause can carry non-source field requirements", async () => {
    const current = { ...task(), target: undefined };
    const third = {
      kind: "asset",
      id: "source-C",
      name: "新文件.jsonl",
      count: 2,
    };
    const result = await discoverSources(
      database([...items, third]),
      { projectId: "project", actorId: "actor" },
      {
        task: current,
        request: "请用新文件.jsonl，其他不变",
        requestId: "new",
        input: { kind: "files", search: "新文件.jsonl" },
      },
    );
    expect(result.resolvedSource).toEqual({
      kind: "assets",
      assetIds: ["source-C"],
    });
  });
});
