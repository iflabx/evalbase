import { BusinessError } from "../operations/errors.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { z } from "zod";
import type {
  ProcessingInput,
  ProcessingOptions,
} from "../processing/protocol.js";
import {
  validateProcessingRequirements,
  validateRules,
} from "../processing/requirements.js";

export const FORMAL_RUNTIME_VERSION = "deepagents-v4";
const id = z.string().min(1).max(250);
const fields = z
  .array(z.enum(["question", "expectedOutput", "metadata"]))
  .min(1)
  .max(3)
  .refine((v) => new Set(v).size === v.length);
const recordIds = z
  .array(id)
  .min(1)
  .max(10000)
  .refine((v) => new Set(v).size === v.length);
export const sourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("assets"),
      assetIds: z.array(id).min(1).max(5),
      recordIds: recordIds.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("draft"), id, recordIds: recordIds.optional() })
    .strict(),
  z
    .object({ kind: z.literal("version"), id, recordIds: recordIds.optional() })
    .strict(),
]);
const classification = z
  .object({
    field: z.enum(["expectedOutput", "metadata"]),
    key: z.string().min(1).max(250).optional(),
    basis: z.enum(["background", "user"]).optional(),
    allowedValues: z.array(z.string().max(2000)).max(100).optional(),
    requiredValues: z.array(z.string().max(2000)).max(100).optional(),
    definitions: z
      .array(
        z
          .object({
            value: z.string().max(2000),
            text: z.string().max(8000),
            basis: z.enum(["background", "user"]).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    quotas: z
      .array(
        z
          .object({
            value: z.string().max(2000),
            count: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
export const deliveryPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    purpose: z.string().max(2000).optional(),
    operation: z.enum(["clean", "rewrite", "augment", "generate"]).optional(),
    count: z.number().int().min(1).max(10000).optional(),
    source: sourceSchema.nullable().optional(),
    allowedFields: fields.optional(),
    metadataKeys: z
      .array(z.string().trim().min(1).max(250))
      .max(100)
      .optional(),
    instructions: z.string().max(8000).optional(),
    classifications: z.array(classification).max(100).optional(),
    saveTarget: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("newDraft"),
            name: z.string().trim().min(1).max(200),
            purpose: z.string().max(2000).optional(),
          })
          .strict(),
        z.object({ kind: z.literal("draft"), id }).strict(),
        z.object({ kind: z.literal("asset") }).strict(),
      ])
      .nullable()
      .optional(),
    status: z.enum(["active", "cancelled"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "修改内容不能为空");
export const requirementChangeSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    changes: z
      .object({
        objective: z.string().max(8000).optional(),
        mode: z.enum(["plan", "execute"]).optional(),
        deliveries: z
          .array(
            z
              .object({ deliveryId: id.optional(), patch: deliveryPatchSchema })
              .strict(),
          )
          .max(100)
          .optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, "修改内容不能为空"),
  })
  .strict();
/** Creation never derives its meaning from an omitted target identity. */
export const requirementCreationSchema = requirementChangeSchema
  .safeExtend({
    changes: requirementChangeSchema.shape.changes.safeExtend({
      deliveries: z
        .array(
          z
            .object({
              patch: deliveryPatchSchema.refine(
                (p) => p.status !== "cancelled",
                "新增不能同时取消",
              ),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    }),
  })
  .describe("创建新交付 v2；不用于修改既有交付");
export type RequirementCommand = "create" | "update";
export const messageSubmissionSchema = z
  .object({
    submissionId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    expectedRevision: z.number().int().min(1),
    text: z
      .string()
      .min(1)
      .max(20000)
      .refine((v) => v.trim().length > 0),
    context: sourceSchema.optional(),
    contextRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    attachments: z.array(id).max(5).optional(),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
export type Delivery = z.infer<typeof deliveryPatchSchema> & {
  id: string;
  status: "active" | "cancelled";
  sourceSnapshot?: { hash: string; revision: unknown };
  instructionsContext?: string;
};
export type SessionRequirements = {
  objective: string;
  mode: "plan" | "execute";
  deliveries: Delivery[];
};
export type RequirementChange = z.infer<typeof requirementChangeSchema>;
export const emptyRequirements = (): SessionRequirements => ({
  objective: "",
  mode: "plan",
  deliveries: [],
});
export function validateDelivery(value: Delivery) {
  validateRules({
    classifications: value.classifications,
    targetCount: value.count,
    metadataKeys: value.metadataKeys,
    allowedFields: value.allowedFields,
  });
}

/** Exact output values and quotas, independent of semantic content review. */
export function validateDeliveryResults(
  delivery: Delivery,
  records: ProcessingInput[],
  options: ProcessingOptions,
) {
  validateProcessingRequirements(
    { targetCount: delivery.count, classifications: delivery.classifications },
    { ...options, operation: "clean", allowedFields: [] },
    records,
    [],
    true,
  );
}

/** Scope/field semantics bind rules; labels and save destinations do not change processing. */
export function instructionRuleContext(delivery: Delivery) {
  const source = delivery.source;
  return canonicalJson({
    operation: delivery.operation ?? null,
    allowedFields: [...(delivery.allowedFields ?? [])].sort(),
    metadataKeys: delivery.allowedFields?.includes("metadata")
      ? [...(delivery.metadataKeys ?? [])].sort()
      : null,
    classifications: delivery.classifications ?? [],
    source:
      source?.kind === "assets"
        ? { kind: source.kind, assetIds: [...source.assetIds].sort() }
        : source
          ? { kind: source.kind, id: source.id }
          : null,
  });
}
// Only explicit record-scope expressions are checked; arbitrary prose is not parsed.
export function instructionScopeConflict(
  delivery: Delivery,
): string | undefined {
  if (delivery.count === undefined || !delivery.instructions) return;
  if (["augment", "generate"].includes(delivery.operation ?? "")) return;
  const text = delivery.instructions;
  // Ambiguous subgroups, examples and negations are not evidence of a whole-task scope conflict.

  const number = (text: string): number => {
    if (/^\d+$/.test(text)) return Number(text);
    const digits: Record<string, number> = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
    let total = 0,
      current = 0;
    for (const ch of text) {
      if (ch in digits) current = digits[ch];
      else if (ch in units) {
        total += (current || 1) * units[ch];
        current = 0;
      } else return NaN;
    }
    return total + current;
  };
  for (const clause of text.split(/[，。；;\n]/)) {
    if (/(?:每|分批|不要|不能|并非|例如|比如|示例)/.test(clause)) continue;
    const expressions = clause.matchAll(
      /^\s*(?:只|仅)?(?:处理|清洗|改写|整理)\s*(?:前\s*|共\s*|总共\s*|全部\s*)?([0-9零一二两三四五六七八九十百千]+)\s*[条行]/g,
    );
    for (const match of expressions)
      if (number(match[1]) !== delivery.count)
        return (
          "加工说明中的「" +
          match[0] +
          "」与当前结构化数量 " +
          delivery.count +
          " 条冲突；只修正该范围表述，保留其他加工规则。"
        );
  }
}
export function instructionContext(delivery: Delivery) {
  return sha256(
    canonicalJson({
      operation: delivery.operation ?? null,
      count: delivery.count ?? null,
      source: delivery.sourceSnapshot
        ? {
            kind: delivery.source?.kind,
            snapshot: delivery.sourceSnapshot,
            recordIds: delivery.source?.recordIds ?? [],
          }
        : (delivery.source ?? null),
      allowedFields: [...(delivery.allowedFields ?? [])].sort(),
      metadataKeys: delivery.allowedFields?.includes("metadata")
        ? [...(delivery.metadataKeys ?? [])].sort()
        : null,
      classifications: delivery.classifications ?? [],
    }),
  );
}
export function deliveryExecution(delivery: Delivery) {
  const operation = delivery.operation
    ? {
        clean: "清洗",
        rewrite: "改写",
        augment: "扩充",
        generate: "生成",
      }[delivery.operation]
    : "待确认操作";
  const fields = (delivery.allowedFields ?? [])
    .map(
      (f) =>
        ({
          question: "问题",
          expectedOutput: "期望输出",
          metadata: "Metadata",
        })[f],
    )
    .join("、");
  const amount = ["augment", "generate"].includes(delivery.operation ?? "")
    ? "新增"
    : "处理";
  const target =
    delivery.saveTarget?.kind === "newDraft"
      ? "保存为「" + delivery.saveTarget.name + "」"
      : delivery.saveTarget?.kind === "draft"
        ? "保存到指定草稿"
        : "";
  return {
    summary: [
      operation + " · " + amount + " " + (delivery.count ?? "待确认") + " 条",
      fields ? "允许修改：" + fields : "",
      target,
    ]
      .filter(Boolean)
      .join(" · "),
    rules: delivery.instructions ?? "",
  };
}
export type RequirementTargetBinding = {
  index: number;
  deliveryId: string;
  patch?: z.infer<typeof deliveryPatchSchema>;
};
export class RequirementRepairError extends BusinessError {
  constructor(
    readonly paths: string[][],
    readonly contexts: { deliveryId: string; before: string; after: string }[],
    code: string,
    hint: string,
    readonly targetBindings: RequirementTargetBinding[] = [],
  ) {
    super(422, code, hint);
  }
}
export class InstructionRefreshError extends RequirementRepairError {
  constructor(
    paths: string[][],
    contexts: { deliveryId: string; before: string; after: string }[],
    targetBindings: RequirementTargetBinding[] = [],
    conflict?: string,
  ) {
    super(
      paths,
      contexts,
      "processing_instructions_refresh_required",
      conflict ??
        "加工方式、字段或来源身份已变化，请重新核对并显式提供适用的加工规则；仍适用时可以保留原文，无需更换同义词。保持本次数量、范围、目标和交付身份不变。",
      targetBindings,
    );
  }
}
export function assertInstructionsCurrent(delivery: Delivery) {
  if (
    delivery.instructions?.trim() &&
    delivery.instructionsContext !== instructionContext(delivery)
  )
    throw new BusinessError(
      422,
      "processing_instructions_stale",
      "加工规则尚未按当前要求核对，本步骤未执行；请先更新要求，原记录与成果保留。",
    );
}

export type ReadinessIssue = {
  code: string;
  message: string;
  deliveryId?: string;
  field?: string;
};
/** The single current execution contract; plan drafts may intentionally remain incomplete. */
export function executionReadiness(
  requirements: SessionRequirements,
  pending = false,
) {
  const active = requirements.deliveries.filter((d) => d.status === "active"),
    issues: ReadinessIssue[] = [];
  if (pending)
    issues.push({
      code: "requirements_amendment_pending",
      message: "本次修改尚未完整生效",
    });
  if (!active.length)
    issues.push({
      code: "active_delivery_required",
      message: "需要至少一份活动交付",
    });
  for (const d of active) {
    const missing = (field: string, message: string) =>
      issues.push({
        code: "execution_requirements_incomplete",
        deliveryId: d.id,
        field,
        message,
      });
    if (
      !["clean", "rewrite", "augment", "generate"].includes(d.operation ?? "")
    )
      missing("operation", "需要明确处理操作");
    if (d.operation !== "generate" && !d.source?.recordIds?.length)
      missing("source", "需要固定实际输入记录");
    if (d.operation === "generate" && d.source)
      missing("source", "从背景生成不使用原始记录");
    if (
      d.count === undefined ||
      (d.operation !== "generate" &&
        d.operation !== "augment" &&
        d.count !== d.source?.recordIds?.length)
    )
      missing("count", "需要明确数量，一对一处理须与固定输入范围一致");
    if (
      ["generate", "augment", "rewrite"].includes(d.operation ?? "") &&
      !d.instructions?.trim()
    )
      missing("instructions", "需要明确生成或改写要求");
    if (d.operation === "generate" && d.allowedFields?.length !== 3)
      missing("allowedFields", "从零生成需要生成问题、期望输出和Metadata");
    if (!d.allowedFields?.length)
      missing("allowedFields", "需要明确允许修改的字段");
    if (d.allowedFields?.includes("metadata") && d.metadataKeys?.length === 0)
      missing("metadataKeys", "未指定允许修改的Metadata字段");
    if (!d.saveTarget) missing("saveTarget", "需要明确保存目标");
    if (
      d.instructions?.trim() &&
      d.instructionsContext !== instructionContext(d)
    )
      issues.push({
        code: "processing_instructions_stale",
        deliveryId: d.id,
        field: "instructions",
        message: "加工规则需要按当前上下文核对",
      });
  }
  return {
    ready: requirements.mode === "execute" && issues.length === 0,
    complete: issues.length === 0,
    issues,
  };
}
export function assertExecutionReady(
  requirements: SessionRequirements,
  pending = false,
  deliveryId?: string,
) {
  const readiness = executionReadiness(requirements, pending);
  if (!readiness.ready)
    throw new BusinessError(
      422,
      readiness.issues[0]?.code ?? "execution_not_authorized",
      readiness.issues.map((i) => i.message).join("；") ||
        "当前仅保存方案，未授权执行",
    );
  return requirements.deliveries.find(
    (d) => d.status === "active" && (!deliveryId || d.id === deliveryId),
  )! as Delivery & {
    source: Source & { recordIds: string[] };
    count: number;
    operation: "clean" | "rewrite" | "augment" | "generate";
    allowedFields: NonNullable<Delivery["allowedFields"]>;
    saveTarget: { kind: "newDraft"; name: string; purpose?: string };
  };
}
