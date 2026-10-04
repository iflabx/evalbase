import type { Database } from "../db/pool.js";
import { writeBatches } from "../db/batch.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { isPlainObject, opaqueId } from "../server/support.js";
import {
  getProcessingRun,
  processingAccess,
  processingSourceAvailable,
  ProcessingError,
  type ProcessingScope,
  type InputSnapshot,
} from "./store.js";
import type { ProcessingOutput, ProcessingResult } from "./protocol.js";

export async function acceptProcessingResults(
  db: Database,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runId: string,
  key: unknown,
  input: unknown,
) {
  await processingAccess(db, scope);
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 200 ||
    !isPlainObject(input) ||
    Object.keys(input).some((k) => !["resultIds", "target"].includes(k)) ||
    !Array.isArray(input.resultIds) ||
    !input.resultIds.length ||
    input.resultIds.length > 10000 ||
    input.resultIds.some(
      (id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id),
    ) ||
    new Set(input.resultIds).size !== input.resultIds.length ||
    !isPlainObject(input.target)
  )
    throw new ProcessingError(422, "processing_accept_invalid");
  const target = input.target;
  if (target.kind === "asset") {
    if (Object.keys(target).some((k) => !["kind"].includes(k)))
      throw new ProcessingError(422, "processing_accept_invalid");
  } else if (target.kind === "draft") {
    if (
      typeof target.id !== "string" ||
      !Number.isSafeInteger(target.expectedRevision) ||
      Object.keys(target).some(
        (k) => !["kind", "id", "expectedRevision"].includes(k),
      )
    )
      throw new ProcessingError(422, "processing_accept_invalid");
  } else if (target.kind === "newDraft") {
    if (
      typeof target.name !== "string" ||
      !target.name.trim() ||
      target.name.length > 200 ||
      typeof target.purpose !== "string" ||
      target.purpose.length > 2000 ||
      Object.keys(target).some((k) => !["kind", "name", "purpose"].includes(k))
    )
      throw new ProcessingError(422, "processing_accept_invalid");
  } else throw new ProcessingError(422, "processing_accept_invalid");
  const ids = (input.resultIds as string[])
    .slice()
    .sort(
      (a, b) =>
        Number(a.split(":")[0]) - Number(b.split(":")[0]) ||
        Number(a.split(":")[1]) - Number(b.split(":")[1]),
    );
  const digest = sha256(canonicalJson({ ids, target }));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One receipt and all domain writes commit together. A second browser can safely retry the same confirmation.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing-accept:${scope.projectId}:${scope.actorId}:${key}`,
    ]);
    const prior = (
      await client.query(
        "SELECT * FROM processing_acceptance WHERE project_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [scope.projectId, scope.actorId, key],
      )
    ).rows[0];
    if (prior) {
      await processingAccess(client, scope, true);
      if (prior.run_id !== runId || prior.request_hash !== digest)
        throw new ProcessingError(409, "idempotency_conflict");
      await client.query("COMMIT");
      return { receipt: prior.receipt, replayed: true };
    }
    const run = await getProcessingRun(client, scope, runId);
    if (!["succeeded", "failed", "cancelled"].includes(run.status))
      throw new ProcessingError(409, "processing_still_running");
    let draftId: string | null =
      target.kind === "draft" ? String(target.id) : null;
    let revision = 0;
    if (draftId) {
      const draft = (
        await client.query(
          "SELECT revision FROM collaborative_draft WHERE id=$1 AND project_id=$2 AND status='editing' FOR UPDATE",
          [draftId, scope.projectId],
        )
      ).rows[0];
      if (!draft) throw new ProcessingError(404, "draft_not_found");
      await processingSourceAvailable(
        client,
        scope.projectId,
        { kind: "draft", id: draftId, recordIds: [] },
        true,
      );
      revision = Number(draft.revision);
      if (
        !(
          run.source.kind === "draft" &&
          run.source.id === draftId &&
          run.options.operation !== "augment"
        ) &&
        revision !== target.expectedRevision
      )
        throw new ProcessingError(409, "draft_revision_conflict");
    }
    // Lock the job/run after the draft, matching the source-edit ordering.
    const locked = await getProcessingRun(client, scope, runId, true);
    if (!["succeeded", "failed", "cancelled"].includes(locked.status))
      throw new ProcessingError(409, "processing_still_running");
    await processingAccess(client, scope, true);
    const snapshot = JSON.parse(
      (await artifacts.readBytes(run.input_ref!, 100000000)).toString("utf8"),
    ) as InputSnapshot;
    const original = new Map(snapshot.records.map((row) => [row.id, row]));
    const batchIds = [...new Set(ids.map((id) => Number(id.split(":")[0])))];
    const batches = await client.query(
      "SELECT ordinal,result_ref FROM processing_batch WHERE run_id=$1 AND ordinal=ANY($2::integer[]) AND result_ref IS NOT NULL",
      [runId, batchIds],
    );
    const available = new Map<string, ProcessingOutput>();
    for (const batch of batches.rows) {
      const result = JSON.parse(
        (await artifacts.readBytes(batch.result_ref, 100000000)).toString(
          "utf8",
        ),
      ) as ProcessingResult;
      result.records.forEach((row, index) =>
        available.set(`${batch.ordinal}:${index}`, row),
      );
    }
    const selected = ids.map((id) => {
      const row = available.get(id);
      if (!row || !original.has(row.sourceId))
        throw new ProcessingError(422, "processing_result_invalid");
      return { id, ...row };
    });
    const replacing =
      draftId !== null &&
      run.source.kind === "draft" &&
      run.source.id === draftId &&
      run.options.operation !== "augment";
    const updates: { id: string; field: string; value: unknown }[] = [];
    if (replacing) {
      const current = await client.query(
        "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false ORDER BY id FOR UPDATE",
        [draftId, selected.map((row) => row.sourceId)],
      );
      const byId = new Map(current.rows.map((row) => [row.id, row]));
      for (const row of selected) {
        const before = original.get(row.sourceId)!,
          now = byId.get(row.sourceId);
        if (!now) throw new ProcessingError(409, "draft_record_removed");
        for (const field of run.options.allowedFields) {
          if (canonicalJson(before[field]) === canonicalJson(row[field]))
            continue;
          const column = field === "expectedOutput" ? "expected_output" : field;
          if (Number(now[`${column}_revision`]) !== before.revisions?.[field])
            throw new ProcessingError(409, "draft_field_conflict");
          updates.push({ id: row.sourceId, field, value: row[field] });
        }
      }
    }
    if (target.kind === "newDraft") {
      draftId = opaqueId("collabdraft");
      await client.query(
        `INSERT INTO collaborative_draft(id,project_id,name,purpose,updated_by,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$5,now())`,
        [
          draftId,
          scope.projectId,
          String(target.name).trim(),
          target.purpose,
          scope.actorId,
        ],
      );
    }
    const acceptanceId = opaqueId("adoption"),
      assetId = opaqueId("asset"),
      viewId = opaqueId("view");
    const values = selected.map(({ question, expectedOutput, metadata }) => ({
      question,
      expectedOutput,
      metadata,
    }));
    const bytes = Buffer.from(
      values.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    if (bytes.byteLength > 50000000)
      throw new ProcessingError(422, "processing_capacity_exceeded");
    let highWater = 0;
    if (draftId) {
      const capacity = (
        await client.query(
          `SELECT count(*) FILTER(WHERE NOT deleted)::int AS count,coalesce(max(position),0)::bigint AS position,
        array_agg(DISTINCT source->>'assetId') FILTER(WHERE NOT deleted AND source IS NOT NULL AND NOT(id=ANY($2::text[]))) AS assets FROM collaborative_draft_record WHERE draft_id=$1`,
          [draftId, replacing ? selected.map((row) => row.sourceId) : []],
        )
      ).rows[0];
      const assets = capacity.assets ?? [];
      const size = (
        await client.query(
          "SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM data_asset WHERE id=ANY($1::text[])",
          [assets],
        )
      ).rows[0];
      if (
        assets.length + 1 > 5 ||
        Number(size.bytes) + bytes.byteLength > 100000000 ||
        Number(capacity.count) + (replacing ? 0 : selected.length) > 10000
      )
        throw new ProcessingError(422, "test_set_capacity_exceeded");
      highWater = Number(capacity.position);
    }
    const stored = await artifacts.storeImmutable(bytes, acceptanceId);
    const collection = (
      await client.query(
        "SELECT id FROM raw_material_collection WHERE project_id=$1 AND is_unfiled",
        [scope.projectId],
      )
    ).rows[0];
    const label = { clean: "清洗", rewrite: "改写", augment: "鎵╁厖" }[
      run.options.operation
    ];
    const name = `${label}结果-${runId.slice(-8)}.jsonl`;
    await client.query(
      `INSERT INTO data_asset(id,project_id,collection_id,blob_sha256,object_ref,size_bytes,mime_type,file_name,format,status,uploaded_by,processing_run_id)
      VALUES($1,$2,$3,$4,$5,$6,'application/x-ndjson',$7,'jsonl','stored',$8,$9)`,
      [
        assetId,
        scope.projectId,
        collection.id,
        stored.sha256,
        stored.objectRef,
        stored.size,
        name,
        scope.actorId,
        runId,
      ],
    );
    // Origin is derived data, not a declaration that third-party material is synthetic or non-sensitive.
    await client.query(
      `INSERT INTO source_attribution_revision(id,asset_id,source_type,source_name,purpose,responsible_actor,responsible_person,license_status,sensitivity)
      VALUES($1,$2,'model_processed',$3,$4,$5,$5,'derived_from_source','inherited')`,
      [opaqueId("attr"), assetId, name, `${label}处理结果`, scope.actorId],
    );
    const mapping = {
      question: "/question",
      expectedOutput: "/expectedOutput",
      metadata: [],
      metadataEntries: "/metadata",
    };
    await client.query(
      `INSERT INTO parsed_view(id,asset_id,format,parser_name,parser_version,parser_config,parser_config_hash,status,
      record_count,success_count,failure_count,boundary_trusted,draft_eligible,is_current,field_summary,error_summary,display_mapping,mapping_ready,mapping_revision)
      VALUES($1,$2,'jsonl','processing','processing-v1','{}',$3,'ready',$4,$4,0,true,true,true,$5,'[]',$6,true,1)`,
      [
        viewId,
        assetId,
        sha256("{}"),
        selected.length,
        JSON.stringify(
          ["/question", "/expectedOutput", "/metadata"].map((path) => ({
            path,
            examples: [],
          })),
        ),
        mapping,
      ],
    );
    await writeBatches(
      client,
      `INSERT INTO source_record(parsed_view_id,ordinal,value,locator,record_hash)
      SELECT $1,x.ordinal,x.value,x.locator,x.hash FROM jsonb_to_recordset($2::jsonb) AS x(ordinal integer,value jsonb,locator jsonb,hash text)`,
      [viewId],
      values.map((value, index) => ({
        ordinal: index + 1,
        value,
        locator: {
          kind: "jsonl",
          line: index + 1,
          processingRunId: runId,
          resultId: selected[index].id,
          inputId: selected[index].sourceId,
        },
        hash: sha256(canonicalJson(value)),
      })),
    );
    if (draftId) {
      if (replacing) {
        for (const update of updates) {
          const column =
            update.field === "expectedOutput"
              ? "expected_output"
              : update.field;
          await client.query(
            `UPDATE collaborative_draft_record SET ${column}=$3,${column}_revision=${column}_revision+1,row_revision=row_revision+1,
            field_attribution=jsonb_set(field_attribution,$4::text[],jsonb_build_object('userId',$5::text,'at',now(),'processingRunId',$6::text),true),
            updated_by=$5,updated_at=now() WHERE draft_id=$1 AND id=$2`,
            [
              draftId,
              update.id,
              update.field === "metadata"
                ? JSON.stringify(update.value)
                : update.value,
              [update.field],
              scope.actorId,
              runId,
            ],
          );
        }
        for (const [index, row] of selected.entries())
          await client.query(
            "UPDATE collaborative_draft_record SET source=$3 WHERE draft_id=$1 AND id=$2",
            [draftId, row.sourceId, { assetId, ordinal: index + 1 }],
          );
      } else
        await writeBatches(
          client,
          `INSERT INTO collaborative_draft_record(draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
        SELECT $1,x.id,x.position,x.question,x.expected_output,x.metadata,x.source,$2,
          jsonb_build_object('question',jsonb_build_object('userId',$2::text,'at',now(),'processingRunId',$3::text),
          'expectedOutput',jsonb_build_object('userId',$2::text,'at',now(),'processingRunId',$3::text),'metadata',jsonb_build_object('userId',$2::text,'at',now(),'processingRunId',$3::text))
        FROM jsonb_to_recordset($4::jsonb) AS x(id text,position bigint,question text,expected_output text,metadata jsonb,source jsonb)`,
          [draftId, scope.actorId, runId],
          selected.map((row, index) => ({
            id: opaqueId("draftrow"),
            position: ++highWater,
            question: row.question,
            expected_output: row.expectedOutput,
            metadata: row.metadata,
            source: { assetId, ordinal: index + 1 },
          })),
        );
      await client.query(
        "UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1",
        [draftId, scope.actorId],
      );
    }
    const receipt = {
      acceptanceId,
      runId,
      assetId,
      fileName: name,
      draftId,
      adopted: selected.length,
      changedFields: updates.length,
      ...(draftId ? { revision: revision + 1 } : {}),
    };
    await client.query(
      `INSERT INTO processing_acceptance(id,run_id,project_id,actor_id,idempotency_key,request_hash,result_ids,asset_id,draft_id,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        acceptanceId,
        runId,
        scope.projectId,
        scope.actorId,
        key,
        digest,
        JSON.stringify(ids),
        assetId,
        draftId,
        receipt,
      ],
    );
    await client.query("COMMIT");
    return { receipt, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
