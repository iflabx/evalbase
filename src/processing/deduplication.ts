import { canonicalJson } from "../package/contract.js";
import type { ProcessingInput } from "./protocol.js";

type Content = Pick<
  ProcessingInput,
  "question" | "expectedOutput" | "metadata"
>;
/** Compare actual content only. Metadata entry ordering carries no business meaning. */
export function contentKey(row: Content) {
  return canonicalJson({
    question: row.question,
    expectedOutput: row.expectedOutput,
    metadata: [...row.metadata].sort((a, b) =>
      a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : a.value < b.value
            ? -1
            : a.value > b.value
              ? 1
              : 0,
    ),
  });
}
export function deduplicate(
  rows: (Content & { id: string })[],
  existing: Content[] = [],
) {
  const baseline = new Set(existing.map(contentKey)),
    seen = new Set(baseline),
    groups = new Map<string, string[]>(),
    questions = new Map<string, { keys: Set<string>; ids: string[] }>();
  const keptIds: string[] = [],
    excludedIds: string[] = [];
  for (const row of rows) {
    const key = contentKey(row);
    if (seen.has(key)) excludedIds.push(row.id);
    else keptIds.push(row.id);
    seen.add(key);
    const group = groups.get(key) ?? [];
    group.push(row.id);
    groups.set(key, group);
    const question = questions.get(row.question) ?? {
      keys: new Set<string>(),
      ids: [],
    };
    question.keys.add(key);
    question.ids.push(row.id);
    questions.set(row.question, question);
  }
  const duplicateIds = new Set(
    [...groups].flatMap(([key, ids]) =>
      ids.length > 1 || baseline.has(key) ? ids : [],
    ),
  );
  const collisions = new Set(
    [...questions.values()].flatMap((group) =>
      group.keys.size > 1 ? group.ids : [],
    ),
  );
  return {
    keptIds,
    excludedIds,
    duplicateIds: rows
      .filter((row) => duplicateIds.has(row.id))
      .map((row) => row.id),
    questionCollisionIds: rows
      .filter((row) => collisions.has(row.id))
      .map((row) => row.id),
  };
}
