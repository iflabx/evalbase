import { z } from "zod";
import { canonicalJson } from "../package/contract.js";
import { deliveryPatchSchema } from "./session-contract.js";
type Shape = {
  type?: string;
  properties?: Record<string, Shape>;
  items?: Shape;
  oneOf?: Shape[];
  anyOf?: Shape[];
  default?: unknown;
};
const patchKeys = new Set(Object.keys(deliveryPatchSchema.shape));
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : canonicalJson(a) === canonicalJson(b);
/** Decimal strings are checked exactly before crossing into JavaScript Number. */
function exactInteger(text: string): number | undefined {
  if (text.length > 256) return;
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) return;
  const digits = (m[2]! + (m[3] ?? "")).replace(/^0+/, "") || "0";
  if (digits === "0") return 0;
  const exponent = Number(m[4] ?? 0);
  if (!Number.isSafeInteger(exponent)) return;
  const shift = exponent - (m[3]?.length ?? 0);
  let integer: bigint;
  if (shift >= 0) {
    if (digits.length + shift > 16) return;
    integer = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const cut = -shift;
    if (cut > digits.length || !digits.endsWith("0".repeat(cut))) return;
    integer = BigInt(digits.slice(0, -cut) || "0");
  }
  if (m[1] === "-") integer = -integer;
  if (
    integer > BigInt(Number.MAX_SAFE_INTEGER) ||
    integer < BigInt(Number.MIN_SAFE_INTEGER)
  )
    return;
  return Number(integer);
}
/** Only schema-declared representations and the registered delivery wrapper alias are normalized. */
export function normalizeToolArguments(
  schema: z.ZodType,
  args: unknown,
  toolName?: string,
  options: { applyDefaults?: boolean } = {},
) {
  const applyDefaults = options.applyDefaults !== false;
  const paths: string[][] = [],
    conflicts: string[][] = [];
  const variants = (s: Shape): Shape[] => [
    s,
    ...[...(s.oneOf ?? []), ...(s.anyOf ?? [])].flatMap(variants),
  ];
  const walk = (
    shape: Shape,
    value: unknown,
    path: string[],
    depth: number,
  ): unknown => {
    if (depth > 12) return value;
    const choices = variants(shape),
      has = (type: string) => choices.some((s) => s.type === type);
    if (value === undefined && applyDefaults) {
      const defaults = choices.filter((s) => Object.hasOwn(s, "default"));
      if (
        defaults.length &&
        defaults.every((s) => equal(s.default, defaults[0]!.default))
      ) {
        value = structuredClone(defaults[0]!.default);
        paths.push(path);
      }
    }
    if (typeof value === "string") {
      if (value.length <= 65536 && /^\s*[[{]/.test(value)) {
        try {
          const decoded: unknown = JSON.parse(value),
            type = Array.isArray(decoded)
              ? "array"
              : object(decoded)
                ? "object"
                : null;
          if (type && has(type)) {
            value = decoded;
            paths.push(path);
          }
        } catch {
          /* Keep malformed JSON for validation. */
        }
      } else if (
        !has("string") &&
        value.trim() !== "" &&
        (has("number") || has("integer")) &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
      ) {
        const number = has("integer") ? exactInteger(value) : Number(value);
        if (
          number !== undefined &&
          Number.isFinite(number) &&
          (!has("integer") || Number.isSafeInteger(number))
        ) {
          value = number;
          paths.push(path);
        }
      } else if (
        !has("string") &&
        has("boolean") &&
        (value === "true" || value === "false")
      ) {
        value = value === "true";
        paths.push(path);
      } else if (
        !has("string") &&
        has("array") &&
        value.trim() !== "" &&
        choices.some((s) => s.items?.type === "string")
      ) {
        value = [value];
        paths.push(path);
      }
    }
    if (Array.isArray(value)) {
      const items = choices
        .filter((s) => s.type === "array" && s.items)
        .map((s) => s.items!);
      return items.length
        ? value.map((v, i) =>
            walk({ anyOf: items }, v, [...path, String(i)], depth + 1),
          )
        : value;
    }
    if (object(value)) {
      if (
        ["create_requirements", "update_requirements"].includes(
          toolName ?? "",
        ) &&
        path.length === 3 &&
        path[0] === "changes" &&
        path[1] === "deliveries"
      ) {
        const flat = Object.keys(value).filter((k) => patchKeys.has(k));
        if (flat.length && Object.hasOwn(value, "patch")) conflicts.push(path);
        else if (flat.length) {
          value = {
            ...Object.fromEntries(
              Object.entries(value).filter(([k]) => !flat.includes(k)),
            ),
            patch: Object.fromEntries(
              flat.map((k) => [k, (value as Record<string, unknown>)[k]]),
            ),
          };
          paths.push([...path, "patch"]);
        }
      }
      const properties = Object.assign(
        {},
        ...choices.map((s) => s.properties ?? {}),
      ) as Record<string, Shape>;
      const keys = new Set([
        ...Object.keys(value as object),
        ...Object.keys(properties).filter(
          (k) =>
            applyDefaults &&
            variants(properties[k]!).some((s) => Object.hasOwn(s, "default")),
        ),
      ]);
      let result = Object.fromEntries(
        [...keys].map((key) => {
          const fields = choices.flatMap((s) =>
            s.properties?.[key] ? [s.properties[key]!] : [],
          );
          const v = (value as Record<string, unknown>)[key];
          return [
            key,
            fields.length
              ? walk({ anyOf: fields }, v, [...path, key], depth + 1)
              : v,
          ];
        }),
      );
      if (
        ["create_requirements", "update_requirements"].includes(
          toolName ?? "",
        ) &&
        path.length === 4 &&
        path[0] === "changes" &&
        path[1] === "deliveries" &&
        path[3] === "patch"
      ) {
        result = Object.fromEntries(
          Object.entries(result).map(([key, v]) => {
            const field =
              deliveryPatchSchema.shape[
                key as keyof typeof deliveryPatchSchema.shape
              ];
            if (!field) return [key, v];
            const parsed = field.safeParse(v);
            if (parsed.success && !equal(v, parsed.data)) {
              paths.push([...path, key]);
              return [key, parsed.data];
            }
            return [key, v];
          }),
        );
      }
      return result;
    }
    return value;
  };
  const value = walk(
    z.toJSONSchema(schema, { io: "input" }) as Shape,
    args,
    [],
    0,
  );
  const parsed = schema.safeParse(value);
  return {
    args: parsed.success && applyDefaults ? parsed.data : value,
    paths,
    ...(conflicts.length ? { conflicts } : {}),
  };
}
/** Materialize omissions first, canonicalize with full context, then compare protected business values. */
export function mergeToolCorrection(
  base: unknown,
  candidate: unknown,
  removablePaths: string[][] = [],
  canonicalize: (v: unknown) => unknown = (v) => v,
) {
  const changedPaths: string[][] = [];
  const removable = (p: string[]) => removablePaths.some((r) => equal(r, p));
  const materialize = (
    before: unknown,
    after: unknown,
    path: string[],
    provided: boolean,
  ): unknown => {
    if (!provided) return removable(path) ? undefined : structuredClone(before);
    if (Array.isArray(before) && Array.isArray(after)) {
      const identified =
        before.length > 0 &&
        before.every((v) => object(v) && typeof v.deliveryId === "string");
      if (
        identified &&
        after.length > 0 &&
        after.every((v) => object(v) && typeof v.deliveryId === "string")
      ) {
        const ids = after.map((v) => v.deliveryId);
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => !before.some((v) => v.deliveryId === id))
        ) {
          changedPaths.push(path);
          return before;
        }
        return before.map((v, i) => {
          const item = after.find((x) => x.deliveryId === v.deliveryId);
          return item
            ? materialize(v, item, [...path, String(i)], true)
            : structuredClone(v);
        });
      }
      if (before.length !== after.length) {
        changedPaths.push(path);
        return before;
      }
      return before.map((v, i) =>
        materialize(v, after[i], [...path, String(i)], true),
      );
    }
    if (object(before) && object(after))
      return Object.fromEntries(
        [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
          (key) => {
            const v = materialize(
              before[key],
              after[key],
              [...path, key],
              Object.hasOwn(after, key),
            );
            return v === undefined ? [] : [[key, v]];
          },
        ),
      );
    return structuredClone(after);
  };
  const args = canonicalize(materialize(base, candidate, [], true));
  const compare = (before: unknown, after: unknown, path: string[]) => {
    if (changedPaths.length >= 12 || removable(path) || equal(before, after))
      return;
    if (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length
    ) {
      before.forEach((v, i) => compare(v, after[i], [...path, String(i)]));
      return;
    }
    if (object(before) && object(after)) {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ]))
        compare(before[key], after[key], [...path, key]);
      return;
    }
    changedPaths.push(path);
  };
  compare(base, args, []);
  return { args, changedPaths };
}
