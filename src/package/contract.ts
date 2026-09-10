import { createHash } from "node:crypto";

import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { canonicalize } from "json-canonicalize";

export const STANDARD_FILES = [
  "manifest.json",
  "schema.json",
  "items.jsonl",
  "lineage.jsonl",
  "parse-views.json",
  "recipe.json",
  "source-attributions.json",
  "transformation-runs.jsonl",
  "checksums.sha256",
] as const;

export const EVIDENCE_FILES = [
  "lineage.jsonl",
  "parse-views.json",
  "recipe.json",
  "schema.json",
  "source-attributions.json",
  "transformation-runs.jsonl",
] as const;

export interface ProvenanceAsset {
  assetId: string;
  fileName: string;
  sha256: string;
  bytes: Uint8Array;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  return canonicalize(value);
}

function assertJsonValue(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(assertJsonValue);
    return;
  }
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    Object.values(value).forEach(assertJsonValue);
    return;
  }
  throw new TypeError("Canonical JSON accepts only JSON-representable values");
}

export interface PackageItem {
  case_id: string;
  input: Record<string, unknown>;
  expected_output: unknown;
  metadata: Record<string, unknown>;
  source?: {
    assetId: string;
    parsedViewId: string;
    ordinal: number;
    locator: unknown;
    recordHash: string;
  };
  lineage?: Record<string, unknown>;
}

export interface StandardPackageInput {
  testSet: { id: string; name: string };
  version: {
    id: string;
    number: number;
    publishedAt: string;
    parentId?: string | null;
  };
  schema: {
    dialect: "https://json-schema.org/draft/2020-12/schema";
    revisionId: string;
    mode: "gold_required" | "input_only";
    input: unknown;
    expectedOutput: unknown;
  };
  recipe: unknown;
  attribution?: unknown;
  parsedView?: unknown;
  sources?: Array<{ parsedView: unknown; attribution: unknown }>;
  items: PackageItem[];
  transformationRuns?: Array<Record<string, unknown>>;
}

export type StandardEvidenceInput = Omit<
  StandardPackageInput,
  "testSet" | "version"
> & { itemsSha256: string };

export interface StandardManifestInput {
  testSet: StandardPackageInput["testSet"];
  version: StandardPackageInput["version"];
  schema: {
    revisionId: string;
    mode: "gold_required" | "input_only";
    sha256: string;
  };
  payloadHash: string;
  evidenceHash: string;
  counts: { items: number; recordLevel: number; assetLevel: number };
}

export function createStandardManifest(input: StandardManifestInput) {
  const withoutOwnHash = {
    package_format_version: "1.0",
    test_set: input.testSet,
    version: {
      id: input.version.id,
      number: input.version.number,
      parent_version_id: input.version.parentId ?? null,
      payload_hash: input.payloadHash,
      evidence_hash: input.evidenceHash,
      published_at: input.version.publishedAt,
    },
    formal_schema: {
      file: "schema.json",
      revision_id: input.schema.revisionId,
      mode: input.schema.mode,
      sha256: input.schema.sha256,
    },
    counts: {
      items: input.counts.items,
      record_level: input.counts.recordLevel,
      asset_level: input.counts.assetLevel,
    },
    items: { file: "items.jsonl", format: "jsonl" },
    evidence_files: {
      lineage: "lineage.jsonl",
      parse_views: "parse-views.json",
      recipe: "recipe.json",
      source_attributions: "source-attributions.json",
      transformation_runs: "transformation-runs.jsonl",
    },
    checksums_file: "checksums.sha256",
  };
  const hash = sha256(canonicalJson(withoutOwnHash));
  const manifest = {
    ...withoutOwnHash,
    version: { ...withoutOwnHash.version, version_manifest_hash: hash },
  };
  return { manifest, hash, text: `${canonicalJson(manifest)}\n` };
}

function buildEvidence(input: StandardEvidenceInput) {
  const lineageJsonl = `${input.items
    .map((item) => {
      const lineage =
        item.lineage ??
        (item.source
          ? { level: "record_level", source_record: item.source }
          : undefined);
      if (!lineage)
        throw new TypeError("Every package item requires record-level lineage");
      return canonicalJson({ case_id: item.case_id, ...lineage });
    })
    .join("\n")}\n`;
  const parsedViews = input.sources?.map((source) => source.parsedView) ?? [
    input.parsedView,
  ];
  const attributions = input.sources?.map((source) => source.attribution) ?? [
    input.attribution,
  ];
  const transformationRunsJsonl = input.transformationRuns?.length
    ? `${input.transformationRuns
        .map((run) => canonicalJson(run))
        .join("\n")}\n`
    : "";
  const evidence: Record<string, Uint8Array | string> = {
    "schema.json": `${canonicalJson({
      $schema: input.schema.dialect,
      revisionId: input.schema.revisionId,
      mode: input.schema.mode,
      input: input.schema.input,
      expectedOutput: input.schema.expectedOutput,
    })}\n`,
    "lineage.jsonl": lineageJsonl,
    "parse-views.json": `${canonicalJson(
      parsedViews.length === 1 ? parsedViews[0] : parsedViews,
    )}\n`,
    "recipe.json": `${canonicalJson(input.recipe)}\n`,
    "source-attributions.json": `${canonicalJson(
      attributions.length === 1 ? attributions[0] : attributions,
    )}\n`,
    "transformation-runs.jsonl": transformationRunsJsonl,
  };
  const evidenceHash = sha256(
    canonicalJson(
      EVIDENCE_FILES.map((path) => ({
        path,
        sha256: sha256(evidence[path]),
        size: Buffer.byteLength(evidence[path]),
      })),
    ),
  );
  return { evidence, evidenceHash };
}

export function createStandardEvidence(input: StandardEvidenceInput) {
  const { evidence, evidenceHash } = buildEvidence(input);
  return {
    files: evidence,
    payloadHash: input.itemsSha256,
    evidenceHash,
  };
}

export function createStandardPackage(input: StandardPackageInput) {
  const itemsJsonl = Buffer.from(
    `${input.items
      .map(({ case_id, input: itemInput, expected_output, metadata }) =>
        canonicalJson({
          case_id,
          input: itemInput,
          expected_output,
          metadata,
        }),
      )
      .join("\n")}\n`,
  );
  const payloadHash = sha256(itemsJsonl);
  const { evidence, evidenceHash } = buildEvidence({
    ...input,
    itemsSha256: payloadHash,
  });
  const manifest = createStandardManifest({
    testSet: input.testSet,
    version: input.version,
    schema: {
      revisionId: input.schema.revisionId,
      mode: input.schema.mode,
      sha256: sha256(evidence["schema.json"]),
    },
    payloadHash,
    evidenceHash,
    counts: {
      items: input.items.length,
      recordLevel: input.items.filter(
        (item) => (item.lineage?.level ?? "record_level") === "record_level",
      ).length,
      assetLevel: input.items.filter(
        (item) => item.lineage?.level === "asset_level",
      ).length,
    },
  });
  const files: Record<string, Uint8Array | string> = {
    "manifest.json": manifest.text,
    "items.jsonl": itemsJsonl,
    ...evidence,
  };
  files["checksums.sha256"] = `${Object.keys(files)
    .sort()
    .map((file) => `${sha256(files[file])}  ${file}`)
    .join("\n")}\n`;
  const zipInput: Zippable = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [
        name,
        [
          typeof files[name] === "string"
            ? strToU8(files[name])
            : new Uint8Array(files[name]),
          { mtime: new Date("1980-01-01T00:00:00.000Z") },
        ] as const,
      ]),
  );
  const bytes = zipSync(zipInput, { level: 6 });
  return {
    bytes,
    files,
    payloadHash,
    evidenceHash,
    versionManifestHash: manifest.hash,
    deliveryHash: sha256(bytes),
  };
}

export function createFullProvenancePackage(
  standardPackageBytes: Uint8Array,
  assets: ProvenanceAsset[],
) {
  const standardArchive = unzipSync(standardPackageBytes);
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(standardArchive)) {
    files[`version/${name}`] = bytes;
  }
  const manifestAssets = assets
    .map((asset) => ({
      assetId: asset.assetId,
      fileName: asset.fileName,
      path: `assets/${asset.assetId}/asset.bin`,
      sha256: asset.sha256,
      size: asset.bytes.byteLength,
    }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  for (const asset of manifestAssets)
    files[asset.path] = assets.find(
      (item) => item.assetId === asset.assetId,
    )!.bytes;
  files["filename-manifest.json"] = Buffer.from(
    `${canonicalJson({
      package_format_version: "1.0-full",
      assets: manifestAssets,
    })}\n`,
  );

  const zipInput: Zippable = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [
        name,
        [
          new Uint8Array(files[name]),
          { mtime: new Date("1980-01-01T00:00:00.000Z") },
        ] as const,
      ]),
  );
  const bytes = zipSync(zipInput, { level: 6 });
  return { bytes, deliveryHash: sha256(bytes) };
}

export function createLangfuseCsv(versionId: string, items: PackageItem[]) {
  const csvCell = (value: unknown) =>
    `"${canonicalJson(value).replace(/"/gu, '""')}"`;
  const rows = items.map((item) => {
    if (item.metadata && "_agentbench" in item.metadata)
      throw new TypeError(
        "Business metadata cannot override reserved _agentbench",
      );
    const metadata = {
      ...(item.metadata as Record<string, unknown>),
      _agentbench: { case_id: item.case_id, version_id: versionId },
    };
    return [
      csvCell(item.input),
      csvCell(item.expected_output),
      csvCell(metadata),
    ].join(",");
  });
  const bytes = Buffer.from(
    `input,expected_output,metadata\n${rows.join("\n")}\n`,
    "utf8",
  );
  return { bytes, deliveryHash: sha256(bytes) };
}
