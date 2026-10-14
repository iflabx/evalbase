import { contentKey, deduplicate } from "./deduplication.js";
import { guardAssistantCommit } from "../assistant/fence.js";
import { adoptedCandidateKeys } from "./adoption.js";
import { guardProcessingTask } from "./task-state.js";
import { processingResultName } from "./names.js";
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
  processingCandidateOrigins,
  type ProcessingScope,
  type InputSnapshot,
} from "./store.js";
import type { ProcessingOutput, ProcessingResult } from "./protocol.js";

const sortedIds = (ids: string[]) =>
  ids
    .slice()
    .sort(
      (a, b) =>
        Number(a.split(":")[0]) - Number(b.split(":")[0]) ||
        Number(a.split(":")[1]) - Number(b.split(":")[1]),
    );
export function processingAcceptanceHash(
  ids: string[],
  target: unknown,
  groups?: { runId: string; resultIds: string[] }[],
) {
  return sha256(
    canonicalJson(
      groups && groups.length > 1
        ? {
            groups: groups.map((group) => ({
              runId: group.runId,
              resultIds: sortedIds(group.resultIds),
            })),
            target,
          }
        : { ids: sortedIds(ids), target },
    ),
  );
}

export async function selectedProcessingGroup(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runId: string,
  ids: string[],
) {
  const run = await getProcessingRun(db, scope, runId);
  if (!["succeeded", "failed", "cancelled"].includes(run.status))
    throw new ProcessingError(409, "processing_still_running");
  const snapshot = JSON.parse(
    (await artifacts.readBytes(run.input_ref!, 100000000)).toString("utf8"),
  ) as InputSnapshot;
  const original = new Map(snapshot.records.map((row) => [row.id, row]));
  const origins = await processingCandidateOrigins(
    db,
    artifacts,
    scope,
    snapshot,
  );
  const batches = await db.query(
    "SELECT ordinal,result_ref,result_indices FROM processing_batch WHERE run_id=$1 AND ordinal=ANY($2::integer[]) AND result_ref IS NOT NULL",
    [runId, [...new Set(ids.map((id) => Number(id.split(":")[0])))]],
  );
  const available = new Map<string, ProcessingOutput>();
  for (const batch of batches.rows) {
    const result = JSON.parse(
      (await artifacts.readBytes(batch.result_ref, 100000000)).toString("utf8"),
    ) as ProcessingResult;
    result.records.forEach((row, index) =>
      available.set(
        `${batch.ordinal}:${batch.result_indices?.[index] ?? index}`,
        row,
      ),
    );
  }
  return {
    run,
    continuation: Boolean(snapshot.continuation),
    selected: ids.map((id) => {
      const row = available.get(id),
        input = row && original.get(row.sourceId);
      if (!row || !input)
        throw new ProcessingError(422, "processing_result_invalid");
      return {
        id,
        ...row,
        runId,
        candidateOrigin: origins.get(row.sourceId) ?? { runId, resultId: id },
        input,
        source: run.source,
        originalId: input.baseline?.id ?? row.sourceId,
        adoptionFields:
          input.adoptionFields ??
          snapshot.continuation?.adoptionFields ??
          snapshot.refinement?.adoptionFields ??
          run.options.allowedFields,
        rootOperation:
          input.adoptionOperation ??
          snapshot.continuation?.rootOperation ??
          snapshot.refinement?.rootOperation ??
          run.options.operation,
      };
    }),
  };
}

function checkedIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 10000 ||
    value.some((id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new ProcessingError(422, "processing_deduplication_invalid");
  return sortedIds(value as string[]);
}
/** Full selected scope; immutable results and server identities are the only authority. */
export async function previewDeduplication(
  db: Pick<Database, "query">,
  artifacts: ArtifactRepository,
  scope: ProcessingScope,
  runId: string,
  value: unknown,
) {
  await processingAccess(db, scope);
  const ids = checkedIds(value),
    group = await selectedProcessingGroup(db, artifacts, scope, runId, ids),
    rows = group.selected;
  const knownDraft =
    group.run.target_draft_id ??
    (group.run.source.kind === "draft" ? group.run.source.id : null);
  const existing =
    rows[0]?.rootOperation === "augment" && knownDraft
      ? (
          await db.query(
            "SELECT question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
            [knownDraft],
          )
        ).rows.map((row) => ({
          question: row.question,
          expectedOutput: row.expected_output,
          metadata: row.metadata,
        }))
      : [];
  const plan = deduplicate(rows, existing);
  const keptIds = new Set(plan.keptIds),
    excludedIds = new Set(plan.excludedIds);
  const keptOriginals = new Set(
    rows.filter((row) => keptIds.has(row.id)).map((row) => row.originalId),
  );
  const removable = rows.filter(
    (row) =>
      excludedIds.has(row.id) &&
      row.source.kind === "draft" &&
      row.rootOperation !== "augment" &&
      !keptOriginals.has(row.originalId),
  );
  return {
    ...plan,
    checkedIds: ids,
    inspected: ids.length,
    removedRecordIds: [...new Set(removable.map((row) => row.originalId))],
  };
}
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
    Object.keys(input).some(
      (k) => !["resultIds", "target", "deduplication"].includes(k),
    ) ||
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
  const groups = scope.acceptanceGroups?.map((group) => ({
    ...group,
    resultIds: sortedIds(group.resultIds),
  })) ?? [{ runId, resultIds: ids }];
  if (
    !groups.length ||
    groups.length > (scope.taskSave ? 10000 : 12) ||
    new Set(groups.map((group) => group.runId)).size !== groups.length ||
    groups.some(
      (group) =>
        !group.resultIds.length ||
        new Set(group.resultIds).size !== group.resultIds.length ||
        group.resultIds.some(
          (id) => typeof id !== "string" || !/^\d+:\d+$/u.test(id),
        ),
    ) ||
    groups.reduce((count, group) => count + group.resultIds.length, 0) >
      10000 ||
    canonicalJson(
      groups.find((group) => group.runId === runId)?.resultIds ?? [],
    ) !== canonicalJson(ids)
  )
    throw new ProcessingError(422, "processing_accept_invalid");
  const dedupIds =
    input.deduplication === undefined
      ? undefined
      : isPlainObject(input.deduplication) &&
          Object.keys(input.deduplication).every((k) => k === "checkedIds")
        ? checkedIds(input.deduplication.checkedIds)
        : checkedIds(null);
  if (dedupIds && groups.length !== 1)
    throw new ProcessingError(422, "processing_deduplication_invalid");
  const digest = processingAcceptanceHash(
    ids,
    dedupIds ? { ...target, deduplication: dedupIds } : target,
    groups,
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing-candidates:${scope.projectId}`,
    ]);
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
    // Different UI entry points have different keys, but must not repeat the same frozen effect.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `processing-accept-effect:${scope.projectId}:${scope.actorId}:${runId}:${digest}`,
    ]);
    const adopted = (
      await client.query(
        `SELECT * FROM processing_acceptance
        WHERE project_id=$1 AND actor_id=$2 AND run_id=$3 AND request_hash=$4
        ORDER BY created_at,id LIMIT 1`,
        [scope.projectId, scope.actorId, runId, digest],
      )
    ).rows[0];
    if (adopted) {
      await getProcessingRun(client, scope, runId);
      await processingAccess(client, scope, true);
      await guardAssistantCommit(client, scope);
      await client.query(
        `INSERT INTO processing_acceptance(id,run_id,project_id,actor_id,idempotency_key,request_hash,result_ids,asset_id,draft_id,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          opaqueId("adoption"),
          runId,
          scope.projectId,
          scope.actorId,
          key,
          digest,
          JSON.stringify(ids),
          adopted.asset_id,
          adopted.draft_id,
          adopted.receipt,
        ],
      );
      await client.query("COMMIT");
      return { receipt: adopted.receipt, replayed: true };
    }
    const loaded = [];
    for (const group of groups)
      loaded.push(
        await selectedProcessingGroup(
          client,
          artifacts,
          scope,
          group.runId,
          group.resultIds,
        ),
      );
    const run = loaded.find((item) => item.run.id === runId)!.run;
    for (const group of loaded) {
      const priorCandidates = await adoptedCandidateKeys(
        client,
        artifacts,
        scope,
        [{ run: group.run, records: group.selected }],
        undefined,
        true,
        // Only this group's own receipt is an existing alternate destination; other groups remain cross-round identities.
        group.continuation ? [] : [group.run.id],
      );
      if (priorCandidates.size)
        throw new ProcessingError(409, "processing_already_adopted");
    }
    await guardProcessingTask(client, scope);
    const activeTask =
      !scope.assistantGuard &&
      (
        await client.query(
          `SELECT t.id FROM processing_task t JOIN processing_run latest ON latest.id=t.latest_run_id JOIN job j ON j.id=latest.job_id
      WHERE t.id IN(SELECT task_id FROM processing_run WHERE id=ANY($1::text[])) AND j.status NOT IN('succeeded','failed','cancelled') FOR UPDATE OF t`,
          [groups.map((group) => group.runId)],
        )
      ).rowCount;
    if (activeTask) throw new ProcessingError(409, "processing_still_running");
    if (groups.length > 1 && !scope.taskSave) {
      await guardAssistantCommit(client, scope);
      const task = (
        await client.query("SELECT task FROM assistant_session WHERE id=$1", [
          scope.assistantGuard?.sessionId,
        ])
      ).rows[0]?.task;
      const anchors = (
        await client.query(
          "SELECT DISTINCT task_id FROM processing_run WHERE project_id=$1 AND id=ANY($2::text[])",
          [scope.projectId, task?.runIds ?? []],
        )
      ).rows.map((row) => row.task_id);
      const members = scope.assistantResultsGuard
        ? (
            await client.query(
              "SELECT id FROM processing_run WHERE project_id=$1 AND task_id=ANY($2::text[]) AND task_id=ANY($3::text[])",
              [
                scope.projectId,
                anchors,
                scope.assistantResultsGuard.states.map((state) => state.id),
              ],
            )
          ).rows.map((row) => row.id)
        : [];
      if (
        !task ||
        loaded.some(
          (item) =>
            !task.runIds?.includes(item.run.id) &&
            !members.includes(item.run.id),
        )
      )
        throw new ProcessingError(409, "assistant_processing_context_changed");
      const sourceAssets = new Set(
        loaded.flatMap((item) =>
          item.run.source.kind === "assets"
            ? item.run.source.assetIds
            : item.selected.flatMap((row) => {
                const source = row.input.baseline?.source ?? row.input.source;
                return isPlainObject(source) &&
                  typeof source.assetId === "string"
                  ? [source.assetId]
                  : [];
              }),
        ),
      );
      const size = (
        await client.query(
          "SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM data_asset WHERE project_id=$1 AND id=ANY($2::text[])",
          [scope.projectId, [...sourceAssets]],
        )
      ).rows[0];
      if (sourceAssets.size > 5 || Number(size.bytes) > 100000000)
        throw new ProcessingError(422, "processing_capacity_exceeded");
    }
    const selected = loaded.flatMap((item) => item.selected);
    const dedupPlan = dedupIds
      ? await previewDeduplication(client, artifacts, scope, runId, dedupIds)
      : null;
    if (
      dedupPlan &&
      canonicalJson(sortedIds(dedupPlan.keptIds)) !== canonicalJson(ids)
    )
      throw new ProcessingError(409, "processing_deduplication_changed");
    const excludedGroups =
      scope.taskSave?.excludedGroups ??
      scope.assistantResultsGuard?.excludedGroups;
    const excludedRows = excludedGroups
      ? (
          await Promise.all(
            excludedGroups.map((group) =>
              selectedProcessingGroup(
                client,
                artifacts,
                scope,
                group.runId,
                group.resultIds,
              ),
            ),
          )
        ).flatMap((group) => group.selected)
      : dedupPlan
        ? (
            await selectedProcessingGroup(
              client,
              artifacts,
              scope,
              runId,
              dedupPlan.excludedIds,
            )
          ).selected
        : [];
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
        (dedupPlan?.removedRecordIds.length || excludedRows.length) &&
        revision !== target.expectedRevision
      )
        throw new ProcessingError(409, "draft_revision_conflict");
      if (
        !selected.every(
          (row) =>
            row.source.kind === "draft" &&
            row.source.id === draftId &&
            row.rootOperation !== "augment",
        ) &&
        revision !== target.expectedRevision
      )
        throw new ProcessingError(409, "draft_revision_conflict");
    }
    // Lock the job/run after the draft, matching the source-edit ordering.
    for (const group of groups
      .slice()
      .sort((a, b) => a.runId.localeCompare(b.runId))) {
      const locked = await getProcessingRun(client, scope, group.runId, true);
      if (!["succeeded", "failed", "cancelled"].includes(locked.status))
        throw new ProcessingError(409, "processing_still_running");
    }
    await processingAccess(client, scope, true);

    const replacingRows = selected.filter(
      (row) =>
        draftId !== null &&
        row.source.kind === "draft" &&
        row.source.id === draftId &&
        row.rootOperation !== "augment",
    );
    const removingRows = excludedRows.filter(
      (row) =>
        draftId &&
        row.source.kind === "draft" &&
        row.source.id === draftId &&
        row.rootOperation !== "augment" &&
        (excludedGroups
          ? !selected.some(
              (kept) =>
                kept.originalId === row.originalId &&
                kept.rootOperation !== "augment",
            )
          : dedupPlan?.removedRecordIds.includes(row.originalId)),
    );
    const removingIds = [...new Set(removingRows.map((row) => row.originalId))];
    if (removingIds.length) {
      const current = await client.query(
        "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false ORDER BY id FOR UPDATE",
        [draftId, removingIds],
      );
      const byId = new Map(current.rows.map((row) => [row.id, row]));
      for (const row of removingRows) {
        const now = byId.get(row.originalId),
          baseline = row.input.baseline ?? row.input;
        if (!now) throw new ProcessingError(409, "draft_record_removed");
        for (const field of [
          "question",
          "expectedOutput",
          "metadata",
        ] as const) {
          const column = field === "expectedOutput" ? "expected_output" : field;
          if (Number(now[`${column}_revision`]) !== baseline.revisions?.[field])
            throw new ProcessingError(409, "draft_field_conflict");
        }
      }
    }
    const replacingIds = replacingRows.map((row) => row.originalId);
    const replacingSet = new Set(replacingRows);
    const savedRows: { runId: string; resultId: string; recordId: string }[] =
      [];
    if (draftId) {
      const existing = await client.query(
        "SELECT id,question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
        [draftId],
      );
      const planned = new Set([
        ...replacingRows.map((row) => row.originalId),
        ...removingIds,
      ]);
      const keys = new Set(
        existing.rows
          .filter((row) => !planned.has(row.id))
          .map((row) =>
            contentKey({
              question: row.question,
              expectedOutput: row.expected_output,
              metadata: row.metadata,
            }),
          ),
      );
      for (const row of selected) {
        const key = contentKey(row);
        if (!replacingSet.has(row) && keys.has(key))
          throw new ProcessingError(409, "processing_duplicate_target");
        keys.add(key);
      }
    }
    if (new Set(replacingIds).size !== replacingIds.length)
      throw new ProcessingError(422, "processing_results_overlap");
    const updates: {
      id: string;
      field: string;
      value: unknown;
      runId: string;
    }[] = [];
    if (replacingRows.length) {
      const current = await client.query(
        "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false ORDER BY id FOR UPDATE",
        [draftId, replacingIds],
      );
      const byId = new Map(current.rows.map((row) => [row.id, row]));
      for (const row of replacingRows) {
        const input = row.input;
        const before = input.baseline ?? input,
          now = byId.get(row.originalId);
        if (!now) throw new ProcessingError(409, "draft_record_removed");
        for (const field of row.adoptionFields) {
          if (canonicalJson(before[field]) === canonicalJson(row[field]))
            continue;
          const column = field === "expectedOutput" ? "expected_output" : field;
          if (Number(now[`${column}_revision`]) !== before.revisions?.[field])
            throw new ProcessingError(409, "draft_field_conflict");
          updates.push({
            id: row.originalId,
            field,
            value: row[field],
            runId: row.runId,
          });
        }
      }
    }
    if (target.kind === "draft") {
      const priorResults = await adoptedCandidateKeys(
        client,
        artifacts,
        scope,
        loaded.map((item) => ({ run: item.run, records: item.selected })),
        draftId!,
      );
      if (priorResults.size)
        throw new ProcessingError(409, "processing_already_adopted");
    }

    await guardAssistantCommit(client, scope);
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
          [draftId, replacingIds],
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
        Number(capacity.count) -
          removingIds.length +
          (selected.length - replacingRows.length) >
          10000
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
    const name =
      groups.length > 1
        ? `任务成果-${acceptanceId.slice(-8)}.jsonl`
        : processingResultName(run.options.operation, runId);
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
      [
        opaqueId("attr"),
        assetId,
        name,
        `${{ clean: "清洗", rewrite: "改写", augment: "扩充" }[run.options.operation]}处理结果`,
        scope.actorId,
      ],
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
          processingRunId: selected[index].runId,
          resultId: selected[index].id,
          inputId: selected[index].sourceId,
        },
        hash: sha256(canonicalJson(value)),
      })),
    );
    if (draftId) {
      if (replacingRows.length) {
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
              update.runId,
            ],
          );
        }
        for (const [index, row] of selected.entries())
          if (replacingSet.has(row))
            await client.query(
              "UPDATE collaborative_draft_record SET source=$3 WHERE draft_id=$1 AND id=$2",
              [draftId, row.originalId, { assetId, ordinal: index + 1 }],
            );
      }
      const appending = selected
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => !replacingSet.has(row));
      const appendedIds = new Map(
        appending.map(({ index }) => [index, opaqueId("draftrow")]),
      );
      selected.forEach((row, index) =>
        savedRows.push({
          runId: row.runId,
          resultId: row.id,
          recordId: replacingSet.has(row)
            ? row.originalId
            : appendedIds.get(index)!,
        }),
      );
      if (appending.length)
        await writeBatches(
          client,
          `INSERT INTO collaborative_draft_record(draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
        SELECT $1,x.id,x.position,x.question,x.expected_output,x.metadata,x.source,$2,
          jsonb_build_object('question',jsonb_build_object('userId',$2::text,'at',now(),'processingRunId',x.run_id),
          'expectedOutput',jsonb_build_object('userId',$2::text,'at',now(),'processingRunId',x.run_id),'metadata',jsonb_build_object('userId',$2::text,'at',now(),'processingRunId',x.run_id))
        FROM jsonb_to_recordset($3::jsonb) AS x(id text,position bigint,question text,expected_output text,metadata jsonb,source jsonb,run_id text)`,
          [draftId, scope.actorId],
          appending.map(({ row, index }) => ({
            id: appendedIds.get(index)!,
            position: ++highWater,
            question: row.question,
            expected_output: row.expectedOutput,
            metadata: row.metadata,
            source: { assetId, ordinal: index + 1 },
            run_id: row.runId,
          })),
        );
      if (removingIds.length)
        await client.query(
          "UPDATE collaborative_draft_record SET deleted=true,row_revision=row_revision+1 WHERE draft_id=$1 AND id=ANY($2::text[])",
          [draftId, removingIds],
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
      candidateOrigins: [...selected, ...removingRows].map(
        (row) => row.candidateOrigin,
      ),
      removed: removingIds.length,
      updated: replacingRows.length,
      added: selected.length - replacingRows.length,
      ...(scope.taskSave?.requestHash
        ? { taskRequestHash: scope.taskSave.requestHash }
        : {}),
      ...(draftId ? { savedRows } : {}),
      ...(groups.length > 1 ? { resultGroups: groups } : {}),
      ...(draftId ? { revision: revision + 1 } : {}),
    };
    for (const group of groups)
      await client.query(
        `INSERT INTO processing_acceptance(id,run_id,project_id,actor_id,idempotency_key,request_hash,result_ids,asset_id,draft_id,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          group.runId === runId ? acceptanceId : opaqueId("adoption"),
          group.runId,
          scope.projectId,
          scope.actorId,
          group.runId === runId
            ? key
            : `assistant-group:${sha256(`${key}:${group.runId}`)}`,
          digest,
          JSON.stringify(group.resultIds),
          assetId,
          draftId,
          receipt,
        ],
      );
    await guardAssistantCommit(client, scope);
    if (scope.taskSave) {
      const removedRefs = removingRows.map(
        (row) => `${row.runId}\u001f${row.id}`,
      );
      await client.query(
        `UPDATE processing_task SET revision=revision+1,updated_at=now(),
        excluded_refs=coalesce((SELECT jsonb_agg(ref) FROM jsonb_array_elements(excluded_refs) ref
          WHERE NOT ((ref->>'runId') || chr(31) || (ref->>'resultId') = ANY($2::text[]))), '[]'::jsonb) WHERE id=$1`,
        [scope.taskSave.taskId, removedRefs],
      );
    }
    await client.query("COMMIT");
    return { receipt, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
