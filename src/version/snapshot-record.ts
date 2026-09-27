import { canonicalJson, sha256 } from "../package/contract.js";

export type SparseRecord = {
  question: string;
  expectedOutput: string;
  metadata: Array<{ key: string; value: string }>;
  source?: { assetId: string; ordinal: number };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const display = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

function metadataEntries(value: unknown): SparseRecord["metadata"] {
  if (isObject(value) && Array.isArray(value.entries))
    return metadataEntries(value.entries);
  if (isObject(value) && typeof value.text === "string")
    return [{ key: "Metadata", value: value.text }];
  if (typeof value === "string") return [{ key: "Metadata", value }];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value))
    return [{ key: "Metadata", value: display(value) }];
  return value.map((entry) => ({
    key: String(entry.key),
    value: String(entry.value),
  }));
}

export function storedRecord(row: Record<string, unknown>): SparseRecord {
  const input = row.input;
  const expected = row.expected_output;
  const origin = row.origin_ref;
  const source =
    row.origin_kind === "source_record" &&
    isObject(origin) &&
    typeof origin.assetId === "string" &&
    typeof origin.ordinal === "number"
      ? { assetId: origin.assetId, ordinal: origin.ordinal }
      : undefined;
  return {
    question:
      isObject(input) && typeof input.question === "string"
        ? input.question
        : display(input),
    expectedOutput:
      isObject(expected) && typeof expected.text === "string"
        ? expected.text
        : display(expected),
    metadata: metadataEntries(row.metadata),
    ...(source ? { source } : {}),
  };
}

export function snapshotPayloadHash(records: SparseRecord[]): string {
  return sha256(
    `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
}
