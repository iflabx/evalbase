import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  readProcessingRun,
  ProcessingError,
  type ProcessingScope,
  type CandidateOrigin,
} from "./store.js";

type CandidateRun = {
  run: { id: string };
  records: { id: string; candidateOrigin: CandidateOrigin }[];
};
export const candidateKey = (origin: CandidateOrigin) =>
  `${origin.runId}:${origin.resultId}`;

/** One adoption identity survives local refinements; receipts remain bound to actual result IDs. */
export async function adoptedCandidateKeys(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runs: CandidateRun[],
  draftId?: string,
  shared = false,
  excludeRunIds: string[] = [],
  cached = new Map<string, Awaited<ReturnType<typeof readProcessingRun>>>(),
  relevantOnly = false,
) {
  const receipts = (
    await db.query(
      "SELECT run_id,result_ids,receipt FROM processing_acceptance WHERE project_id=$1 AND ($4 OR actor_id=$2) AND ($3::text IS NULL OR draft_id=$3) AND NOT (run_id=ANY($5::text[]))",
      [scope.projectId, scope.actorId, draftId ?? null, shared, excludeRunIds],
    )
  ).rows;
  const identities = new Set<string>();
  for (const receipt of receipts) {
    for (const id of receipt.result_ids as string[])
      identities.add(candidateKey({ runId: receipt.run_id, resultId: id }));
    if (Array.isArray(receipt.receipt.candidateOrigins)) {
      for (const origin of receipt.receipt
        .candidateOrigins as CandidateOrigin[])
        identities.add(candidateKey(origin));
    }
  }
  const legacy = receipts.filter(
    (receipt) =>
      !Array.isArray(receipt.receipt.candidateOrigins) &&
      (relevantOnly || !runs.some((run) => run.run.id === receipt.run_id)),
  );
  let relevant: Set<string> | undefined;
  if (relevantOnly && legacy.length) {
    const unresolved = runs.flatMap((run) =>
      run.records
        .filter(
          (row) =>
            !identities.has(candidateKey(row.candidateOrigin)) &&
            !identities.has(
              candidateKey({ runId: run.run.id, resultId: row.id }),
            ),
        )
        .map((row) => row.candidateOrigin.runId),
    );
    relevant = new Set(
      unresolved.length
        ? (
            await db.query(
              `WITH RECURSIVE lineage AS (
        SELECT id,parent_run_id,id AS receipt_run_id FROM processing_run WHERE project_id=$1 AND id=ANY($2::text[])
        UNION
        SELECT r.id,r.parent_run_id,l.receipt_run_id FROM processing_run r JOIN lineage l ON r.id=l.parent_run_id WHERE r.project_id=$1
      ) SELECT DISTINCT receipt_run_id FROM lineage WHERE id=ANY($3::text[])`,
              [
                scope.projectId,
                legacy.map((receipt) => receipt.run_id),
                [...new Set(unresolved)],
              ],
            )
          ).rows.map((row) => row.receipt_run_id as string)
        : [],
    );
  }
  for (const receipt of legacy) {
    if (relevant && !relevant.has(receipt.run_id)) continue;
    // Old receipts lack stable origins. Resolve them using the frozen parent chain, never guess from contents.
    try {
      let data = cached.get(receipt.run_id);
      if (!data) {
        data = await readProcessingRun(
          db,
          artifacts,
          scope,
          receipt.run_id,
          { limit: "10000" },
          true,
        );
        cached.set(receipt.run_id, data);
      }
      for (const row of data.records)
        if (receipt.result_ids.includes(row.id))
          identities.add(candidateKey(row.candidateOrigin));
    } catch (error) {
      if (
        !(error instanceof ProcessingError) ||
        ![404, 409].includes(error.status)
      )
        throw error;
      // A removed source cannot have a readable descendant; unrelated historical receipts need no body.
    }
  }
  return new Set(
    runs.flatMap((run) =>
      run.records
        .filter(
          (row) =>
            identities.has(candidateKey(row.candidateOrigin)) ||
            identities.has(
              candidateKey({ runId: run.run.id, resultId: row.id }),
            ),
        )
        .map((row) => candidateKey({ runId: run.run.id, resultId: row.id })),
    ),
  );
}
