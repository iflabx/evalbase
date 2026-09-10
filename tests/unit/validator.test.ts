import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  createFullProvenancePackage,
  createStandardPackage,
  sha256,
  STANDARD_FILES,
  type StandardPackageInput,
} from "../../src/package/contract.js";
import {
  validatePackage,
  ValidatorInputError,
} from "../../src/validator/validate.js";
import { transformationManifestHash } from "../../src/transformation/index.js";

const fixture: StandardPackageInput = {
  testSet: { id: "testset_golden", name: "Golden" },
  version: {
    id: "version_golden",
    number: 1,
    publishedAt: "2026-08-18T00:00:00.000Z",
  },
  schema: {
    dialect: "https://json-schema.org/draft/2020-12/schema",
    revisionId: "schema_golden",
    mode: "gold_required",
    input: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    expectedOutput: { type: "string" },
  },
  recipe: { filter: { field: "kind", operator: "eq", value: "golden" } },
  attribution: { id: "attribution_golden", assetId: "asset_golden" },
  parsedView: { id: "view_golden", assetId: "asset_golden" },
  items: [
    {
      case_id: "case_golden",
      input: { message: "hello" },
      expected_output: "world",
      metadata: {},
      source: {
        assetId: "asset_golden",
        parsedViewId: "view_golden",
        ordinal: 1,
        locator: { physicalLine: 2 },
        recordHash: "b".repeat(64),
      },
    },
  ],
};

function createFullFixture() {
  const input = structuredClone(fixture);
  const raw = "question,answer,category\nhello,world,golden\n";
  input.parsedView = {
    id: "view_golden",
    assetId: "asset_golden",
    parserName: "format-adapter",
    parserVersion: "parser-contract-v1",
    parserFormat: "csv",
    parserConfig: {
      delimiter: ",",
      encoding: "auto",
      headerRow: 1,
      quote: '"',
    },
    recordCount: 1,
  };
  input.items[0].source!.locator = {
    kind: "csv_row",
    dataRow: 1,
    physicalLine: 2,
  };
  input.items[0].source!.recordHash = sha256(
    canonicalJson({ question: "hello", answer: "world", category: "golden" }),
  );
  return {
    input,
    assets: [
      {
        assetId: "asset_golden",
        fileName: "golden.csv",
        sha256: sha256(raw),
        bytes: Buffer.from(raw),
      },
    ],
  };
}

function freezeRun(run: Record<string, unknown>) {
  const manifest = { ...run };
  delete manifest.id;
  delete manifest.manifestHash;
  return {
    ...run,
    manifestHash: transformationManifestHash(manifest),
  };
}

function reseal(archive: Record<string, Uint8Array>): void {
  const evidence = [
    "lineage.jsonl",
    "parse-views.json",
    "recipe.json",
    "schema.json",
    "source-attributions.json",
    "transformation-runs.jsonl",
  ].map((path) => ({
    path,
    sha256: sha256(archive[path]),
    size: archive[path].byteLength,
  }));
  const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
  manifest.version.evidence_hash = sha256(canonicalJson(evidence));
  delete manifest.version.version_manifest_hash;
  manifest.version.version_manifest_hash = sha256(canonicalJson(manifest));
  archive["manifest.json"] = strToU8(`${canonicalJson(manifest)}\n`);
  archive["checksums.sha256"] = strToU8(
    `${Object.keys(archive)
      .filter((name) => name !== "checksums.sha256")
      .sort()
      .map((name) => `${sha256(archive[name])}  ${name}`)
      .join("\n")}\n`,
  );
}

function asZip64(bytes: Uint8Array): Uint8Array {
  const source = Buffer.from(bytes);
  const eocdOffset = source.length - 22;
  const entryCount = source.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = source.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = source.readUInt32LE(eocdOffset + 16);

  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4);
  zip64Eocd.writeUInt16LE(45, 12);
  zip64Eocd.writeUInt16LE(45, 14);
  zip64Eocd.writeBigUInt64LE(BigInt(entryCount), 24);
  zip64Eocd.writeBigUInt64LE(BigInt(entryCount), 32);
  zip64Eocd.writeBigUInt64LE(BigInt(centralDirectorySize), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(centralDirectoryOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(eocdOffset), 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.from(source.subarray(eocdOffset));
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([
    source.subarray(0, eocdOffset),
    zip64Eocd,
    locator,
    eocd,
  ]);
}

function withDuplicateEntry(source: Uint8Array): Buffer {
  const bytes = Buffer.from(source);
  const eocdOffset = bytes.length - 22;
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const headerLength =
    46 +
    bytes.readUInt16LE(centralDirectoryOffset + 28) +
    bytes.readUInt16LE(centralDirectoryOffset + 30) +
    bytes.readUInt16LE(centralDirectoryOffset + 32);
  const centralDirectoryEnd = centralDirectoryOffset + headerLength;
  const duplicate = Buffer.from(
    bytes.subarray(centralDirectoryOffset, centralDirectoryEnd),
  );
  const eocd = Buffer.from(bytes.subarray(eocdOffset));
  eocd.writeUInt16LE(eocd.readUInt16LE(10) + 1, 10);
  eocd.writeUInt32LE(eocd.readUInt32LE(12) + headerLength, 12);
  return Buffer.concat([
    bytes.subarray(0, centralDirectoryEnd),
    duplicate,
    eocd,
  ]);
}

function withUnsupportedCompression(source: Uint8Array): Buffer {
  const bytes = Buffer.from(source);
  const eocdOffset = bytes.length - 22;
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const localOffset = bytes.readUInt32LE(centralDirectoryOffset + 42);
  bytes.writeUInt16LE(9, localOffset + 8);
  bytes.writeUInt16LE(9, centralDirectoryOffset + 10);
  return bytes;
}

describe("Offline Validator public contract", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentbench-validator-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns the stable machine-readable Standard Package report", async () => {
    const packagePath = join(directory, "standard.zip");
    const goldenFiles = await Promise.all(
      [...STANDARD_FILES]
        .sort()
        .map(async (name) => [
          name,
          await readFile(
            new URL(
              `../fixtures/standard-package-golden/${name}`,
              import.meta.url,
            ),
          ),
        ]),
    );
    const goldenPackage = zipSync(
      Object.fromEntries(
        goldenFiles.map(([name, bytes]) => [
          name,
          [bytes, { mtime: new Date("1980-01-01T00:00:00.000Z") }],
        ]),
      ),
      { level: 6 },
    );
    expect(sha256(goldenPackage)).toBe(
      "bfa00f4d259003f17b88d2ed932df9c2c3200beaef291c445e3df254d1ca8447",
    );
    await writeFile(packagePath, goldenPackage);
    await expect(validatePackage(packagePath)).resolves.toEqual({
      valid: true,
      package_type: "standard",
      verification_level: "standard",
      counts: { items: 1, record_level: 1, asset_level: 0 },
      errors: [],
      warnings: ["standard_package_excludes_raw_asset_bytes"],
    });
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        packagePath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      valid: true,
      package_type: "standard",
      verification_level: "standard",
      counts: { items: 1, record_level: 1, asset_level: 0 },
      errors: [],
      warnings: ["standard_package_excludes_raw_asset_bytes"],
    });
  });

  it("accepts a null expected output only in input_only mode", async () => {
    const packagePath = join(directory, "input-only.zip");
    const inputOnly = structuredClone(fixture);
    inputOnly.schema.mode = "input_only";
    inputOnly.items[0].expected_output = null;
    await writeFile(packagePath, createStandardPackage(inputOnly).bytes);
    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("consumes the independent input-only Standard Golden", async () => {
    const fixtureRoot = new URL(
      "../fixtures/standard-package-input-only-golden/",
      import.meta.url,
    );
    const bytes = await readFile(new URL("package.zip", fixtureRoot));
    const expected = JSON.parse(
      await readFile(new URL("expected.json", fixtureRoot), "utf8"),
    );
    expect(sha256(bytes)).toBe(expected.delivery_sha256);
    const packagePath = join(directory, "input-only-golden.zip");
    await writeFile(packagePath, bytes);
    await expect(validatePackage(packagePath)).resolves.toEqual(
      expected.report,
    );
  });

  it("accepts a scalar input when the frozen Formal Schema allows it", async () => {
    const packagePath = join(directory, "scalar-input.zip");
    const scalar = structuredClone(fixture);
    scalar.schema.input = { type: "string" };
    scalar.items[0].input = "hello" as any;
    await writeFile(packagePath, createStandardPackage(scalar).bytes);
    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("detects a changed evidence file even when its checksum is replaced", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    archive["recipe.json"] = strToU8('{"tampered":true}\n');
    const checksums = strFromU8(archive["checksums.sha256"])
      .trimEnd()
      .split("\n")
      .map((line) =>
        line.endsWith("  recipe.json")
          ? `${sha256(archive["recipe.json"])}  recipe.json`
          : line,
      )
      .join("\n");
    archive["checksums.sha256"] = strToU8(`${checksums}\n`);
    const packagePath = join(directory, "tampered.zip");
    await writeFile(packagePath, zipSync(archive));

    const report = await validatePackage(packagePath);
    expect(report.valid).toBe(false);
    expect(report.errors).toContain("evidence_hash_mismatch");
  });

  it("uses exit 2 for an unreadable invocation", () => {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        join(directory, "missing.zip"),
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("reports the actual package and verification level from the CLI", async () => {
    const fullFixture = createFullFixture();
    const fullPackage = createFullProvenancePackage(
      createStandardPackage(fullFixture.input).bytes,
      fullFixture.assets,
    );
    const packagePath = join(directory, "full-cli.zip");
    await writeFile(packagePath, fullPackage.bytes);

    const result = spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/validator/cli.ts", packagePath],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Full Provenance Package is valid");
    expect(result.stdout).toContain("verification level: full");
    expect(result.stdout).not.toContain("Standard Package is valid");
  });

  it("rejects a Full Provenance filename manifest that loses the frozen filename", async () => {
    const fullFixture = createFullFixture();
    const archive = unzipSync(
      createFullProvenancePackage(
        createStandardPackage(fullFixture.input).bytes,
        fullFixture.assets,
      ).bytes,
    );
    const manifest = JSON.parse(
      strFromU8(archive["filename-manifest.json"]),
    ) as { assets: Array<Record<string, unknown>> };
    delete manifest.assets[0].fileName;
    archive["filename-manifest.json"] = strToU8(`${canonicalJson(manifest)}\n`);
    const packagePath = join(directory, "full-filename-manifest.zip");
    await writeFile(packagePath, zipSync(archive));

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["provenance_manifest_invalid"]),
    });
  });

  it("rejects an extra Full-only file inside a Standard Package", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    archive["filename-manifest.json"] = strToU8("{}\n");
    const packagePath = join(directory, "standard-extra-file.zip");
    await writeFile(packagePath, zipSync(archive));

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["package_file_set_invalid"]),
    });
  });

  it("rejects Full Provenance asset, locator, record hash, path, and format corruption", async () => {
    const fullFixture = createFullFixture();
    const createArchive = () =>
      unzipSync(
        createFullProvenancePackage(
          createStandardPackage(fullFixture.input).bytes,
          fullFixture.assets,
        ).bytes,
      );
    const sealStandard = (archive: Record<string, Uint8Array>) => {
      const standard: Record<string, Uint8Array> = {};
      for (const [name, bytes] of Object.entries(archive)) {
        if (name.startsWith("version/")) standard[name.slice(8)] = bytes;
      }
      reseal(standard);
      for (const [name, bytes] of Object.entries(standard))
        archive[`version/${name}`] = bytes;
      return zipSync(archive);
    };

    const missingAsset = createArchive();
    delete missingAsset["assets/asset_golden/asset.bin"];
    const corruptedAsset = createArchive();
    corruptedAsset["assets/asset_golden/asset.bin"][0] ^= 1;
    const locatorMismatch = createArchive();
    const locator = JSON.parse(
      strFromU8(locatorMismatch["version/lineage.jsonl"]),
    );
    locator.source_record.locator.physicalLine = 3;
    locatorMismatch["version/lineage.jsonl"] = strToU8(
      `${canonicalJson(locator)}\n`,
    );
    const recordHashMismatch = createArchive();
    const lineage = JSON.parse(
      strFromU8(recordHashMismatch["version/lineage.jsonl"]),
    );
    lineage.source_record.recordHash = "a".repeat(64);
    recordHashMismatch["version/lineage.jsonl"] = strToU8(
      `${canonicalJson(lineage)}\n`,
    );
    const unsupportedFormat = createArchive();
    const manifest = JSON.parse(
      strFromU8(unsupportedFormat["version/manifest.json"]),
    );
    manifest.package_format_version = "1.1";
    unsupportedFormat["version/manifest.json"] = strToU8(
      `${canonicalJson(manifest)}\n`,
    );
    const traversal = createArchive();
    (traversal as Record<string, Uint8Array>)["../escape.txt"] =
      strToU8("unsafe\n");

    const cases: Array<[string, Uint8Array, string]> = [
      ["missing-asset", zipSync(missingAsset), "provenance_manifest_invalid"],
      ["asset-hash", zipSync(corruptedAsset), "provenance_asset_hash_mismatch"],
      [
        "locator",
        sealStandard(locatorMismatch),
        "provenance_source_locator_mismatch",
      ],
      [
        "record-hash",
        sealStandard(recordHashMismatch),
        "provenance_source_record_mismatch",
      ],
    ];
    for (const [name, bytes, expected] of cases) {
      const packagePath = join(directory, `full-${name}.zip`);
      await writeFile(packagePath, bytes);
      await expect(validatePackage(packagePath)).resolves.toMatchObject({
        valid: false,
        errors: expect.arrayContaining([expected]),
      });
    }

    const unsupportedPath = join(directory, "full-unsupported.zip");
    await writeFile(unsupportedPath, sealStandard(unsupportedFormat));
    await expect(validatePackage(unsupportedPath)).rejects.toBeInstanceOf(
      ValidatorInputError,
    );

    const traversalPath = join(directory, "full-traversal.zip");
    await writeFile(traversalPath, zipSync(traversal));
    await expect(validatePackage(traversalPath)).rejects.toBeInstanceOf(
      ValidatorInputError,
    );
  });

  it("validates a mixed CSV, JSON, and JSONL Full Provenance Golden", async () => {
    const records = [
      {
        assetId: "asset_csv",
        parsedViewId: "view_csv",
        parserFormat: "csv",
        parserConfig: {
          delimiter: ",",
          encoding: "auto",
          headerRow: 1,
          quote: '"',
        },
        locator: { kind: "csv_row", dataRow: 1, physicalLine: 2 },
        fields: { message: "csv question", answer: "csv answer" },
        bytes: Buffer.from("message,answer\ncsv question,csv answer\n"),
      },
      {
        assetId: "asset_json",
        parsedViewId: "view_json",
        parserFormat: "json",
        parserConfig: { recordPath: "" },
        locator: { kind: "json_pointer", pointer: "/0" },
        fields: { message: "json question", answer: "json answer" },
        bytes: Buffer.from(
          '[{"message":"json question","answer":"json answer"}]\n',
        ),
      },
      {
        assetId: "asset_jsonl",
        parsedViewId: "view_jsonl",
        parserFormat: "jsonl",
        parserConfig: {},
        locator: { kind: "jsonl_line", physicalLine: 1 },
        fields: { message: "jsonl question", answer: "jsonl answer" },
        bytes: Buffer.from(
          '{"message":"jsonl question","answer":"jsonl answer"}\n',
        ),
      },
    ];
    const input: StandardPackageInput = {
      ...structuredClone(fixture),
      sources: records.map((record) => ({
        parsedView: {
          id: record.parsedViewId,
          assetId: record.assetId,
          parserName: "format-adapter",
          parserVersion: "parser-contract-v1",
          parserFormat: record.parserFormat,
          parserConfig: record.parserConfig,
          recordCount: 1,
        },
        attribution: {
          id: `attribution_${record.assetId}`,
          assetId: record.assetId,
        },
      })),
      items: records.map((record, index) => ({
        case_id: `case_${index}`,
        input: { message: record.fields.message },
        expected_output: record.fields.answer,
        metadata: {},
        source: {
          assetId: record.assetId,
          parsedViewId: record.parsedViewId,
          ordinal: 1,
          locator: record.locator,
          recordHash: sha256(canonicalJson(record.fields)),
        },
      })),
    };
    const assets = records.map((record) => ({
      assetId: record.assetId,
      fileName: `${record.assetId}.${record.parserFormat}`,
      sha256: sha256(record.bytes),
      bytes: record.bytes,
    }));
    const first = createFullProvenancePackage(
      createStandardPackage(input).bytes,
      assets,
    );
    const second = createFullProvenancePackage(
      createStandardPackage(input).bytes,
      assets,
    );
    expect(first.bytes).toEqual(second.bytes);
    expect(first.deliveryHash).toBe(sha256(first.bytes));
    const packagePath = join(directory, "full-mixed-golden.zip");
    await writeFile(packagePath, first.bytes);
    await expect(validatePackage(packagePath)).resolves.toEqual({
      valid: true,
      package_type: "full_provenance",
      verification_level: "full",
      counts: { items: 3, record_level: 3, asset_level: 0 },
      errors: [],
      warnings: [],
    });
  });

  it("consumes the independent Full Golden through validator and CLI black-box seams", async () => {
    const fixtureRoot = new URL(
      "../fixtures/full-package-golden/",
      import.meta.url,
    );
    const packagePath = new URL("package.zip", fixtureRoot);
    const bytes = await readFile(packagePath);
    const expected = JSON.parse(
      await readFile(new URL("expected.json", fixtureRoot), "utf8"),
    );
    expect(sha256(bytes)).toBe(expected.delivery_sha256);
    const report = await validatePackage(packagePath.pathname);
    expect(report).toEqual(expected.report);

    const result = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        packagePath.pathname,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expected.report);
  });

  it("returns CLI exit 1 for readable corruption and exit 2 for unsafe ZIP paths", async () => {
    const fixtureRoot = new URL(
      "../fixtures/full-package-golden/",
      import.meta.url,
    );
    const original = await readFile(new URL("package.zip", fixtureRoot));
    const corruptedArchive = unzipSync(original);
    corruptedArchive["version/items.jsonl"] = strToU8(
      Buffer.from(corruptedArchive["version/items.jsonl"])
        .toString("utf8")
        .replace("hello", "tampered"),
    );
    const corruptedPath = join(directory, "cli-corrupt.zip");
    await writeFile(corruptedPath, zipSync(corruptedArchive));
    const corrupted = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        corruptedPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(corrupted.status).toBe(1);
    expect(JSON.parse(corrupted.stdout)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["checksum_mismatch"]),
    });

    const unsafeArchive = unzipSync(original);
    unsafeArchive["../escape.txt"] = strToU8("unsafe\n");
    const unsafePath = join(directory, "cli-unsafe.zip");
    await writeFile(unsafePath, zipSync(unsafeArchive));
    const unsafe = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        unsafePath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(unsafe.status).toBe(2);
    expect(unsafe.stdout).toBe("");

    const unsupportedPath = join(directory, "cli-unsupported.zip");
    await writeFile(unsupportedPath, withUnsupportedCompression(original));
    const unsupported = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        unsupportedPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(unsupported.status).toBe(2);
    expect(unsupported.stdout).toBe("");
  });

  it("keeps secret canaries out of CLI stdout and stderr", async () => {
    const secretCanary = "synthetic-password-SESSION-raw-record-prompt";
    const safe = structuredClone(fixture);
    safe.items[0].input.message = secretCanary;
    const safePath = join(directory, "cli-secret-valid.zip");
    await writeFile(safePath, createStandardPackage(safe).bytes);
    const safeResult = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        safePath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(safeResult.status).toBe(0);
    expect(safeResult.stdout).toContain('"valid":true');
    expect(safeResult.stdout + safeResult.stderr).not.toContain(secretCanary);

    const corrupted = unzipSync(createStandardPackage(fixture).bytes);
    const item = JSON.parse(strFromU8(corrupted["items.jsonl"]).trimEnd());
    item.input.message = secretCanary;
    corrupted["items.jsonl"] = strToU8(`${canonicalJson(item)}\n`);
    const corruptedPath = join(directory, "cli-secret-corrupt.zip");
    await writeFile(corruptedPath, zipSync(corrupted));

    const corruptedResult = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        corruptedPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(corruptedResult.status).toBe(1);
    expect(corruptedResult.stdout).toContain("checksum_mismatch");
    expect(corruptedResult.stdout + corruptedResult.stderr).not.toContain(
      secretCanary,
    );

    const unsafe = unzipSync(createStandardPackage(fixture).bytes);
    (unsafe as Record<string, Uint8Array>)[`../${secretCanary}.txt`] =
      strToU8("unsafe\n");
    const unsafePath = join(directory, "cli-secret-path.zip");
    await writeFile(unsafePath, zipSync(unsafe));
    const unsafeResult = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        unsafePath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(unsafeResult.status).toBe(2);
    expect(unsafeResult.stdout).toBe("");
    expect(unsafeResult.stderr).toContain(
      "Package contains an unsafe or duplicate path",
    );
    expect(unsafeResult.stdout + unsafeResult.stderr).not.toContain(
      secretCanary,
    );
  });

  it("covers the remaining single-factor corruption matrix", async () => {
    const fullBytes = await readFile(
      new URL("../fixtures/full-package-golden/package.zip", import.meta.url),
    );
    const standardArchive = () => {
      const full = unzipSync(fullBytes);
      const standard: Record<string, Uint8Array> = {};
      for (const [name, bytes] of Object.entries(full)) {
        if (name.startsWith("version/")) standard[name.slice(8)] = bytes;
      }
      return standard;
    };
    const seal = (archive: Record<string, Uint8Array>) =>
      zipSync(archive) as Uint8Array;
    const replaceChecksums = (archive: Record<string, Uint8Array>) => {
      archive["checksums.sha256"] = strToU8(
        `${Object.keys(archive)
          .filter((name) => name !== "checksums.sha256")
          .sort()
          .map((name) => `${sha256(archive[name])}  ${name}`)
          .join("\n")}\n`,
      );
    };

    const grammar = standardArchive();
    grammar["checksums.sha256"] = strToU8(
      `not-a-checksum  manifest.json\n${strFromU8(grammar["checksums.sha256"])
        .trimEnd()
        .split("\n")
        .slice(1)
        .join("\n")}\n`,
    );
    const checksumOrder = standardArchive();
    checksumOrder["checksums.sha256"] = strToU8(
      `${strFromU8(checksumOrder["checksums.sha256"]).trimEnd().split("\n").reverse().join("\n")}\n`,
    );
    const layeredHash = standardArchive();
    const layeredManifest = JSON.parse(strFromU8(layeredHash["manifest.json"]));
    layeredManifest.version.payload_hash = "0".repeat(64);
    delete layeredManifest.version.version_manifest_hash;
    layeredManifest.version.version_manifest_hash = sha256(
      canonicalJson(layeredManifest),
    );
    layeredHash["manifest.json"] = strToU8(
      `${canonicalJson(layeredManifest)}\n`,
    );
    replaceChecksums(layeredHash);
    const recursiveHash = standardArchive();
    const recursiveManifest = JSON.parse(
      strFromU8(recursiveHash["manifest.json"]),
    );
    recursiveManifest.version.version_manifest_hash = "0".repeat(64);
    recursiveManifest.version.version_manifest_hash = sha256(
      canonicalJson(recursiveManifest),
    );
    recursiveHash["manifest.json"] = strToU8(
      `${canonicalJson(recursiveManifest)}\n`,
    );
    replaceChecksums(recursiveHash);
    const blankLine = standardArchive();
    blankLine["items.jsonl"] = strToU8(
      `${strFromU8(blankLine["items.jsonl"])}\n`,
    );
    reseal(blankLine);
    const twoItems = structuredClone(fixture);
    twoItems.items.push(structuredClone(fixture.items[0]));
    twoItems.items[1].case_id = "case_golden_second";
    const lineOrderArchive = unzipSync(createStandardPackage(twoItems).bytes);
    const originalLines = strFromU8(lineOrderArchive["items.jsonl"])
      .trimEnd()
      .split("\n");
    lineOrderArchive["items.jsonl"] = strToU8(
      `${originalLines.reverse().join("\n")}\n`,
    );
    reseal(lineOrderArchive);
    const wrongNewline = standardArchive();
    wrongNewline["items.jsonl"] = strToU8(
      strFromU8(wrongNewline["items.jsonl"]).replaceAll("\n", "\r\n"),
    );
    reseal(wrongNewline);
    const invalidEncoding = standardArchive();
    invalidEncoding["items.jsonl"] = Buffer.from(
      Buffer.from(invalidEncoding["items.jsonl"]),
    );
    invalidEncoding["items.jsonl"][0] = 0xff;
    reseal(invalidEncoding);
    const schemaFailure = standardArchive();
    const schema = JSON.parse(strFromU8(schemaFailure["schema.json"]));
    schema.input.properties.message.type = "number";
    schemaFailure["schema.json"] = strToU8(`${canonicalJson(schema)}\n`);
    reseal(schemaFailure);

    const cases: Array<[string, Uint8Array, string]> = [
      ["grammar", seal(grammar), "checksum_grammar_invalid"],
      ["order", seal(checksumOrder), "checksum_order_invalid"],
      ["layered-hash", seal(layeredHash), "payload_hash_mismatch"],
      ["recursive-hash", seal(recursiveHash), "version_manifest_hash_mismatch"],
      ["blank-line", seal(blankLine), "canonical_encoding_invalid"],
      ["line-order", seal(lineOrderArchive), "payload_hash_mismatch"],
      ["newline", seal(wrongNewline), "canonical_encoding_invalid"],
      ["encoding", seal(invalidEncoding), "json_invalid"],
      ["schema", seal(schemaFailure), "formal_schema_invalid"],
    ];
    for (const [name, bytes, expected] of cases) {
      const packagePath = join(directory, `matrix-${name}.zip`);
      await writeFile(packagePath, bytes);
      await expect(validatePackage(packagePath)).resolves.toMatchObject({
        valid: false,
        errors: expect.arrayContaining([expected]),
      });
    }

    const duplicateItems = structuredClone(fixture);
    duplicateItems.items.push(structuredClone(fixture.items[0]));
    const duplicateIdentity = unzipSync(
      createStandardPackage(duplicateItems).bytes,
    );
    await writeFile(
      join(directory, "matrix-duplicate-case.zip"),
      seal(duplicateIdentity),
    );
    await expect(
      validatePackage(join(directory, "matrix-duplicate-case.zip")),
    ).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["case_identity_invalid"]),
    });

    const reserved = structuredClone(fixture);
    (reserved.items[0].metadata as Record<string, unknown>)._agentbench = {};
    const reservedArchive = unzipSync(createStandardPackage(reserved).bytes);
    await writeFile(
      join(directory, "matrix-reserved-metadata.zip"),
      seal(reservedArchive),
    );
    await expect(
      validatePackage(join(directory, "matrix-reserved-metadata.zip")),
    ).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["item_envelope_invalid"]),
    });

    const absolute = standardArchive();
    absolute["/absolute.txt"] = strToU8("unsafe\n");
    const bomb = standardArchive();
    bomb["items.jsonl"] = Buffer.alloc(10_000_001);
    const inputErrors: Array<[string, Uint8Array]> = [
      ["duplicate-entry", withDuplicateEntry(fullBytes)],
      ["absolute-path", seal(absolute)],
      ["unsupported-compression", withUnsupportedCompression(fullBytes)],
      ["resource-limit", seal(bomb)],
    ];
    for (const [name, bytes] of inputErrors) {
      const packagePath = join(directory, `unsafe-${name}.zip`);
      await writeFile(packagePath, bytes);
      await expect(validatePackage(packagePath)).rejects.toBeInstanceOf(
        ValidatorInputError,
      );
    }
  });

  it("rejects malformed Transformation Run evidence after valid rehashing", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    archive["transformation-runs.jsonl"] = strToU8("not-json\n");
    reseal(archive);
    const packagePath = join(directory, "bad-run.zip");
    await writeFile(packagePath, zipSync(archive));

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["transformation_runs_invalid"]),
    });
  });

  it("accepts honest asset-level lineage backed by frozen Transformation Run evidence", async () => {
    const input = structuredClone(fixture);
    input.items[0].lineage = {
      level: "asset_level",
      transformation_run: {
        id: "run_asset",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
      },
      input_scope: [
        {
          objectType: "test_set_version",
          id: input.version.id,
          sha256: "e".repeat(64),
          scope: { kind: "golden" },
        },
      ],
      output_asset: {
        assetId: "asset_golden",
        sha256: "c".repeat(64),
        recordCount: 1,
      },
    };
    input.transformationRuns = [
      freezeRun({
        id: "run_asset",
        schemaVersion: "1.0",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
        purpose: "Synthetic package fixture",
        tool: { name: "synthetic-tool", version: "1.0" },
        model: {
          provider: "synthetic-provider",
          name: "synthetic-model",
          parameters: {},
        },
        prompt: {
          version: "package-v1",
          sha256: sha256("Expand synthetic fixture data"),
          content: "Expand synthetic fixture data",
        },
        parameters: {},
        inputs: input.items[0].lineage.input_scope,
        outputs: [input.items[0].lineage.output_asset],
        executedBy: "user_owner",
        startedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: "2026-08-22T00:01:00.000Z",
      }),
    ];
    const packagePath = join(directory, "asset-lineage.zip");
    await writeFile(packagePath, createStandardPackage(input).bytes);

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: true,
      counts: { items: 1, record_level: 0, asset_level: 1 },
    });
  });

  it("requires Full Provenance bytes for every frozen Transformation asset", async () => {
    const fullFixture = createFullFixture();
    const inputBytes = Buffer.from("source asset\n");
    const outputBytes = Buffer.from("derived asset\n");
    const inputAsset = {
      assetId: "asset_input",
      fileName: "input.csv",
      sha256: sha256(inputBytes),
      bytes: inputBytes,
    };
    const outputAsset = {
      assetId: "asset_output",
      fileName: "output.csv",
      sha256: sha256(outputBytes),
      bytes: outputBytes,
    };
    const input = structuredClone(fullFixture.input);
    const runInputs = [
      {
        objectType: "data_asset",
        id: inputAsset.assetId,
        sha256: inputAsset.sha256,
        scope: { entireAsset: true },
      },
    ];
    const runOutput = {
      assetId: outputAsset.assetId,
      sha256: outputAsset.sha256,
      recordCount: 1,
    };
    input.items[0].lineage = {
      level: "asset_level",
      transformation_run: {
        id: "run_asset_closure",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
      },
      input_scope: runInputs,
      output_asset: runOutput,
    };
    input.transformationRuns = [
      freezeRun({
        id: "run_asset_closure",
        schemaVersion: "1.0",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
        purpose: "Synthetic asset closure fixture",
        tool: { name: "synthetic-tool", version: "1.0" },
        model: {
          provider: "synthetic-provider",
          name: "synthetic-model",
          parameters: {},
        },
        prompt: {
          version: "closure-v1",
          sha256: sha256("Closure fixture prompt"),
          content: "Closure fixture prompt",
        },
        parameters: {},
        inputs: runInputs,
        outputs: [runOutput],
        executedBy: "user_owner",
        startedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: "2026-08-22T00:01:00.000Z",
      }),
    ];
    const standard = createStandardPackage(input).bytes;
    const complete = createFullProvenancePackage(standard, [
      ...fullFixture.assets,
      inputAsset,
      outputAsset,
    ]);
    const completePath = join(directory, "asset-closure-complete.zip");
    await writeFile(completePath, complete.bytes);
    await expect(validatePackage(completePath)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });

    const missingOutput = createFullProvenancePackage(standard, [
      ...fullFixture.assets,
      inputAsset,
    ]);
    const missingOutputPath = join(directory, "asset-closure-output.zip");
    await writeFile(missingOutputPath, missingOutput.bytes);
    await expect(validatePackage(missingOutputPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["provenance_asset_missing"]),
    });

    const missingInput = createFullProvenancePackage(standard, [
      ...fullFixture.assets,
      outputAsset,
    ]);
    const missingInputPath = join(directory, "asset-closure-input.zip");
    await writeFile(missingInputPath, missingInput.bytes);
    await expect(validatePackage(missingInputPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["provenance_asset_missing"]),
    });
  });

  it("rejects a self-consistent Full asset that is not in the evidence closure", async () => {
    const fullFixture = createFullFixture();
    const extraBytes = Buffer.from("unreferenced asset\n");
    const packagePath = join(directory, "full-unreferenced-asset.zip");
    await writeFile(
      packagePath,
      createFullProvenancePackage(
        createStandardPackage(fullFixture.input).bytes,
        [
          ...fullFixture.assets,
          {
            assetId: "asset_extra",
            fileName: "extra.csv",
            sha256: sha256(extraBytes),
            bytes: extraBytes,
          },
        ],
      ).bytes,
    );

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["provenance_asset_unreferenced"]),
    });
  });

  it("accepts a complete non-Agent code/rule Transformation Run", async () => {
    const input = structuredClone(fixture);
    const parentInputs = [
      {
        objectType: "case_revision",
        id: "revision_parent",
        contentHash: "d".repeat(64),
      },
    ];
    input.items[0].lineage = {
      level: "record_level",
      transformation_run: {
        id: "run_code_rule",
        operationType: "code_rule",
        lineageLevel: "record_level",
      },
      parent_inputs: parentInputs,
    };
    input.transformationRuns = [
      freezeRun({
        id: "run_code_rule",
        schemaVersion: "1.0",
        operationType: "code_rule",
        lineageLevel: "record_level",
        purpose: "Apply the synthetic normalization rule",
        tool: {
          name: "normalizer",
          version: "1.0.0",
          codeRef: "git:abcdef",
        },
        parameters: {},
        inputs: [
          {
            objectType: "test_set_version",
            id: input.version.id,
            sha256: "e".repeat(64),
            scope: { kind: "golden" },
          },
        ],
        outputs: [
          { assetId: "asset_golden", sha256: "c".repeat(64), recordCount: 1 },
        ],
        recordEdges: [{ outputOrdinal: 1, inputs: parentInputs }],
        executedBy: "user_owner",
        startedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: "2026-08-22T00:01:00.000Z",
      }),
    ];
    const packagePath = join(directory, "code-rule-lineage.zip");
    await writeFile(packagePath, createStandardPackage(input).bytes);

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects unsupported operations and forged asset-level scope", async () => {
    const makePackageInput = (
      runOverrides: Record<string, unknown> = {},
      lineageOverrides: Record<string, unknown> = {},
    ) => {
      const input = structuredClone(fixture);
      const runInputs = [
        {
          objectType: "test_set_version",
          id: input.version.id,
          sha256: "e".repeat(64),
          scope: { kind: "golden" },
        },
      ];
      const runOutputs = [
        { assetId: "asset_golden", sha256: "c".repeat(64), recordCount: 1 },
      ];
      const run = {
        id: "run_asset_validation",
        schemaVersion: "1.0",
        operationType: "agent_augmentation",
        lineageLevel: "asset_level",
        purpose: "Synthetic package fixture",
        tool: { name: "synthetic-tool", version: "1.0" },
        model: {
          provider: "synthetic-provider",
          name: "synthetic-model",
          parameters: {},
        },
        prompt: {
          version: "package-v1",
          sha256: sha256("Expand synthetic fixture data"),
          content: "Expand synthetic fixture data",
        },
        parameters: {},
        inputs: runInputs,
        outputs: runOutputs,
        executedBy: "user_owner",
        startedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: "2026-08-22T00:01:00.000Z",
        ...runOverrides,
      };
      if (!("manifestHash" in run)) Object.assign(run, freezeRun(run));
      input.items[0].lineage = {
        level: "asset_level",
        transformation_run: {
          id: run.id,
          operationType: run.operationType,
          lineageLevel: run.lineageLevel,
        },
        input_scope: runInputs,
        output_asset: runOutputs[0],
        ...lineageOverrides,
      };
      input.transformationRuns = [run];
      return input;
    };

    const unsupportedPath = join(directory, "unsupported-operation.zip");
    await writeFile(
      unsupportedPath,
      createStandardPackage(makePackageInput({ operationType: "mystery_tool" }))
        .bytes,
    );
    await expect(validatePackage(unsupportedPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });

    const forgedPath = join(directory, "forged-asset-scope.zip");
    await writeFile(
      forgedPath,
      createStandardPackage(
        makePackageInput(
          {},
          {
            input_scope: [
              {
                objectType: "test_set_version",
                id: "different-version",
                sha256: "f".repeat(64),
                scope: { kind: "forged" },
              },
            ],
            output_asset: {
              assetId: "different-output",
              sha256: "f".repeat(64),
              recordCount: 1,
            },
          },
        ),
      ).bytes,
    );
    await expect(validatePackage(forgedPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });

    const hashPath = join(directory, "forged-run-hash.zip");
    await writeFile(
      hashPath,
      createStandardPackage(makePackageInput({ manifestHash: "f".repeat(64) }))
        .bytes,
    );
    await expect(validatePackage(hashPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });

    const missingHashPath = join(directory, "missing-run-hash.zip");
    const missingHashArchive = unzipSync(
      createStandardPackage(makePackageInput()).bytes,
    );
    const missingHashRun = JSON.parse(
      strFromU8(missingHashArchive["transformation-runs.jsonl"]).trimEnd(),
    );
    delete missingHashRun.manifestHash;
    missingHashArchive["transformation-runs.jsonl"] = strToU8(
      `${canonicalJson(missingHashRun)}\n`,
    );
    reseal(missingHashArchive);
    await writeFile(missingHashPath, zipSync(missingHashArchive));
    await expect(validatePackage(missingHashPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });
  });

  it("reports an oversized Transformation Run output instead of allocating an unbounded ordinal array", async () => {
    const input = structuredClone(fixture);
    input.items[0].lineage = {
      level: "record_level",
      transformation_run: {
        id: "run_oversized",
        operationType: "code_rule",
        lineageLevel: "record_level",
      },
      parent_inputs: [
        {
          objectType: "case_revision",
          id: "revision_parent",
          contentHash: "d".repeat(64),
        },
      ],
    };
    input.transformationRuns = [
      freezeRun({
        id: "run_oversized",
        schemaVersion: "1.0",
        operationType: "code_rule",
        lineageLevel: "record_level",
        purpose: "Oversized synthetic fixture",
        tool: { name: "normalizer", version: "1.0", codeRef: "git:abcdef" },
        parameters: {},
        inputs: [
          {
            objectType: "test_set_version",
            id: input.version.id,
            sha256: "e".repeat(64),
            scope: { kind: "golden" },
          },
        ],
        outputs: [
          {
            assetId: "asset_golden",
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
                id: "revision_parent",
                contentHash: "d".repeat(64),
              },
            ],
          },
        ],
        executedBy: "user_owner",
        startedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: "2026-08-22T00:01:00.000Z",
      }),
    ];
    const packagePath = join(directory, "oversized-run.zip");
    await writeFile(packagePath, createStandardPackage(input).bytes);

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });
  });

  it("rejects Agent record-level evidence missing model and Prompt context", async () => {
    const input = structuredClone(fixture);
    input.items[0].lineage = {
      level: "record_level",
      transformation_run: {
        id: "run_record",
        operationType: "agent_rewrite",
        lineageLevel: "record_level",
      },
      parent_inputs: [
        {
          objectType: "case_revision",
          id: "revision_parent",
          contentHash: "d".repeat(64),
        },
      ],
    };
    input.transformationRuns = [
      freezeRun({
        id: "run_record",
        schemaVersion: "1.0",
        operationType: "agent_rewrite",
        lineageLevel: "record_level",
        purpose: "Synthetic rewrite fixture",
        tool: { name: "synthetic-tool", version: "1.0" },
        parameters: {},
        inputs: [
          {
            objectType: "test_set_version",
            id: input.version.id,
            sha256: "e".repeat(64),
            scope: { kind: "golden" },
          },
        ],
        outputs: [
          {
            assetId: "asset_golden",
            sha256: "c".repeat(64),
            recordCount: 1,
          },
        ],
        recordEdges: [
          {
            outputOrdinal: 1,
            inputs: input.items[0].lineage.parent_inputs,
          },
        ],
        executedBy: "user_owner",
        startedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: "2026-08-22T00:01:00.000Z",
      }),
    ];
    const packagePath = join(directory, "incomplete-agent-record.zip");
    await writeFile(packagePath, createStandardPackage(input).bytes);

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });

    input.transformationRuns[0].model = {
      provider: "synthetic-provider",
      name: "synthetic-model",
      parameters: {},
    };
    input.transformationRuns[0].prompt = {
      version: "record-v1",
      sha256: sha256("Rewrite synthetic fixture"),
      content: "Rewrite synthetic fixture",
    };
    input.transformationRuns = [freezeRun(input.transformationRuns[0])];
    const completePath = join(directory, "complete-agent-record.zip");
    await writeFile(completePath, createStandardPackage(input).bytes);
    await expect(validatePackage(completePath)).resolves.toMatchObject({
      valid: true,
      counts: { items: 1, record_level: 1, asset_level: 0 },
    });

    const edgeArchive = unzipSync(createStandardPackage(input).bytes);
    const edgeRuns = JSON.parse(
      strFromU8(edgeArchive["transformation-runs.jsonl"]).trimEnd(),
    );
    edgeRuns.recordEdges[0].inputs[0].contentHash = "bad";
    edgeArchive["transformation-runs.jsonl"] = strToU8(
      `${canonicalJson(edgeRuns)}\n`,
    );
    reseal(edgeArchive);
    const edgePath = join(directory, "bad-agent-record-edge.zip");
    await writeFile(edgePath, zipSync(edgeArchive));
    await expect(validatePackage(edgePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });

    const promptArchive = unzipSync(createStandardPackage(input).bytes);
    const promptRuns = JSON.parse(
      strFromU8(promptArchive["transformation-runs.jsonl"]).trimEnd(),
    );
    promptRuns.prompt.sha256 = "e".repeat(64);
    promptArchive["transformation-runs.jsonl"] = strToU8(
      `${canonicalJson(promptRuns)}\n`,
    );
    reseal(promptArchive);
    const promptPath = join(directory, "bad-agent-record-prompt.zip");
    await writeFile(promptPath, zipSync(promptArchive));
    await expect(validatePackage(promptPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });
  });

  it("rejects lineage references missing from frozen asset/view evidence", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    const lineage = JSON.parse(strFromU8(archive["lineage.jsonl"]).trimEnd());
    lineage.source_record.assetId = "asset_missing";
    archive["lineage.jsonl"] = strToU8(`${canonicalJson(lineage)}\n`);
    reseal(archive);
    const packagePath = join(directory, "dangling-lineage.zip");
    await writeFile(packagePath, zipSync(archive));

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_reference_invalid"]),
    });
  });

  it("validates per-output parents for a multi-output Agent rewrite", async () => {
    const input = structuredClone(fixture);
    const parentA = {
      objectType: "case_revision",
      id: "revision_a",
      contentHash: "a".repeat(64),
    };
    const parentB = {
      objectType: "case_revision",
      id: "revision_b",
      contentHash: "b".repeat(64),
    };
    const run = {
      id: "run_multi",
      schemaVersion: "1.0",
      operationType: "agent_rewrite",
      lineageLevel: "record_level",
      purpose: "Synthetic multi-output rewrite",
      tool: { name: "synthetic-tool", version: "1.0" },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: {},
      },
      prompt: {
        version: "multi-v1",
        sha256: sha256("Rewrite each synthetic record"),
        content: "Rewrite each synthetic record",
      },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: input.version.id,
          sha256: "e".repeat(64),
          scope: { kind: "golden" },
        },
      ],
      outputs: [
        {
          assetId: "asset_golden",
          sha256: "c".repeat(64),
          recordCount: 2,
        },
      ],
      recordEdges: [
        { outputOrdinal: 1, inputs: [parentA] },
        { outputOrdinal: 2, inputs: [parentB] },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T00:00:00.000Z",
      finishedAt: "2026-08-22T00:01:00.000Z",
    };
    const transformedLineage = (parent: unknown) => ({
      level: "record_level",
      transformation_run: {
        id: run.id,
        operationType: run.operationType,
        lineageLevel: run.lineageLevel,
      },
      parent_inputs: [parent],
    });
    input.items.push({
      case_id: "case_golden_2",
      input: { message: "second" },
      expected_output: "rewritten",
      metadata: {},
    });
    input.items[0].lineage = transformedLineage(parentA);
    input.items[1].lineage = transformedLineage(parentB);
    input.transformationRuns = [freezeRun(run)];

    const validPath = join(directory, "multi-agent-record.zip");
    await writeFile(validPath, createStandardPackage(input).bytes);
    await expect(validatePackage(validPath)).resolves.toMatchObject({
      valid: true,
      counts: { items: 2, record_level: 2, asset_level: 0 },
    });

    input.items[0].lineage.parent_inputs = [parentB];
    const swappedPath = join(directory, "multi-agent-record-swapped.zip");
    await writeFile(swappedPath, createStandardPackage(input).bytes);
    await expect(validatePackage(swappedPath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });
  });

  it("rejects an incomplete record-level Source Record reference", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    const lineage = JSON.parse(strFromU8(archive["lineage.jsonl"]).trimEnd());
    delete lineage.source_record.ordinal;
    delete lineage.source_record.recordHash;
    archive["lineage.jsonl"] = strToU8(`${canonicalJson(lineage)}\n`);
    reseal(archive);
    const packagePath = join(directory, "incomplete-lineage.zip");
    await writeFile(packagePath, zipSync(archive));

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_reference_invalid"]),
    });
  });

  it("accepts filtered record-level outputs whose ordinals are not package indexes", async () => {
    const input = structuredClone(fixture);
    const parents = ["a", "b", "c"].map((letter) => ({
      objectType: "case_revision",
      id: `revision_${letter}`,
      contentHash: letter.repeat(64),
    }));
    const run = {
      id: "run_filtered",
      schemaVersion: "1.0",
      operationType: "agent_rewrite",
      lineageLevel: "record_level",
      purpose: "Synthetic filtered rewrite",
      tool: { name: "synthetic-tool", version: "1.0" },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: {},
      },
      prompt: {
        version: "filtered-v1",
        sha256: sha256("Rewrite filtered synthetic records"),
        content: "Rewrite filtered synthetic records",
      },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: input.version.id,
          sha256: "e".repeat(64),
          scope: { kind: "golden" },
        },
      ],
      outputs: [
        { assetId: "asset_golden", sha256: "c".repeat(64), recordCount: 3 },
      ],
      recordEdges: parents.map((parent, index) => ({
        outputOrdinal: index + 1,
        inputs: [parent],
      })),
      executedBy: "user_owner",
      startedAt: "2026-08-22T00:00:00.000Z",
      finishedAt: "2026-08-22T00:01:00.000Z",
    };
    input.items.push({
      case_id: "case_golden_2",
      input: { message: "second" },
      expected_output: "rewritten",
      metadata: {},
    });
    const transformedLineage = (parent: unknown) => ({
      level: "record_level",
      transformation_run: {
        id: run.id,
        operationType: run.operationType,
        lineageLevel: run.lineageLevel,
      },
      parent_inputs: [parent],
    });
    input.items[0].lineage = transformedLineage(parents[2]);
    input.items[1].lineage = transformedLineage(parents[1]);
    input.transformationRuns = [freezeRun(run)];

    const packagePath = join(directory, "filtered-record-lineage.zip");
    await writeFile(packagePath, createStandardPackage(input).bytes);
    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: true,
      counts: { items: 2, record_level: 2, asset_level: 0 },
    });
  });

  it("rejects truthy but non-object manual lineage evidence", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    const lineage = JSON.parse(strFromU8(archive["lineage.jsonl"]).trimEnd());
    delete lineage.source_record;
    lineage.manual_creation = [];
    archive["lineage.jsonl"] = strToU8(`${canonicalJson(lineage)}\n`);
    reseal(archive);
    const packagePath = join(directory, "empty-manual-lineage.zip");
    await writeFile(packagePath, zipSync(archive));

    await expect(validatePackage(packagePath)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["lineage_invalid"]),
    });
  });

  it("rejects a ZIP entry marked as a symbolic link", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    const packagePath = join(directory, "symlink.zip");
    await writeFile(
      packagePath,
      zipSync({
        ...archive,
        "manifest.json": [
          archive["manifest.json"],
          { os: 3, attrs: 0o120777 << 16 },
        ],
      }),
    );

    await expect(validatePackage(packagePath)).rejects.toBeInstanceOf(
      ValidatorInputError,
    );
  });

  it("rejects a ZIP64 package instead of bypassing link checks", async () => {
    const archive = unzipSync(createStandardPackage(fixture).bytes);
    const packagePath = join(directory, "symlink-zip64.zip");
    const symlinkPackage = zipSync({
      ...archive,
      "manifest.json": [
        archive["manifest.json"],
        { os: 3, attrs: 0o120777 << 16 },
      ],
    });
    await writeFile(packagePath, asZip64(symlinkPackage));

    await expect(validatePackage(packagePath)).rejects.toBeInstanceOf(
      ValidatorInputError,
    );
  });
});
