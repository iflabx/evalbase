import type { MetadataEntry } from "@/services/workspace";
import type { SharedDraftRecord } from "./drafts";

export type RecordEdit = Pick<SharedDraftRecord, "question" | "expectedOutput" | "metadata">;
export type RecordField = keyof RecordEdit;
export type FieldConflict = {
  local: string | MetadataEntry[];
  remote: string | MetadataEntry[];
  authorId?: string | undefined;
  at?: string | undefined;
};
const fields: RecordField[] = ["question", "expectedOutput", "metadata"];
const equal = (a: string | MetadataEntry[], b: string | MetadataEntry[]) =>
  JSON.stringify(a) === JSON.stringify(b);
export function mergeRecordSnapshot(
  base: SharedDraftRecord,
  local: RecordEdit,
  remote: SharedDraftRecord,
): {
  edit: RecordEdit;
  conflicts: Partial<Record<RecordField, FieldConflict>>;
} {
  const edit: RecordEdit = { ...local };
  const conflicts: Partial<Record<RecordField, FieldConflict>> = {};
  for (const field of fields) {
    const revisionKey = `${field}Revision` as
      "questionRevision" | "expectedOutputRevision" | "metadataRevision";
    if (remote[revisionKey] <= base[revisionKey]) continue;
    if (equal(local[field], base[field]) || equal(local[field], remote[field])) {
      if (field === "metadata") edit.metadata = remote.metadata.map((item) => ({ ...item }));
      else edit[field] = remote[field];
    } else {
      const fact = remote.fieldAttribution?.[field];
      conflicts[field] = {
        local: local[field],
        remote: remote[field],
        authorId: fact?.userId,
        at: fact?.at,
      };
    }
  }
  return { edit, conflicts };
}
