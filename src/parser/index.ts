import type { Readable } from "node:stream";

import { CAPACITY_LIMITS } from "../capacity.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { parseCsv, type CsvParserConfig } from "./csv.js";

type ParserInput = {
  assetId: string;
  parsedViewId: string;
  parserVersion: string;
  bytes: Readable;
  onBatch?: (recordsProcessed: number) => Promise<void>;
} & (
  | {
      format: "csv";
      config: CsvParserConfig;
    }
  | { format: "json"; config: { recordPath: string } }
  | { format: "jsonl"; config: Record<string, never> }
);

type Locator =
  | { kind: "csv_row"; dataRow: number; physicalLine: number }
  | { kind: "json_pointer"; pointer: string }
  | { kind: "jsonl_line"; physicalLine: number };

export interface ParseError {
  code: string;
  reason: string;
  location: Locator | { kind: "json_document" } | { kind: "parsed_view" };
  retry: string;
  object?: { type: string; id?: string };
  blockingPhase?: string;
  actualRecords?: number;
  limitRecords?: number;
}

export interface SourceRecord {
  assetId: string;
  parsedViewId: string;
  ordinal: number;
  locator: Locator;
  fields: unknown;
  recordHash: string | null;
  parseStatus: "valid" | "invalid";
  error?: ParseError;
}

export interface FieldProfile {
  path: string;
  types: string[];
  nullCount: number;
  nullRatio: number;
  examples: unknown[];
}

export async function parseSourceRecords(input: ParserInput): Promise<{
  records: SourceRecord[];
  summary: {
    totalCount: number;
    successCount: number;
    failureCount: number;
    boundaryTrusted: boolean;
    detectedEncoding?: "utf8" | "gb18030" | "gbk";
    blockingErrors?: ParseError[];
    draftEligible?: boolean;
    fieldProfiles?: FieldProfile[];
    warnings?: string[];
    fields?: string[];
  };
}> {
  const records: SourceRecord[] = [];
  const add = (fields: unknown, locator: Locator) => {
    records.push({
      assetId: input.assetId,
      parsedViewId: input.parsedViewId,
      ordinal: records.length + 1,
      locator,
      fields,
      recordHash: sha256(canonicalJson(fields)),
      parseStatus: "valid",
    });
  };
  const notifyBatch = async () => {
    if (input.onBatch && records.length % 100 === 0)
      await input.onBatch(records.length);
  };

  let detectedEncoding: "utf8" | "gb18030" | "gbk" | undefined;
  let csvFields: string[] | undefined;
  if (input.format === "csv") {
    try {
      const csv = await parseCsv(
        input.bytes,
        input.config,
        async (record) => {
          add(record.value, {
            kind: "csv_row",
            dataRow: record.ordinal,
            physicalLine: record.locator.physicalLine,
          });
          await notifyBatch();
        },
        Number.POSITIVE_INFINITY,
      );
      detectedEncoding = csv.detectedEncoding;
      csvFields = csv.fields;
    } catch (error) {
      const internalCode = errorCode(error, "malformed_csv");
      if (internalCode === "job_cancel_requested") throw error;
      const code = [
        "duplicate_field_name",
        "invalid_encoding",
        "invalid_parser_config",
      ].includes(internalCode)
        ? internalCode
        : "malformed_csv";
      return blockedResult(
        code,
        code === "duplicate_field_name"
          ? "CSV header names must be unique."
          : code === "invalid_encoding"
            ? "CSV bytes do not match the selected encoding."
            : "CSV record boundaries cannot be trusted with this dialect.",
        "Correct the encoding or CSV dialect, then create a new parse attempt.",
      );
    }
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of input.bytes) {
      chunks.push(Buffer.from(chunk));
      if (input.onBatch) await input.onBatch(records.length);
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      return blockedResult(
        "invalid_encoding",
        "JSON and JSONL assets must contain valid UTF-8.",
        "Correct the declared file or upload valid UTF-8 bytes, then retry.",
      );
    }

    if (input.format === "json") {
      try {
        const value = parseJson(source);
        const { values, pointer } = selectJsonRecords(
          value,
          input.config.recordPath,
        );
        for (const [index, fields] of values.entries()) {
          add(fields, {
            kind: "json_pointer",
            pointer:
              pointer === "" && !Array.isArray(value)
                ? ""
                : `${pointer}/${index}`,
          });
          await notifyBatch();
        }
      } catch (error) {
        if (errorCode(error, "malformed_json") === "job_cancel_requested")
          throw error;
        const code = errorCode(error, "malformed_json");
        return {
          records: [],
          summary: {
            totalCount: 0,
            successCount: 0,
            failureCount: 0,
            boundaryTrusted: false,
            draftEligible: false,
            blockingErrors: [
              {
                code,
                reason: parserReason(code),
                location: { kind: "json_document" },
                retry:
                  "Correct the JSON or choose one RFC 6901 array pointer, then retry.",
              },
            ],
          },
        };
      }
    } else {
      for (const [index, line] of source.split(/\r\n|\n|\r/).entries()) {
        if (line.trim() !== "") {
          const locator = {
            kind: "jsonl_line",
            physicalLine: index + 1,
          } as const;
          try {
            add(parseJson(line), locator);
          } catch (error) {
            const code = errorCode(error, "malformed_json");
            records.push({
              assetId: input.assetId,
              parsedViewId: input.parsedViewId,
              ordinal: records.length + 1,
              locator,
              fields: null,
              recordHash: null,
              parseStatus: "invalid",
              error: {
                code,
                reason:
                  code === "malformed_json"
                    ? "Malformed JSON on this physical line."
                    : parserReason(code),
                location: locator,
                retry: "Correct this physical line or explicitly exclude it.",
              },
            });
          }
          await notifyBatch();
        }
      }
    }
  }

  const successCount = records.filter(
    (record) => record.parseStatus === "valid",
  ).length;
  const failureCount = records.length - successCount;
  const overLimit = records.length > CAPACITY_LIMITS.parsedViewRecords;
  const blockingErrors = overLimit
    ? [
        {
          code: "source_record_limit_exceeded",
          reason: `Parsed View exceeds ${CAPACITY_LIMITS.parsedViewRecords.toLocaleString(
            "en-US",
          )} Source Records.`,
          location: { kind: "parsed_view" as const },
          object: { type: "parsed_view", id: input.parsedViewId },
          blockingPhase: "parsed_view",
          actualRecords: records.length,
          limitRecords: CAPACITY_LIMITS.parsedViewRecords,
          retry: `Use an asset with at most ${CAPACITY_LIMITS.parsedViewRecords.toLocaleString(
            "en-US",
          )} Source Records.`,
        },
      ]
    : undefined;

  return {
    records,
    summary: {
      totalCount: records.length,
      successCount,
      failureCount,
      boundaryTrusted: true,
      ...(detectedEncoding ? { detectedEncoding } : {}),
      ...(csvFields ? { fields: csvFields } : {}),
      ...(blockingErrors ? { blockingErrors } : {}),
      draftEligible: !overLimit && failureCount === 0,
      fieldProfiles: profileFields(records),
      ...(records.length === 0 ? { warnings: ["empty_source"] } : {}),
    },
  };
}

function blockedResult(code: string, reason: string, retry: string) {
  return {
    records: [] as SourceRecord[],
    summary: {
      totalCount: 0,
      successCount: 0,
      failureCount: 0,
      boundaryTrusted: false,
      draftEligible: false,
      blockingErrors: [
        {
          code,
          reason,
          location: { kind: "parsed_view" as const },
          retry,
        },
      ],
    },
  };
}

export function excludeLocatedFailures(
  records: SourceRecord[],
  locators: Locator[],
): {
  records: SourceRecord[];
  report: {
    excludedCount: number;
    draftEligible: boolean;
    exclusions: { locator: Locator; reason: string }[];
  };
} {
  const selected = new Set(locators.map((locator) => canonicalJson(locator)));
  const exclusions = records
    .filter(
      (record) =>
        record.parseStatus === "invalid" &&
        selected.has(canonicalJson(record.locator)),
    )
    .map((record) => ({
      locator: record.locator,
      reason: record.error?.reason ?? "Invalid Source Record.",
    }));
  const remainingFailures = records.filter(
    (record) =>
      record.parseStatus === "invalid" &&
      !selected.has(canonicalJson(record.locator)),
  );
  const usable = records.filter((record) => record.parseStatus === "valid");
  return {
    records: usable,
    report: {
      excludedCount: exclusions.length,
      draftEligible:
        remainingFailures.length === 0 &&
        usable.length <= CAPACITY_LIMITS.parsedViewRecords,
      exclusions,
    },
  };
}

function profileFields(records: SourceRecord[]): FieldProfile[] {
  const profiles = new Map<
    string,
    { types: Set<string>; nullCount: number; examples: unknown[] }
  >();
  const visit = (value: unknown, path: string) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, nested] of Object.entries(value)) {
        visit(
          nested,
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
      }
      return;
    }
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const profile = profiles.get(path) ?? {
      types: new Set<string>(),
      nullCount: 0,
      examples: [],
    };
    profile.types.add(type);
    if (value === null) profile.nullCount += 1;
    if (
      profile.examples.length < 3 &&
      !profile.examples.some(
        (item) => canonicalJson(item) === canonicalJson(value),
      )
    ) {
      profile.examples.push(value);
    }
    profiles.set(path, profile);
  };
  const valid = records.filter((record) => record.parseStatus === "valid");
  valid.forEach((record) => visit(record.fields, ""));
  return [...profiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, profile]) => ({
      path,
      types: [...profile.types].sort(),
      nullCount: profile.nullCount,
      nullRatio: valid.length ? profile.nullCount / valid.length : 0,
      examples: profile.examples,
    }));
}

function parserError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : fallback;
}

function parserReason(code: string): string {
  const reasons: Record<string, string> = {
    duplicate_field_name: "JSON object keys must be unique.",
    unsafe_json_integer:
      "JSON integer is outside the exact safe-integer range.",
    invalid_record_path:
      "Record path must be an RFC 6901 JSON Pointer without wildcards.",
    record_path_not_found: "The selected record path does not exist.",
    record_path_not_array:
      "A selected nested record path must resolve to one array.",
    malformed_json: "The JSON document is malformed.",
  };
  return reasons[code] ?? "The JSON document cannot be parsed.";
}

function parseJson(source: string): unknown {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const readString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset] === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      } else {
        offset += 1;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const readValue = (depth: number): void => {
    if (depth > 256) throw parserError("json_nesting_too_deep");
    skipWhitespace();
    if (source[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        if (source[offset] !== '"')
          throw new SyntaxError("Expected JSON object key");
        const key = readString();
        if (keys.has(key)) throw parserError("duplicate_field_name");
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ":") throw new SyntaxError("Expected colon");
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") throw new SyntaxError("Expected comma");
        offset += 1;
        skipWhitespace();
      }
      throw new SyntaxError("Unterminated JSON object");
    }
    if (source[offset] === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        readValue(depth + 1);
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") throw new SyntaxError("Expected comma");
        offset += 1;
      }
      throw new SyntaxError("Unterminated JSON array");
    }
    if (source[offset] === '"') {
      readString();
      return;
    }
    const token = source
      .slice(offset)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u,
      )?.[0];
    if (!token) throw new SyntaxError("Invalid JSON value");
    if (
      /^-?(?:0|[1-9]\d*)$/u.test(token) &&
      !Number.isSafeInteger(Number(token))
    ) {
      throw parserError("unsafe_json_integer");
    }
    offset += token.length;
  };

  readValue(0);
  skipWhitespace();
  if (offset !== source.length) throw new SyntaxError("Trailing JSON content");
  return JSON.parse(source);
}

function selectJsonRecords(
  value: unknown,
  pointer: string,
): { values: unknown[]; pointer: string } {
  if (pointer === "") {
    if (Array.isArray(value)) return { values: value, pointer: "" };
    if (typeof value === "object" && value !== null) {
      return { values: [value], pointer: "" };
    }
    throw parserError("record_path_not_array");
  }
  if (!pointer.startsWith("/") || /(?:~[^01]|\*)/u.test(pointer)) {
    throw parserError("invalid_record_path");
  }
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let selected = value;
  for (const part of parts) {
    if (Array.isArray(selected) && /^(?:0|[1-9]\d*)$/u.test(part)) {
      selected = selected[Number(part)];
    } else if (
      typeof selected === "object" &&
      selected !== null &&
      Object.hasOwn(selected, part)
    ) {
      selected = (selected as Record<string, unknown>)[part];
    } else {
      throw parserError("record_path_not_found");
    }
  }
  if (!Array.isArray(selected)) throw parserError("record_path_not_array");
  return { values: selected, pointer };
}
