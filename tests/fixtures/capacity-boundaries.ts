import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CAPACITY_BOUNDARY_FIXTURE_IDS = [
  "upload-exact-50mb-csv",
  "upload-over-50mb-csv",
  "draft-exact-50mb-jsonl",
  "draft-overflow-byte",
  "source-exact-5000-jsonl",
  "source-over-10000-jsonl",
  "draft-combined-asset-1",
  "draft-combined-asset-2",
  "draft-combined-asset-3",
  "draft-combined-asset-4",
  "draft-combined-asset-5",
  "candidate-exact-source-10000-jsonl",
  "candidate-overflow-source-10000-jsonl",
  "g02-exact-input",
  "g02-over-input",
] as const;

export type CapacityFixtureId = (typeof CAPACITY_BOUNDARY_FIXTURE_IDS)[number];

type FixtureSpec = {
  id: CapacityFixtureId;
  seed: string;
  bytes: number;
  recordCount: number;
  sha256: string;
  normalizedBytes?: number;
  normalizedSha256?: string;
  normalizedCaseId?: string;
};

type FixtureManifest = {
  schemaVersion: string;
  generatorVersion: string;
  fixtures: Record<CapacityFixtureId, Omit<FixtureSpec, "id">>;
};

const manifest = JSON.parse(
  readFileSync(
    new URL("./capacity-boundary-manifest-v2.json", import.meta.url),
    "utf8",
  ),
) as FixtureManifest;

export const CAPACITY_BOUNDARY_FIXTURES = Object.fromEntries(
  Object.entries(manifest.fixtures).map(([id, fixture]) => [
    id,
    { id, ...fixture },
  ]),
) as Record<CapacityFixtureId, FixtureSpec>;

export type BuiltCapacityFixture = Omit<
  FixtureSpec,
  "bytes" | "recordCount" | "sha256"
> & {
  bytes: Buffer;
  recordCount: number;
  sha256: string;
};

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function seedChar(id: CapacityFixtureId, offset = 0): string {
  const seed = CAPACITY_BOUNDARY_FIXTURES[id].seed;
  const value = createHash("sha256").update(`${seed}:${offset}`).digest()[0];
  return String.fromCharCode(97 + (value % 26));
}

function verify(
  id: CapacityFixtureId,
  bytes: Buffer,
  recordCount: number,
): BuiltCapacityFixture {
  const fixture = CAPACITY_BOUNDARY_FIXTURES[id];
  const sha256 = digest(bytes);
  if (
    bytes.byteLength !== fixture.bytes ||
    recordCount !== fixture.recordCount ||
    sha256 !== fixture.sha256
  ) {
    throw new Error(
      `Capacity fixture ${id} does not match ${manifest.generatorVersion}`,
    );
  }
  return { ...fixture, bytes, recordCount, sha256 };
}

function jsonlPaddingLine(targetSize: number, fill: string): Buffer {
  const prefix = Buffer.from('{"padding":"');
  const suffix = Buffer.from('"}\n');
  return Buffer.concat([
    prefix,
    Buffer.alloc(targetSize - prefix.byteLength - suffix.byteLength, fill),
    suffix,
  ]);
}

function combinedDraftAsset(
  id: CapacityFixtureId,
  assetNumber: number,
): Buffer {
  const lineSize = 10_000;
  const recordCount = 2_000;
  const bytes = Buffer.alloc(lineSize * recordCount, seedChar(id));
  let offset = 0;
  for (let index = 0; index < recordCount; index += 1) {
    const prefix = Buffer.from(
      `{"id":"asset-${assetNumber}-${String(index).padStart(4, "0")}","padding":"`,
    );
    const suffix = Buffer.from('"}\n');
    prefix.copy(bytes, offset);
    suffix.copy(bytes, offset + lineSize - suffix.byteLength);
    offset += lineSize;
  }
  return bytes;
}

function candidateFields() {
  return Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `field${index}`,
      "b".repeat(450),
    ]),
  );
}

function candidateTailLength(): number {
  const emptyTailLine = JSON.stringify({
    case_id: "x".repeat("case_".length + 32),
    input: { ...candidateFields(), tail: "" },
    expected_output: "ok",
    metadata: {},
  });
  return 9_999 - emptyTailLine.length;
}

function buildBytes(id: CapacityFixtureId): {
  bytes: Buffer;
  recordCount: number;
} {
  switch (id) {
    case "upload-exact-50mb-csv": {
      const bytes = Buffer.alloc(50_000_000, seedChar(id));
      bytes.write("value\n");
      bytes[bytes.length - 1] = 0x0a;
      return { bytes, recordCount: 1 };
    }
    case "upload-over-50mb-csv": {
      const bytes = Buffer.alloc(50_000_001, seedChar(id));
      bytes.write("value\n");
      bytes[bytes.length - 2] = 0x0a;
      return {
        bytes,
        recordCount: 2,
      };
    }
    case "draft-exact-50mb-jsonl":
      return {
        bytes: jsonlPaddingLine(50_000_000, seedChar(id)),
        recordCount: 1,
      };
    case "draft-overflow-byte":
      return {
        bytes: Buffer.from(seedChar(id) < "n" ? "\n" : "\r"),
        recordCount: 0,
      };
    case "source-exact-5000-jsonl":
      return {
        bytes: Buffer.from(
          Array.from(
            { length: 5_000 },
            (_, index) =>
              `${JSON.stringify({
                id: `${CAPACITY_BOUNDARY_FIXTURES[id].seed}-${index}`,
              })}\n`,
          ).join(""),
        ),
        recordCount: 5_000,
      };
    case "source-over-10000-jsonl":
      return {
        bytes: Buffer.from(
          `${JSON.stringify({ value: seedChar(id) })}\n`.repeat(10_001),
        ),
        recordCount: 10_001,
      };
    case "draft-combined-asset-1":
      return { bytes: combinedDraftAsset(id, 1), recordCount: 2_000 };
    case "draft-combined-asset-2":
      return { bytes: combinedDraftAsset(id, 2), recordCount: 2_000 };
    case "draft-combined-asset-3":
      return { bytes: combinedDraftAsset(id, 3), recordCount: 2_000 };
    case "draft-combined-asset-4":
      return { bytes: combinedDraftAsset(id, 4), recordCount: 2_000 };
    case "draft-combined-asset-5":
      return { bytes: combinedDraftAsset(id, 5), recordCount: 2_000 };
    case "candidate-exact-source-10000-jsonl": {
      const tail = "e".repeat(candidateTailLength());
      return {
        bytes: Buffer.from(
          Array.from(
            { length: 10_000 },
            (_, index) =>
              `${JSON.stringify({
                id: "cap",
                base: `${seedChar(id).repeat(446)}${String(index).padStart(4, "0")}`,
                tail,
              })}\n`,
          ).join(""),
        ),
        recordCount: 10_000,
      };
    }
    case "candidate-overflow-source-10000-jsonl": {
      const exactTail = "e".repeat(candidateTailLength());
      return {
        bytes: Buffer.from(
          Array.from({ length: 10_000 }, (_, index) => {
            const overflowTail =
              index === 9_999 ? "e".repeat(exactTail.length + 1) : exactTail;
            return `${JSON.stringify({
              id: "cap",
              base: `${seedChar(id).repeat(446)}${String(index).padStart(4, "0")}`,
              exactTail,
              overflowTail,
            })}\n`;
          }).join(""),
        ),
        recordCount: 10_000,
      };
    }
    case "g02-exact-input":
      return {
        bytes: Buffer.from(
          JSON.stringify(seedChar(id).repeat(10_000_000 - 2)),
          "utf8",
        ),
        recordCount: 1,
      };
    case "g02-over-input":
      return {
        bytes: Buffer.from(
          JSON.stringify(seedChar(id).repeat(10_000_001)),
          "utf8",
        ),
        recordCount: 1,
      };
    default:
      throw new Error(`Unknown capacity fixture: ${id}`);
  }
}

export function buildCapacityFixture(
  id: CapacityFixtureId,
): BuiltCapacityFixture {
  const generated = buildBytes(id);
  return verify(id, generated.bytes, generated.recordCount);
}

export function buildCapacityFixtureValue(
  id: "g02-exact-input" | "g02-over-input",
): string {
  return JSON.parse(buildCapacityFixture(id).bytes.toString("utf8")) as string;
}
