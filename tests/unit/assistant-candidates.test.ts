import { describe, expect, it } from "vitest";
import {
  selectCandidateRun,
  selectCandidateCollection,
  scopeCandidateRun,
  carryCandidateScope,
} from "../../src/assistant/candidates.js";
import type { readProcessingRun } from "../../src/processing/store.js";

type Run = Awaited<ReturnType<typeof readProcessingRun>>;
const records = Array.from({ length: 6 }, (_, index) => ({
  id: `0:${index}`,
  candidateOrigin: { runId: "fixed-run", resultId: `0:${index}` },
  original: undefined,
  result: {
    sourceId: `source:${index}`,
    question: `问题${index}`,
    expectedOutput: "原标签",
    metadata: [{ key: "risk", value: index < 4 ? "甲" : "乙" }],
  },
}));
const data = {
  run: { id: "fixed-run", status: "succeeded" },
  records,
  total: 6,
  allIds: records.map((row) => row.id),
} as unknown as Run;
describe("fixed classified candidate selection", () => {
  it("keeps the selected adoption identities through refinement and retry", () => {
    const scope = selectCandidateRun(data, {
      selection: {
        method: "all",
        conditions: [
          { field: "metadata", key: "risk", operator: "equals", value: "乙" },
        ],
      },
    });
    const carried = carryCandidateScope(scope, "child", "fixed-run")!;
    const child = {
      ...data,
      run: { ...data.run, id: "child", parentRunId: "fixed-run" },
      records: records.map((row, index) => ({
        ...row,
        id: `1:${index}`,
        result: { ...row.result, question: `修改${index}` },
      })),
    };
    expect(scopeCandidateRun(child, carried).allIds).toEqual(["1:4", "1:5"]);
    expect(carryCandidateScope(carried, "child")).toEqual(carried);
    expect(carryCandidateScope(scope, "supplement", "other")).toEqual(scope);
    expect(() =>
      scopeCandidateRun(
        { ...child, run: { ...child.run, parentRunId: "other" } },
        carried,
      ),
    ).toThrow("assistant_candidate_selection_changed");
    expect(
      scopeCandidateRun(
        {
          ...child,
          records: child.records.slice(0, 5),
          run: { ...child.run, status: "failed" },
        },
        carried,
      ).total,
    ).toBe(1);
    expect(() =>
      scopeCandidateRun(
        { ...child, records: child.records.slice(0, 5) },
        carried,
      ),
    ).toThrow("assistant_candidate_selection_changed");
  });
  it("keeps a deterministic, disjoint subset and reports actual category shortages", () => {
    const configuration = {
      seed: "fixed",
      groups: [
        {
          count: 3,
          conditions: [
            {
              field: "metadata" as const,
              key: "risk",
              operator: "equals" as const,
              value: "甲",
            },
          ],
        },
        { count: 4, conditions: [] },
      ],
    };
    const scope = selectCandidateRun(data, configuration);
    expect(scope).toEqual(selectCandidateRun(data, configuration));
    expect(new Set(scope.resultIds).size).toBe(6);
    expect(scope.groups).toMatchObject([
      { requested: 3, available: 4, selected: 3 },
      { requested: 4, available: 3, selected: 3 },
    ]);
    expect(scope.targetCount).toBe(7);
    expect(scopeCandidateRun(data, scope).records).toEqual(records);
    expect(
      scopeCandidateRun(JSON.parse(JSON.stringify(data)), scope).allIds,
    ).toEqual(data.allIds);
  });
  it("rejects changed candidate content or a different run before adoption", () => {
    const scope = selectCandidateRun(data, {
      selection: {
        method: "all",
        conditions: [
          { field: "metadata", key: "risk", operator: "equals", value: "乙" },
        ],
      },
    });
    expect(scopeCandidateRun(data, scope).records.map((row) => row.id)).toEqual(
      ["0:4", "0:5"],
    );
    expect(() =>
      scopeCandidateRun({ ...data, records: records.slice(0, 5) }, scope),
    ).toThrow("assistant_candidate_selection_changed");
    expect(() =>
      scopeCandidateRun({ ...data, run: { ...data.run, id: "other" } }, scope),
    ).toThrow("assistant_candidate_selection_changed");
    expect(() =>
      scopeCandidateRun(
        {
          ...data,
          records: records.map((row) => ({
            ...row,
            result: { ...row.result, question: "改变的问题" },
          })),
        },
        scope,
      ),
    ).toThrow("assistant_candidate_selection_changed");
    expect(() =>
      selectCandidateRun(
        { ...data, run: { ...data.run, status: "running" } },
        { selection: { method: "all", conditions: [] } },
      ),
    ).toThrow("processing_still_running");
  });
});

it("replays an already filtered frozen collection without changing seed, IDs or original source count", () => {
  const input = {
    seed: "fixed",
    selection: {
      method: "random",
      mode: "count",
      value: 2,
      conditions: [],
      seed: "fixed",
    },
  };
  const fixed = selectCandidateCollection(data, [data], input);
  const rows = data.records.filter((row) =>
    fixed.members![0].resultIds.includes(row.id),
  );
  const retained = {
    ...data,
    records: rows,
    total: rows.length,
    allIds: rows.map((r) => r.id),
  };
  expect(selectCandidateCollection(retained, [retained], input, fixed)).toBe(
    fixed,
  );
  expect(fixed.sourceCount).toBe(6);
  const changed = {
    ...retained,
    records: rows.map((row) => ({
      ...row,
      result: { ...row.result, question: "unauthorized change" },
    })),
  };
  expect(() =>
    selectCandidateCollection(changed, [changed], input, fixed),
  ).toThrow("assistant_candidate_selection_changed");
});
