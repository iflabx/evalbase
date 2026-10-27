import type { Database } from "../db/pool.js";
import type { ProcessingScope } from "../processing/store.js";
import type { BackgroundSnapshot } from "../processing/background.js";
import { guardRuntimeCommit } from "../operations/runtime-guard.js";
/** Explicit evidence, never derived from a legacy plan or assistant task JSON. */
export async function freezeRuntimeBackground(
  db: Pick<Database, "query">,
  scope: ProcessingScope,
  instructions: string,
): Promise<BackgroundSnapshot> {
  await guardRuntimeCommit(db, scope);
  const documents = (
    await db.query(
      "SELECT d.* FROM rebuild_document d JOIN rebuild_session s ON s.id=d.session_id WHERE s.id=$1 AND s.project_id=$2 AND s.actor_id=$3 ORDER BY d.id FOR SHARE OF d",
      [scope.runtimeGuard!.sessionId, scope.projectId, scope.actorId],
    )
  ).rows;
  return {
    contentReviewPolicy: "manual-v1",
    currentRequirements: true,
    requirements: [instructions],
    documents: documents.map((d) => ({
      id: d.id,
      fileName: d.name,
      sha256: d.sha256,
      extractorVersion: d.extraction.extractorVersion,
      fragments: d.extraction.fragments,
    })),
  };
}
