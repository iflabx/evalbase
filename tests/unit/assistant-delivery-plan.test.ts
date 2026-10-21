import { describe, expect, it } from "vitest";
import {
  assertDeliveryRepair,
  deliveryGoals,
  generationSteps,
  reviseDeliveryGoals,
  validateRequestedCategories,
} from "../../src/assistant/delivery-plan.js";

const single = (name = "GB A.1.a", count = 5) => ({
  name,
  count,
  countKind: "new" as const,
  instructions: "按已读定义生成语义完整的自然用户问题",
  scenarios: [
    "真实用户提出明确请求",
    "用户说明前置背景后提问",
    "用户带限制条件提出请求",
  ],
  classifications: [
    {
      field: "metadata" as const,
      key: "riskCategory",
      basis: "background" as const,
      allowedValues: [name],
      requiredValues: [name],
      definitions: [{ value: name, reference: "definition:" + name }],
      quotas: [{ value: name, count }],
    },
  ],
});

describe("OPT-35 delivery planning contract", () => {
  it("keeps two independent deliveries, computed total and stable IDs in generation steps", () => {
    const goals = reviseDeliveryGoals(
      [],
      [single(), single("GB A.1.b")],
      "GB A.1.a 和 A.1.b 各一份5条",
    );
    expect(goals).toHaveLength(2);
    expect(new Set(goals.map((goal) => goal.id)).size).toBe(2);
    expect(goals.reduce((sum, goal) => sum + goal.count, 0)).toBe(10);
    const steps = generationSteps(goals);
    expect(steps[0].input).not.toHaveProperty("deliveryId");
    expect(steps[0].input.classifications[0].quotas).toEqual([
      { value: "GB A.1.a", count: 5 },
    ]);
    expect(deliveryGoals({ contractVersion: 1, steps })).toEqual(goals);
    expect(deliveryGoals({ steps })).toEqual([]);
  });

  it("keeps internal intent quotas inside one six-row collection", () => {
    const intent = {
      ...single("客服意图", 6),
      classifications: [
        {
          field: "expectedOutput" as const,
          basis: "background" as const,
          allowedValues: ["退款申请", "物流查询"],
          definitions: [
            { value: "退款申请", reference: "definition:refund" },
            { value: "物流查询", reference: "definition:logistics" },
          ],
          quotas: [
            { value: "退款申请", count: 3 },
            { value: "物流查询", count: 3 },
          ],
        },
      ],
    };
    for (const request of [
      "一份客服意图测试集共6条，退款申请和物流查询各3条",
      "一份 6 条，退款申请和物流查询各 3 条，不用原始数据，先给方案",
    ]) {
      expect(reviseDeliveryGoals([], [intent], request)).toHaveLength(1);
      expect(() =>
        reviseDeliveryGoals(
          [],
          [single("退款申请", 3), single("物流查询", 3)],
          request,
        ),
      ).toThrowError(
        expect.objectContaining({ hint: expect.stringMatching(/份数/) }),
      );
      expect(() =>
        reviseDeliveryGoals([], [single("客服意图", 5)], request),
      ).toThrow();
    }
    expect(() =>
      reviseDeliveryGoals([], [single()], "GB A.1.a 和 A.1.b 各一份5条"),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/分别交付/) }),
    );
    expect(
      reviseDeliveryGoals(
        [],
        [single(), single("GB A.1.b")],
        "为 A.1.a 和 A.1.b 各建一份 5 条测试集，先给方案",
      ),
    ).toHaveLength(2);
    // A compact plural clause fixes the number of collections, not their allocation.
    expect(
      reviseDeliveryGoals(
        [],
        [single("退款申请", 2), single("物流查询", 4)],
        "两份 6 条",
      ),
    ).toHaveLength(2);
    expect(() => reviseDeliveryGoals([], [intent], "两份 6 条")).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/份数/) }),
    );
  });

  it("preserves omitted goals and fields, uses IDs for updates, and only removes an explicitly cancelled named goal", () => {
    const goals = reviseDeliveryGoals(
      [],
      [single(), single("GB A.1.b")],
      "两份各5条",
    );
    const changed = reviseDeliveryGoals(
      goals,
      [{ id: goals[0].id, instructions: "改为完整自然用户问法" }],
      "第一份改为完整自然用户问法",
    );
    expect(changed[0]).toEqual({
      ...goals[0],
      instructions: "改为完整自然用户问法",
    });
    expect(changed[1]).toEqual(goals[1]);
    expect(goals[0].instructions).toBe(single().instructions);
    expect(() =>
      reviseDeliveryGoals(goals, [{ id: "missing", count: 3 }], "改为各3条"),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/引用/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ name: goals[0].name, count: 3 }],
        "改为各3条",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/真实引用/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ id: goals[0].id, remove: true }],
        "不要删除GB A.1.a",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/没有明确取消/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ id: goals[0].id, remove: true }],
        "删除第二份",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/没有明确取消/) }),
    );
    expect(
      reviseDeliveryGoals(
        goals,
        [{ id: goals[0].id, remove: true }],
        "取消GB A.1.a",
      ),
    ).toEqual([goals[1]]);
  });

  it("updates clear per-delivery and overall counts without losing class definitions", () => {
    const goals = reviseDeliveryGoals(
      [],
      [single(), single("GB A.1.b")],
      "两份各5条",
    );
    for (const request of ["改为各3条", "总共6条"]) {
      const changed = reviseDeliveryGoals(goals, undefined, request);
      expect(changed.map((goal) => goal.count)).toEqual([3, 3]);
      expect(
        changed.map((goal) => goal.classifications[0].quotas?.[0].count),
      ).toEqual([3, 3]);
      expect(changed[0].classifications[0].definitions).toEqual(
        goals[0].classifications[0].definitions,
      );
      expect(changed.map((goal) => goal.id)).toEqual(
        goals.map((goal) => goal.id),
      );
    }
    expect(() => reviseDeliveryGoals(goals, undefined, "总共7条")).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/平均分配/) }),
    );
    expect(() =>
      reviseDeliveryGoals(goals, [{ id: goals[0].id, count: 2 }], "改为各3条"),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/明确/) }),
    );
    const one = reviseDeliveryGoals(
      [],
      [{ ...single("普通文档", 5), classifications: [] }],
      "一份测试集共5条",
    );
    expect(reviseDeliveryGoals(one, undefined, "总共6条")[0].count).toBe(6);
    const multi = {
      ...single("意图", 6),
      classifications: [
        {
          field: "expectedOutput" as const,
          allowedValues: ["A", "B"],
          quotas: [
            { value: "A", count: 3 },
            { value: "B", count: 3 },
          ],
        },
      ],
    };
    const saved = reviseDeliveryGoals([], [multi], "一份测试集共6条");
    expect(() => reviseDeliveryGoals(saved, undefined, "总共4条")).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/类别分配/) }),
    );
    const unequal = reviseDeliveryGoals(
      [],
      [single("第一份", 5), single("第二份", 10)],
      "创建两份测试集",
    );
    expect(() =>
      reviseDeliveryGoals(unequal, undefined, "总共6条"),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/数量不同/) }),
    );
    expect(
      reviseDeliveryGoals(unequal, undefined, "改为各3条").map(
        (goal) => goal.count,
      ),
    ).toEqual([3, 3]);
    expect(
      reviseDeliveryGoals(one, undefined, "目标数量改为6条")[0].count,
    ).toBe(6);
    expect(reviseDeliveryGoals(one, undefined, "最终总数6条")[0]).toMatchObject(
      { count: 6, countKind: "final" },
    );
    expect(() =>
      reviseDeliveryGoals(goals, undefined, "目标数量改为6条"),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/指向不明确/) }),
    );
  });

  it("does not mistake a negated or explanatory count for a user update", () => {
    const goals = reviseDeliveryGoals(
      [],
      [single(), single("GB A.1.b")],
      "两份各5条",
    );
    expect(reviseDeliveryGoals(goals, undefined, "不要改为各3条")).toEqual(
      goals,
    );
    expect(
      reviseDeliveryGoals(goals, undefined, "解释一下总共6条是什么意思"),
    ).toEqual(goals);
    expect(reviseDeliveryGoals(goals, undefined, "输入记录总共6条")).toEqual(
      goals,
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ id: goals[0].id, count: 3 }],
        "每条问题不少于3条信息",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/没有明确改变/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ id: goals[0].id, count: 3 }],
        "不要改为各3条",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/没有明确改变/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ id: goals[0].id, countKind: "final" }],
        "继续规划",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/数量的含义/) }),
    );
  });

  it("preserves omitted rule properties and requires user intent to revoke a saved constraint", () => {
    const goals = reviseDeliveryGoals([], [single()], "创建测试集");
    const id = goals[0].id;
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [{ id, classifications: [] }],
        "继续规划，修正参数",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/不能清空/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [
          {
            id,
            classifications: [
              { field: "metadata", key: "riskCategory", definitions: [] },
            ],
          },
        ],
        "修正参数",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/未更改/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        goals,
        [
          {
            id,
            classifications: [
              { field: "metadata", key: "riskCategory", allowedValues: [] },
            ],
          },
        ],
        "不要清空Metadata",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/未更改/) }),
    );
    const changed = reviseDeliveryGoals(
      goals,
      [
        {
          id,
          count: 3,
          classifications: [
            {
              field: "metadata",
              key: "riskCategory",
              quotas: [{ value: "GB A.1.a", count: 3 }],
            },
          ],
        },
      ],
      "改为各3条",
    );
    expect(changed[0].classifications[0]).toEqual({
      ...goals[0].classifications[0],
      quotas: [{ value: "GB A.1.a", count: 3 }],
    });
    expect(
      reviseDeliveryGoals(
        goals,
        [
          {
            id,
            classifications: [
              { field: "metadata", key: "riskCategory", clear: true },
            ],
          },
        ],
        "取消Metadata riskCategory分类约束",
      )[0].classifications,
    ).toEqual([]);
  });

  it("refuses invalid counts, empty contracts, duplicate scenarios and quota conflicts", () => {
    for (const count of [0, -1, 1.5, 10001])
      expect(() =>
        reviseDeliveryGoals([], [single("A", count)], "创建测试集"),
      ).toThrow();
    expect(() => reviseDeliveryGoals([], [], "创建测试集")).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/不能为空/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        [],
        [{ ...single(), scenarios: ["相同场景", "相同场景", "其他场景"] }],
        "创建测试集",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/不能重复/) }),
    );
    expect(() =>
      reviseDeliveryGoals(
        [],
        [single("A", 6000), single("B", 6000)],
        "创建测试集",
      ),
    ).toThrowError(
      expect.objectContaining({ hint: expect.stringMatching(/10000/) }),
    );
  });

  it("allows correcting an unknown field but rejects weakening an unsuccessful delivery proposal", () => {
    const original = {
      deliveries: [single(), single("GB A.1.b")],
      unknownField: "not authoritative",
    };
    expect(() =>
      assertDeliveryRepair(original, {
        deliveries: structuredClone(original.deliveries),
      }),
    ).not.toThrow();
    const rejected = (edit: (proposal: any) => void) => {
      const next = structuredClone(original);
      edit(next);
      expect(() => assertDeliveryRepair(original, next)).toThrow();
    };
    rejected((next) => {
      next.deliveries.pop();
    });
    rejected((next) => {
      next.deliveries[0].count = 3;
    });
    rejected((next) => {
      next.deliveries[0].classifications = [];
    });
    rejected((next) => {
      next.deliveries[0].classifications[0].allowedValues = [];
    });
    rejected((next) => {
      next.deliveries[0].classifications[0].definitions = [];
    });
    rejected((next) => {
      next.deliveries[0].classifications[0].quotas[0].count = 3;
    });
    rejected((next) => {
      next.deliveries[0].classifications[0].basis = "user";
    });
    rejected((next) => {
      next.deliveries[0].remove = true;
    });
    const moved = structuredClone(original);
    moved.deliveries[0].classifications[0].definitions[0] = {
      value: "GB A.1.a",
      text: "已读文档中真实定义",
    } as any;
    expect(() => assertDeliveryRepair(original, moved)).not.toThrow();
  });

  it("OPT37 relocates intact rejected enums for explicit prose without weakening Metadata or category constraints", () => {
    const request =
      "为 A.1.a 和 A.1.b 各建一份 5 条测试集，问题自然完整，期望输出写具体安全行为，不用原始数据，先给方案";
    const original = {
      deliveries: [single(), single("GB A.1.b")].map((goal) => ({
        ...goal,
        classifications: [
          {
            ...goal.classifications[0],
            field: "expectedOutput",
            key: undefined,
          },
          {
            field: "metadata",
            key: "sourceType",
            basis: "user",
            allowedValues: ["安全测试"],
            definitions: [{ value: "安全测试", text: "保留用户指定资料类型" }],
            quotas: [{ value: "安全测试", count: 5 }],
          },
        ],
      })),
    };
    const repaired = structuredClone(original);
    for (const goal of repaired.deliveries) {
      goal.classifications[0].field = "metadata";
      goal.classifications[0].key = "riskCategory";
    }
    expect(() =>
      assertDeliveryRepair(original, repaired, request),
    ).not.toThrow();
    for (const text of ["修正方案", "期望输出填写风险分类标签"]) {
      expect(() => assertDeliveryRepair(original, repaired, text)).toThrow();
    }
    for (const edit of [
      (next: any) => {
        next.deliveries[0].classifications[0].allowedValues = ["GB A.1.c"];
      },
      (next: any) => {
        next.deliveries[0].classifications[0].definitions = [];
      },
      (next: any) => {
        next.deliveries[0].classifications[0].quotas[0].count = 3;
      },
      (next: any) => {
        next.deliveries[0].classifications[0].clear = true;
      },
      (next: any) => {
        next.deliveries[0].classifications[0].key = " ";
      },
      (next: any) => {
        next.deliveries[0].classifications.push({
          ...next.deliveries[0].classifications[0],
          key: "anotherCategory",
        });
      },
      (next: any) => {
        next.deliveries[0].classifications.pop();
      },
      (next: any) => {
        next.deliveries[0].classifications.push({
          ...original.deliveries[0].classifications[0],
          allowedValues: [],
        });
      },
    ]) {
      const changed = structuredClone(repaired);
      edit(changed);
      expect(() => assertDeliveryRepair(original, changed, request)).toThrow();
    }
  });

  it("permits only server-rejected output enum relocation and its standalone label directive", () => {
    const original: any = {
      deliveries: [single()],
      requirements: ["问题完整自然", "期望输出标签固定为 GB A.1.a。"],
    };
    original.deliveries[0].classifications[0].field = "expectedOutput";
    delete original.deliveries[0].classifications[0].key;
    const repaired = structuredClone(original);
    repaired.deliveries[0].classifications[0].field = "metadata";
    repaired.deliveries[0].classifications[0].key = "riskCategory";
    repaired.requirements = ["问题完整自然", "每条 Metadata 中记录所属类别"];
    const prompt = "好的，生成这一类相关的5条测试数据，先给方案，不要执行。";
    expect(() =>
      assertDeliveryRepair(original, repaired, prompt, true),
    ).not.toThrow();
    expect(() => assertDeliveryRepair(original, repaired, prompt)).toThrow();
    expect(() =>
      assertDeliveryRepair(
        original,
        repaired,
        "期望输出填写风险分类标签",
        true,
      ),
    ).toThrow();
    const altered = structuredClone(repaired);
    altered.deliveries[0].classifications[0].quotas[0].count = 3;
    expect(() =>
      assertDeliveryRepair(original, altered, prompt, true),
    ).toThrow();
    for (const requirement of [
      "问题完整自然",
      "期望输出标签固定为 GB A.1.a，并且不得包含个人信息。",
      "期望输出标签固定为 未知类别。",
    ]) {
      const protectedInput = { ...original, requirements: [requirement] };
      const removing = { ...repaired, requirements: [] };
      expect(() =>
        assertDeliveryRepair(protectedInput, removing, prompt, true),
      ).toThrow();
    }
  });

  it("OPT38 relocates a rejected enum directive without retaining contradictory output requirements", () => {
    const original: any = {
      deliveries: [single()],
      requirements: [
        "问题完整自然",
        "期望输出固定为 GB A.1.a，作为该测试集的分类标签。",
      ],
    };
    original.deliveries[0].classifications[0].field = "expectedOutput";
    delete original.deliveries[0].classifications[0].key;
    const repaired = structuredClone(original);
    repaired.deliveries[0].classifications[0].field = "metadata";
    repaired.deliveries[0].classifications[0].key = "riskCategory";
    repaired.requirements = ["问题完整自然", "每条Metadata记录所属类别"];
    const withAnnotation = {
      ...original,
      requirements: ["共生成5条测试数据，全部标记为 GB A.1.a。"],
    };
    const movedAnnotation = {
      ...repaired,
      requirements: [
        "共生成5条测试数据，全部在Metadata的riskCategory中标记为 GB A.1.a。",
      ],
    };
    expect(() =>
      assertDeliveryRepair(
        {
          ...withAnnotation,
          requirements: [...withAnnotation.requirements, "保留 TokenABC"],
        },
        {
          ...movedAnnotation,
          requirements: [...movedAnnotation.requirements, "保留 tokenabc"],
        },
        "先给方案不执行",
        true,
      ),
    ).toThrow();
    expect(() =>
      assertDeliveryRepair(
        withAnnotation,
        movedAnnotation,
        "先给方案不执行",
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertDeliveryRepair(
        {
          ...withAnnotation,
          requirements: [
            "共生成5条测试数据，全部标记为 GB A.1.a，不能包含个人信息。",
          ],
        },
        movedAnnotation,
        "先给方案不执行",
        true,
      ),
    ).toThrow();
    expect(() =>
      assertDeliveryRepair(original, repaired, "先给方案不执行", true),
    ).not.toThrow();
    expect(() =>
      assertDeliveryRepair(
        original,
        { ...repaired, requirements: original.requirements },
        "先给方案不执行",
        true,
      ),
    ).toThrow();
    for (const retained of [
      "期望输出固定为 GB A.1.a，作为该测试集的分类标签",
      "期望输出 固定为  GB A.1.a。",
    ]) {
      expect(() =>
        assertDeliveryRepair(
          original,
          { ...repaired, requirements: ["问题完整自然", retained] },
          "先给方案不执行",
          true,
        ),
      ).toThrow();
    }
    expect(() =>
      assertDeliveryRepair(
        {
          ...original,
          requirements: [
            "期望输出固定为 GB A.1.a，作为该测试集的分类标签，并且不得包含个人信息。",
          ],
        },
        repaired,
        "先给方案不执行",
        true,
      ),
    ).toThrow();
  });

  it("OPT38 preserves exact business literals during field-location repair", () => {
    for (const [original, next] of [
      ["保留字符串 TokenABC", "保留字符串 tokenabc"],
      ["接口路径必须为 /API/Refund", "接口路径必须为 /api/refund"],
      ["保留 AB C", "保留 ABC"],
      ['保留引号 "X"', "保留引号 X"],
    ]) {
      expect(() =>
        assertDeliveryRepair(
          { requirements: [original] },
          { requirements: [next] },
          "先给方案",
          false,
        ),
      ).toThrow();
    }
  });

  it("keeps semantic requirements and field protection during parameter repair", () => {
    const original = {
      deliveries: [single()],
      requirements: ["问题完整自然", "不编造事实"],
      allowedFields: ["question"],
      metadataKeys: ["intent"],
      unknown: "ignored",
    };
    expect(() =>
      assertDeliveryRepair(original, structuredClone(original)),
    ).not.toThrow();
    for (const edit of [
      (next: any) => {
        next.requirements = ["问题完整自然"];
      },
      (next: any) => {
        next.allowedFields.push("expectedOutput");
      },
      (next: any) => {
        delete next.allowedFields;
      },
      (next: any) => {
        next.metadataKeys.push("risk");
      },
      (next: any) => {
        delete next.metadataKeys;
      },
    ]) {
      const next = structuredClone(original);
      edit(next);
      expect(() => assertDeliveryRepair(original, next)).toThrow();
    }
    expect(() =>
      assertDeliveryRepair(
        { ...original, allowedFields: ["unknown"] },
        { ...original, allowedFields: [] },
      ),
    ).not.toThrow();
  });

  it("authorizes changes only for the named Metadata key and honors explicit preservation", () => {
    const saved = reviseDeliveryGoals(
      [],
      [
        {
          ...single(),
          classifications: [
            { ...single().classifications[0], key: "intent" },
            { ...single().classifications[0], key: "riskCategory" },
            {
              ...single().classifications[0],
              field: "expectedOutput",
              key: undefined,
            },
          ],
        },
      ],
      "创建测试集",
    );
    const clearRisk = [
      {
        id: saved[0].id,
        classifications: [
          { field: "metadata" as const, key: "riskCategory", clear: true },
        ],
      },
    ];
    expect(() =>
      reviseDeliveryGoals(saved, clearRisk, "取消Metadata intent分类"),
    ).toThrow();
    const clearIntent = [
      {
        id: saved[0].id,
        classifications: [
          { field: "metadata" as const, key: "intent", clear: true },
        ],
      },
    ];
    expect(() =>
      reviseDeliveryGoals(
        saved,
        clearIntent,
        "期望输出改为自然语言并保留Metadata intent原分类",
      ),
    ).toThrow();
    expect(
      reviseDeliveryGoals(
        saved,
        clearIntent,
        "取消Metadata intent分类",
      )[0].classifications.some((rule) => rule.key === "riskCategory"),
    ).toBe(true);
    expect(
      reviseDeliveryGoals(
        saved,
        clearRisk,
        "取消全部Metadata分类",
      )[0].classifications.some((rule) => rule.key === "intent"),
    ).toBe(true);
  });

  it("does not silently change definitions or references of an existing category", () => {
    const userRule = {
      ...single().classifications[0],
      basis: "user" as const,
      definitions: [{ value: "GB A.1.a", text: "请求退款" }],
    };
    const saved = reviseDeliveryGoals(
      [],
      [{ ...single(), classifications: [userRule] }],
      "创建测试集",
    );
    expect(() =>
      reviseDeliveryGoals(
        saved,
        [
          {
            id: saved[0].id,
            classifications: [
              {
                field: "metadata",
                key: "riskCategory",
                definitions: [{ value: "GB A.1.a", text: "不得退款" }],
              },
            ],
          },
        ],
        "继续规划",
      ),
    ).toThrow();
    const background = reviseDeliveryGoals([], [single()], "创建测试集");
    expect(() =>
      reviseDeliveryGoals(
        background,
        [
          {
            id: background[0].id,
            classifications: [
              {
                field: "metadata",
                key: "riskCategory",
                definitions: [
                  { value: "GB A.1.a", reference: "definition:other" },
                ],
              },
            ],
          },
        ],
        "修正参数",
      ),
    ).toThrow();
  });

  it("repairs an incorrect model quantity to the explicit user goal without weakening valid goals", () => {
    const original = { deliveries: [single("客服", 5)] };
    const repaired = { deliveries: [single("客服", 3)] };
    // SDK normalization may retain five; the business validator still rejects that quantity.
    expect(() =>
      assertDeliveryRepair(
        { ...original, instruction: "字段拼写待修复" },
        original,
        "一份测试集共3条",
      ),
    ).not.toThrow();
    expect(() =>
      reviseDeliveryGoals([], original.deliveries, "一份测试集共3条"),
    ).toThrow();
    expect(() =>
      assertDeliveryRepair(
        original,
        { deliveries: [single("客服", 4)] },
        "一份测试集共3条",
      ),
    ).toThrow();
    expect(() =>
      assertDeliveryRepair(original, repaired, "一份测试集共3条"),
    ).not.toThrow();
    expect(() =>
      assertDeliveryRepair(original, repaired, "修正参数"),
    ).toThrow();
    expect(() =>
      assertDeliveryRepair(
        original,
        { deliveries: [single("客服", 6)] },
        "一份测试集共3条",
      ),
    ).toThrow();
    expect(() =>
      assertDeliveryRepair(
        { deliveries: [single("客服", 3)] },
        original,
        "一份测试集共3条",
      ),
    ).toThrow();
  });

  it("requires explicitly requested catalog categories and exact quotas but permits ordinary documents", () => {
    const request = "一份客服意图测试集共6条，退款申请和物流查询各3条";
    const catalog = [
      { value: "退款申请", aliases: ["退款"] },
      { value: "物流查询", aliases: ["查物流"] },
    ];
    const empty = reviseDeliveryGoals(
      [],
      [{ ...single("客服", 6), classifications: [] }],
      request,
    );
    expect(() =>
      validateRequestedCategories(empty, request, catalog),
    ).toThrow();
    const goals = reviseDeliveryGoals(
      [],
      [
        {
          ...single("客服", 6),
          classifications: [
            {
              field: "expectedOutput",
              allowedValues: ["退款申请", "物流查询"],
              requiredValues: ["退款申请", "物流查询"],
              quotas: [
                { value: "退款申请", count: 3 },
                { value: "物流查询", count: 3 },
              ],
            },
          ],
        },
      ],
      request,
    );
    expect(() =>
      validateRequestedCategories(goals, request, catalog),
    ).not.toThrow();
    const incomplete = structuredClone(goals);
    incomplete[0].classifications[0].quotas = [
      { value: "退款申请", count: 2 },
      { value: "物流查询", count: 4 },
    ];
    expect(() =>
      validateRequestedCategories(incomplete, request, catalog),
    ).toThrow();
    expect(() =>
      validateRequestedCategories(empty, "按普通文档写六条问题", []),
    ).not.toThrow();
  });
  it.each([
    "查物流和改地址，各做2条，先别执行。",
    "查物流和改地址各2条",
    "查物流和改地址，各2条",
    "查物流和改地址，各做2条，先不要执行。",
  ])(
    "rejects omitted requested categories in ordinary wording: %s",
    (request) => {
      const goals: any = [
        {
          id: "a",
          name: "查物流测试集",
          count: 2,
          classifications: [
            {
              field: "metadata",
              key: "业务场景",
              allowedValues: ["查物流"],
              quotas: [{ value: "查物流", count: 2 }],
            },
          ],
        },
      ];
      expect(() =>
        validateRequestedCategories(goals, request, [
          { value: "查物流" },
          { value: "改地址" },
        ]),
      ).toThrow();
    },
  );
  it("rejects stale delivery topics and per-topic quantities on an amendment", () => {
    const goals: any = [
      {
        id: "a",
        name: "查物流测试集",
        count: 3,
        classifications: [
          {
            field: "metadata",
            key: "业务场景",
            allowedValues: ["查物流"],
            quotas: [{ value: "查物流", count: 3 }],
          },
        ],
      },
      {
        id: "b",
        name: "改地址测试集",
        count: 2,
        classifications: [
          {
            field: "metadata",
            key: "业务场景",
            allowedValues: ["改地址"],
            quotas: [{ value: "改地址", count: 2 }],
          },
        ],
      },
    ];
    const catalog = [
      { value: "查物流" },
      { value: "改地址" },
      { value: "退款进度" },
    ];
    expect(() =>
      validateRequestedCategories(
        goals,
        "算了，查物流还是2条，改地址只要1条。",
        catalog,
      ),
    ).toThrow();
    expect(() =>
      validateRequestedCategories(
        goals,
        "改地址不要了，换成退款进度。",
        catalog,
      ),
    ).toThrow();
    for (const request of [
      "把改地址换成退款进度，先不执行",
      "先解释原因，然后把改地址换成退款进度，先不执行",
    ])
      expect(() =>
        validateRequestedCategories(goals, request, catalog),
      ).toThrow();
    expect(() =>
      validateRequestedCategories(goals, "不要把改地址换成退款进度", catalog),
    ).not.toThrow();
    const corrected = structuredClone(goals);
    corrected[0].count = 2;
    corrected[0].classifications[0].quotas[0].count = 2;
    corrected[1].count = 1;
    corrected[1].classifications[0].quotas[0].count = 1;
    expect(() =>
      validateRequestedCategories(
        corrected,
        "算了，查物流还是2条，改地址只要1条。",
        catalog,
      ),
    ).not.toThrow();
    expect(() =>
      validateRequestedCategories(
        goals,
        "不要改地址，解释退款进度是什么",
        catalog,
      ),
    ).not.toThrow();
  });
});
