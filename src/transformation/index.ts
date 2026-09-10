import { canonicalJson, sha256 } from "../package/contract.js";
import { CAPACITY_LIMITS } from "../capacity.js";

export const TRANSFORMATION_MANIFEST_VERSION = "1.0";
const MAX_TRANSFORMATION_RECORD_COUNT = CAPACITY_LIMITS.parsedViewRecords;

export const TRANSFORMATION_OPERATION_TYPES = [
  "import",
  "code_rule",
  "agent_rewrite",
  "agent_extraction",
  "agent_augmentation",
  "agent_generation",
  "manual_revision",
  "unknown_external_tool",
] as const;

export type TransformationOperationType =
  (typeof TRANSFORMATION_OPERATION_TYPES)[number];

export type TransformationLineageLevel = "record_level" | "asset_level";

export interface TransformationValidationReport {
  valid: boolean;
  errors: Array<{
    code: string;
    path: string;
    retry: string;
  }>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const isPlaceholderUnknown = (value: unknown) =>
  typeof value === "string" && value.trim().toLowerCase() === "unknown";

function invalid(path: string) {
  return {
    code: "transformation_manifest_invalid",
    path,
    retry: "Complete the Transformation Run manifest, then retry registration.",
  };
}

export function transformationManifestHash(manifest: unknown): string {
  return sha256(canonicalJson(manifest));
}

export function registerRun(
  manifest: Record<string, unknown>,
  sha256Content: (value: string) => string,
) {
  const prompt = isObject(manifest.prompt) ? manifest.prompt : undefined;
  if (
    prompt &&
    typeof prompt.content === "string" &&
    prompt.content.trim() &&
    !prompt.sha256
  )
    prompt.sha256 = sha256Content(prompt.content);
  return { manifest, report: validateTransformationManifest(manifest) };
}

export function validateForPublication(
  runs: Array<{ id: string; status: string; validation_report?: unknown }>,
) {
  const incomplete = runs.find((run) => run.status !== "complete");
  return incomplete
    ? {
        valid: false,
        errorCode: "transformation_run_incomplete",
        object: { type: "transformation_run", id: incomplete.id },
        blockingPhase: "candidate_materialization",
        errors: [
          {
            code: "transformation_run_incomplete",
            runId: incomplete.id,
            ...(incomplete.validation_report as object),
          },
        ],
        retry:
          "Complete the Transformation Run manifest, then materialize a new Candidate.",
      }
    : { valid: true };
}

export function trace(
  subject: { type: string; id: string },
  nodes: Array<{ type: string; id: string }>,
  edges: Array<{ from: string; to: string }>,
) {
  const byKey = new Map<string, string[]>();
  for (const edge of edges) {
    const from = String(edge.from);
    byKey.set(from, [...(byKey.get(from) ?? []), String(edge.to)]);
  }
  const subjectKey = `${subject.type}:${subject.id}`;
  const reachable = new Set([subjectKey]);
  let frontier = [subjectKey];
  let observedHops = 0;
  for (let hop = 0; hop < 3; hop += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of byKey.get(from) ?? []) {
        if (!reachable.has(to)) {
          reachable.add(to);
          next.push(to);
        }
      }
    }
    if (!next.length) break;
    frontier = next;
    observedHops += 1;
  }
  return {
    maxHops: observedHops,
    subject,
    nodes: nodes.filter((node) => reachable.has(`${node.type}:${node.id}`)),
    edges: edges.filter(
      (edge) =>
        reachable.has(String(edge.from)) && reachable.has(String(edge.to)),
    ),
  };
}

export function validateTransformationManifest(
  value: unknown,
): TransformationValidationReport {
  const errors: TransformationValidationReport["errors"] = [];
  if (!isObject(value)) {
    return { valid: false, errors: [invalid("/")] };
  }

  if ("id" in value || "manifestHash" in value) errors.push(invalid("/"));
  if (value.schemaVersion !== TRANSFORMATION_MANIFEST_VERSION)
    errors.push(invalid("/schemaVersion"));
  const operationType = value.operationType;
  if (
    !TRANSFORMATION_OPERATION_TYPES.includes(
      operationType as TransformationOperationType,
    )
  )
    errors.push(invalid("/operationType"));
  if (
    value.lineageLevel !== "record_level" &&
    value.lineageLevel !== "asset_level"
  )
    errors.push(invalid("/lineageLevel"));
  if (
    value.lineageLevel === "asset_level" &&
    !["agent_augmentation", "agent_generation"].includes(
      operationType as string,
    )
  )
    errors.push(invalid("/lineageLevel"));

  for (const path of ["/purpose", "/executedBy"] as const)
    if (!nonEmptyString(value[path === "/purpose" ? "purpose" : "executedBy"]))
      errors.push(invalid(path));
  if (
    isPlaceholderUnknown(value.purpose) ||
    isPlaceholderUnknown(value.executedBy)
  )
    errors.push(invalid("/purpose"));

  const tool = value.tool;
  if (!isObject(tool)) errors.push(invalid("/tool"));
  else {
    if (!nonEmptyString(tool.name)) errors.push(invalid("/tool/name"));
    if (!nonEmptyString(tool.version)) errors.push(invalid("/tool/version"));
    if (isPlaceholderUnknown(tool.name)) errors.push(invalid("/tool/name"));
    if (isPlaceholderUnknown(tool.version))
      errors.push(invalid("/tool/version"));
    if (
      operationType === "code_rule" &&
      !nonEmptyString(tool.codeRef) &&
      !nonEmptyString(tool.artifactVersion)
    )
      errors.push(invalid("/tool/codeRef"));
    if (
      operationType === "unknown_external_tool" &&
      !nonEmptyString(tool.description)
    )
      errors.push(invalid("/tool/description"));
    if (isPlaceholderUnknown(tool.description))
      errors.push(invalid("/tool/description"));
    if (
      isPlaceholderUnknown(tool.codeRef) ||
      isPlaceholderUnknown(tool.artifactVersion)
    )
      errors.push(invalid("/tool"));
  }

  if (operationType === "manual_revision") {
    const manual = value.manual;
    if (!isObject(manual)) errors.push(invalid("/manual"));
    else {
      if (!nonEmptyString(manual.reason))
        errors.push(invalid("/manual/reason"));
      if (isPlaceholderUnknown(manual.reason))
        errors.push(invalid("/manual/reason"));
      if (!isObject(manual.before)) errors.push(invalid("/manual/before"));
      if (!isObject(manual.after)) errors.push(invalid("/manual/after"));
      if (!isObject(manual.diff)) errors.push(invalid("/manual/diff"));
    }
  }

  if (!isObject(value.parameters)) errors.push(invalid("/parameters"));

  if (
    [
      "agent_rewrite",
      "agent_extraction",
      "agent_augmentation",
      "agent_generation",
    ].includes(operationType as string)
  ) {
    const model = value.model;
    if (!isObject(model)) errors.push(invalid("/model"));
    else {
      if (!nonEmptyString(model.provider))
        errors.push(invalid("/model/provider"));
      if (!nonEmptyString(model.name)) errors.push(invalid("/model/name"));
      if (isPlaceholderUnknown(model.provider))
        errors.push(invalid("/model/provider"));
      if (isPlaceholderUnknown(model.name)) errors.push(invalid("/model/name"));
      if (!isObject(model.parameters))
        errors.push(invalid("/model/parameters"));
    }

    const prompt = value.prompt;
    if (!isObject(prompt)) errors.push(invalid("/prompt"));
    else {
      if (!nonEmptyString(prompt.version))
        errors.push(invalid("/prompt/version"));
      if (isPlaceholderUnknown(prompt.version))
        errors.push(invalid("/prompt/version"));
      if (!isSha256(prompt.sha256)) errors.push(invalid("/prompt/sha256"));
      const hasContent = typeof prompt.content === "string";
      const reference = prompt.immutableRef;
      const hasReference = isObject(reference);
      if (hasContent === hasReference) errors.push(invalid("/prompt"));
      if (hasContent) {
        if (!(prompt.content as string).trim())
          errors.push(invalid("/prompt/content"));
        if (
          isSha256(prompt.sha256) &&
          sha256(prompt.content as string) !== prompt.sha256
        )
          errors.push(invalid("/prompt/sha256"));
      }
      if (hasReference) {
        if (!nonEmptyString(reference.assetId))
          errors.push(invalid("/prompt/immutableRef/assetId"));
        if (!isSha256(reference.sha256))
          errors.push(invalid("/prompt/immutableRef/sha256"));
        if (
          isSha256(reference.sha256) &&
          isSha256(prompt.sha256) &&
          prompt.sha256 !== reference.sha256
        )
          errors.push(invalid("/prompt/sha256"));
      }
    }
  }

  if (!Array.isArray(value.inputs) || !value.inputs.length)
    errors.push(invalid("/inputs"));
  else {
    const inputKeys = new Set<string>();
    for (const [index, input] of value.inputs.entries()) {
      if (!isObject(input)) errors.push(invalid(`/inputs/${index}`));
      else {
        const scope = input.scope;
        if (
          !["data_asset", "test_set_version"].includes(
            input.objectType as string,
          )
        )
          errors.push(invalid(`/inputs/${index}/objectType`));
        if (!nonEmptyString(input.id))
          errors.push(invalid(`/inputs/${index}/id`));
        if (!isSha256(input.sha256))
          errors.push(invalid(`/inputs/${index}/sha256`));
        if (!isObject(scope)) errors.push(invalid(`/inputs/${index}/scope`));
        else if (
          input.objectType === "data_asset" &&
          scope.entireAsset !== true
        )
          errors.push(invalid(`/inputs/${index}/scope`));
        else if (
          input.objectType === "test_set_version" &&
          Object.keys(scope).length === 0
        )
          errors.push(invalid(`/inputs/${index}/scope`));
        const inputKey = `${String(input.objectType)}:${String(input.id)}`;
        if (inputKeys.has(inputKey)) errors.push(invalid(`/inputs/${index}`));
        inputKeys.add(inputKey);
      }
    }
  }

  if (!Array.isArray(value.outputs) || value.outputs.length !== 1)
    errors.push(invalid("/outputs"));
  else {
    const output = value.outputs[0];
    if (!isObject(output)) errors.push(invalid("/outputs/0"));
    else {
      if (!nonEmptyString(output.assetId))
        errors.push(invalid("/outputs/0/assetId"));
      if (!isSha256(output.sha256)) errors.push(invalid("/outputs/0/sha256"));
      if (
        !Number.isInteger(output.recordCount) ||
        Number(output.recordCount) < 1 ||
        Number(output.recordCount) > MAX_TRANSFORMATION_RECORD_COUNT
      )
        errors.push(invalid("/outputs/0/recordCount"));
    }
  }

  if (value.lineageLevel === "record_level") {
    if (!Array.isArray(value.recordEdges) || !value.recordEdges.length)
      errors.push(invalid("/recordEdges"));
    else {
      const edgeInputKeys = new Set<string>();
      for (const [index, edge] of value.recordEdges.entries()) {
        if (
          !isObject(edge) ||
          !Number.isInteger(edge.outputOrdinal) ||
          Number(edge.outputOrdinal) < 1 ||
          !Array.isArray(edge.inputs) ||
          !edge.inputs.length
        )
          errors.push(invalid(`/recordEdges/${index}`));
        else {
          for (const [inputIndex, input] of edge.inputs.entries()) {
            const inputValid =
              isObject(input) &&
              ((input.objectType === "source_record" &&
                nonEmptyString(input.parsedViewId) &&
                Number.isInteger(input.ordinal) &&
                Number(input.ordinal) >= 1 &&
                isSha256(input.recordHash)) ||
                (input.objectType === "case_revision" &&
                  nonEmptyString(input.id) &&
                  isSha256(input.contentHash)));
            if (!inputValid) {
              errors.push(
                invalid(`/recordEdges/${index}/inputs/${inputIndex}`),
              );
            } else {
              const inputKey = `${Number(edge.outputOrdinal)}:${canonicalJson(
                input,
              )}`;
              if (edgeInputKeys.has(inputKey))
                errors.push(
                  invalid(`/recordEdges/${index}/inputs/${inputIndex}`),
                );
              edgeInputKeys.add(inputKey);
            }
          }
        }
      }

      const outputCount = Array.isArray(value.outputs)
        ? Number(value.outputs[0]?.recordCount)
        : Number.NaN;
      const outputOrdinals = new Set(
        Array.isArray(value.recordEdges)
          ? value.recordEdges.map((edge) =>
              isObject(edge) ? Number(edge.outputOrdinal) : 0,
            )
          : [],
      );
      if (
        Number.isInteger(outputCount) &&
        outputCount > 0 &&
        (value.recordEdges.length !== outputCount ||
          outputOrdinals.size !== outputCount ||
          [...outputOrdinals].some(
            (ordinal) => ordinal < 1 || ordinal > outputCount,
          ))
      )
        errors.push(invalid("/recordEdges"));
    }
  } else if (Array.isArray(value.recordEdges) && value.recordEdges.length)
    errors.push(invalid("/recordEdges"));

  for (const path of ["/startedAt", "/finishedAt"] as const) {
    const fieldValue =
      value[path === "/startedAt" ? "startedAt" : "finishedAt"];
    if (
      !nonEmptyString(fieldValue) ||
      Number.isNaN(Date.parse(fieldValue as string))
    )
      errors.push(invalid(path));
  }
  if (
    !Number.isNaN(Date.parse(value.startedAt as string)) &&
    !Number.isNaN(Date.parse(value.finishedAt as string)) &&
    new Date(value.finishedAt as string).getTime() <
      new Date(value.startedAt as string).getTime()
  )
    errors.push(invalid("/finishedAt"));

  return { valid: errors.length === 0, errors };
}
