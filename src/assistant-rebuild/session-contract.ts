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
