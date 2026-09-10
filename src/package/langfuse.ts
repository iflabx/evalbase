import { canonicalJson, type PackageItem } from "./contract.js";
import {
  validateFormalItems,
  type FormalSchemaBundle,
} from "../schema/formal.js";

export type LangfuseCsvSchema = FormalSchemaBundle;

export interface LangfuseCsvValidationInput {
  schema: LangfuseCsvSchema;
  versionId: string;
  expectedItems: PackageItem[];
}

export interface LangfuseCsvValidationReport {
  valid: boolean;
  rowCount: number;
  errors: string[];
}

const HEADER = ["input", "expected_output", "metadata"];

function parseStrictCsv(source: string) {
  const rows: Array<{ cells: string[]; quoted: boolean[] }> = [];
  let cells: string[] = [];
  let quoted: boolean[] = [];
  let cell = "";
  let cellQuoted = false;
  let inQuotes = false;
  let cellStarted = false;

  const endCell = () => {
    cells.push(cell);
    quoted.push(cellQuoted);
    cell = "";
    cellQuoted = false;
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    rows.push({ cells, quoted });
    cells = [];
    quoted = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character !== '"') {
        cell += character;
        continue;
      }
      if (source[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      inQuotes = false;
      cellStarted = true;
      continue;
    }
    if (character === '"' && !cellStarted) {
      inQuotes = true;
      cellQuoted = true;
      continue;
    }
    if (character === ",") {
      endCell();
      continue;
    }
    if (character === "\n") {
      endRow();
      continue;
    }
    if (character === '"' || character === "\r") return null;
    cell += character;
    cellStarted = true;
  }
  if (inQuotes) return null;
  endRow();
  return rows;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function validateLangfuseCsv(
  bytes: Uint8Array,
  input: LangfuseCsvValidationInput,
): LangfuseCsvValidationReport {
  const errors = new Set<string>();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(bytes),
    );
  } catch {
    source = "";
    errors.add("csv_syntax_invalid");
  }
  if (source && !source.endsWith("\n")) errors.add("csv_syntax_invalid");

  const rows = source ? parseStrictCsv(source.slice(0, -1)) : null;
  if (!rows?.length) {
    errors.add("csv_syntax_invalid");
    return { valid: false, rowCount: 0, errors: [...errors] };
  }
  const [header, ...dataRows] = rows;
  if (
    header.cells.length !== HEADER.length ||
    header.cells.some((cell, index) => cell !== HEADER[index])
  )
    errors.add("csv_header_invalid");

  const items: PackageItem[] = [];
  dataRows.forEach((row, index) => {
    if (row.cells.length !== HEADER.length) {
      errors.add("csv_mapping_invalid");
      return;
    }
    if (row.quoted.some((quoted) => !quoted)) {
      errors.add("csv_quoting_invalid");
      return;
    }
    try {
      const [itemInput, expectedOutput, metadata] = row.cells.map((cell) =>
        JSON.parse(cell),
      );
      if (
        [itemInput, expectedOutput, metadata].some(
          (value, index) => row.cells[index] !== canonicalJson(value),
        )
      ) {
        errors.add("csv_json_canonical_invalid");
        return;
      }
      if (!isPlainObject(metadata)) {
        errors.add("metadata_contract_invalid");
        return;
      }
      const identity = metadata._agentbench;
      if (
        !isPlainObject(identity) ||
        typeof identity.case_id !== "string" ||
        !identity.case_id ||
        identity.version_id !== input.versionId
      ) {
        errors.add("agentbench_identity_invalid");
        return;
      }
      items.push({
        case_id: String(identity.case_id),
        input: itemInput,
        expected_output: expectedOutput,
        metadata,
      });
      const expected = input.expectedItems[index];
      const expectedMetadata = expected
        ? {
            ...expected.metadata,
            _agentbench: {
              case_id: expected.case_id,
              version_id: input.versionId,
            },
          }
        : undefined;
      if (
        !expected ||
        canonicalJson(itemInput) !== canonicalJson(expected.input) ||
        canonicalJson(expectedOutput) !==
          canonicalJson(expected.expected_output) ||
        canonicalJson(metadata) !== canonicalJson(expectedMetadata)
      )
        errors.add("csv_mapping_invalid");
    } catch {
      errors.add("csv_json_invalid");
    }
  });

  if (dataRows.length !== input.expectedItems.length)
    errors.add("csv_row_count_mismatch");
  if (new Set(items.map((item) => item.case_id)).size !== items.length)
    errors.add("agentbench_identity_invalid");
  try {
    const formal = validateFormalItems(
      input.schema.input,
      input.schema.expectedOutput,
      items.map((item) => ({
        input: item.input,
        expected_output: item.expected_output,
      })),
      input.schema.mode,
    );
    if (!formal.valid) errors.add("formal_schema_invalid");
  } catch {
    errors.add("formal_schema_invalid");
  }

  return {
    valid: errors.size === 0,
    rowCount: dataRows.length,
    errors: [...errors],
  };
}
