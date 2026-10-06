import type { Database } from "../db/pool.js";
import { sha256 } from "../package/contract.js";
import { opaqueId } from "../server/support.js";
import { BACKGROUND_LIMITS, extractBackground } from "./extract-background.js";
import {
  AssistantError,
  assistantAccess,
  readSession,
  sessionRow,
  type AssistantScope,
} from "./store.js";
import type { BackgroundFragment } from "./extract-background.js";
import type { CandidateGoal } from "../processing/review.js";

export type BackgroundSnapshot = {
  requirements: string[];
  userRequests?: string[];
  classifications?: CandidateGoal["classifications"];
  documents: {
    id: string;
    fileName: string;
    sha256: string;
    extractorVersion: string;
    fragments: BackgroundFragment[];
  }[];
};

const catalogColumns = `id,file_name AS "fileName",format,sha256,file_size AS "fileSize",
  extractor_version AS "extractorVersion",units,characters,jsonb_array_length(fragments) AS "fragmentCount"`;

export async function backgroundCatalog(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  sessionId: string,
) {
  await sessionRow(db, scope, sessionId);
  return (
    await db.query(
      `SELECT ${catalogColumns} FROM assistant_background_document WHERE session_id=$1 ORDER BY created_at,id`,
      [sessionId],
    )
  ).rows;
}

async function assertIdle(
  db: Pick<Database, "query">,
  session: Record<string, any>,
) {
  if (
    (
      await db.query(
        `SELECT 1 FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')
    UNION ALL SELECT 1 FROM assistant_proposal WHERE session_id=$1 AND status='executing' AND lease_until>now()
    UNION ALL SELECT 1 FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.id=ANY($2::text[]) AND j.status IN('queued','running','retry_wait') LIMIT 1`,
        [
          session.id,
          session.task?.runIds ??
            (session.task?.runId ? [session.task.runId] : []),
        ],
      )
    ).rowCount
  )
    throw new AssistantError(409, "assistant_busy");
}

export async function uploadBackground(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  fileName: string,
  bytes: Uint8Array,
) {
  await readSession(db, scope, sessionId);
  const before = await sessionRow(db, scope, sessionId);
  const extracted = await extractBackground(fileName, bytes),
    hash = sha256(bytes);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const session = await sessionRow(client, scope, sessionId, true);
    if (session.content_revision !== before.content_revision)
      throw new AssistantError(409, "assistant_context_deleted");
    const prior = (
      await client.query(
        `SELECT ${catalogColumns} FROM assistant_background_document WHERE session_id=$1 AND sha256=$2 AND format=$3`,
        [sessionId, hash, extracted.format],
      )
    ).rows[0];
    if (prior) {
      await client.query("COMMIT");
      return { document: prior, replayed: true };
    }
    await assertIdle(client, session);
    const capacity = (
      await client.query(
        `SELECT count(*)::int AS files,coalesce(sum(file_size),0)::int AS bytes,coalesce(sum(characters),0)::int AS characters FROM assistant_background_document WHERE session_id=$1`,
        [sessionId],
      )
    ).rows[0];
    if (
      capacity.files >= BACKGROUND_LIMITS.files ||
      capacity.bytes + bytes.byteLength > BACKGROUND_LIMITS.bytes ||
      capacity.characters + extracted.characters > BACKGROUND_LIMITS.characters
    )
      throw new AssistantError(413, "assistant_document_capacity");
    const document = (
      await client.query(
        `INSERT INTO assistant_background_document(id,session_id,project_id,actor_id,file_name,format,sha256,file_size,extractor_version,units,characters,fragments)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${catalogColumns}`,
        [
          opaqueId("background"),
          sessionId,
          scope.projectId,
          scope.actorId,
          fileName,
          extracted.format,
          hash,
          bytes.byteLength,
          extracted.extractorVersion,
          extracted.units,
          extracted.characters,
          JSON.stringify(extracted.fragments),
        ],
      )
    ).rows[0];
    await client.query(
      `UPDATE assistant_session SET content_revision=content_revision+1,task_revision=task_revision+1,updated_at=now(),task=task||'{"backgroundEvidence":[],"review":null,"nextAction":null,"stage":"waiting_input"}'::jsonb WHERE id=$1`,
      [sessionId],
    );
    await client.query(
      "UPDATE assistant_proposal SET status='invalid' WHERE session_id=$1 AND status='pending'",
      [sessionId],
    );
    await client.query("COMMIT");
    return { document, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readBackground(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  documentId: string,
  from = 1,
  limit = 3,
  query?: string,
) {
  if (
    !Number.isInteger(from) ||
    from < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 3
  )
    throw new AssistantError(422, "assistant_document_range");
  if (
    query !== undefined &&
    (typeof query !== "string" || !query.trim() || query.length > 200)
  )
    throw new AssistantError(422, "assistant_document_range");
  await readSession(db, scope, sessionId);
  const before = await sessionRow(db, scope, sessionId);
  const row = (
    await db.query(
      `SELECT ${catalogColumns},fragments FROM assistant_background_document WHERE session_id=$1 AND id=$2`,
      [sessionId, documentId],
    )
  ).rows[0];
  if (!row) throw new AssistantError(404, "assistant_document_not_found");
  const normalize = (text: string) =>
    text.replace(/\s+/gu, "").toLocaleLowerCase();
  const fragments =
    query === undefined
      ? row.fragments
      : row.fragments.filter((fragment: BackgroundFragment) =>
          normalize(fragment.text).includes(normalize(query)),
        );
  if (fragments.length && from > fragments.length)
    throw new AssistantError(422, "assistant_document_range");
  await assistantAccess(db, scope);
  const after = await sessionRow(db, scope, sessionId);
  if (after.content_revision !== before.content_revision)
    throw new AssistantError(409, "assistant_context_deleted");
  return {
    ...row,
    ...(query === undefined ? {} : { matchCount: fragments.length }),
    fragments: fragments.slice(from - 1, from - 1 + limit),
  };
}

/** Called with the assistant session already fenced in the processing transaction. */
export async function freezeBackground(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  sessionId: string,
): Promise<BackgroundSnapshot | undefined> {
  const session = await sessionRow(db, scope, sessionId);
  const documents = (
    await db.query(
      `SELECT ${catalogColumns},fragments FROM assistant_background_document WHERE session_id=$1 FOR SHARE`,
      [sessionId],
    )
  ).rows;
  if (!documents.length && !session.task.classifications?.length) return;
  const evidence: { documentId: string; fragmentIndex: number }[] =
    session.task.backgroundEvidence ?? [];
  if (documents.length && !evidence.length)
    throw new AssistantError(422, "assistant_background_not_read");
  const selected: BackgroundSnapshot["documents"] = [];
  for (const document of documents) {
    const indices = new Set(
      evidence
        .filter((ref) => ref.documentId === document.id)
        .map((ref) => ref.fragmentIndex),
    );
    if (!indices.size) continue;
    const fragments = document.fragments.filter(
      (fragment: BackgroundFragment) => indices.has(fragment.index),
    );
    if (fragments.length !== indices.size)
      throw new AssistantError(409, "assistant_background_changed");
    selected.push({
      id: document.id,
      fileName: document.fileName,
      sha256: document.sha256,
      extractorVersion: document.extractorVersion,
      fragments,
    });
  }
  if (
    (documents.length > 0 && !selected.length) ||
    evidence.some(
      (ref) => !documents.some((document) => document.id === ref.documentId),
    )
  )
    throw new AssistantError(409, "assistant_background_changed");
  if (
    evidence.length > 12 ||
    Buffer.byteLength(JSON.stringify(selected)) > 30000
  )
    throw new AssistantError(422, "assistant_background_capacity");
  return {
    requirements: session.task.requirements ?? [],
    ...(session.task.classifications?.length
      ? { classifications: session.task.classifications }
      : {}),
    userRequests: [
      session.task.goal,
      ...(session.task.supplements ?? []),
    ].filter(
      (text): text is string => typeof text === "string" && text.length > 0,
    ),
    documents: selected,
  };
}

export async function removeBackground(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  documentId: string,
) {
  await readSession(db, scope, sessionId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const session = await sessionRow(client, scope, sessionId, true);
    await assertIdle(client, session);
    const deleted = await client.query(
      "DELETE FROM assistant_background_document WHERE id=$1 AND session_id=$2 RETURNING id",
      [documentId, sessionId],
    );
    if (!deleted.rowCount)
      throw new AssistantError(404, "assistant_document_not_found");
    await client.query("COMMIT");
    return { removed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
