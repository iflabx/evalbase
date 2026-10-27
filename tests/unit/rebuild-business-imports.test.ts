import { expect, it, vi } from "vitest";
// Loading business operations/new runtime must not require a legacy planner or scheduler.
vi.mock("../../src/assistant/plan.js", () => {
  throw Error("legacy_plan_loaded");
});
vi.mock("../../src/assistant/tasks.js", () => {
  throw Error("legacy_scheduler_loaded");
});
it("loads actual business and rebuild entry points with legacy execution unavailable", async () => {
  const [draft, selection, processing, adoption, publication, host] =
    await Promise.all([
      import("../../src/drafts/create.js"),
      import("../../src/selection/store.js"),
      import("../../src/processing/store.js"),
      import("../../src/processing/accept.js"),
      import("../../src/version/publish-sparse.js"),
      import("../../src/assistant-rebuild/host.js"),
    ]);
  expect(
    [
      draft.createSharedDraft,
      selection.applySelectionPreview,
      processing.createProcessingRun,
      adoption.acceptProcessingResults,
      publication.publishSparseVersion,
      host.RebuildHost,
    ].every((x) => typeof x === "function"),
  ).toBe(true);
});
