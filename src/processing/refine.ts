import {
  guardAssistantCommit,
  linkAssistantProcessing,
} from "../assistant/fence.js";
import type { Database } from "../db/pool.js";
import { cleanupProcessingObjects } from "./cleanup.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { opaqueId, isPlainObject } from "../server/support.js";
import { processingOptions, PROCESSING_EXECUTION } from "./protocol.js";
import {
  getProcessingRun,
  processingAccess,
  readProcessingRun,
  ProcessingError,
  type InputSnapshot,
  type ProcessingScope,
} from "./store.js";

/** Refine candidates, retaining their original adoption baseline and unselected values. */
export async function createRefinementRun(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  parentId: string,
  key: unknown,
  body: unknown,
) {
  await processingAccess(db, scope);
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 200 ||
    !isPlainObject(body) ||
    Object.keys(body).some(
      (k) => !["resultIds", "instructions", "allowedFields"].includes(k),
    ) ||
    !Array.isArray(body.resultIds) ||
    !body.resultIds.length ||
    body.resultIds.length > 10000 ||
    body.resultIds.some(
      (id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id),
    ) ||
    new Set(body.resultIds).size !== body.resultIds.length
  )
    throw new ProcessingError(422, "processing_refinement_invalid");
  let options;
  try {
    options = processingOptions({
      operation: "rewrite",
      instructions: body.instructions,
      allowedFields: body.allowedFields ?? ["question"],
    });
  } catch {
    throw new ProcessingError(422, "processing_configuration_invalid");
  }
  const digest = sha256(
    canonicalJson({ parentId, resultIds: [...body.resultIds].sort(), options }),
  );
  const client = await db.connect();
  let storedInput: string | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing:${scope.projectId}:${scope.actorId}:${key}`,
    ]);
    await processingAccess(client, scope, true);
    const prior = (
      await client.query(
        "SELECT id,request_hash FROM processing_run WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [scope.projectId, scope.actorId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== digest)
        throw new ProcessingError(409, "idempotency_conflict");
      const result = await readProcessingRun(db, artifacts, scope, prior.id, {
        limit: "1",
      });
      await client.query("COMMIT");
      return { run: result.run, replayed: true };
    }
    const parent = await getProcessingRun(client, scope, parentId, true);
    if (!["succeeded", "failed", "cancelled"].includes(parent.status))
      throw new ProcessingError(409, "processing_still_running");
    const data = await readProcessingRun(
      db,
      artifacts,
      scope,
      parentId,
      { limit: "10000" },
      true,
    );
    if (body.resultIds.some((id) => !data.allIds.includes(id)))
      throw new ProcessingError(422, "processing_result_invalid");
    const input = JSON.parse(
      (await artifacts.readBytes(parent.input_ref!, 100000000)).toString(
        "utf8",
      ),
    ) as InputSnapshot;
    const snapshots = new Map(input.records.map((row) => [row.id, row]));
    const selected = new Set(body.resultIds);
    const refinement = {
      parentRunId: parentId,
      selectedIds: body.resultIds.map((id) => `candidate:${id}`),
      rootOperation:
        input.refinement?.rootOperation ?? parent.options.operation,
      adoptionFields: [
        ...new Set([
          ...(input.refinement?.adoptionFields ?? parent.options.allowedFields),
          ...options.allowedFields,
        ]),
      ],
    };
    const records = data.records.map((row) => {
      const original = snapshots.get(row.result.sourceId);
      if (!original) throw new ProcessingError(409, "processing_input_corrupt");
      return {
        id: `candidate:${row.id}`,
        question: row.result.question,
        expectedOutput: row.result.expectedOutput,
        metadata: row.result.metadata,
        baseline: original.baseline ?? original,
        source: original.source,
        revisions: original.revisions,
      };
    });
    if (
      records.length > 10000 ||
      Buffer.byteLength(canonicalJson({ records, refinement })) > 100000000
    )
      throw new ProcessingError(422, "processing_capacity_exceeded");
    const model = (
      await client.query(
        "SELECT revision,enabled FROM model_connection ORDER BY revision DESC LIMIT 1",
      )
    ).rows[0];
    if (!model?.enabled)
      throw new ProcessingError(409, "model_connection_unavailable");
    await guardAssistantCommit(client, scope);
    const runId = opaqueId("processing"),
      jobId = opaqueId("job");
    const stored = await artifacts.storeProcessing(
      Buffer.from(
        canonicalJson({
          source: input.source,
          revision: input.revision,
          records,
          refinement,
        }),
      ),
      runId,
      "input",
    );
    storedInput = stored.objectRef;
    await client.query(
      "INSERT INTO job(id,project_id,actor_id,kind,payload,status,idempotency_key,correlation_id) VALUES($1,$2,$3,'process_data',$4,'queued',$5,$1)",
      [jobId, scope.projectId, scope.actorId, { runId }, `processing:${runId}`],
    );
    await client.query(
      `INSERT INTO processing_run(id,project_id,actor_id,job_id,idempotency_key,request_hash,source,options,input_ref,input_hash,input_count,model_revision,target_draft_id,execution_config,parent_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        runId,
        scope.projectId,
        scope.actorId,
        jobId,
        key,
        digest,
        parent.source,
        options,
        stored.objectRef,
        stored.sha256,
        records.length,
        model.revision,
        parent.target_draft_id,
        PROCESSING_EXECUTION,
        parentId,
      ],
    );
    await linkAssistantProcessing(client, scope, runId);
    await client.query("COMMIT");
    const result = await readProcessingRun(db, artifacts, scope, runId, {
      limit: "1",
    });
    return {
      run: { ...result.run, refinedCount: selected.size },
      replayed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (storedInput) {
      await db.query(
        "INSERT INTO processing_cleanup(project_id,object_ref) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [scope.projectId, storedInput],
      );
      await cleanupProcessingObjects(db, artifacts, scope.projectId);
    }
    throw error;
  } finally {
    client.release();
  }
}
