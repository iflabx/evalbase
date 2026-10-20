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
export type QuestionPolicy = "distinct-v1" | "variants-v1";

/** Matches the existing clean operation: trim outer whitespace, preserve meaningful text. */
export const questionKey = (row: Pick<Content, "question">) =>
  row.question.trim();
export const candidateKey = (row: Content, policy?: QuestionPolicy) =>
  policy === "distinct-v1" ? questionKey(row) : contentKey(row);

/** Only actual user clauses can freeze an exception; model instructions are never passed here. */
export function newQuestionPolicy(
  operation: string,
  userRequests: string[],
  delivery?: { name: string; names: string[] },
): QuestionPolicy | undefined {
  if (!["generate", "augment"].includes(operation)) return;
  let policy: QuestionPolicy = "distinct-v1";
  for (const text of userRequests)
    for (const clause of text.split(/[。；;，,\n]/u)) {
      const contrast =
        /同题(?:多|不同)(?:答案|回答)|同一(?:个)?问题.{0,8}(?:多个|不同|多种)(?:答案|回答)|对照样本/u;
      const denied =
        /(?:不要|不得|禁止|不允许|不需要|不生成|不制作|不做|不想|不希望|无需|无须|没有|避免|排除|不含|取消|不再).{0,12}/u.test(
          clause,
        ) && contrast.test(clause);
      if (delivery && delivery.names.length > 1) {
        const named = delivery.names.filter((name) => clause.includes(name));
        const allDeliveries =
          /(?:每份|全部|所有)(?:交付|测试集|集合)?/u.test(clause) ||
          (delivery.names.length === 2 &&
            /(?:这)?两份/u.test(clause) &&
            !/(?:前|后|其中).{0,4}两份/u.test(clause));
        // Unqualified revocation is conservative; granting an exception needs clear scope.
        if (
          named.length
            ? named.length !== 1 || named[0] !== delivery.name
            : !denied && !allDeliveries
        )
          continue;
      }
      if (denied) policy = "distinct-v1";
      else if (
        /(?:每条|全部|所有).{0,8}(?:不同|不重复)(?:的)?问题/u.test(clause)
      )
        policy = "distinct-v1";
      else if (
        !/(?:解释|什么是|是否|是不是|能否|例如|比如)/u.test(clause) &&
        new RegExp(
          "(?:生成|创建|制作|保留|允许|需要|做)\\s*(?:一组|一些|多组|一份|若干)?\\s*(?:" +
            contrast.source +
            ")",
          "u",
        ).test(clause)
      )
        policy = "variants-v1";
    }
  return policy;
}

export function deduplicate(
  rows: (Content & { id: string })[],
  existing: Content[] = [],
  policy?: QuestionPolicy,
) {
  const baseline = new Set(existing.map((row) => candidateKey(row, policy))),
    seen = new Set(baseline),
    groups = new Map<string, string[]>(),
    questions = new Map<string, { keys: Set<string>; ids: string[] }>();
  const keptIds: string[] = [],
    excludedIds: string[] = [];
  for (const row of rows) {
    const key = candidateKey(row, policy);
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
