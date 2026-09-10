import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createStandardEvidence,
  createStandardPackage,
  sha256,
  STANDARD_FILES,
  type StandardPackageInput,
} from "../../src/package/contract.js";

describe("Package Contract v1 canonical JSON fixture", () => {
  it("matches the independently frozen UTF-8 bytes and SHA-256", () => {
    const canonical = canonicalJson({
      b: 1,
      a: "中",
      nested: { z: null, y: [true, 2] },
    });
    expect(canonical).toBe('{"a":"中","b":1,"nested":{"y":[true,2],"z":null}}');
    expect(sha256(canonical)).toBe(
      "8c6996f50292c63b7c50170e279d728843df2a0126810f02fe1dc1579380f218",
    );
  });

  it("rejects values that JSON cannot represent without data loss", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(
      "JSON-representable",
    );
    expect(() => canonicalJson({ number: Number.POSITIVE_INFINITY })).toThrow(
      "JSON-representable",
    );
    expect(() => canonicalJson(1n)).toThrow("JSON-representable");
  });

  it("commits file path, digest and byte size in the layered hashes", () => {
    const result = createStandardPackage({
      testSet: { id: "testset_fixture", name: "Fixture" },
      version: {
        id: "version_fixture",
        number: 1,
        publishedAt: "2026-08-18T00:00:00.000Z",
      },
      schema: {
        dialect: "https://json-schema.org/draft/2020-12/schema",
        revisionId: "schema_fixture",
        mode: "gold_required",
        input: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        expectedOutput: { type: "string" },
      },
      recipe: { filter: { field: "kind", operator: "eq", value: "ok" } },
      attribution: { id: "attribution_fixture", assetId: "asset_fixture" },
      parsedView: { id: "view_fixture", assetId: "asset_fixture" },
      items: [
        {
          case_id: "case_fixture",
          input: { message: "hello" },
          expected_output: "world",
          metadata: {},
          source: {
            assetId: "asset_fixture",
            parsedViewId: "view_fixture",
            ordinal: 1,
            locator: { physicalLine: 2 },
            recordHash: "a".repeat(64),
          },
        },
      ],
    });
    const manifest = JSON.parse(String(result.files["manifest.json"]));
    const withoutOwnHash = structuredClone(manifest);
    delete withoutOwnHash.version.version_manifest_hash;

    expect(result.evidenceHash).toBe(
      sha256(
        canonicalJson(
          [
            "lineage.jsonl",
            "parse-views.json",
            "recipe.json",
            "schema.json",
            "source-attributions.json",
            "transformation-runs.jsonl",
          ].map((path) => ({
            path,
            sha256: sha256(result.files[path]),
            size: Buffer.byteLength(result.files[path]),
          })),
        ),
      ),
    );
    expect(result.versionManifestHash).toBe(
      sha256(canonicalJson(withoutOwnHash)),
    );
  });

  it("matches the independent full-package Golden files and ZIP hash", async () => {
    const goldenInput = {
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
    } satisfies StandardPackageInput;
    const result = createStandardPackage(goldenInput);
    for (const name of STANDARD_FILES) {
      const golden = await readFile(
        new URL(`../fixtures/standard-package-golden/${name}`, import.meta.url),
        "utf8",
      );
      expect(String(result.files[name])).toBe(golden);
    }
    expect(result.deliveryHash).toBe(
      "bfa00f4d259003f17b88d2ed932df9c2c3200beaef291c445e3df254d1ca8447",
    );
    expect(createStandardPackage(goldenInput).bytes).toEqual(result.bytes);
    const evidenceOnly = createStandardEvidence({
      ...goldenInput,
      itemsSha256: result.payloadHash,
    });
    expect(Object.keys(evidenceOnly.files).sort()).toEqual([
      "lineage.jsonl",
      "parse-views.json",
      "recipe.json",
      "schema.json",
      "source-attributions.json",
      "transformation-runs.jsonl",
    ]);
    expect(evidenceOnly.payloadHash).toBe(result.payloadHash);
    expect(evidenceOnly.evidenceHash).toBe(result.evidenceHash);
  });
});
