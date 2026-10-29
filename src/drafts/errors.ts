import { BusinessError } from "../operations/errors.js";
import type { OperationScope } from "../operations/commit.js";
export type DraftScope = OperationScope & {
  draftId?: string;
  recordId?: string;
  testSetId?: string;
  versionId?: string;
  ordinal?: string;
  changeId?: string;
};
export class DraftOperationError extends BusinessError {
  constructor(
    status: number,
    public body: Record<string, any>,
  ) {
    super(status, body?.error?.code ?? "draft_operation_failed");
  }
}
