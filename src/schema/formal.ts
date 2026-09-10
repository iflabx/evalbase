import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import { canonicalJson } from "../package/contract.js";

export type FormalSchemaMode = "gold_required" | "input_only";

export interface FormalItem {
  input: unknown;
  expected_output: unknown;
}

export interface FormalValidationResult {
  valid: boolean;
  errors: Array<{
    target: "input" | "expected_output";
    keyword: string;
    instancePath?: string;
  }>;
}

export interface FormalSchemaBundle {
  mode: FormalSchemaMode;
  input: object;
  expectedOutput: object;
}

export function isValidCaseMetadata(
  metadata: unknown,
): metadata is Record<string, unknown> {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    !("_agentbench" in metadata)
  );
}

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const MAX_BYTES = 32_768;
const MAX_DEPTH = 8;
const MAX_PROPERTIES = 100;
const MAX_KEYWORDS = 300;
const TYPES = new Set([
  "null",
  "boolean",
  "object",
  "number",
  "integer",
  "string",
  "array",
]);
const KEYWORDS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minProperties",
  "maxProperties",
]);

function fail(code: string): never {
  throw new Error(code);
}

function schemaObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("formal_schema_shape_invalid");
  return value as Record<string, unknown>;
}

function schemaType(value: unknown) {
  const types = Array.isArray(value) ? value : [value];
  if (
    !types.length ||
    types.some((type) => typeof type !== "string" || !TYPES.has(type))
  )
    fail("formal_schema_type_invalid");
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function localDefinition(ref: string, root: Record<string, unknown>) {
  if (!ref.startsWith("#/$defs/"))
    fail(
      "formal_schema_remote_ref: Remote Formal Schema references are not supported",
    );
  const key = ref
    .slice("#/$defs/".length)
    .replaceAll("~1", "/")
    .replaceAll("~0", "~");
  const definitions = schemaObject(root.$defs ?? {});
  if (!(key in definitions)) fail("formal_schema_local_ref_missing");
  return { key, value: definitions[key] };
}

function inspect(
  value: unknown,
  root: Record<string, unknown>,
  depth: number,
  state: {
    properties: number;
    keywords: number;
    resolving: Set<string>;
    seen: WeakSet<object>;
  },
): void {
  if (depth > MAX_DEPTH)
    fail("formal_schema_depth_exceeded: Formal Schema exceeds nesting limit");
  const schema = schemaObject(value);
  // A local definition is inspected at its declaration and through each $ref.
  // Count the schema node once; references do not create new properties.
  if (state.seen.has(schema)) return;
  state.seen.add(schema);
  for (const keyword of Object.keys(schema)) {
    state.keywords += 1;
    if (state.keywords > MAX_KEYWORDS)
      fail("formal_schema_keyword_limit_exceeded");
    if (!KEYWORDS.has(keyword))
      fail(
        `formal_schema_keyword_unsupported: Formal Schema unsupported keyword: ${keyword}`,
      );
  }
  if (schema.$schema !== undefined && schema.$schema !== DIALECT)
    fail("formal_schema_dialect_invalid");
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") fail("formal_schema_ref_invalid");
    const definition = localDefinition(schema.$ref, root);
    if (state.resolving.has(definition.key))
      fail("formal_schema_recursive_ref");
    state.resolving.add(definition.key);
    inspect(definition.value, root, depth + 1, state);
    state.resolving.delete(definition.key);
  }
  if (schema.type !== undefined) schemaType(schema.type);
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    fail("formal_schema_enum_invalid");
  if (schema.properties !== undefined) {
    const properties = schemaObject(schema.properties);
    state.properties += Object.keys(properties).length;
    if (state.properties > MAX_PROPERTIES)
      fail("formal_schema_property_limit_exceeded");
    Object.values(properties).forEach((child) =>
      inspect(child, root, depth + 1, state),
    );
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some((key) => typeof key !== "string")
    )
      fail("formal_schema_required_invalid");
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  )
    fail("formal_schema_additional_properties_invalid");
  if (schema.items !== undefined) inspect(schema.items, root, depth + 1, state);
  for (const keyword of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minProperties",
    "maxProperties",
  ]) {
    if (schema[keyword] !== undefined && !nonNegativeInteger(schema[keyword]))
      fail("formal_schema_limit_invalid");
  }
  for (const keyword of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ]) {
    if (schema[keyword] !== undefined && !number(schema[keyword]))
      fail("formal_schema_bound_invalid");
  }
  const minimum = schema.minimum;
  const maximum = schema.maximum;
  if (
    typeof minimum === "number" &&
    Number.isFinite(minimum) &&
    typeof maximum === "number" &&
    Number.isFinite(maximum) &&
    minimum > maximum
  )
    fail("formal_schema_bound_invalid");
}

export function assertFormalSchema(schema: unknown): asserts schema is object {
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_BYTES)
    fail("formal_schema_size_exceeded");
  const root = schemaObject(schema);
  const state = {
    properties: 0,
    keywords: 0,
    resolving: new Set<string>(),
    seen: new WeakSet<object>(),
  };
  inspect(root, root, 0, state);
  for (const [key, definition] of Object.entries(
    schemaObject(root.$defs ?? {}),
  )) {
    state.resolving.add(key);
    inspect(definition, root, 1, state);
    state.resolving.delete(key);
  }
}

function summarize(
  target: "input" | "expected_output",
  errors: ErrorObject[] | null | undefined,
) {
  return (errors ?? []).map((error) => ({
    target,
    keyword: error.keyword,
    instancePath: error.instancePath || "/",
  }));
}

export function validateFormalItems(
  inputSchema: object,
  expectedOutputSchema: object,
  items: FormalItem[],
  mode: FormalSchemaMode = "gold_required",
): FormalValidationResult {
  assertFormalSchema(inputSchema);
  assertFormalSchema(expectedOutputSchema);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateInput = ajv.compile(inputSchema);
  const validateExpectedOutput = ajv.compile(expectedOutputSchema);
  const errors: FormalValidationResult["errors"] = [];
  for (const item of items) {
    if (!validateInput(item.input))
      errors.push(...summarize("input", validateInput.errors));
    if (item.expected_output == null && mode === "gold_required")
      errors.push({ target: "expected_output", keyword: "required" });
    else if (
      item.expected_output != null &&
      !validateExpectedOutput(item.expected_output)
    )
      errors.push(
        ...summarize("expected_output", validateExpectedOutput.errors),
      );
  }
  return { valid: errors.length === 0, errors };
}

function values(schema: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(schema[key]) ? schema[key] : [];
}

function typeValues(schema: Record<string, unknown>): string[] | undefined {
  if (schema.type === undefined) return undefined;
  return Array.isArray(schema.type)
    ? (schema.type as string[])
    : [schema.type as string];
}

function allowsAll(before: unknown[], after: unknown[]): boolean {
  return before.every((value) =>
    after.some(
      (candidate) => canonicalJson(candidate) === canonicalJson(value),
    ),
  );
}

function resolved(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof schema.$ref !== "string") return schema;
  const { $ref: _ref, ...siblings } = schema;
  return {
    ...resolved(schemaObject(localDefinition(_ref, root).value), root),
    ...siblings,
  };
}

/** Returns true when every value accepted by before remains accepted by after. */
function compatible(
  beforeValue: Record<string, unknown>,
  afterValue: Record<string, unknown>,
  beforeRoot: Record<string, unknown>,
  afterRoot: Record<string, unknown>,
): boolean {
  const before = resolved(beforeValue, beforeRoot);
  const after = resolved(afterValue, afterRoot);
  const oldTypes = typeValues(before);
  const newTypes = typeValues(after);
  if (!oldTypes && newTypes) return false;
  if (
    oldTypes &&
    newTypes &&
    !oldTypes.every((type) => newTypes.includes(type))
  )
    return false;
  if (
    before.const !== undefined &&
    after.const !== undefined &&
    canonicalJson(before.const) !== canonicalJson(after.const)
  )
    return false;
  if (before.const === undefined && after.const !== undefined) return false;
  if (
    before.enum !== undefined &&
    (after.enum === undefined ||
      !allowsAll(values(before, "enum"), values(after, "enum")))
  )
    return false;
  if (before.enum === undefined && after.enum !== undefined) return false;
  for (const key of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
    "minProperties",
  ])
    if (
      after[key] !== undefined &&
      (before[key] === undefined || Number(after[key]) > Number(before[key]))
    )
      return false;
  for (const key of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
    "maxProperties",
  ])
    if (
      after[key] !== undefined &&
      (before[key] === undefined || Number(after[key]) < Number(before[key]))
    )
      return false;
  if (
    before.additionalProperties !== false &&
    after.additionalProperties === false
  )
    return false;
  if (
    values(after, "required").some(
      (key) => !values(before, "required").includes(key),
    )
  )
    return false;
  const oldProperties = (before.properties ?? {}) as Record<string, unknown>;
  const newProperties = (after.properties ?? {}) as Record<string, unknown>;
  for (const [key, oldSchema] of Object.entries(oldProperties)) {
    const newSchema = newProperties[key];
    if (newSchema === undefined) {
      if (after.additionalProperties === false) return false;
      continue;
    }
    if (
      !compatible(
        schemaObject(oldSchema),
        schemaObject(newSchema),
        beforeRoot,
        afterRoot,
      )
    )
      return false;
  }
  if (before.items !== undefined) {
    if (
      after.items === undefined ||
      !compatible(
        schemaObject(before.items),
        schemaObject(after.items),
        beforeRoot,
        afterRoot,
      )
    )
      return false;
  } else if (after.items !== undefined) return false;
  return true;
}

export function compareFormalSchemas(
  before: object,
  after: object,
): "compatible" | "requires_new_test_set" {
  assertFormalSchema(before);
  assertFormalSchema(after);
  return compatible(
    before as Record<string, unknown>,
    after as Record<string, unknown>,
    before as Record<string, unknown>,
    after as Record<string, unknown>,
  )
    ? "compatible"
    : "requires_new_test_set";
}

export function compareFormalSchemaBundles(
  before: FormalSchemaBundle,
  after: FormalSchemaBundle,
): "compatible" | "requires_new_test_set" {
  if (before.mode !== after.mode) return "requires_new_test_set";
  return compareFormalSchemas(before.input, after.input) === "compatible" &&
    compareFormalSchemas(before.expectedOutput, after.expectedOutput) ===
      "compatible"
    ? "compatible"
    : "requires_new_test_set";
}
