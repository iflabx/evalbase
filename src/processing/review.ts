import { canonicalJson } from "../package/contract.js";
import type { readProcessingRun } from "./store.js";

/** Full-result diagnostics; semantic correctness still belongs to the reviewer. */
export function reviewCandidates(
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  goal?: { targetCount?: number; allowedLabels?: string[] },
) {
  const seen = new Set<string>(),
    labels: Record<string, number> = {};
  let emptyQuestions = 0,
    duplicates = 0,
    protectedFieldChanges = 0,
    outsideLabels = 0;
  for (const row of data.records) {
    const record = row.result;
    if (!record.question.trim()) emptyQuestions++;
    const key = canonicalJson({
      question: record.question,
      expectedOutput: record.expectedOutput,
      metadata: record.metadata,
    });
    if (seen.has(key)) duplicates++;
    else seen.add(key);
    labels[record.expectedOutput] = (labels[record.expectedOutput] ?? 0) + 1;
    if (
      goal?.allowedLabels?.length &&
      !goal.allowedLabels.includes(record.expectedOutput)
    )
      outsideLabels++;
    for (const field of ["question", "expectedOutput", "metadata"] as const)
      if (
        !data.run.options.allowedFields.includes(field) &&
        row.original &&
        canonicalJson(record[field]) !== canonicalJson(row.original[field])
      )
        protectedFieldChanges++;
  }
  const expectedCount =
    goal?.targetCount ?? data.run.options.outputCount ?? data.run.inputCount;
  const formatIssues = data.issues.filter((issue) =>
    [
      "invalid_output",
      "unknown_source",
      "duplicate_source",
      "missing_output",
      "excess_output",
      "processing_batch_failed",
    ].includes(issue.code),
  );
  return {
    total: data.total,
    expectedCount,
    countSatisfied: data.total === expectedCount,
    emptyQuestions,
    duplicates,
    protectedFieldChanges,
    outsideLabels,
    labels: Object.entries(labels)
      .slice(0, 100)
      .map(([label, count]) => ({ label, count })),
    additionalLabels: Math.max(0, Object.keys(labels).length - 100),
    formatIssues,
    complete:
      data.run.status === "succeeded" &&
      data.total === expectedCount &&
      !outsideLabels &&
      !protectedFieldChanges &&
      !formatIssues.length,
    semanticReview: "required",
  };
}
