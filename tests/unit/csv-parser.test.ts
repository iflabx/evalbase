import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseUtf8Csv } from "../../src/parser/csv.js";

describe("UTF-8 CSV Parser Adapter", () => {
  it("emits canonical Source Records with stable locators and hashes", async () => {
    const records: unknown[] = [];
    const summary = await parseUtf8Csv(
      Readable.from("a,b\n1,2\n"),
      async (record) => records.push(record),
    );

    expect(summary).toEqual({ recordCount: 1, fields: ["a", "b"] });
    expect(records).toEqual([
      {
        ordinal: 1,
        value: { a: "1", b: "2" },
        locator: { physicalLine: 2 },
        recordHash:
          "21f76dfbfe6dfe21f762080ef484112cf2952974cef30741fd1931e1c6d92112",
      },
    ]);
  });

  it("rejects instead of truncating a CSV above 10,000 Source Records", async () => {
    const csv = `value\n${"x\n".repeat(10_001)}`;
    await expect(
      parseUtf8Csv(Readable.from(csv), async () => undefined),
    ).rejects.toMatchObject({ code: "source_record_limit_exceeded" });
  });
});
