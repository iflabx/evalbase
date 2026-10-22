import { describe, expect, it } from "vitest";
import {
  documentDefinitionReferences,
  resolveBackgroundDefinitions,
  validateBackgroundRules,
} from "../../src/assistant/background.js";
import { turnNeedsWork } from "../../src/assistant/intent.js";
import { validateRequestedCategories } from "../../src/assistant/delivery-plan.js";

const scope = { projectId: "p", actorId: "u" };
function fixture(text: string) {
  const documents = [
    {
      id: "doc",
      sha256: "hash",
      extractorVersion: "text-v1",
      fragments: [{ index: 1, startLine: 1, endLine: 8, text }],
    },
  ];
  const current: any = {
    goal: "根据文档里的业务分类做2条，先给方案，不要执行。",
    backgroundEvidence: [{ documentId: "doc", fragmentIndex: 1 }],
  };
  return {
    documents,
    current,
    refs: documentDefinitionReferences(
      documents,
      current.backgroundEvidence,
      scope,
      "s",
    ),
  };
}
describe("batch2 ordinary document contracts", () => {
  it("does not expose structural headings or ordinal aliases as new categories", () => {
    const f = fixture("# 背景说明\n# 业务分类\n查物流：用户查询配送进度。");
    expect(f.refs.map((r) => r.value)).toEqual(["查物流"]);
    const numbered = fixture("一、查物流：用户查询配送进度。");
    expect(numbered.refs[0].aliases).toEqual(["查物流"]);
    for (const text of [
      "一、说明\n本节是说明，不是业务类别。\n二、业务分类\n查物流：用户查询配送进度。",
      "一、业务分类：查物流。定义：用户查询配送进度。",
      "一、查物流\n用户查询配送进度。",
      "一、业务分类\n（一）查物流\n用户查询配送进度。",
    ]) {
      const plain = fixture(text);
      expect(plain.refs.map((r) => r.value)).toEqual(["查物流"]);
      expect(plain.refs[0].aliases).toEqual(["查物流"]);
    }
  });
  it("requires discovery facts but accepts a receipt-backed processing wait", () => {
    const query: any = { mode: "query" };
    expect(
      turnNeedsWork(query, {}, [
        { name: "plan_task", status: "succeeded", result: { unchanged: true } },
      ]),
    ).toBe(true);
    expect(
      turnNeedsWork(query, {}, [
        { name: "query_project", status: "succeeded", result: { items: [] } },
      ]),
    ).toBe(false);
    const execute: any = { mode: "execute" };
    expect(
      turnNeedsWork(execute, { runId: "run", stage: "processing" }, [
        {
          name: "read_processing",
          status: "succeeded",
          result: { run: { id: "run", status: "running" } },
        },
      ]),
    ).toBe(false);
    expect(
      turnNeedsWork(execute, { runId: "run", stage: "processing" }, []),
    ).toBe(true);
  });
  it("keeps genuine hierarchical category codes distinct from list ordinals", () => {
    const f = fixture(
      "A.1.a 风险甲：甲类风险定义。\nA.1.b 风险乙：乙类风险定义。",
    );
    expect(f.refs.map((r) => r.value)).toEqual(["A.1.a", "A.1.b"]);
    expect(f.refs.map((r) => r.code)).toEqual(["A.1.a", "A.1.b"]);
  });
  it.each([
    [
      "一、查物流：用户查询订单运输位置。\n二、改地址：用户希望修改收货地址。",
      ["查物流", "改地址"],
    ],
    [
      "分类一：退款进度。用户查询申请是否受理。\n分类二：退款到账时间。用户查询何时到账。",
      ["退款进度", "退款到账时间"],
    ],
    ["业务分类：查物流。定义：用户查询配送进度。", ["查物流"]],
  ])(
    "binds semantic names rather than structural labels: %s",
    (text, names) => {
      const f = fixture(text);
      expect(f.refs.map((r) => r.value)).toEqual(names);
      const classifications = [
        {
          field: "metadata",
          key: "业务场景",
          basis: "background",
          allowedValues: f.refs.map((r) => r.value),
          quotas: f.refs.map((r) => ({ value: r.value, count: 2 })),
          definitions: f.refs.map((r) => ({
            value: r.value,
            reference: r.reference,
          })),
        },
      ];
      const resolved = resolveBackgroundDefinitions(
        f.current,
        { classifications },
        f.documents,
        scope,
        "s",
      );
      expect(() =>
        validateBackgroundRules({ ...f.current, ...resolved }, f.documents),
      ).not.toThrow();
      expect(() =>
        validateRequestedCategories(
          [{ id: "a", classifications: resolved.classifications } as any],
          f.current.goal,
          f.refs,
        ),
      ).not.toThrow();
    },
  );
  it("repairs document-backed Metadata origin without deleting its classification", () => {
    const f = fixture(
      "只包含查物流这一类，指用户查询配送进度。\nMetadata业务场景填写查物流。",
    );
    const patch = {
      classifications: [
        {
          field: "metadata",
          key: "业务场景",
          basis: "user",
          allowedValues: ["查物流"],
          definitions: [
            {
              value: "查物流",
              basis: "user",
              text: "Metadata业务场景填写查物流。",
            },
          ],
        },
      ],
    };
    const resolved = resolveBackgroundDefinitions(
      f.current,
      patch,
      f.documents,
      scope,
      "s",
    );
    expect(resolved.classifications[0].basis).toBe("background");
    expect(() =>
      validateBackgroundRules({ ...f.current, ...resolved }, f.documents),
    ).not.toThrow();
    expect(resolved.classifications[0].allowedValues).toEqual(["查物流"]);
  });
  it("does not promote invented labels or a different category's definition", () => {
    const f = fixture("业务分类：查物流。定义：用户查询配送进度。");
    const patch = {
      classifications: [
        {
          field: "metadata",
          key: "业务场景",
          basis: "user",
          allowedValues: ["退款"],
          definitions: [{ value: "退款", text: "用户查询配送进度。" }],
        },
      ],
    };
    expect(() =>
      validateBackgroundRules(
        {
          ...f.current,
          ...resolveBackgroundDefinitions(
            f.current,
            patch,
            f.documents,
            scope,
            "s",
          ),
        },
        f.documents,
      ),
    ).toThrow();
  });
});
