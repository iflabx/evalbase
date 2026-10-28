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

export const FORMAL_RUNTIME_VERSION = "deepagents-v2";
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
    { ...options, allowedFields: [] },
    records,
    [],
    true,
  );
}

/** Scope/field semantics bind rules; labels and save destinations do not change processing. */
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
export class RequirementRepairError extends BusinessError {
  constructor(
    readonly paths: string[][],
    readonly contexts: { deliveryId: string; before: string; after: string }[],
    code: string,
    hint: string,
    readonly targetBindings: { index: number; deliveryId: string }[] = [],
  ) {
    super(422, code, hint);
  }
}
export class InstructionRefreshError extends RequirementRepairError {
  constructor(
    paths: string[][],
    contexts: { deliveryId: string; before: string; after: string }[],
  ) {
    super(
      paths,
      contexts,
      "processing_instructions_refresh_required",
      "处理范围或规则已变化，请按当前要求重新整理加工规则，勿在规则中重复记录范围、总数量或保存目标；原方案未被覆盖。保持本次已明确的范围、数量与目标，只补齐受影响的instructions。",
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
  if (active.length !== 1)
    issues.push({
      code: "single_delivery_required",
      message: "当前执行能力要求一份活动交付",
    });
  for (const d of active) {
    const missing = (field: string, message: string) =>
      issues.push({
        code: "execution_requirements_incomplete",
        deliveryId: d.id,
        field,
        message,
      });
    if (!["clean", "rewrite"].includes(d.operation ?? ""))
      missing("operation", "需要明确清洗或改写操作");
    if (!d.source?.recordIds?.length) missing("source", "需要固定实际输入记录");
    if (d.count === undefined || d.count !== d.source?.recordIds?.length)
      missing("count", "数量须与固定输入范围一致");
    if (!d.allowedFields?.length)
      missing("allowedFields", "需要明确允许修改的字段");
    if (d.allowedFields?.includes("metadata") && d.metadataKeys?.length === 0)
      missing("metadataKeys", "未指定允许修改的Metadata字段");
    if (d.saveTarget?.kind !== "newDraft")
      missing("saveTarget", "当前保存能力需要新草稿目标");
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
    (d) => d.status === "active",
  )! as Delivery & {
    source: Source & { recordIds: string[] };
    count: number;
    operation: "clean" | "rewrite";
    allowedFields: NonNullable<Delivery["allowedFields"]>;
    saveTarget: { kind: "newDraft"; name: string; purpose?: string };
  };
}
