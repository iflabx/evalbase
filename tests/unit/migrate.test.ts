import { describe, expect, it } from "vitest";

import { repairedDraftRevision } from "../../src/db/migrate.js";

const operation = {
  id: "op_1",
  draft_id: "draft_1",
  operation: "update",
  case_id: "case_1",
  input: { message: "hi" },
  expected_output: null,
  metadata: {},
  reason: "clear",
  previous_content: { expected_output: "gold" },
  diff: { expected_output: { before: "gold", after: null } },
  created_by: "owner",
  created_at: "2026-08-21T00:00:00.000Z",
};

const baseRevision = {
  recipe: { filter: { field: "category", operator: "eq", value: "billing" } },
  sources: [{ asset_id: "asset_1" }],
  schema_revision_id: "schema_1",
  base_version_id: "version_1",
  version_description: "legacy",
};

describe("legacy draft revision migration", () => {
  it("clears operations from historical revisions and rehashes them", () => {
    const repaired = repairedDraftRevision(
      {
        ...baseRevision,
        revision: 2,
        current_revision: 3,
        revision_hash:
          "aca2dc8a0216557954a6365e10d046a481349fae92d3ab0c4d151a75a6a36727",
      },
      [operation],
    );

    expect(repaired).toEqual({
      operations: [],
      revisionHash:
        "82469ee8347017839f1bfbccf8322234147fcdfc1424472cab2a8c08cf02c39d",
    });
  });

  it("retains current draft operations and rehashes them", () => {
    const repaired = repairedDraftRevision(
      {
        ...baseRevision,
        revision: 3,
        current_revision: 3,
        revision_hash:
          "91ed81ee9fe12c011f1d8101ac695e24648dba1ec163ecd7af4657d817fd888e",
      },
      [operation],
    );

    expect(repaired).toEqual({
      operations: [operation],
      revisionHash:
        "38bcc27f310965b4ff34059d04839bcb02b0263698fcd1e9f0fc99a02a9118e3",
    });
  });

  it("recognizes pre-multi-asset revision hashes", () => {
    const repaired = repairedDraftRevision(
      {
        recipe: {
          steps: [
            {
              kind: "filter",
              filter: { field: "/kind", value: "fixture", operator: "eq" },
            },
            { kind: "sample", mode: "count", seed: "fixture", value: 0 },
            { kind: "manual", exclude: [], include: [] },
          ],
        },
        sources: null,
        schema_revision_id: null,
        base_version_id: null,
        version_description: "Keep this synthetic fixture.",
        revision: 2,
        current_revision: 3,
        revision_hash:
          "794e65f0e6bb2562377fbd628c6c8ce5d959a66b1b4516cb0efcf5cc299079df",
      },
      [],
    );

    expect(repaired).toEqual({
      operations: [],
      revisionHash:
        "63f4c27fb2aa8bdca1b5e5f1eaf0155673aaf53e1b860493daadcc7e04cf476c",
    });
  });
});
