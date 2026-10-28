import { z } from "zod";
import { materialRecordRows } from "../materials/store.js";
import { previewProcessingInput } from "../processing/store.js";
import {
  SessionStore,
  SessionError,
  type SessionScope,
} from "./session-store.js";
import { sourceSchema } from "./session-contract.js";
const inputSchema = z
  .object({
    collectionId: z.string().min(1),
    assetId: z.string().min(1).optional(),
    mode: z.enum(["selected", "matching", "file"]),
    records: z
      .array(
        z
          .object({
            assetId: z.string().min(1),
            ordinal: z.number().int().min(1),
          })
          .strict(),
      )
      .max(10000)
      .optional(),
    search: z.string().max(200).optional(),
  })
  .strict();
export async function fixedMaterialInput(
  store: SessionStore,
  scope: SessionScope,
  input: unknown,
) {
  await store.access(scope);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new SessionError("input_scope_invalid", 422);
  const v = parsed.data;
  if (v.mode === "selected" && !v.records?.length)
    throw new SessionError("input_scope_empty", 422);
  if (v.mode === "file" && !v.assetId)
    throw new SessionError("input_scope_invalid", 422);
  const rows = await materialRecordRows(
    store.db,
    scope.projectId,
    v.collectionId,
    v.assetId,
    v.mode === "matching" ? v.search : undefined,
  );
  const keys = new Set(
    v.records?.map((r) => r.assetId + ":" + r.ordinal) ?? [],
  );
  const selected =
    v.mode === "selected"
      ? rows.filter((r: any) => keys.has(r.assetId + ":" + r.ordinal))
      : rows;
  if (
    v.mode === "selected" &&
    new Set(selected.map((r: any) => r.assetId + ":" + r.ordinal)).size !==
      keys.size
  )
    throw new SessionError("source_revision_conflict", 409);
  if (!selected.length) throw new SessionError("input_scope_empty", 422);
  if (selected.length > 10000)
    throw new SessionError("input_scope_capacity", 413);
  const source = sourceSchema.safeParse({
    kind: "assets",
    assetIds: [...new Set(selected.map((r: any) => r.assetId))],
    recordIds: selected.map((r: any) => r.recordId),
  });
  if (!source.success) throw new SessionError("input_scope_capacity", 413);
  await store.freezeSource(scope, source.data);
  const preview = await previewProcessingInput(
    store.db,
    scope,
    {
      source: { kind: "assets", assetIds: (source.data as any).assetIds },
      limit: 1,
    },
    "read",
  );
  return {
    source: source.data,
    sourceRevision: preview.sourceRevision,
    total: selected.length,
  };
}
