import { canonicalJson } from "../package/contract.js";
import type { readProcessingRun } from "./store.js";
import type { ProcessingInput } from "./protocol.js";

export type CandidateGoal = {
  targetCount?: number | null;
  countKind?: "new" | "final";
  allowedLabels?: string[];
  classifications?: {
    field: "expectedOutput" | "metadata";
    key?: string;
    allowedValues?: string[];
    quotas?: { value: string; count: number }[];
  }[];
};

/** Full-result diagnostics; semantic correctness still belongs to the reviewer. */
export function reviewCandidates(
  data: Awaited<ReturnType<typeof readProcessingRun>>,
  goal?: CandidateGoal,
  runs: Awaited<ReturnType<typeof readProcessingRun>>[] = [data],
  final?: {
    records: ProcessingInput[];
    baseCount: number;
    remainingCount: number;
    revision: number;
  },
) {
  const seen = new Set<string>(),
    labels = new Map<string, number>();
  let emptyQuestions = 0,
    duplicates = 0,
    protectedFieldChanges = 0,
    outsideLabels = 0;
  const records =
    final?.records ??
    runs.flatMap((batch) => batch.records.map((row) => row.result));
  for (const record of records) {
    if (!record.question.trim()) emptyQuestions++;
    const key = canonicalJson({
      question: record.question,
      expectedOutput: record.expectedOutput,
      metadata: record.metadata,
    });
    if (seen.has(key)) duplicates++;
    else seen.add(key);
    labels.set(
      record.expectedOutput,
      (labels.get(record.expectedOutput) ?? 0) + 1,
    );
    if (
      goal?.allowedLabels?.length &&
      !goal.allowedLabels.includes(record.expectedOutput)
    )
      outsideLabels++;
  }
  for (const batch of runs)
    for (const row of batch.records)
      for (const field of ["question", "expectedOutput", "metadata"] as const)
        if (
          !batch.run.options.allowedFields.includes(field) &&
          row.original &&
          canonicalJson(row.result[field]) !==
            canonicalJson(row.original[field])
        )
          protectedFieldChanges++;
  const expectedRunCount = runs.reduce(
    (count, item) =>
      count + (item.run.options.outputCount ?? item.run.inputCount),
    0,
  );
  const expectedCount =
    goal?.targetCount === null ? null : (goal?.targetCount ?? expectedRunCount);
  const candidateCount = runs.reduce((count, item) => count + item.total, 0);
  const total = final ? records.length : candidateCount;
  const countSatisfied =
    expectedCount === null
      ? candidateCount === expectedRunCount
      : total === expectedCount;
  const formatIssues = runs
    .flatMap((item) => item.issues)
    .filter((issue) =>
      [
        "invalid_output",
        "unknown_source",
        "duplicate_source",
        "missing_output",
        "excess_output",
        "processing_batch_failed",
      ].includes(issue.code),
    );
  const classifications = (goal?.classifications ?? []).map((rule) => {
    const counts = new Map<string, number>();
    let missing = 0,
      outsideValues = 0;
    for (const record of records) {
      const values =
        rule.field === "expectedOutput"
          ? [record.expectedOutput]
          : record.metadata
              .filter((entry) => entry.key === rule.key)
              .map((entry) => entry.value);
      if (values.length !== 1 || !values[0]!.trim()) {
        missing++;
        continue;
      }
      const value = values[0]!;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (rule.allowedValues?.length && !rule.allowedValues.includes(value))
        outsideValues++;
    }
    const quotaDifferences = (rule.quotas ?? []).flatMap(({ value, count }) => {
      const actual = counts.get(value) ?? 0;
      return actual === count ? [] : [{ value, expected: count, actual }];
    });
    return {
      field: rule.field,
      ...(rule.key === undefined ? {} : { key: rule.key }),
      missing,
      outsideValues,
      values: [...counts]
        .slice(0, 100)
        .map(([value, count]) => ({ value, count })),
      additionalValues: Math.max(0, counts.size - 100),
      quotaDifferences,
      satisfied: !missing && !outsideValues && !quotaDifferences.length,
    };
  });
  return {
    runId: data.run.id,
    total,
    countKind: goal?.countKind ?? "new",
    candidateCount,
    ...(final
      ? {
          baseCount: final.baseCount,
          remainingCount: final.remainingCount,
          draftRevision: final.revision,
        }
      : {}),
    missingCount: runs.reduce(
      (count, item) => count + (item.run.missingCount ?? 0),
      0,
    ),
    expectedCount,
    countSatisfied,
    emptyQuestions,
    duplicates,
    protectedFieldChanges,
    outsideLabels,
    labels: [...labels]
      .slice(0, 100)
      .map(([label, count]) => ({ label, count })),
    additionalLabels: Math.max(0, labels.size - 100),
    classifications,
    formatIssues,
    complete:
      runs.every((item) => item.run.status === "succeeded") &&
      countSatisfied &&
      !outsideLabels &&
      !emptyQuestions &&
      !duplicates &&
      classifications.every((rule) => rule.satisfied) &&
      !protectedFieldChanges &&
      !formatIssues.length,
    semanticReview: "required",
  };
}
