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
) {
  const receipts = (
    await db.query(
      "SELECT run_id,result_ids,receipt FROM processing_acceptance WHERE project_id=$1 AND ($4 OR actor_id=$2) AND ($3::text IS NULL OR draft_id=$3) AND NOT (run_id=ANY($5::text[]))",
      [scope.projectId, scope.actorId, draftId ?? null, shared, excludeRunIds],
    )
  ).rows;
  const identities = new Set<string>();
  const cached = new Map<
    string,
    Awaited<ReturnType<typeof readProcessingRun>>
  >();
  for (const receipt of receipts) {
    for (const id of receipt.result_ids as string[])
      identities.add(candidateKey({ runId: receipt.run_id, resultId: id }));
    if (Array.isArray(receipt.receipt.candidateOrigins)) {
      for (const origin of receipt.receipt
        .candidateOrigins as CandidateOrigin[])
        identities.add(candidateKey(origin));
    } else if (!runs.some((run) => run.run.id === receipt.run_id)) {
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
