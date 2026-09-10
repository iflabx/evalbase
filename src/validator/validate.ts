import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { strFromU8, unzipSync } from "fflate";

import {
  canonicalJson,
  EVIDENCE_FILES,
  sha256,
  STANDARD_FILES,
} from "../package/contract.js";
import { validateFormalItems } from "../schema/formal.js";
import { parseSourceRecords } from "../parser/index.js";
import {
  transformationManifestHash,
  validateTransformationManifest,
} from "../transformation/index.js";

export interface ValidationReport {
  valid: boolean;
  package_type: "standard" | "full_provenance";
  verification_level: "standard" | "full";
  counts: { items: number; record_level: number; asset_level: number };
  errors: string[];
  warnings: string[];
}

export class ValidatorInputError extends Error {
  readonly exitCode = 2;
}

function report(
  errors: string[],
  counts = { items: 0, record_level: 0, asset_level: 0 },
  packageType: "standard" | "full_provenance" = "standard",
): ValidationReport {
  return {
    valid: errors.length === 0,
    package_type: packageType,
    verification_level: packageType === "standard" ? "standard" : "full",
    counts,
    errors: [...new Set(errors)],
    warnings:
      packageType === "standard"
        ? ["standard_package_excludes_raw_asset_bytes"]
        : [],
  };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function assertNoSymbolicLinks(bytes: Buffer): void {
  const searchStart = Math.max(0, bytes.length - 65_557);
  let endOfCentralDirectory = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) return;

  const entryCount = bytes.readUInt16LE(endOfCentralDirectory + 10);
  const centralDirectorySize = bytes.readUInt32LE(endOfCentralDirectory + 12);
  let offset = bytes.readUInt32LE(endOfCentralDirectory + 16);
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    offset === 0xffffffff
  )
    throw new ValidatorInputError("ZIP64 packages are not supported");
  const centralDirectoryEnd = offset + centralDirectorySize;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new ValidatorInputError("Package central directory is invalid");
    const unixMode = bytes.readUInt32LE(offset + 38) >>> 16;
    if ((unixMode & 0o170000) === 0o120000)
      throw new ValidatorInputError("Package contains a symbolic link");
    offset +=
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  if (offset !== centralDirectoryEnd || centralDirectoryEnd > bytes.length)
    throw new ValidatorInputError("Package central directory is invalid");
}

export async function validatePackage(path: string): Promise<ValidationReport> {
  let compressed: Awaited<ReturnType<typeof stat>>;
  let bytes: Buffer;
  try {
    compressed = await stat(path);
    bytes = await readFile(path);
  } catch {
    throw new ValidatorInputError("Package is missing or unreadable");
  }
  if (!compressed.isFile())
    throw new ValidatorInputError("Package is missing or unreadable");
  return await validatePackageBytes(bytes, compressed.size);
}

export async function validatePackageBytes(
  source: Uint8Array,
  compressedSize = source.byteLength,
): Promise<ValidationReport> {
  const bytes = Buffer.from(source);
  if (compressedSize > 250_000_000)
    throw new ValidatorInputError("Package exceeds compressed size limit");
  assertNoSymbolicLinks(bytes);

  const seen = new Set<string>();
  let expandedSize = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter: (file) => {
        const standardPath = file.name.startsWith("version/")
          ? file.name.slice("version/".length)
          : file.name;
        const isStandardFile = (STANDARD_FILES as readonly string[]).includes(
          standardPath,
        );
        const isVersionFile = file.name.startsWith("version/");
        const allowedPath =
          (isVersionFile && isStandardFile) ||
          (!isVersionFile &&
            (isStandardFile ||
              file.name === "filename-manifest.json" ||
              /^assets\/[a-z0-9_-]+\/asset\.bin$/u.test(file.name)));
        if (
          !allowedPath ||
          seen.has(file.name) ||
          file.name.includes("..") ||
          file.name.startsWith("/")
        )
          throw new ValidatorInputError(
            "Package contains an unsafe or duplicate path",
          );
        seen.add(file.name);
        const entryLimit =
          standardPath === "items.jsonl"
            ? 100_000_000
            : file.name.endsWith("/asset.bin")
              ? 50_000_000
              : 10_000_000;
        expandedSize += file.originalSize;
        if (
          file.originalSize > entryLimit ||
          expandedSize > 250_000_000 ||
          file.originalSize > Math.max(1, file.size) * 100
        )
          throw new ValidatorInputError(
            "Package exceeds extraction resource limits",
          );
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ValidatorInputError) throw error;
    throw new ValidatorInputError("Package is not a safe readable ZIP");
  }

  const names = Object.keys(archive).sort();
  const packageType = names.includes("version/manifest.json")
    ? "full_provenance"
    : "standard";
  const standardArchive =
    packageType === "full_provenance"
      ? Object.fromEntries(
          Object.entries(archive)
            .filter(([name]) => name.startsWith("version/"))
            .map(([name, bytes]) => [name.slice("version/".length), bytes]),
        )
      : archive;
  const standardNames = Object.keys(standardArchive).sort();
  if (
    JSON.stringify(standardNames) !== JSON.stringify([...STANDARD_FILES].sort())
  )
    return report(["package_file_set_invalid"], undefined, packageType);
  if (
    packageType === "full_provenance" &&
    names.some(
      (name) =>
        !name.startsWith("version/") &&
        name !== "filename-manifest.json" &&
        !/^assets\/[a-z0-9_-]+\/asset\.bin$/u.test(name),
    )
  )
    return report(["package_file_set_invalid"], undefined, packageType);
  if (
    packageType === "full_provenance" &&
    !names.includes("filename-manifest.json")
  )
    return report(["package_file_set_invalid"], undefined, packageType);
  const text = Object.fromEntries(
    standardNames.map((name) => [name, strFromU8(standardArchive[name])]),
  );
  const errors: string[] = [];

  const checksumLines = text["checksums.sha256"].trimEnd().split("\n");
  const checksums = new Map<string, string>();
  const checksumPaths: string[] = [];
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64}) {2}([a-z0-9.-]+)$/.exec(line);
    if (!match || checksums.has(match?.[2])) {
      errors.push("checksum_grammar_invalid");
      continue;
    }
    checksums.set(match[2], match[1]);
    checksumPaths.push(match[2]);
  }
  const checkedNames = standardNames.filter(
    (name) => name !== "checksums.sha256",
  );
  if (
    checksums.size !== checkedNames.length ||
    checkedNames.some((name) => !checksums.has(name))
  )
    errors.push("checksum_file_set_invalid");
  if (JSON.stringify(checksumPaths) !== JSON.stringify(checkedNames.sort()))
    errors.push("checksum_order_invalid");
  for (const name of checkedNames) {
    if (checksums.get(name) !== sha256(standardArchive[name]))
      errors.push("checksum_mismatch");
  }
  if (errors.length) return report(errors, undefined, packageType);

  let manifest: any;
  let schema: any;
  let items: any[];
  let lineage: any[];
  let parsedView: any;
  let recipe: any;
  let attribution: any;
  let transformationRuns: any[] = [];
  let filenameManifest: any;
  try {
    manifest = parseJson(text["manifest.json"]);
    schema = parseJson(text["schema.json"]);
    items = text["items.jsonl"]
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map(parseJson);
    lineage = text["lineage.jsonl"]
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map(parseJson);
    parsedView = parseJson(text["parse-views.json"]);
    recipe = parseJson(text["recipe.json"]);
    attribution = parseJson(text["source-attributions.json"]);
    if (packageType === "full_provenance")
      filenameManifest = parseJson(
        strFromU8(archive["filename-manifest.json"]),
      );
  } catch {
    return report(["json_invalid"], undefined, packageType);
  }
  try {
    transformationRuns = text["transformation-runs.jsonl"]
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map(parseJson);
  } catch {
    errors.push("transformation_runs_invalid");
  }
  if (manifest.package_format_version !== "1.0")
    throw new ValidatorInputError("Unsupported package format");

  try {
    const itemSourceLines = text["items.jsonl"].endsWith("\n")
      ? text["items.jsonl"].slice(0, -1).split("\n")
      : [];
    const lineageSourceLines = text["lineage.jsonl"].endsWith("\n")
      ? text["lineage.jsonl"].slice(0, -1).split("\n")
      : [];
    const transformationSourceLines = text["transformation-runs.jsonl"]
      ? text["transformation-runs.jsonl"].endsWith("\n")
        ? text["transformation-runs.jsonl"].slice(0, -1).split("\n")
        : []
      : [];
    const canonicalJsonFiles: Array<[string, unknown]> = [
      ["manifest.json", manifest],
      ["schema.json", schema],
      ["parse-views.json", parsedView],
      ["recipe.json", recipe],
      ["source-attributions.json", attribution],
    ];
    if (
      canonicalJsonFiles.some(
        ([name, value]) => text[name] !== `${canonicalJson(value)}\n`,
      ) ||
      !text["items.jsonl"].endsWith("\n") ||
      !text["lineage.jsonl"].endsWith("\n") ||
      text["items.jsonl"].includes("\n\n") ||
      text["lineage.jsonl"].includes("\n\n") ||
      items.some(
        (item, index) => canonicalJson(item) !== itemSourceLines[index],
      ) ||
      lineage.some(
        (entry, index) => canonicalJson(entry) !== lineageSourceLines[index],
      ) ||
      (text["transformation-runs.jsonl"] !== "" &&
        (!text["transformation-runs.jsonl"].endsWith("\n") ||
          text["transformation-runs.jsonl"].includes("\n\n") ||
          transformationRuns.some(
            (entry, index) =>
              canonicalJson(entry) !== transformationSourceLines[index],
          )))
    )
      errors.push("canonical_encoding_invalid");

    const expectedEvidenceFiles = {
      lineage: "lineage.jsonl",
      parse_views: "parse-views.json",
      recipe: "recipe.json",
      source_attributions: "source-attributions.json",
      transformation_runs: "transformation-runs.jsonl",
    };
    if (
      manifest.checksums_file !== "checksums.sha256" ||
      manifest.items?.file !== "items.jsonl" ||
      manifest.items?.format !== "jsonl" ||
      manifest.formal_schema?.file !== "schema.json" ||
      manifest.formal_schema?.revision_id !== schema.revisionId ||
      manifest.formal_schema?.mode !== schema.mode ||
      canonicalJson(manifest.evidence_files) !==
        canonicalJson(expectedEvidenceFiles)
    )
      errors.push("manifest_contract_invalid");
  } catch {
    errors.push("canonical_encoding_invalid");
  }

  const counts = {
    items: items.length,
    record_level: lineage.filter((entry) => entry?.level === "record_level")
      .length,
    asset_level: lineage.filter((entry) => entry?.level === "asset_level")
      .length,
  };
  if (
    counts.items !== manifest.counts?.items ||
    counts.record_level !== manifest.counts?.record_level ||
    counts.asset_level !== manifest.counts?.asset_level ||
    lineage.length !== items.length
  )
    errors.push("count_mismatch");
  const isObject = (value: unknown) =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const validParent = (value: unknown) =>
    isObject(value) &&
    typeof (value as any).caseId === "string" &&
    !!(value as any).caseId &&
    typeof (value as any).revisionId === "string" &&
    !!(value as any).revisionId;
  const validManual = (value: unknown) =>
    isObject(value) &&
    typeof (value as any).actorId === "string" &&
    !!(value as any).actorId &&
    typeof (value as any).reason === "string" &&
    !!(value as any).reason;
  const validSource = (value: unknown) =>
    isObject(value) &&
    typeof (value as any).parsedViewId === "string" &&
    !!(value as any).parsedViewId;
  const nonEmpty = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;
  const usedRecordEdges = new Set<string>();
  const validFrozenRun = (value: unknown, level: string) => {
    if (!isObject(value)) return false;
    const run = transformationRuns.find(
      (item) => item?.id === (value as any).id,
    ) as any;
    if (!run || !isObject(run)) return false;
    const manifest = { ...run };
    delete manifest.id;
    delete manifest.manifestHash;
    const report = validateTransformationManifest(manifest);
    return (
      typeof (value as any).id === "string" &&
      !!(value as any).id &&
      report.valid &&
      /^[a-f0-9]{64}$/.test(run.manifestHash ?? "") &&
      run.manifestHash === transformationManifestHash(manifest) &&
      run.lineageLevel === level &&
      run.id === (value as any).id
    );
  };
  const validAssetLineage = (entry: any) => {
    if (!validFrozenRun(entry?.transformation_run, "asset_level")) return false;
    if (!Array.isArray(entry?.input_scope) || !entry.input_scope.length)
      return false;
    if (!isObject(entry?.output_asset)) return false;
    const run = transformationRuns.find(
      (item: any) => item?.id === entry?.transformation_run?.id,
    ) as any;
    return (
      canonicalJson(entry.input_scope) === canonicalJson(run.inputs) &&
      canonicalJson(entry.output_asset) === canonicalJson(run.outputs[0]) &&
      entry.input_scope.every(
        (input: any) => isObject(input) && /^[a-f0-9]{64}$/.test(input.sha256),
      ) &&
      typeof entry.output_asset.assetId === "string" &&
      /^[a-f0-9]{64}$/.test(entry.output_asset.sha256 ?? "") &&
      Number.isInteger(entry.output_asset.recordCount)
    );
  };
  const validTransformedRecordLineage = (entry: any) => {
    if (
      !validFrozenRun(entry?.transformation_run, "record_level") ||
      !Array.isArray(entry?.parent_inputs) ||
      !entry.parent_inputs.length ||
      !entry.parent_inputs.every(
        (input: any) =>
          isObject(input) &&
          ((input.objectType === "source_record" &&
            nonEmpty(input.parsedViewId) &&
            Number.isInteger(input.ordinal) &&
            /^[a-f0-9]{64}$/.test(input.recordHash ?? "")) ||
            (input.objectType === "case_revision" &&
              nonEmpty(input.id) &&
              /^[a-f0-9]{64}$/.test(input.contentHash ?? ""))),
      )
    )
      return false;
    const run = transformationRuns.find(
      (item: any) => item?.id === entry.transformation_run.id,
    ) as any;
    const edge = run.recordEdges.find((candidate: any) => {
      const edgeKey = `${run.id}:${Number(candidate?.outputOrdinal)}`;
      return (
        !usedRecordEdges.has(edgeKey) &&
        canonicalJson(candidate?.inputs ?? []) ===
          canonicalJson(entry.parent_inputs)
      );
    });
    if (!edge) return false;
    usedRecordEdges.add(`${run.id}:${Number(edge.outputOrdinal)}`);
    return true;
  };
  if (
    lineage.some((entry) => {
      const origins = [
        validSource(entry?.source_record),
        validParent(entry?.parent_case_revision),
        validManual(entry?.manual_creation),
      ].filter(Boolean).length;
      if (entry?.level === "asset_level") return !validAssetLineage(entry);
      return (
        entry?.level !== "record_level" ||
        !(
          (origins === 1 && !entry.transformation_run) ||
          (origins === 0 && validTransformedRecordLineage(entry))
        )
      );
    })
  )
    errors.push("lineage_invalid");
  if (
    new Set(items.map((item) => item?.case_id)).size !== items.length ||
    lineage.some((entry, index) => entry?.case_id !== items[index]?.case_id)
  )
    errors.push("case_identity_invalid");

  const parsedViews = Array.isArray(parsedView) ? parsedView : [parsedView];
  const attributions = Array.isArray(attribution) ? attribution : [attribution];
  if (
    lineage.some((entry) => {
      const source = entry?.source_record;
      if (!source) return false;
      const view = parsedViews.find(
        (item) => item?.id === source?.parsedViewId,
      );
      return (
        typeof source?.assetId !== "string" ||
        typeof source?.parsedViewId !== "string" ||
        !Number.isInteger(source?.ordinal) ||
        source.ordinal < 1 ||
        !source.locator ||
        typeof source.locator !== "object" ||
        Array.isArray(source.locator) ||
        !/^[a-f0-9]{64}$/.test(source?.recordHash ?? "") ||
        !view ||
        view.assetId !== source.assetId ||
        (Number.isInteger(view.recordCount) &&
          source.ordinal > view.recordCount) ||
        !attributions.some((item) => item?.assetId === source.assetId)
      );
    })
  )
    errors.push("lineage_reference_invalid");

  if (manifest.version?.payload_hash !== sha256(text["items.jsonl"]))
    errors.push("payload_hash_mismatch");
  if (manifest.formal_schema?.sha256 !== sha256(text["schema.json"]))
    errors.push("schema_hash_mismatch");
  const calculatedEvidenceHash = sha256(
    canonicalJson(
      EVIDENCE_FILES.map((evidencePath) => ({
        path: evidencePath,
        sha256: sha256(standardArchive[evidencePath]),
        size: standardArchive[evidencePath].byteLength,
      })),
    ),
  );
  if (manifest.version?.evidence_hash !== calculatedEvidenceHash)
    errors.push("evidence_hash_mismatch");
  try {
    const manifestWithoutOwnHash = structuredClone(manifest);
    delete manifestWithoutOwnHash.version.version_manifest_hash;
    if (
      manifest.version?.version_manifest_hash !==
      sha256(canonicalJson(manifestWithoutOwnHash))
    )
      errors.push("version_manifest_hash_mismatch");
  } catch {
    errors.push("version_manifest_invalid");
  }

  if (
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    !["gold_required", "input_only"].includes(schema.mode)
  )
    errors.push("schema_contract_invalid");
  if (
    items.some(
      (item) =>
        !item?.case_id ||
        !("input" in item) ||
        (schema.mode === "gold_required" && item.expected_output == null) ||
        !item.metadata ||
        typeof item.metadata !== "object" ||
        Array.isArray(item.metadata) ||
        "_agentbench" in item.metadata,
    )
  )
    errors.push("item_envelope_invalid");
  else {
    try {
      const formal = validateFormalItems(
        schema.input,
        schema.expectedOutput,
        items,
        schema.mode,
      );
      if (!formal.valid) errors.push("formal_schema_invalid");
    } catch {
      errors.push("formal_schema_contract_invalid");
    }
  }
  if (packageType === "full_provenance") {
    if (
      strFromU8(archive["filename-manifest.json"]) !==
      `${canonicalJson(filenameManifest)}\n`
    )
      errors.push("provenance_manifest_invalid");
    const listedAssets = Array.isArray(filenameManifest?.assets)
      ? filenameManifest.assets
      : [];
    const assetPaths = names
      .filter((name) => name.startsWith("assets/"))
      .sort();
    const listedAssetIds = new Set<string>();
    const validManifestAssets = listedAssets.every((asset: any) => {
      const valid =
        typeof asset?.assetId === "string" &&
        !!asset.assetId &&
        !listedAssetIds.has(asset.assetId) &&
        typeof asset?.fileName === "string" &&
        !!asset.fileName &&
        /^[a-f0-9]{64}$/u.test(asset?.sha256 ?? "") &&
        Number.isInteger(asset?.size) &&
        asset?.size >= 0 &&
        asset?.path === `assets/${asset.assetId}/asset.bin`;
      if (typeof asset?.assetId === "string") listedAssetIds.add(asset.assetId);
      return valid;
    });
    if (
      filenameManifest?.package_format_version !== "1.0-full" ||
      !validManifestAssets ||
      JSON.stringify(listedAssets.map((asset: any) => asset.path).sort()) !==
        JSON.stringify(assetPaths)
    )
      errors.push("provenance_manifest_invalid");
    for (const asset of listedAssets) {
      const bytes = archive[String(asset.path)];
      if (
        !bytes ||
        sha256(bytes) !== asset.sha256 ||
        bytes.byteLength !== asset.size
      )
        errors.push("provenance_asset_hash_mismatch");
    }
    if (
      lineage.some(
        (entry) =>
          entry?.source_record?.assetId &&
          !listedAssetIds.has(String(entry.source_record.assetId)),
      )
    )
      errors.push("provenance_asset_missing");
    const requiredAssetHashes = new Map<string, string | undefined>();
    const requireAsset = (assetId: unknown, digest?: unknown) => {
      if (typeof assetId !== "string" || !assetId) return;
      const hash = /^[a-f0-9]{64}$/u.test(String(digest ?? ""))
        ? String(digest)
        : undefined;
      const existing = requiredAssetHashes.get(assetId);
      if (existing && hash && existing !== hash)
        errors.push("provenance_asset_hash_mismatch");
      else if (!requiredAssetHashes.has(assetId))
        requiredAssetHashes.set(assetId, hash);
    };
    for (const view of parsedViews) requireAsset(view?.assetId);
    for (const source of attributions) requireAsset(source?.assetId);
    for (const entry of lineage) {
      requireAsset(entry?.source_record?.assetId);
      if (entry?.level !== "asset_level") continue;
      for (const input of entry?.input_scope ?? [])
        if (input?.objectType === "data_asset")
          requireAsset(input.id, input.sha256);
      requireAsset(entry?.output_asset?.assetId, entry?.output_asset?.sha256);
    }
    for (const run of transformationRuns) {
      for (const input of run?.inputs ?? [])
        if (input?.objectType === "data_asset")
          requireAsset(input.id, input.sha256);
      for (const output of run?.outputs ?? [])
        requireAsset(output?.assetId, output?.sha256);
    }
    for (const [assetId, expectedHash] of requiredAssetHashes) {
      const listed = listedAssets.find(
        (asset: any) => asset?.assetId === assetId,
      );
      if (!listed) errors.push("provenance_asset_missing");
      else if (expectedHash && listed.sha256 !== expectedHash)
        errors.push("provenance_asset_hash_mismatch");
    }
    if (
      listedAssetIds.size !== requiredAssetHashes.size ||
      [...listedAssetIds].some((assetId) => !requiredAssetHashes.has(assetId))
    )
      errors.push("provenance_asset_unreferenced");
    const assetsById = new Map<string, Uint8Array>(
      listedAssets.map((asset: any) => [
        String(asset.assetId),
        archive[String(asset.path)],
      ]),
    );
    const sourceParses = new Map<
      string,
      Awaited<ReturnType<typeof parseSourceRecords>>
    >();
    for (const entry of lineage) {
      const source = entry?.source_record;
      if (!source?.parsedViewId) continue;
      const view = parsedViews.find((item) => item?.id === source.parsedViewId);
      const bytes = assetsById.get(String(source.assetId));
      if (!view?.parserFormat || !view?.parserConfig || !bytes) {
        errors.push("provenance_source_evidence_invalid");
        continue;
      }
      try {
        let parsed = sourceParses.get(String(source.parsedViewId));
        if (!parsed) {
          parsed = await parseSourceRecords({
            assetId: String(source.assetId),
            parsedViewId: String(source.parsedViewId),
            parserVersion: String(view.parserVersion),
            format: view.parserFormat,
            config: view.parserConfig,
            bytes: Readable.from(Buffer.from(bytes)),
          });
          sourceParses.set(String(source.parsedViewId), parsed);
        }
        const record = parsed.records[Number(source.ordinal) - 1];
        if (!record) errors.push("provenance_source_record_missing");
        else if (
          canonicalJson(record.locator) !== canonicalJson(source.locator)
        )
          errors.push("provenance_source_locator_mismatch");
        else if (record.recordHash !== source.recordHash)
          errors.push("provenance_source_record_mismatch");
      } catch {
        errors.push("provenance_source_parse_failed");
      }
    }
  }
  return report(errors, counts, packageType);
}
