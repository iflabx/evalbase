export type MappingValue =
  | {
      source: string;
      interpretAs?: "string" | "number" | "integer" | "boolean";
    }
  | { constant: unknown }
  | { object: Record<string, MappingValue> };

export interface DraftMapping {
  input: MappingValue;
  expectedOutput?: MappingValue;
  metadata?: MappingValue;
}

export interface MappingError {
  target: "input" | "expected_output" | "metadata";
  path: string;
  code:
    | "mapping_source_missing"
    | "mapping_type_interpretation_failed"
    | "mapping_metadata_invalid";
}

function mappingValue(value: unknown): value is MappingValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.source === "string")
    return (
      entry.interpretAs === undefined ||
      (typeof entry.interpretAs === "string" &&
        ["string", "number", "integer", "boolean"].includes(entry.interpretAs))
    );
  if ("constant" in entry) return Object.keys(entry).length === 1;
  return (
    Object.keys(entry).length === 1 &&
    !!entry.object &&
    typeof entry.object === "object" &&
    !Array.isArray(entry.object) &&
    Object.values(entry.object as Record<string, unknown>).every(mappingValue)
  );
}

export function normalizeDraftMapping(
  value: unknown,
): DraftMapping | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const mapping = value as Record<string, unknown>;
  if (
    mappingValue(mapping.input) &&
    (mapping.expectedOutput === undefined ||
      mappingValue(mapping.expectedOutput)) &&
    (mapping.metadata === undefined || mappingValue(mapping.metadata))
  )
    return mapping as unknown as DraftMapping;
  if (
    !mapping.input ||
    typeof mapping.input !== "object" ||
    Array.isArray(mapping.input) ||
    typeof mapping.expectedOutput !== "string"
  )
    return undefined;
  return {
    input: {
      object: Object.fromEntries(
        Object.entries(mapping.input as Record<string, unknown>).map(
          ([key, source]) => [key, { source: String(source) }],
        ),
      ),
    },
    expectedOutput: { source: mapping.expectedOutput },
  };
}

export function mappedSourceFields(mapping: DraftMapping): string[] {
  const fields = new Set<string>();
  const visit = (value: MappingValue) => {
    if ("source" in value) fields.add(canonicalSourcePath(value.source));
    else if ("object" in value) Object.values(value.object).forEach(visit);
  };
  visit(mapping.input);
  if (mapping.expectedOutput) visit(mapping.expectedOutput);
  if (mapping.metadata) visit(mapping.metadata);
  return [...fields].sort();
}

export function sourcePathIsMapped(path: string, mappedPaths: Set<string>) {
  return [...mappedPaths].some(
    (mappedPath) => path === mappedPath || path.startsWith(`${mappedPath}/`),
  );
}

export function canonicalSourcePath(path: string): string {
  if (path.startsWith("/")) return path;
  return `/${path.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

export function sourceLeafPaths(value: unknown): string[] {
  const leaves = new Set<string>();
  const visit = (current: unknown, path: string) => {
    if (current && typeof current === "object") {
      const entries = Array.isArray(current)
        ? current.map((child, index) => [String(index), child] as const)
        : Object.entries(current);
      if (!entries.length) {
        leaves.add(path || "/");
        return;
      }
      for (const [key, child] of entries)
        visit(
          child,
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
      return;
    }
    leaves.add(path || "/");
  };
  visit(value, "");
  return [...leaves].sort();
}

export function sourceValueAt(
  value: unknown,
  path: string,
): { found: boolean; value: unknown } {
  const parts = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [path];
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current))
      return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function interpret(
  value: unknown,
  kind: Exclude<
    MappingValue,
    { constant: unknown } | { object: Record<string, MappingValue> }
  >["interpretAs"],
) {
  if (!kind) return { valid: true as const, value };
  if (kind === "string")
    return typeof value === "string"
      ? { valid: true as const, value }
      : { valid: false as const };
  if (kind === "boolean") {
    if (value === true || value === false)
      return { valid: true as const, value };
    if (value === "true") return { valid: true as const, value: true };
    if (value === "false") return { valid: true as const, value: false };
    return { valid: false as const };
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (kind !== "integer" || Number.isInteger(value))
  )
    return { valid: true as const, value };
  if (
    typeof value === "string" &&
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)
  ) {
    const parsed = Number(value);
    if (
      Number.isFinite(parsed) &&
      (kind !== "integer" || Number.isInteger(parsed))
    )
      return { valid: true as const, value: parsed };
  }
  return { valid: false as const };
}

function mapValue(
  source: unknown,
  mapping: MappingValue,
  target: MappingError["target"],
  path: string,
  errors: MappingError[],
): unknown {
  if ("constant" in mapping) return mapping.constant;
  if ("object" in mapping)
    return Object.fromEntries(
      Object.entries(mapping.object).map(([key, child]) => [
        key,
        mapValue(source, child, target, `${path}/${key}`, errors),
      ]),
    );
  const resolved = sourceValueAt(source, mapping.source);
  if (!resolved.found) {
    errors.push({ target, path, code: "mapping_source_missing" });
    return undefined;
  }
  const converted = interpret(resolved.value, mapping.interpretAs);
  if (!converted.valid) {
    errors.push({ target, path, code: "mapping_type_interpretation_failed" });
    return undefined;
  }
  return converted.value;
}

export function replayMapping(source: unknown, mapping: DraftMapping) {
  const errors: MappingError[] = [];
  const input = mapValue(source, mapping.input, "input", "/input", errors);
  const expected_output =
    mapping.expectedOutput === undefined
      ? null
      : mapValue(
          source,
          mapping.expectedOutput,
          "expected_output",
          "/expected_output",
          errors,
        );
  const metadata =
    mapping.metadata === undefined
      ? {}
      : mapValue(source, mapping.metadata, "metadata", "/metadata", errors);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    "_agentbench" in metadata
  )
    errors.push({
      target: "metadata",
      path: "/metadata",
      code: "mapping_metadata_invalid",
    });
  return { item: { input, expected_output, metadata }, errors };
}

function suggestedSchema(values: unknown[]): Record<string, unknown> {
  const types = [
    ...new Set(
      values.map((value) =>
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      ),
    ),
  ].filter((type) =>
    ["null", "boolean", "object", "number", "string", "array"].includes(type),
  );
  if (!types.length) return {};
  if (types.length !== 1) return { type: types };
  if (types[0] !== "object") return { type: types[0] };
  const objects = values as Record<string, unknown>[];
  const keys = [
    ...new Set(objects.flatMap((value) => Object.keys(value))),
  ].sort();
  return {
    type: "object",
    properties: Object.fromEntries(
      keys.map((key) => [
        key,
        suggestedSchema(
          objects.filter((value) => key in value).map((value) => value[key]),
        ),
      ]),
    ),
    required: keys.filter((key) => objects.every((value) => key in value)),
  };
}

export function suggestFormalSchema(
  items: Array<{ input: unknown; expected_output: unknown }>,
) {
  return {
    input: suggestedSchema(items.map((item) => item.input)),
    expectedOutput: suggestedSchema(
      items
        .filter((item) => item.expected_output != null)
        .map((item) => item.expected_output),
    ),
  };
}
