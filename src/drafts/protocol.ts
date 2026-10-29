import { selectionProblems } from "../selection/index.js";
import { z } from "zod";
export const identity = z.string().min(1).max(250);
export const pageSchema = z
  .object({
    search: z.string().max(200).default(""),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
const metadata = z.array(
  z.object({ key: z.string(), value: z.string() }).strict(),
);
const source = z
  .object({ assetId: identity, ordinal: z.number().int().min(0) })
  .strict();
export const draftPatchSchema = z
  .object({
    field: z.enum(["name", "purpose"]),
    value: z.string().max(2000),
    expectedFieldRevision: z.number().int().min(0),
  })
  .strict();
export const draftRecordSchema = z
  .object({
    question: z.string().optional(),
    expectedOutput: z.string().optional(),
    metadata: metadata.optional(),
    source: source.optional(),
  })
  .strict();
export const recordPatchSchema = z
  .object({
    field: z.enum(["question", "expectedOutput", "metadata", "source"]),
    value: z.union([z.string().max(100000), metadata, source, z.null()]),
    expectedFieldRevision: z.number().int().min(0),
  })
  .strict();
export const selectionSchema = z
  .object({
    assetIds: z.array(identity).min(1).max(5),
    conditions: z
      .array(
        z
          .object({
            field: z.enum(["question", "expectedOutput", "metadata"]),
            key: z.string().optional(),
            operator: z.enum(["contains", "equals", "empty", "filled"]),
            value: z.string().optional(),
          })
          .strict(),
      )
      .max(20),
    method: z.enum(["all", "random"]),
    mode: z.enum(["count", "percent"]).optional(),
    value: z.number().optional(),
    seed: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const problem of selectionProblems(value)) {
      if (value.method === "all" && ["/mode", "/value"].includes(problem.path))
        ctx.addIssue({
          code: "unrecognized_keys",
          keys: [problem.path.slice(1)],
          message: problem.message,
        });
      else
        ctx.addIssue({
          code: "custom",
          path: problem.path
            .split("/")
            .filter(Boolean)
            .map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
          message: problem.message,
        });
    }
  });
