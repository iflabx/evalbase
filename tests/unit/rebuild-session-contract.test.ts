import { describe, expect, it } from "vitest";
import {
  messageSubmissionSchema,
  requirementChangeSchema,
} from "../../src/assistant-rebuild/session-contract.js";

describe("formal assistant contracts", () => {
  it("requires a stable submission identity and rejects caller authority", () => {
    const valid = {
      submissionId: "submission-1234567890",
      expectedRevision: 1,
      text: "给我一个方案",
    };
    expect(messageSubmissionSchema.safeParse(valid).success).toBe(true);
    for (const extra of [
      { token: "forged" },
      { actorId: "other" },
      { operationId: "model-key" },
      { execution: true },
    ])
      expect(
        messageSubmissionSchema.safeParse({ ...valid, ...extra }).success,
      ).toBe(false);
  });
  it("supports partial requirement amendments and the existing 10000-row business ceiling", () => {
    expect(
      requirementChangeSchema.safeParse({
        expectedRevision: 0,
        changes: {
          deliveries: [
            { patch: { name: "意图识别", operation: "generate", count: 400 } },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      requirementChangeSchema.safeParse({
        expectedRevision: 1,
        changes: {
          deliveries: [
            {
              deliveryId: "delivery-real",
              patch: {
                allowedFields: ["question"],
                instructions: "整理首尾空白，其他不变",
              },
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      requirementChangeSchema.safeParse({
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { count: 10001 } }] },
      }).success,
    ).toBe(false);
    expect(
      requirementChangeSchema.safeParse({
        expectedRevision: 0,
        changes: { steps: [] },
      }).success,
    ).toBe(false);
  });
});
