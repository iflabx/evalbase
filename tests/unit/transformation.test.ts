import { describe, expect, it } from "vitest";

import {
  trace,
  validateTransformationManifest,
  type TransformationValidationReport,
} from "../../src/transformation/index.js";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    operationType: "agent_augmentation",
    lineageLevel: "asset_level",
    purpose: "Expand refund questions",
    tool: {
      name: "dataset-expander",
      version: "0.3.1",
      codeRef: "git:abcdef1",
    },
    model: {
      provider: "synthetic-provider",
      name: "synthetic-model",
      parameters: { temperature: 0.2 },
    },
    prompt: {
      version: "refund-expand-v2",
      sha256: "b".repeat(64),
      immutableRef: { assetId: "asset_prompt", sha256: "b".repeat(64) },
    },
    parameters: {},
    inputs: [
      {
        objectType: "test_set_version",
        id: "version_1",
        sha256: "e".repeat(64),
        scope: { category: "refund" },
      },
    ],
    outputs: [
      {
        assetId: "asset_output",
        sha256: "c".repeat(64),
        recordCount: 2,
      },
    ],
    executedBy: "user_owner",
    startedAt: "2026-08-22T02:10:00.000Z",
    finishedAt: "2026-08-22T02:14:00.000Z",
    ...overrides,
  };
}

function paths(report: TransformationValidationReport) {
  return report.errors.map((error) => error.path);
}

describe("Ticket 10 Transformation Run decision table", () => {
  it("accepts each supported operation when its required evidence is complete", () => {
    const recordEdges = [
      {
        outputOrdinal: 1,
        inputs: [
          {
            objectType: "case_revision",
            id: "revision_1",
            contentHash: "d".repeat(64),
          },
        ],
      },
    ];
    const operations: Record<string, Record<string, unknown>> = {
      import: { recordEdges },
      code_rule: {
        tool: { name: "normalizer", version: "1.0", codeRef: "git:abcdef" },
        recordEdges,
      },
      agent_rewrite: { recordEdges },
      agent_extraction: { recordEdges },
      agent_augmentation: {},
      agent_generation: {},
      manual_revision: {
        manual: {
          before: { input: "old" },
          after: { input: "new" },
          diff: { input: ["old", "new"] },
          reason: "Correct synthetic gold",
        },
        recordEdges,
      },
      unknown_external_tool: {
        tool: {
          name: "external-tool",
          version: "2.0",
          description: "Synthetic external normalizer",
        },
        recordEdges,
      },
    };

    for (const [operationType, overrides] of Object.entries(operations)) {
      const result = validateTransformationManifest(
        manifest({
          operationType,
          lineageLevel: ["agent_augmentation", "agent_generation"].includes(
            operationType,
          )
            ? "asset_level"
            : "record_level",
          outputs: [
            { assetId: "asset_output", sha256: "c".repeat(64), recordCount: 1 },
          ],
          ...overrides,
        }),
      );
      expect(result, operationType).toMatchObject({ valid: true });
    }
  });

  it("accepts only complete manifests for the declared operation and lineage level", () => {
    expect(validateTransformationManifest(manifest()).valid).toBe(true);

    expect(
      validateTransformationManifest(
        manifest({
          operationType: "code_rule",
          lineageLevel: "asset_level",
          recordEdges: [],
        }),
      ).valid,
    ).toBe(false);

    expect(
      validateTransformationManifest(
        manifest({
          operationType: "manual_revision",
          lineageLevel: "record_level",
          recordEdges: [
            {
              outputOrdinal: 1,
              inputs: [{ objectType: "case_revision", id: "revision_1" }],
            },
          ],
        }),
      ).valid,
    ).toBe(false);

    expect(
      validateTransformationManifest(
        manifest({
          operationType: "code_rule",
          lineageLevel: "record_level",
          tool: { name: "normalizer", version: "1.0.0" },
          recordEdges: [
            {
              outputOrdinal: 1,
              inputs: [{ objectType: "source_record", ordinal: 1 }],
            },
          ],
        }),
      ),
    ).toMatchObject({ valid: false });

    expect(
      validateTransformationManifest(
        manifest({
          operationType: "unknown_external_tool",
          lineageLevel: "record_level",
          tool: { name: "unknown", version: "unknown" },
          recordEdges: [
            {
              outputOrdinal: 1,
              inputs: [
                {
                  objectType: "source_record",
                  parsedViewId: "view_1",
                  ordinal: 1,
                },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({ valid: false });
  });

  it("rejects record counts above the non-production capacity before ordinal expansion", () => {
    const result = validateTransformationManifest(
      manifest({
        operationType: "code_rule",
        lineageLevel: "record_level",
        tool: { name: "normalizer", version: "1.0", codeRef: "git:abcdef" },
        outputs: [
          {
            assetId: "asset_output",
            sha256: "c".repeat(64),
            recordCount: 10_001,
          },
        ],
        recordEdges: [
          {
            outputOrdinal: 1,
            inputs: [
              {
                objectType: "case_revision",
                id: "revision_1",
                contentHash: "d".repeat(64),
              },
            ],
          },
        ],
      }),
    );

    expect(result).toMatchObject({ valid: false });
    expect(result.errors.map((error) => error.path)).toContain(
      "/outputs/0/recordCount",
    );
  });

  it("returns only edges whose endpoints are within the three-hop trace", () => {
    const result = trace(
      { type: "case_revision", id: "case_1" },
      [
        { type: "case_revision", id: "case_1" },
        { type: "transformation_run", id: "run_1" },
        { type: "source_record", id: "source_1" },
        { type: "case_revision", id: "unrelated" },
      ],
      [
        { from: "case_revision:case_1", to: "transformation_run:run_1" },
        { from: "transformation_run:run_1", to: "source_record:source_1" },
        { from: "unrelated", to: "case_revision:case_1" },
      ],
    );

    expect(result.edges).toEqual([
      { from: "case_revision:case_1", to: "transformation_run:run_1" },
      { from: "transformation_run:run_1", to: "source_record:source_1" },
    ]);
  });

  it("rejects every missing or forged core manifest field", () => {
    const cases: Array<[string, (value: any) => void, string]> = [
      ["purpose", (value) => delete value.purpose, "/purpose"],
      ["executedBy", (value) => delete value.executedBy, "/executedBy"],
      ["tool-name", (value) => delete value.tool.name, "/tool/name"],
      ["tool-version", (value) => delete value.tool.version, "/tool/version"],
      [
        "code-ref",
        (value) => {
          value.operationType = "code_rule";
          delete value.tool.codeRef;
        },
        "/tool/codeRef",
      ],
      [
        "model-provider",
        (value) => delete value.model.provider,
        "/model/provider",
      ],
      ["model-name", (value) => delete value.model.name, "/model/name"],
      [
        "model-parameters",
        (value) => (value.model.parameters = []),
        "/model/parameters",
      ],
      [
        "prompt-version",
        (value) => delete value.prompt.version,
        "/prompt/version",
      ],
      [
        "prompt-hash",
        (value) => (value.prompt.sha256 = "bad"),
        "/prompt/sha256",
      ],
      [
        "input-hash",
        (value) => delete value.inputs[0].sha256,
        "/inputs/0/sha256",
      ],
      [
        "output-hash",
        (value) => delete value.outputs[0].sha256,
        "/outputs/0/sha256",
      ],
      [
        "output-count",
        (value) => (value.outputs[0].recordCount = 0),
        "/outputs/0/recordCount",
      ],
      ["started-at", (value) => delete value.startedAt, "/startedAt"],
      ["finished-at", (value) => delete value.finishedAt, "/finishedAt"],
      ["record-edge", (value) => (value.recordEdges = []), "/recordEdges"],
      [
        "edge-input",
        (value) => delete value.recordEdges[0].inputs[0].contentHash,
        "/recordEdges/0/inputs/0",
      ],
      ["unknown-purpose", (value) => (value.purpose = " unknown "), "/purpose"],
      [
        "manual-reason",
        (value) => {
          value.operationType = "manual_revision";
          value.manual = {
            before: {},
            after: {},
            diff: {},
            reason: "Synthetic correction",
          };
          delete value.manual.reason;
        },
        "/manual/reason",
      ],
      [
        "manual-before",
        (value) => {
          value.operationType = "manual_revision";
          value.manual = {
            before: {},
            after: {},
            diff: {},
            reason: "Synthetic correction",
          };
          value.manual.before = [];
        },
        "/manual/before",
      ],
      [
        "manual-after",
        (value) => {
          value.operationType = "manual_revision";
          value.manual = {
            before: {},
            after: {},
            diff: {},
            reason: "Synthetic correction",
          };
          value.manual.after = [];
        },
        "/manual/after",
      ],
      [
        "manual-diff",
        (value) => {
          value.operationType = "manual_revision";
          value.manual = {
            before: {},
            after: {},
            diff: {},
            reason: "Synthetic correction",
          };
          value.manual.diff = [];
        },
        "/manual/diff",
      ],
      [
        "unknown-tool-description",
        (value) => {
          value.operationType = "unknown_external_tool";
          value.tool.description = "Synthetic external tool";
          delete value.tool.description;
        },
        "/tool/description",
      ],
      [
        "agent-extraction-model",
        (value) => {
          value.operationType = "agent_extraction";
          delete value.model.provider;
        },
        "/model/provider",
      ],
      [
        "agent-generation-prompt",
        (value) => {
          value.operationType = "agent_generation";
          delete value.prompt.version;
        },
        "/prompt/version",
      ],
    ];

    for (const [name, mutate, path] of cases) {
      const value = manifest({
        operationType: "agent_rewrite",
        lineageLevel: "record_level",
        outputs: [
          { assetId: "asset_output", sha256: "c".repeat(64), recordCount: 1 },
        ],
        recordEdges: [
          {
            outputOrdinal: 1,
            inputs: [
              {
                objectType: "case_revision",
                id: "revision_1",
                contentHash: "d".repeat(64),
              },
            ],
          },
        ],
      });
      mutate(value);
      const result = validateTransformationManifest(value);
      expect(
        result.errors.map((error) => error.path),
        name,
      ).toContain(path);
    }
  });

  it("covers every operation type and its operation-specific core omissions", () => {
    const recordEdges = [
      {
        outputOrdinal: 1,
        inputs: [
          {
            objectType: "case_revision",
            id: "revision_1",
            contentHash: "d".repeat(64),
          },
        ],
      },
    ];
    const manual = {
      before: { input: "old" },
      after: { input: "new" },
      diff: { input: ["old", "new"] },
      reason: "Synthetic correction",
    };
    const complete: Record<string, any> = {
      import: { recordEdges },
      code_rule: {
        tool: { name: "normalizer", version: "1", codeRef: "git:1" },
        recordEdges,
      },
      agent_rewrite: { recordEdges },
      agent_extraction: { recordEdges },
      agent_augmentation: {},
      agent_generation: {},
      manual_revision: { manual, recordEdges },
      unknown_external_tool: {
        tool: { name: "external", version: "1", description: "Synthetic" },
        recordEdges,
      },
    };
    const common: Array<[string, (value: any) => void]> = [
      ["purpose", (value) => delete value.purpose],
      ["executedBy", (value) => delete value.executedBy],
      ["tool.name", (value) => delete value.tool.name],
      ["tool.version", (value) => delete value.tool.version],
      ["parameters", (value) => delete value.parameters],
      ["inputs", (value) => delete value.inputs],
      ["inputs.hash", (value) => delete value.inputs[0].sha256],
      ["outputs", (value) => delete value.outputs],
      ["outputs.hash", (value) => delete value.outputs[0].sha256],
      ["startedAt", (value) => delete value.startedAt],
      ["finishedAt", (value) => delete value.finishedAt],
    ];
    const specific: Record<string, Array<[string, (value: any) => void]>> = {
      import: [["recordEdges", (value) => (value.recordEdges = [])]],
      code_rule: [
        ["tool.codeRef", (value) => delete value.tool.codeRef],
        ["recordEdges", (value) => (value.recordEdges = [])],
      ],
      agent_rewrite: [
        ["model.provider", (value) => delete value.model.provider],
        ["model.parameters", (value) => delete value.model.parameters],
        ["prompt.version", (value) => delete value.prompt.version],
        ["prompt.evidence", (value) => delete value.prompt.immutableRef],
        ["recordEdges", (value) => (value.recordEdges = [])],
      ],
      agent_extraction: [
        ["model.name", (value) => delete value.model.name],
        ["prompt.sha256", (value) => (value.prompt.sha256 = "bad")],
        ["recordEdges", (value) => (value.recordEdges = [])],
      ],
      agent_augmentation: [
        ["model.provider", (value) => delete value.model.provider],
        ["prompt.evidence", (value) => delete value.prompt.immutableRef],
      ],
      agent_generation: [
        ["model.parameters", (value) => delete value.model.parameters],
        ["prompt.sha256", (value) => (value.prompt.sha256 = "bad")],
      ],
      manual_revision: [
        ["manual.reason", (value) => delete value.manual.reason],
        ["manual.before", (value) => delete value.manual.before],
        ["manual.after", (value) => delete value.manual.after],
        ["manual.diff", (value) => delete value.manual.diff],
        ["recordEdges", (value) => (value.recordEdges = [])],
      ],
      unknown_external_tool: [
        ["tool.description", (value) => delete value.tool.description],
        ["recordEdges", (value) => (value.recordEdges = [])],
      ],
    };

    for (const [operationType, overrides] of Object.entries(complete)) {
      for (const [label, mutate] of [...common, ...specific[operationType]]) {
        const value = manifest({
          operationType,
          lineageLevel: ["agent_augmentation", "agent_generation"].includes(
            operationType,
          )
            ? "asset_level"
            : "record_level",
          outputs: [
            { assetId: "asset_output", sha256: "c".repeat(64), recordCount: 1 },
          ],
          ...overrides,
        });
        mutate(value);
        expect(
          validateTransformationManifest(value).valid,
          `${operationType}:${label}`,
        ).toBe(false);
      }
    }
  });

  it("requires complete record edges and full asset-level input scope", () => {
    const recordResult = validateTransformationManifest(
      manifest({
        operationType: "agent_rewrite",
        lineageLevel: "record_level",
        recordEdges: [
          {
            outputOrdinal: 1,
            inputs: [{ objectType: "case_revision" }],
          },
        ],
      }),
    );
    expect(recordResult.valid).toBe(false);
    expect(paths(recordResult)).toContain("/recordEdges/0/inputs/0");

    const assetResult = validateTransformationManifest(
      manifest({
        inputs: [
          {
            objectType: "data_asset",
            id: "asset_input",
            sha256: "f".repeat(64),
            scope: {},
          },
        ],
      }),
    );
    expect(assetResult.valid).toBe(false);
    expect(paths(assetResult)).toContain("/inputs/0/scope");
  });
});
