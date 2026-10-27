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
export class InstructionRefreshError extends BusinessError {
  constructor(
    readonly paths: string[][],
    readonly contexts: { deliveryId: string; before: string; after: string }[],
  ) {
    super(
      422,
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
