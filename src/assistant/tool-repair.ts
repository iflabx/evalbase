import {
  generateText,
  asSchema,
  jsonSchema,
  InvalidToolInputError,
  ToolChoiceViolationError,
  tool,
  type LanguageModel,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { canonicalJson } from "../package/contract.js";
import { isPlainObject } from "../server/support.js";
import { Ajv } from "ajv";

export type RepairDetails = {
  scope: "call" | "step";
  stepIndex?: number;
  issues: { path: string; keyword: string }[];
};

// This validator chooses a smaller repair scope; the tool's own validator is final.
function repairScope(value: unknown, schema: any) {
  const repairValidator = new Ajv({ strict: false, allErrors: true });
  const validate = repairValidator.compile(schema);
  validate(value);
  const issues = (validate.errors ?? []).slice(0, 8).map((error) => ({
    path: (() => {
      const field =
        error.keyword === "required"
          ? error.params.missingProperty
          : error.keyword === "additionalProperties"
            ? error.params.additionalProperty
            : undefined;
      const suffix =
        typeof field === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field)
          ? "/" + field
          : "";
      return (error.instancePath + suffix).slice(0, 240);
    })(),
    keyword: error.keyword,
  }));
  if (
    isPlainObject(value) &&
    Array.isArray(value.steps) &&
    value.steps.length > 1 &&
    schema.properties?.steps?.items
  ) {
    const steps = schema.properties.steps;
    const validOutline = repairValidator.compile({
      ...schema,
      properties: { ...schema.properties, steps: { ...steps, items: {} } },
    });
    const validStep = repairValidator.compile(steps.items);
    const invalid = value.steps.flatMap((step, index) =>
      validStep(step) ? [] : [index],
    );
    if (validOutline(value) && invalid.length === 1) {
      const index = invalid[0]!;
      const originalSteps = value.steps;
      return {
        value: { steps: [value.steps[index]] },
        schema: {
          type: "object",
          properties: { steps: { ...steps, minItems: 1, maxItems: 1 } },
          required: ["steps"],
          additionalProperties: false,
        },
        details: { scope: "step", stepIndex: index, issues } as RepairDetails,
        merge: (fixed: any) => {
          if (
            !isPlainObject(fixed) ||
            Object.keys(fixed).length !== 1 ||
            !Array.isArray(fixed.steps) ||
            fixed.steps.length !== 1
          )
            return undefined;
          const repairedSteps = fixed.steps;
          return {
            ...value,
            steps: originalSteps.map((step, i) =>
              i === index ? repairedSteps[0] : step,
            ),
          };
        },
      };
    }
  }
  return {
    value,
    schema,
    details: { scope: "call", issues } as RepairDetails,
    merge: (fixed: unknown) => fixed,
  };
}

function inputContract(value: unknown, definition: any): any {
  const variants = definition.oneOf ?? definition.anyOf;
  if (variants) {
    const matches = variants.filter((item: any) => {
      if (!isPlainObject(value)) return false;
      const object = value;
      const discriminators = Object.entries(item.properties ?? {}).filter(
        ([key, property]: [string, any]) =>
          Object.hasOwn(object, key) &&
          (property.enum || Object.hasOwn(property, "const")),
      );
      return (
        discriminators.length > 0 &&
        discriminators.every(([key, property]: [string, any]) =>
          property.enum
            ? property.enum.includes(object[key])
            : object[key] === property.const,
        )
      );
    });
    const variant =
      matches.length === 1
        ? matches[0]
        : variants.find((item: any) =>
            (Array.isArray(item.type) ? item.type : [item.type]).includes(
              value === null
                ? "null"
                : Array.isArray(value)
                  ? "array"
                  : typeof value,
            ),
          );
    if (variant) {
      const resolved = { ...definition, ...variant };
      delete resolved.oneOf;
      delete resolved.anyOf;
      return resolved;
    }
  }
  return definition;
}

function parseContainerText(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some providers uniformly escape an entire container without its outer quotes.
    // Require an exact canonical round trip; never search substrings or rewrite quotes.
    const decoded: unknown = JSON.parse('"' + raw + '"');
    if (
      typeof decoded !== "string" ||
      JSON.stringify(decoded).slice(1, -1) !== raw
    )
      throw new Error("noncanonical_json_wrapper");
    parsed = JSON.parse(decoded);
  }
  if (typeof parsed === "string" && JSON.stringify(parsed) === raw)
    parsed = JSON.parse(parsed);
  return parsed;
}

/** Compare meaning conservatively: only lossless schema-directed wrappers/types. */
export function repairInputMeaning(value: unknown, definition: any): unknown {
  definition = inputContract(value, definition);
  const types = Array.isArray(definition.type)
    ? definition.type
    : [definition.type];
  if (typeof value === "string") {
    if (types.includes("number") || types.includes("integer")) {
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
        const number = Number(value);
        if (
          Number.isFinite(number) &&
          String(number) === value &&
          (!types.includes("integer") || Number.isSafeInteger(number))
        )
          value = number;
      }
    } else if (types.includes("object") || types.includes("array")) {
      try {
        const parsed = parseContainerText(value);
        if (isPlainObject(parsed) || Array.isArray(parsed)) value = parsed;
      } catch {
        // A normal string can be a single array item, never a JSON substring.
      }
    }
  }
  if (types.includes("array") && !Array.isArray(value) && value !== null)
    value = [value];
  if (
    types.includes("string") &&
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string"
  )
    value = value[0];
  if (Array.isArray(value))
    return value.map((item) =>
      repairInputMeaning(item, definition.items ?? {}),
    );
  if (isPlainObject(value)) {
    const properties = definition.properties ?? {};
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        // A known spelling alias may move; arbitrary extra fields must survive.
        const field =
          key === "instruction" &&
          properties.instructions &&
          !Object.hasOwn(value, "instructions")
            ? "instructions"
            : key;
        return [field, repairInputMeaning(item, properties[field] ?? {})];
      }),
    );
  }
  return value;
}

function repairInputSchema(value: unknown, definition: any): any {
  const schema = inputContract(value, definition);
  if (isPlainObject(value) && schema.properties) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([key]) => Object.hasOwn(value, key))
        .map(([key, property]) => [
          key,
          repairInputSchema(value[key], property),
        ]),
    );
    return { ...schema, properties, required: Object.keys(properties) };
  }
  if (Array.isArray(value) && value.length) {
    const shapes = [
      ...new Map(
        value.map((item) => {
          const shape = repairInputSchema(item, schema.items ?? {});
          return [canonicalJson(shape), shape];
        }),
      ).values(),
    ];
    return {
      ...schema,
      items: shapes.length === 1 ? shapes[0] : { anyOf: shapes },
    };
  }
  return schema;
}

export function sameRepairMeaning(
  before: unknown,
  after: unknown,
  schema: any,
) {
  return (
    canonicalJson(repairInputMeaning(before, schema)) ===
    canonicalJson(repairInputMeaning(after, schema))
  );
}

/** SDK hook only: this request has a single declared tool and no executor. */
export function argumentRepair(options: {
  model: LanguageModel;
  reserve: (name: string) => Promise<boolean>;
  check: (name: string) => Promise<boolean>;
  observed: (
    name: string,
    outcome:
      | "repaired"
      | "unsafe"
      | "invalid"
      | "unavailable"
      | "exhausted"
      | "interrupted"
      | "failed",
  ) => void | Promise<void>;
  started?: (name: string, details: RepairDetails) => void | Promise<void>;
}): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, tools, inputSchema, error, abortSignal }) => {
    const name = toolCall.toolName;
    if (
      !InvalidToolInputError.isInstance(error) ||
      !Object.hasOwn(tools, name) ||
      !(await options.check(name))
    ) {
      await options.observed(name, "unavailable");
      return null;
    }
    let original: unknown;
    try {
      original = JSON.parse(toolCall.input);
    } catch {
      await options.observed(name, "invalid");
      return null;
    }
    const schema = await inputSchema({ toolName: name });
    const normalized = repairInputMeaning(original, schema);
    const fullSchema = asSchema(tools[name]!.inputSchema);
    const local = await fullSchema.validate?.(normalized);
    if (local?.success && sameRepairMeaning(original, local.value, schema)) {
      if (abortSignal?.aborted) {
        await options.observed(name, "interrupted");
        abortSignal.throwIfAborted();
      }
      if (!(await options.check(name))) {
        await options.observed(name, "unavailable");
        return null;
      }
      await options.observed(name, "repaired");
      return { ...toolCall, input: JSON.stringify(local.value) };
    }
    const focus = repairScope(normalized, schema);
    // Reuse the authoritative validator; expose only supplied root fields to the
    // repair model, without business instructions embedded in descriptions.
    const repairSchema = JSON.parse(
      JSON.stringify(
        repairInputSchema(focus.value, focus.schema),
        (key, value) =>
          key === "description" && typeof value === "string"
            ? undefined
            : value,
      ),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await options.reserve(name))) break;
      let reply: Awaited<ReturnType<typeof generateText>>;
      try {
        await options.started?.(name, focus.details);
        reply = await generateText({
          model: options.model,
          maxRetries: 0,
          temperature: 0,
          maxOutputTokens: 5000,
          abortSignal,
          instructions:
            "你只修复一个工具调用的参数结构，不执行任何业务。normalizedInput是服务端按Schema无损归一后的参数参考，请逐字保留其中所有业务值和字段，不润色、不补充可选字段。只允许数字类型、单项/数组、JSON外壳或instruction/instructions拼写纠正。不得增加缺失业务信息、猜ID、换工具、改数量或删除未知字段；无法无损修复时返回原参数。只使用给定工具返回参数。",
          prompt: JSON.stringify({
            operation: "repair_tool_arguments",
            toolName: name,
            original: focus.value,
            normalizedInput: focus.value,
            error: focus.details.issues,
          }),
          tools: {
            [name]: tool({
              inputSchema: jsonSchema(repairSchema, {
                validate: async (value) => {
                  const merged = focus.merge(value);
                  const checked = await fullSchema.validate?.(merged);
                  return checked?.success
                    ? { success: true, value }
                    : {
                        success: false,
                        error: new Error(
                          "repair must satisfy the complete original contract",
                        ),
                      };
                },
              }),
            }),
          },
          toolChoice: { type: "tool", toolName: name },
        });
      } catch (failure) {
        if (abortSignal?.aborted) {
          await options.observed(name, "interrupted");
          abortSignal.throwIfAborted();
        }
        if (!ToolChoiceViolationError.isInstance(failure)) {
          await options.observed(name, "failed");
          throw failure;
        }
        await options.observed(name, "invalid");
        continue;
      }
      if (abortSignal?.aborted) {
        await options.observed(name, "interrupted");
        abortSignal.throwIfAborted();
      }
      if (!(await options.check(name))) {
        await options.observed(name, "unavailable");
        return null;
      }
      const call =
        reply.toolCalls.length === 1 ? reply.toolCalls[0] : undefined;
      if (call?.toolName === name && !call.invalid) {
        const merged = focus.merge(call.input);
        if (
          (await fullSchema.validate?.(merged))?.success &&
          sameRepairMeaning(original, merged, schema)
        ) {
          await options.observed(name, "repaired");
          return { ...toolCall, input: JSON.stringify(merged) };
        }
        await options.observed(name, "unsafe");
      } else await options.observed(name, "invalid");
    }
    await options.observed(name, "exhausted");
    return null;
  };
}
