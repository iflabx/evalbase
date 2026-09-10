import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  excludeLocatedFailures,
  parseSourceRecords,
} from "../../src/parser/index.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/parser-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("Format Adapter Source Record contract", () => {
  it.each([
    {
      format: "csv" as const,
      source: "question,answer\nWhy?,Because.\n",
      config: {
        encoding: "utf8" as const,
        delimiter: ",",
        headerRow: 1,
        quote: '"',
      },
      locator: { kind: "csv_row", dataRow: 1, physicalLine: 2 },
    },
    {
      format: "json" as const,
      source: '[{"question":"Why?","answer":"Because."}]',
      config: { recordPath: "" },
      locator: { kind: "json_pointer", pointer: "/0" },
    },
    {
      format: "jsonl" as const,
      source: '{"question":"Why?","answer":"Because."}\n',
      config: {},
      locator: { kind: "jsonl_line", physicalLine: 1 },
    },
  ])(
    "emits the shared envelope for $format",
    async ({ format, source, config, locator }) => {
      const records = [];

      const result = await parseSourceRecords({
        assetId: "asset_fixture",
        parsedViewId: `view_${format}`,
        format,
        parserVersion: "parser-contract-v1",
        config: config as never,
        bytes: Readable.from(Buffer.from(source)),
      });
      records.push(...result.records);

      expect(result.summary).toMatchObject({
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        boundaryTrusted: true,
      });
      expect(records).toEqual([
        expect.objectContaining({
          assetId: "asset_fixture",
          parsedViewId: `view_${format}`,
          ordinal: 1,
          locator,
          fields: { question: "Why?", answer: "Because." },
          recordHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          parseStatus: "valid",
        }),
      ]);
    },
  );

  for (const fixture of contract.cases.filter(
    (item: any) => item.format === "csv",
  )) {
    it(`${fixture.id} follows the versioned CSV contract`, async () => {
      const bytes = fixture.source.base64
        ? Buffer.from(fixture.source.base64, "base64")
        : Buffer.from(fixture.source.utf8);
      const result = await parseSourceRecords({
        assetId: "asset_fixture",
        parsedViewId: "view_fixture",
        format: "csv",
        parserVersion: contract.contractVersion,
        config: fixture.config,
        bytes: Readable.from(bytes),
      });

      expect(result.summary).toMatchObject({
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        boundaryTrusted: true,
        ...(fixture.expected.detectedEncoding
          ? { detectedEncoding: fixture.expected.detectedEncoding }
          : {}),
      });
      expect(result.records[0]).toMatchObject({
        ...(fixture.expected.locator
          ? { locator: fixture.expected.locator }
          : {}),
        fields: fixture.expected.fields,
        recordHash: fixture.expected.recordHash,
        parseStatus: "valid",
      });
    });
  }

  for (const fixture of contract.cases.filter(
    (item: any) => item.format === "json",
  )) {
    it(`${fixture.id} follows the versioned JSON contract`, async () => {
      const result = await parseSourceRecords({
        assetId: "asset_fixture",
        parsedViewId: "view_fixture",
        format: "json",
        parserVersion: contract.contractVersion,
        config: fixture.config,
        bytes: Readable.from(Buffer.from(fixture.source.utf8)),
      });

      expect(result.summary).toMatchObject({
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        boundaryTrusted: true,
      });
      expect(result.records).toEqual([
        expect.objectContaining({
          locator: fixture.expected.locator,
          fields: fixture.expected.fields,
          recordHash: fixture.expected.recordHash,
          parseStatus: "valid",
        }),
      ]);
    });
  }

  for (const fixture of contract.cases.filter(
    (item: any) => item.format === "jsonl",
  )) {
    it(`${fixture.id} follows the versioned JSONL contract`, async () => {
      const result = await parseSourceRecords({
        assetId: "asset_fixture",
        parsedViewId: "view_fixture",
        format: "jsonl",
        parserVersion: contract.contractVersion,
        config: fixture.config,
        bytes: Readable.from(Buffer.from(fixture.source.utf8)),
      });

      expect(result.records).toEqual([
        expect.objectContaining({
          locator: fixture.expected.locator,
          fields: fixture.expected.fields,
          recordHash: fixture.expected.recordHash,
          parseStatus: "valid",
        }),
      ]);
    });
  }

  it.each([
    ["duplicate_field_name", '{"value":1,"value":2}', ""],
    ["unsafe_json_integer", '{"value":9007199254740993}', ""],
    ["invalid_record_path", '{"rows":[]}', "$.rows[*]"],
    ["record_path_not_array", '{"rows":{}}', "/rows"],
    ["malformed_json", '{"rows":[}', "/rows"],
  ])(
    "reports %s without claiming trusted record boundaries",
    async (code, source, recordPath) => {
      const result = await parseSourceRecords({
        assetId: "asset_fixture",
        parsedViewId: "view_fixture",
        format: "json",
        parserVersion: contract.contractVersion,
        config: { recordPath },
        bytes: Readable.from(Buffer.from(source)),
      });

      expect(result.records).toEqual([]);
      expect(result.summary).toMatchObject({
        totalCount: 0,
        successCount: 0,
        failureCount: 0,
        boundaryTrusted: false,
        blockingErrors: [expect.objectContaining({ code })],
      });
    },
  );

  it("keeps all 10,000 JSONL boundaries visible and locates three independent failures", async () => {
    const badLines = new Set([3, 5_000, 9_999]);
    const source = Array.from({ length: 10_000 }, (_, index) =>
      badLines.has(index + 1) ? '{"broken":}' : `{"value":${index + 1}}`,
    ).join("\n");
    const result = await parseSourceRecords({
      assetId: "asset_bad_three",
      parsedViewId: "view_bad_three",
      format: "jsonl",
      parserVersion: contract.contractVersion,
      config: {},
      bytes: Readable.from(Buffer.from(source)),
    });

    expect(result.summary).toMatchObject({
      totalCount: 10_000,
      successCount: 9_997,
      failureCount: 3,
      boundaryTrusted: true,
      draftEligible: false,
    });
    expect(
      result.records
        .filter((record) => record.parseStatus === "invalid")
        .map((record) => record.locator),
    ).toEqual(
      [3, 5_000, 9_999].map((physicalLine) => ({
        kind: "jsonl_line",
        physicalLine,
      })),
    );

    const usable = excludeLocatedFailures(result.records, [
      { kind: "jsonl_line", physicalLine: 3 },
      { kind: "jsonl_line", physicalLine: 5_000 },
      { kind: "jsonl_line", physicalLine: 9_999 },
    ]);
    expect(usable.records).toHaveLength(9_997);
    expect(usable.report).toMatchObject({
      excludedCount: 3,
      draftEligible: true,
      exclusions: [
        expect.objectContaining({
          locator: { kind: "jsonl_line", physicalLine: 3 },
          reason: "Malformed JSON on this physical line.",
        }),
        expect.objectContaining({
          locator: { kind: "jsonl_line", physicalLine: 5_000 },
        }),
        expect.objectContaining({
          locator: { kind: "jsonl_line", physicalLine: 9_999 },
        }),
      ],
    });
  });

  it("ignores blank JSONL lines but preserves physical line locators and the final no-EOL line", async () => {
    const result = await parseSourceRecords({
      assetId: "asset_blank_lines",
      parsedViewId: "view_blank_lines",
      format: "jsonl",
      parserVersion: contract.contractVersion,
      config: {},
      bytes: Readable.from(Buffer.from('\n {"value":1} \n\r\n{"value":2}')),
    });

    expect(result.records.map((record) => record.locator)).toEqual([
      { kind: "jsonl_line", physicalLine: 2 },
      { kind: "jsonl_line", physicalLine: 4 },
    ]);
    expect(result.summary).toMatchObject({
      totalCount: 2,
      successCount: 2,
      failureCount: 0,
      draftEligible: true,
    });
  });

  it("marks 10,001 source records draft-ineligible without discarding the asset result", async () => {
    const source = '{"value":1}\n'.repeat(10_001);
    const result = await parseSourceRecords({
      assetId: "asset_over_limit",
      parsedViewId: "view_over_limit",
      format: "jsonl",
      parserVersion: contract.contractVersion,
      config: {},
      bytes: Readable.from(Buffer.from(source)),
    });

    expect(result.summary).toMatchObject({
      totalCount: 10_001,
      successCount: 10_001,
      failureCount: 0,
      draftEligible: false,
      blockingErrors: [
        expect.objectContaining({ code: "source_record_limit_exceeded" }),
      ],
    });
  });

  it("discovers escaped RFC 6901 field paths without changing nested values", async () => {
    const result = await parseSourceRecords({
      assetId: "asset_paths",
      parsedViewId: "view_paths",
      format: "jsonl",
      parserVersion: contract.contractVersion,
      config: {},
      bytes: Readable.from(Buffer.from('{"a/b":{"~key":1},"amount":1.5}\n')),
    });

    expect(result.records[0].fields).toEqual({
      "a/b": { "~key": 1 },
      amount: 1.5,
    });
    expect(result.summary.fieldProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/a~1b/~0key", types: ["number"] }),
        expect.objectContaining({ path: "/amount", types: ["number"] }),
      ]),
    );
  });

  it.each([
    ["empty", "", []],
    ["header-only", "question,answer\n", ["question", "answer"]],
  ])(
    "freezes %s CSV as ready with zero records",
    async (_name, source, fields) => {
      const result = await parseSourceRecords({
        assetId: "asset_empty",
        parsedViewId: "view_empty",
        format: "csv",
        parserVersion: contract.contractVersion,
        config: { encoding: "utf8", delimiter: ",", headerRow: 1, quote: '"' },
        bytes: Readable.from(Buffer.from(source as string)),
      });

      expect(result.records).toEqual([]);
      expect(result.summary).toMatchObject({
        totalCount: 0,
        successCount: 0,
        failureCount: 0,
        boundaryTrusted: true,
        draftEligible: true,
        fields,
        warnings: ["empty_source"],
      });
    },
  );

  it.each([
    ["duplicate_field_name", "question,question\nQ,A\n"],
    ["malformed_csv", 'question,answer\n"unterminated,A\n'],
  ])("returns a stable blocking %s CSV result", async (code, source) => {
    const result = await parseSourceRecords({
      assetId: "asset_bad_csv",
      parsedViewId: "view_bad_csv",
      format: "csv",
      parserVersion: contract.contractVersion,
      config: { encoding: "utf8", delimiter: ",", headerRow: 1, quote: '"' },
      bytes: Readable.from(Buffer.from(source)),
    });

    expect(result.records).toEqual([]);
    expect(result.summary).toMatchObject({
      totalCount: 0,
      successCount: 0,
      failureCount: 0,
      boundaryTrusted: false,
      draftEligible: false,
      blockingErrors: [expect.objectContaining({ code })],
    });
  });

  it("replays the same bytes, parser version, and config deterministically", async () => {
    const input = () => ({
      assetId: "asset_replay",
      parsedViewId: "view_replay",
      format: "jsonl" as const,
      parserVersion: contract.contractVersion,
      config: {},
      bytes: Readable.from(Buffer.from('{"b":2,"a":1}\n{"bad":}\n')),
    });

    expect(await parseSourceRecords(input())).toEqual(
      await parseSourceRecords(input()),
    );
  });

  it("reports invalid UTF-8 before claiming JSONL record boundaries", async () => {
    const result = await parseSourceRecords({
      assetId: "asset_invalid_encoding",
      parsedViewId: "view_invalid_encoding",
      format: "jsonl",
      parserVersion: contract.contractVersion,
      config: {},
      bytes: Readable.from(Buffer.from([0xff, 0xfe, 0xfd])),
    });

    expect(result).toMatchObject({
      records: [],
      summary: {
        boundaryTrusted: false,
        draftEligible: false,
        blockingErrors: [expect.objectContaining({ code: "invalid_encoding" })],
      },
    });
  });

  it("propagates cancellation from JSON and CSV batch seams", async () => {
    const cancellation = Object.assign(new Error("job_cancel_requested"), {
      code: "job_cancel_requested",
    });
    const cancelAfterRecords = async (recordsProcessed: number) => {
      if (recordsProcessed >= 100) throw cancellation;
    };
    const json = Array.from({ length: 100 }, (_, index) => ({ value: index }));
    await expect(
      parseSourceRecords({
        assetId: "asset_cancel_json",
        parsedViewId: "view_cancel_json",
        format: "json",
        parserVersion: contract.contractVersion,
        config: { recordPath: "" },
        bytes: Readable.from(Buffer.from(JSON.stringify(json))),
        onBatch: cancelAfterRecords,
      }),
    ).rejects.toMatchObject({ code: "job_cancel_requested" });

    const csv = [
      "value",
      ...Array.from({ length: 100 }, (_, index) => `${index}`),
    ].join("\n");
    await expect(
      parseSourceRecords({
        assetId: "asset_cancel_csv",
        parsedViewId: "view_cancel_csv",
        format: "csv",
        parserVersion: contract.contractVersion,
        config: { encoding: "utf8", delimiter: ",", headerRow: 1, quote: '"' },
        bytes: Readable.from(Buffer.from(csv)),
        onBatch: cancelAfterRecords,
      }),
    ).rejects.toMatchObject({ code: "job_cancel_requested" });
  });

  it("reports an explicit CSV encoding mismatch at the encoding boundary", async () => {
    const result = await parseSourceRecords({
      assetId: "asset_invalid_csv_encoding",
      parsedViewId: "view_invalid_csv_encoding",
      format: "csv",
      parserVersion: contract.contractVersion,
      config: { encoding: "utf8", delimiter: ",", headerRow: 1, quote: '"' },
      bytes: Readable.from(Buffer.from([0xff, 0xfe, 0xfd])),
    });

    expect(result).toMatchObject({
      records: [],
      summary: {
        boundaryTrusted: false,
        draftEligible: false,
        blockingErrors: [
          expect.objectContaining({
            code: "invalid_encoding",
            reason: "CSV bytes do not match the selected encoding.",
          }),
        ],
      },
    });
  });
});
