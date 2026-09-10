import { Readable } from "node:stream";

import { parse } from "csv-parse";

import { CAPACITY_LIMITS } from "../capacity.js";
import { canonicalJson, sha256 } from "../package/contract.js";

export type CsvEncoding = "auto" | "utf8" | "gb18030" | "gbk";

export interface CsvParserConfig {
  encoding: CsvEncoding;
  delimiter: string;
  headerRow: number;
  quote: string;
}

export interface ParsedSourceRecord {
  ordinal: number;
  value: Record<string, string>;
  locator: { physicalLine: number };
  recordHash: string;
}

async function readBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function decodeCsv(
  bytes: Buffer,
  requested: CsvEncoding,
): { source: string; detectedEncoding: Exclude<CsvEncoding, "auto"> } {
  let encoding: Exclude<CsvEncoding, "auto">;
  if (requested !== "auto") {
    encoding = requested;
  } else {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      encoding = "utf8";
    } catch {
      encoding = "gb18030";
    }
  }
  const label = encoding === "utf8" ? "utf-8" : encoding;
  try {
    return {
      source: new TextDecoder(label, { fatal: true }).decode(bytes),
      detectedEncoding: encoding,
    };
  } catch {
    throw Object.assign(new Error("CSV bytes do not match the encoding"), {
      code: "invalid_encoding",
    });
  }
}

export async function parseCsv(
  stream: Readable,
  config: CsvParserConfig,
  emit: (record: ParsedSourceRecord) => Promise<unknown>,
  maximumRecords = Number.POSITIVE_INFINITY,
): Promise<{
  recordCount: number;
  fields: string[];
  detectedEncoding: Exclude<CsvEncoding, "auto">;
}> {
  if (config.delimiter.length !== 1 || config.quote.length !== 1) {
    throw Object.assign(
      new Error("CSV delimiter and quote must be one character"),
      {
        code: "invalid_parser_config",
      },
    );
  }
  if (!Number.isInteger(config.headerRow) || config.headerRow < 1) {
    throw Object.assign(
      new Error("CSV header row must be a positive integer"),
      {
        code: "invalid_parser_config",
      },
    );
  }

  const { source, detectedEncoding } = decodeCsv(
    await readBytes(stream),
    config.encoding,
  );
  let headerFields: string[] = [];
  const parser = Readable.from(source).pipe(
    parse({
      columns: (fields: string[]) => {
        const duplicate = fields.find(
          (field, index) => fields.indexOf(field) !== index,
        );
        if (duplicate !== undefined) {
          throw Object.assign(new Error(`Duplicate CSV header: ${duplicate}`), {
            code: "duplicate_field_name",
          });
        }
        headerFields = fields;
        return fields;
      },
      delimiter: config.delimiter,
      from_line: config.headerRow,
      info: true,
      quote: config.quote,
      skip_empty_lines: true,
    }),
  );
  let ordinal = 0;
  for await (const parsed of parser) {
    ordinal += 1;
    if (ordinal > maximumRecords) {
      throw Object.assign(
        new Error(
          `CSV exceeds ${maximumRecords.toLocaleString("en-US")} Source Records`,
        ),
        {
          code: "source_record_limit_exceeded",
        },
      );
    }
    const value = parsed.record as Record<string, string>;
    await emit({
      ordinal,
      value,
      locator: { physicalLine: parsed.info.lines },
      recordHash: sha256(canonicalJson(value)),
    });
  }
  return { recordCount: ordinal, fields: headerFields, detectedEncoding };
}

export async function parseUtf8Csv(
  stream: Readable,
  emit: (record: ParsedSourceRecord) => Promise<unknown>,
  maximumRecords = CAPACITY_LIMITS.parsedViewRecords,
): Promise<{ recordCount: number; fields: string[] }> {
  const result = await parseCsv(
    stream,
    { encoding: "utf8", delimiter: ",", headerRow: 1, quote: '"' },
    emit,
    maximumRecords,
  );
  return { recordCount: result.recordCount, fields: result.fields };
}
