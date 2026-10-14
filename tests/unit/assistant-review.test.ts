import { describe, expect, it } from "vitest";
import {
  taskCompatibilityProblem,
  scopeRunToTask,
  effectiveTaskRuns,
} from "../../src/assistant/review.js";
import { planRequirementsKey } from "../../src/assistant/plan.js";
import { requirementSummary } from "../../src/assistant/requirements.js";

describe("current task result compatibility", () => {
  it("OPT-22 reuses background outputs after exact independent requirement reorder but detects real edits", () => {
    const task = {
      requirements: ["保留答案", "保留问题"],
      backgroundEvidence: [
        { documentId: "doc", fragmentIndex: 1, sha256: "hash" },
      ],
    };
    const data: any = {
      run: { source: { kind: "assets", assetIds: ["A"], recordIds: ["A:1"] } },
      backgroundEvidence: task.backgroundEvidence,
      backgroundGoal: {
        requirements: requirementSummary(task),
        classifications: [],
      },
    };
    expect(
      taskCompatibilityProblem(
        { ...task, requirements: [" 保留问题 ", "保留答案", "保留答案"] },
        [data],
      ),
    ).toBeNull();
    expect(
      taskCompatibilityProblem(
        { ...task, requirements: ["改写问题", "保留答案"] },
        [data],
      ),
    ).not.toBeNull();
  });
  it("OPT-10 retains an unfinished run with partially superseded output", () => {
    const source = { kind: "assets", assetIds: ["A"] };
    const row = {
      id: "0:0",
      original: { id: "A:1" },
      result: { sourceId: "A:1" },
    };
    const old: any = {
      run: { id: "old", source, status: "running" },
      records: [row],
      total: 1,
    };
    const newer: any = {
      run: { id: "new", source, status: "succeeded" },
      records: [row],
      total: 1,
    };
    expect(effectiveTaskRuns([old, newer]).map((item) => item.run.id)).toEqual([
      "old",
      "new",
    ]);
    expect(
      effectiveTaskRuns([
        { ...old, run: { ...old.run, status: "succeeded" } },
        newer,
      ]).map((item) => item.run.id),
    ).toEqual(["new"]);
  });
  it("OPT-10 reuses compatible additional evidence but rejects changed definitions or hashes", () => {
    const task = {
      requirements: ["保持原文"],
      backgroundEvidence: [1, 2].map((fragmentIndex) => ({
        documentId: "doc",
        fragmentIndex,
        sha256: "hash",
      })),
    };
    const data: any = {
      run: { source: { kind: "assets", assetIds: ["A"], recordIds: ["A:1"] } },
      backgroundEvidence: task.backgroundEvidence.slice(0, 1),
      backgroundGoal: {
        requirements: requirementSummary(task),
        classifications: [],
      },
    };
    expect(taskCompatibilityProblem(task, [data])).toBeNull();
    const identicalEvidence = {
      ...data,
      backgroundEvidence: task.backgroundEvidence,
    };
    expect(
      taskCompatibilityProblem({ ...task, requirements: ["改为其他规则"] }, [
        identicalEvidence,
      ]),
    ).not.toBeNull();
    expect(
      taskCompatibilityProblem(
        {
          ...task,
          classifications: [
            {
              field: "metadata",
              key: "risk",
              basis: "background",
              allowedValues: ["A.1"],
              definitions: [{ value: "A.1", text: "新定义" }],
            },
          ],
        },
        [identicalEvidence],
      ),
    ).not.toBeNull();
    expect(
      taskCompatibilityProblem({ ...task, requirements: ["改为其他规则"] }, [
        data,
      ]),
    ).not.toBeNull();
    expect(
      taskCompatibilityProblem(task, [
        {
          ...data,
          backgroundEvidence: [
            { ...data.backgroundEvidence[0], sha256: "changed" },
          ],
        },
      ]),
    ).not.toBeNull();
    expect(
      taskCompatibilityProblem(
        { ...task, executionPlan: { needsReview: true } },
        [data],
      ),
    ).not.toBeNull();
  });
  it("OPT-10 replaces overlapping legacy transformations without merging independent augmentation", () => {
    const source = { kind: "assets", assetIds: ["A"] };
    const run = (id: string, start: number, operation = "rewrite") =>
      ({
        run: { id, source, options: { operation } },
        rootOperation: operation,
        records: Array.from({ length: 200 }, (_, i) => ({
          id: `${id}:${i}`,
          original: { id: `A:${start + i}` },
          result: { question: "相同问题", sourceId: `A:${start + i}` },
        })),
      }) as any;
    const second = run("new", 193);
    const task: any = {
      target: source,
      processingScope: {
        source,
        recordIds: second.records.map((r: any) => r.original.id),
        stepId: "s2",
      },
      executionPlan: {
        steps: [1, 2].map((i) => ({
          id: `s${i}`,
          action: "submit_processing",
          input: {
            source,
            operation: "rewrite",
            selection: { method: "random", mode: "count", value: 200 },
          },
          receipt: { runId: i === 1 ? "old" : "new" },
        })),
      },
    };
    task.executionPlan.requirementsKey = planRequirementsKey(task);
    const old = scopeRunToTask(task, run("old", 1));
    expect(old.total).toBe(8);
    const active = effectiveTaskRuns([old, scopeRunToTask(task, second)]);
    expect(active.reduce((sum, r) => sum + r.total, 0)).toBe(200);
    const independent = effectiveTaskRuns([
      second,
      run("augment", 193, "augment"),
    ]);
    expect(independent.reduce((sum, r) => sum + r.total, 0)).toBe(400);
    expect(second.records).toHaveLength(200);
  });
  it("retains each committed batch of a live plan but honors a later standalone selection", () => {
    const task: any = {
      target: { kind: "assets", assetIds: ["A"] },
      processingScope: {
        source: { kind: "assets", assetIds: ["A"] },
        recordIds: ["A:2"],
        stepId: "s2",
      },
      executionPlan: {
        steps: [
          { id: "s1", receipt: { runId: "r1" } },
          { id: "s2", receipt: { runId: "r2" } },
        ],
      },
    };
    task.executionPlan.requirementsKey = planRequirementsKey(task);
    const data = {
      run: {
        id: "r1",
        source: { kind: "assets", assetIds: ["A"], recordIds: ["A:1"] },
      },
      records: [{ id: "row", original: { id: "A:1" }, result: {} }],
    } as any;
    expect(scopeRunToTask(task, data).total).toBe(1);
    expect(taskCompatibilityProblem(task, [data])).toBeNull();
    expect(
      scopeRunToTask(
        {
          ...task,
          processingScope: { ...task.processingScope, stepId: undefined },
        },
        data,
      ).total,
    ).toBe(0);
  });
  it("enforces sub-asset ranges and reuses only the compatible part of a mixed run", () => {
    const task = {
      target: { kind: "assets", assetIds: ["A", "B"] },
      processingScope: {
        source: { kind: "assets", assetIds: ["A", "B"] },
        recordIds: ["A:2", "B:2"],
      },
    };
    expect(
      taskCompatibilityProblem(task, [
        {
          run: {
            source: { kind: "assets", assetIds: ["A"], recordIds: ["A:1"] },
          },
        } as any,
      ]),
    ).not.toBeNull();
    const records = ["A:2", "B:2"].map((id) => ({
      id,
      result: { sourceId: id },
      original: { id },
    }));
    const data = {
      run: { source: { kind: "assets", assetIds: ["A", "B"] } },
      records,
      total: 2,
    } as any;
    const narrowed = { target: { kind: "asset", id: "A" } };
    const scoped = scopeRunToTask(narrowed, data);
    expect(scoped.records.map((row) => row.id)).toEqual(["A:2"]);
    expect(taskCompatibilityProblem(narrowed, [scoped])).toBeNull();
  });
  it("requires the frozen background fragments to match the current basis", () => {
    const task = {
      backgroundEvidence: [
        { documentId: "doc", sha256: "hash", fragmentIndex: 2 },
      ],
    };
    const data = {
      run: { source: { kind: "assets", assetIds: ["A"], recordIds: ["A:1"] } },
      backgroundEvidence: [
        { documentId: "doc", sha256: "hash", fragmentIndex: 1 },
      ],
    };
    expect(taskCompatibilityProblem(task, [data as any])).not.toBeNull();
    expect(
      taskCompatibilityProblem(task, [
        { ...data, backgroundEvidence: task.backgroundEvidence } as any,
      ]),
    ).toBeNull();
    expect(
      taskCompatibilityProblem({ backgroundEvidence: [] }, [data as any]),
    ).not.toBeNull();
  });
  it("rejects old records from the same asset after the fixed input scope narrows", () => {
    const task = {
      target: { kind: "asset", id: "A" },
      processingScope: {
        source: { kind: "assets", assetIds: ["A"] },
        recordIds: ["A:2"],
      },
    };
    const run = {
      source: { kind: "assets", assetIds: ["A"], recordIds: ["A:1"] },
    };
    expect(taskCompatibilityProblem(task, [{ run } as any])).not.toBeNull();
    expect(
      taskCompatibilityProblem(task, [
        {
          run: { ...run, source: { ...run.source, recordIds: ["A:2"] } },
        } as any,
      ]),
    ).toBeNull();
    const oldPlan = {
      steps: [
        {
          action: "submit_processing",
          input: {
            source: { kind: "assets", assetIds: ["A"] },
            recordIds: ["A:1"],
          },
        },
      ],
    };
    const revised = { ...task, executionPlan: oldPlan };
    expect(taskCompatibilityProblem(revised, [{ run } as any])).not.toBeNull();
    const records = ["A:1", "A:2"].map((id) => ({
      id,
      result: { sourceId: id },
      original: { id },
    }));
    expect(
      scopeRunToTask(revised, { run, records } as any).records.map(
        (row) => row.id,
      ),
    ).toEqual(["A:2"]);
  });
});
