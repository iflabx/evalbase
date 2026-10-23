import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import {
  projectQueryConstraints,
  projectQueryFields,
} from "../../src/assistant/query-contract.js";
import { prepareToolProposal } from "../../src/assistant/processing-preparation.js";
import { sourceDiscoveryApplies } from "../../src/assistant/source-discovery.js";

describe("OPT50 query contract and source continuation", () => {
  const validate = new Ajv({ strict: false }).compile({
    type: "object",
    properties: {
      kind: { enum: Object.keys(projectQueryFields) },
      search: { type: "string" },
      offset: { type: "integer" },
      testSetId: { type: "string" },
    },
    required: ["kind"],
    additionalProperties: false,
    ...projectQueryConstraints("query_project"),
  });
  it.each(Object.keys(projectQueryFields))(
    "%s shares kind-specific fields between model schema and preflight",
    (kind) => {
      for (const [field, value] of Object.entries({
        search: "测试",
        offset: 0,
        testSetId: "test-set",
      })) {
        const input = { kind, [field]: value };
        const expected = projectQueryFields[kind]!.includes(field);
        expect(validate(input), kind + "/" + field).toBe(expected);
        const proposal = prepareToolProposal("query_project", input, {
          task: {},
          request: "查询资料",
        });
        expect(proposal.ok, kind + "/" + field).toBe(expected);
      }
    },
  );
  it("continues discovery without prior successful state and retains explicit query intent", () => {
    const task = { goal: "帮我整理一下这些数据" };
    for (const kind of ["project", "files", "drafts", "testSets"]) {
      expect(sourceDiscoveryApplies(task, "继续", { kind })).toBe(true);
      expect(sourceDiscoveryApplies(task, "查看项目概况", { kind })).toBe(
        false,
      );
    }
    expect(sourceDiscoveryApplies({}, "继续", { kind: "project" })).toBe(false);
    expect(
      sourceDiscoveryApplies(task, "查看v2版本", { kind: "versions" }),
    ).toBe(false);
    expect(
      sourceDiscoveryApplies({ goal: "查看项目概况" }, "继续", {
        kind: "project",
      }),
    ).toBe(false);
  });
});
