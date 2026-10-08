import { describe, expect, it } from "vitest";
import {
  taskCompatibilityProblem,
  scopeRunToTask,
} from "../../src/assistant/review.js";
import { planRequirementsKey } from "../../src/assistant/plan.js";

describe("current task result compatibility", () => {
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
