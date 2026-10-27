import { z } from "zod";

type Shape = {
  type?: string;
  properties?: Record<string, Shape>;
  items?: Shape;
  oneOf?: Shape[];
  anyOf?: Shape[];
};
/** Decode only JSON object/array representations declared by the tool; never infer missing business values. */
export function normalizeToolArguments(schema: z.ZodType, args: unknown) {
  const paths: string[][] = [];
  const variants = (node: Shape): Shape[] => [
    node,
    ...[...(node.oneOf ?? []), ...(node.anyOf ?? [])].flatMap(variants),
  ];
  const walk = (
    shape: Shape,
    value: unknown,
    path: string[],
    depth: number,
  ): unknown => {
    if (depth > 12) return value;
    const choices = variants(shape);
    if (
      typeof value === "string" &&
      value.length <= 65536 &&
      /^\s*[[{]/.test(value)
    ) {
      try {
        const decoded: unknown = JSON.parse(value);
        const type = Array.isArray(decoded)
          ? "array"
          : decoded !== null && typeof decoded === "object"
            ? "object"
            : null;
        if (type && choices.some((c) => c.type === type)) {
          value = decoded;
          paths.push(path);
        }
      } catch {
        /* Invalid JSON remains an ordinary validation error. */
      }
    }
    if (Array.isArray(value)) {
      const items = choices
        .filter((c) => c.type === "array" && c.items)
        .map((c) => c.items!);
      return items.length
        ? value.map((v, i) =>
            walk({ anyOf: items }, v, [...path, String(i)], depth + 1),
          )
        : value;
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          const fields = choices.flatMap((c) =>
            c.properties?.[key] ? [c.properties[key]!] : [],
          );
          return [
            key,
            fields.length
              ? walk({ anyOf: fields }, v, [...path, key], depth + 1)
              : v,
          ];
        }),
      );
    }
    return value;
  };
  return {
    args: walk(z.toJSONSchema(schema, { io: "input" }) as Shape, args, [], 0),
    paths,
  };
}
