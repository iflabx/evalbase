import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";

import {
  createLangfuseCsv,
  type PackageItem,
  sha256,
} from "../../src/package/contract.js";
import { validateLangfuseCsv } from "../../src/package/langfuse.js";

const schema = {
  mode: "gold_required" as const,
  input: {
    type: "object" as const,
    properties: { message: { type: "string" as const } },
    required: ["message"],
  },
  expectedOutput: { type: "string" as const },
};

const items: PackageItem[] = [
  {
    case_id: "case_formula",
    input: { message: '=SUM(A1:A2), "quotes", and\nnewline' },
    expected_output: "quoted JSON remains auditable",
    metadata: { owner: "synthetic" },
  },
  {
    case_id: "case_unicode",
    input: { message: "中文" },
    expected_output: "确定性导出",
    metadata: {},
  },
];

describe("Langfuse CSV local public contract", () => {
  it("validates header, row count, JSON cells, Formal Schema, mapping, and formula-cell quoting", () => {
    const csv = createLangfuseCsv("version_fixture", items);
    expect(csv.bytes.toString("utf8").split("\n")[0]).toBe(
      "input,expected_output,metadata",
    );
    expect(csv.bytes.toString("utf8")).toContain('"=SUM(A1:A2)');

    expect(
      validateLangfuseCsv(csv.bytes, {
        schema,
        versionId: "version_fixture",
        expectedItems: items,
      }),
    ).toEqual({
      valid: true,
      rowCount: items.length,
      errors: [],
    });
  });

  it("rejects each single-factor local-contract failure", () => {
    const csv = createLangfuseCsv("version_fixture", items);

    const cases = [
      {
        name: "wrong header",
        bytes: Buffer.from(
          csv.bytes
            .toString("utf8")
            .replace("input,expected_output,metadata", "input,output,metadata"),
        ),
        expected: "csv_header_invalid",
      },
      {
        name: "row count mismatch",
        bytes: Buffer.from(
          `${csv.bytes.toString("utf8")}${
            csv.bytes.toString("utf8").split("\n")[1]
          }\n`,
        ),
        expected: "csv_row_count_mismatch",
      },
      {
        name: "invalid JSON cell",
        bytes: Buffer.from(
          csv.bytes.toString("utf8").replace('""message""', "message"),
        ),
        expected: "csv_json_invalid",
      },
      {
        name: "unquoted formula cell",
        bytes: Buffer.from(
          [
            "input,expected_output,metadata",
            '=SUM(A1:A2),"""quoted""","{""_agentbench"":{""case_id"":""case_formula"",""version_id"":""version_fixture""}}"',
            "",
          ].join("\n"),
        ),
        expected: "csv_quoting_invalid",
      },
      {
        name: "carriage return newline",
        bytes: Buffer.from(csv.bytes.toString("utf8").replaceAll("\n", "\r\n")),
        expected: "csv_syntax_invalid",
      },
      {
        name: "unclosed final quote",
        bytes: Buffer.from(`${csv.bytes.toString("utf8").slice(0, -2)}\n`),
        expected: "csv_syntax_invalid",
      },
      {
        name: "non-canonical JSON cell",
        bytes: Buffer.from(
          [
            "input,expected_output,metadata",
            `"{ ""message"": ""hello"" }","""world""","{""_agentbench"":{""case_id"":""case_fixture"",""version_id"":""version_fixture""}}"`,
            "",
          ].join("\n"),
        ),
        expected: "csv_json_canonical_invalid",
      },
    ];

    for (const testCase of cases) {
      expect(
        validateLangfuseCsv(testCase.bytes, {
          schema,
          versionId: "version_fixture",
          expectedItems: items,
        }).errors,
      ).toContain(testCase.expected);
    }
  });

  it("quotes every spreadsheet formula prefix while preserving JSON semantics", () => {
    const formulaItems: PackageItem[] = [
      "=SUM(A1:A2)",
      "+cmd|' /C calc'!A0",
      "-2+3|cmd",
      "@SUM(A1:A2)",
      "\ttab-formula",
      "\rreturn-formula",
    ].map((message, index) => ({
      case_id: `case_formula_prefix_${index}`,
      input: { message },
      expected_output: `safe output ${index}`,
      metadata: { prefix: index },
    }));
    const csv = createLangfuseCsv("version_fixture", formulaItems);
    const source = csv.bytes.toString("utf8");

    for (const row of source.split("\n").slice(1, -1))
      expect(row.startsWith('"')).toBe(true);
    const rows = parse(source, {
      columns: false,
      quote: '"',
      relax_column_count: false,
    }) as string[][];
    for (const row of rows.slice(1))
      for (const cell of row)
        expect(
          ["=", "+", "-", "@", "\t", "\r"].some((prefix) =>
            cell.startsWith(prefix),
          ),
        ).toBe(false);
    expect(
      validateLangfuseCsv(csv.bytes, {
        schema,
        versionId: "version_fixture",
        expectedItems: formulaItems,
      }),
    ).toEqual({ valid: true, rowCount: 6, errors: [] });
  });

  it("rejects Formal Schema and reserved metadata failures without mutating business data", () => {
    const schemaFailure = validateLangfuseCsv(
      createLangfuseCsv("version_fixture", items).bytes,
      {
        schema: {
          ...schema,
          input: {
            ...schema.input,
            properties: { message: { type: "number" } },
          },
        },
        versionId: "version_fixture",
        expectedItems: items,
      },
    );
    expect(schemaFailure.valid).toBe(false);
    expect(schemaFailure.errors).toContain("formal_schema_invalid");

    const collision = structuredClone(items);
    (collision[0].metadata as Record<string, unknown>)._agentbench = {
      case_id: "business-owned",
    };
    expect(() => createLangfuseCsv("version_fixture", collision)).toThrow(
      /reserved _agentbench/,
    );
  });

  it("preserves input-only semantics in the second Langfuse Golden mode", () => {
    const inputOnlyItems = structuredClone(items);
    inputOnlyItems.forEach((item) => {
      item.expected_output = null;
    });
    const csv = createLangfuseCsv("version_fixture", inputOnlyItems);
    const report = validateLangfuseCsv(csv.bytes, {
      schema: {
        ...schema,
        mode: "input_only",
        expectedOutput: { type: ["string", "null"] },
      },
      versionId: "version_fixture",
      expectedItems: inputOnlyItems,
    });
    expect(report).toEqual({
      valid: true,
      rowCount: 2,
      errors: [],
    });
  });

  it("rejects cells that no longer map to the frozen version items", () => {
    const csv = createLangfuseCsv("version_fixture", items);
    const changed = structuredClone(items);
    changed[0].input = { message: "changed but schema-valid" };
    const report = validateLangfuseCsv(csv.bytes, {
      schema,
      versionId: "version_fixture",
      expectedItems: changed,
    });
    expect(report.valid).toBe(false);
    expect(report.errors).toContain("csv_mapping_invalid");
  });

  it("consumes both independent Langfuse CSV Goldens", async () => {
    const modes = ["gold-required", "input-only"] as const;
    for (const mode of modes) {
      const [bytes, expectedText] = await Promise.all([
        readFile(
          new URL(
            `../fixtures/langfuse-csv-golden/${mode}.csv`,
            import.meta.url,
          ),
        ),
        readFile(
          new URL(
            `../fixtures/langfuse-csv-golden/${mode}-expected.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ]);
      const expected = JSON.parse(expectedText);
      expect(sha256(bytes)).toBe(expected.deliverySha256);
      expect(
        validateLangfuseCsv(bytes, {
          schema: expected.schema,
          versionId: expected.versionId,
          expectedItems: expected.expectedItems,
        }),
      ).toEqual(expected.report);
    }
  });
});
