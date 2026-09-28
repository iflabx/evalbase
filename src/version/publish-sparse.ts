import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { canonicalJson, sha256 } from "../package/contract.js";
import type { Database } from "../db/pool.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import {
  checkpointThresholds,
  createCheckpoint,
  replayCost,
} from "./checkpoint.js";
import {
  snapshotPayloadHash,
  storedRecord,
  type SparseRecord,
} from "./snapshot-record.js";

export type { SparseRecord } from "./snapshot-record.js";

export type SparseOperation =
  | { operation: "add"; after: SparseRecord }
  | {
      operation: "update";
      caseId: string;
      beforeRevisionId: string;
      after: SparseRecord;
    }
  | {
      operation: "delete";
      caseId: string;
      beforeRevisionId: string;
    };

type PublishRequest = {
  projectId: string;
  testSetId: string;
  parentVersionId: string;
  actorId: string;
  idempotencyKey: string;
  operations: SparseOperation[];
  draftId?: string;
  draftRevision?: number;
};

type Member = {
  caseId: string;
  revisionId: string;
  position: bigint;
  contentHash: string;
  record: SparseRecord;
};

type PlannedChange = {
  caseId: string;
  operation: "add" | "update" | "delete";
  position: bigint;
  beforeRevisionId: string | null;
  beforeContentHash: string | null;
  afterRevisionId: string | null;
  afterContentHash: string | null;
  after?: SparseRecord;
};

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const invalid = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const sourceKey = (assetId: string, ordinal: number): string =>
  JSON.stringify([assetId, ordinal]);
export function encodeDeltaManifest(unsigned: Record<string, unknown>): {
  bytes: Buffer;
  manifestHash: string;
} {
  const deltaHash = sha256(
    canonicalJson({
      changes: unsigned.changes,
      new_revisions: unsigned.new_revisions,
    }),
  );
  const withoutHash = { ...unsigned, delta_hash: deltaHash };
  const manifestHash = sha256(canonicalJson(withoutHash));
  return {
    bytes: Buffer.from(
      `${canonicalJson({ ...withoutHash, manifest_hash: manifestHash })}\n`,
    ),
    manifestHash,
  };
}

function normalizeRecord(value: unknown): SparseRecord {
  if (
    !isObject(value) ||
    Object.keys(value).some(
      (key) =>
        !["question", "expectedOutput", "metadata", "source"].includes(key),
    ) ||
    typeof value.question !== "string" ||
    typeof value.expectedOutput !== "string" ||
    value.question.length > 100_000 ||
    value.expectedOutput.length > 100_000 ||
    !Array.isArray(value.metadata)
  )
    invalid("test_record_invalid");
  const record = value as SparseRecord;
  const metadata = record.metadata.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      Object.keys(entry).some((key) => !["key", "value"].includes(key)) ||
      typeof entry.key !== "string" ||
      typeof entry.value !== "string" ||
      !entry.key.trim()
    )
      invalid("test_record_invalid");
    const field = entry as { key: string; value: string };
    return { key: field.key.trim(), value: field.value };
  });
  if (
    new Set(metadata.map((entry) => entry.key.toLocaleLowerCase())).size !==
      metadata.length ||
    Buffer.byteLength(canonicalJson(metadata)) > 100_000
  )
    invalid("test_record_invalid");
  let source: SparseRecord["source"];
  const rawSource = record.source;
  if (rawSource !== undefined) {
    if (
      !isObject(rawSource) ||
      Object.keys(rawSource).some(
        (key) => !["assetId", "ordinal"].includes(key),
      ) ||
      typeof rawSource.assetId !== "string" ||
      !rawSource.assetId ||
      typeof rawSource.ordinal !== "number" ||
      !Number.isInteger(rawSource.ordinal) ||
      rawSource.ordinal < 0
    )
      invalid("source_selection_invalid");
    source = {
      assetId: rawSource.assetId as string,
      ordinal: rawSource.ordinal as number,
    };
  }
  return {
    question: record.question,
    expectedOutput: record.expectedOutput,
    metadata,
    ...(source ? { source } : {}),
  };
}

async function pathHighWater(
  client: PoolClient,
  parentVersionId: string,
  testSetId: string,
) {
  const result = await client.query<{ position: string }>(
    `WITH RECURSIVE path AS (
       SELECT id, parent_version_id FROM test_set_version
        WHERE id=$1 AND test_set_id=$2
       UNION ALL
       SELECT ancestor.id, ancestor.parent_version_id
         FROM path JOIN test_set_version ancestor ON ancestor.id=path.parent_version_id
        WHERE ancestor.test_set_id=$2
     ), positions AS (
       SELECT change.position FROM version_change change JOIN path ON path.id=change.version_id
       UNION ALL SELECT member.position FROM version_checkpoint_member member JOIN path ON path.id=member.version_id
       UNION ALL SELECT member.ordinal::bigint FROM version_member member JOIN path ON path.id=member.version_id
     ) SELECT COALESCE(MAX(position),0)::text AS position FROM positions`,
    [parentVersionId, testSetId],
  );
  return BigInt(result.rows[0].position);
}

async function sourceFacts(
  client: PoolClient,
  projectId: string,
  records: SparseRecord[],
): Promise<Map<string, Record<string, unknown>>> {
  const selected = new Map<string, { asset_id: string; ordinal: number }>();
  for (const record of records)
    if (record.source)
      selected.set(sourceKey(record.source.assetId, record.source.ordinal), {
        asset_id: record.source.assetId,
        ordinal: record.source.ordinal,
      });
  if (!selected.size) return new Map();
  const rows = await client.query(
    `WITH selected(asset_id,ordinal) AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(asset_id text,ordinal integer)
     )
     SELECT selected.asset_id, selected.ordinal, da.size_bytes, pv.id AS parsed_view_id,
            sr.locator, sr.record_hash
       FROM selected
       JOIN data_asset da ON da.id=selected.asset_id AND da.project_id=$1
       JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
       JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.ordinal=selected.ordinal
       WHERE da.status NOT IN ('deletion_pending','tombstoned')
         AND sr.parse_status='valid'
         AND sr.record_hash ~ '^[0-9a-f]{64}$'`,
    [projectId, JSON.stringify([...selected.values()])],
  );
  if (rows.rows.length !== selected.size) invalid("source_selection_invalid");
  const assets = new Map<string, number>();
  for (const row of rows.rows)
    assets.set(String(row.asset_id), Number(row.size_bytes));
  if (
    assets.size > 5 ||
    [...assets.values()].reduce((sum, size) => sum + size, 0) > 100_000_000
  )
    invalid("test_set_capacity_exceeded");
  return new Map(
    rows.rows.map((row) => [
      sourceKey(String(row.asset_id), Number(row.ordinal)),
      row,
    ]),
  );
}

export async function publishSparseVersion(
  db: Database,
  artifacts: ArtifactRepository,
  request: PublishRequest,
): Promise<{ id: string; label: string; replayed: boolean }> {
  if (
    !request.idempotencyKey ||
    request.idempotencyKey.length > 200 ||
    !Array.isArray(request.operations) ||
    request.operations.length > 10_000
  )
    invalid("sparse_publication_request_invalid");
  const fingerprint = sha256(
    canonicalJson(
      request.draftId
        ? {
            draftId: request.draftId,
            draftRevision: request.draftRevision,
          }
        : {
            parentVersionId: request.parentVersionId,
            operations: request.operations,
          },
    ),
  );
  const client = await db.connect();
  let storedObjectRef: string | undefined;
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    const scope = await client.query(
      `SELECT ts.id FROM test_set ts
       JOIN app_user u ON u.id=$3
       LEFT JOIN project_member pm ON pm.project_id=ts.project_id AND pm.user_id=u.id
      WHERE ts.id=$1 AND ts.project_id=$2 AND ts.status='available'
        AND (u.role='admin' OR pm.role IN ('owner','editor')) FOR UPDATE OF ts`,
      [request.testSetId, request.projectId, request.actorId],
    );
    if (!scope.rowCount) invalid("test_set_not_found");
    let collaborativeDraft: Record<string, unknown> | undefined;
    if (request.draftId) {
      const draft = await client.query(
        `SELECT * FROM collaborative_draft
        WHERE id=$1 AND project_id=$2 AND test_set_id=$3 AND parent_version_id=$4
        FOR UPDATE`,
        [
          request.draftId,
          request.projectId,
          request.testSetId,
          request.parentVersionId,
        ],
      );
      if (!draft.rowCount) invalid("draft_not_found");
      const lockedDraft = draft.rows[0] as Record<string, unknown>;
      collaborativeDraft = lockedDraft;
      if (
        lockedDraft.status === "published" &&
        lockedDraft.published_version_id
      ) {
        const existing = await client.query(
          `SELECT id,version_label FROM test_set_version
          WHERE id=$1`,
          [lockedDraft.published_version_id],
        );
        if (!existing.rowCount) invalid("idempotency_result_missing");
        await client.query("COMMIT");
        return {
          id: String(existing.rows[0].id),
          label: String(existing.rows[0].version_label),
          replayed: true,
        };
      }
      if (
        lockedDraft.status !== "editing" ||
        Number(lockedDraft.revision) !== request.draftRevision
      )
        invalid("draft_revision_conflict");
    }
    const replay = await client.query(
      `SELECT request_fingerprint, asset_id FROM upload_idempotency
        WHERE project_id=$1 AND actor_id=$2 AND operation='sparse_version_publish'
          AND idempotency_key=$3 AND status='committed'`,
      [request.projectId, request.actorId, request.idempotencyKey],
    );
    if (replay.rowCount) {
      if (replay.rows[0].request_fingerprint !== fingerprint)
        invalid("idempotency_conflict");
      const previous = await client.query(
        `SELECT id,version_label FROM test_set_version WHERE id=$1 AND test_set_id=$2`,
        [replay.rows[0].asset_id, request.testSetId],
      );
      if (!previous.rowCount) invalid("idempotency_result_missing");
      await client.query("COMMIT");
      return {
        id: previous.rows[0].id,
        label: previous.rows[0].version_label,
        replayed: true,
      };
    }
    const parent = await client.query(
      `SELECT v.id,v.schema_revision_id,v.generation,v.branch_number,
               cs.attribution_revision_id
          FROM test_set_version v
          JOIN candidate_snapshot cs ON cs.id=v.candidate_id
         WHERE v.id=$1 AND v.test_set_id=$2 AND v.status='published'`,
      [request.parentVersionId, request.testSetId],
    );
    if (!parent.rowCount) invalid("version_not_found");
    const parents = await client.query(
      `SELECT vm.case_id,vm.case_revision_id,vm.position::text AS position,
              cr.content_hash,cr.input,cr.expected_output,cr.metadata,
              cr.origin_kind,cr.origin_ref
         FROM resolve_version_members($1) vm
         JOIN case_revision cr ON cr.id=vm.case_revision_id
        ORDER BY vm.ordinal`,
      [request.parentVersionId],
    );
    const members = new Map<string, Member>(
      parents.rows.map((row) => [
        String(row.case_id),
        {
          caseId: String(row.case_id),
          revisionId: String(row.case_revision_id),
          position: BigInt(row.position),
          contentHash: String(row.content_hash),
          record: storedRecord(row),
        },
      ]),
    );
    let effectiveOperations = request.operations;
    if (collaborativeDraft) {
      const rows = await client.query(
        `SELECT * FROM collaborative_draft_record
        WHERE draft_id=$1 ORDER BY position`,
        [request.draftId],
      );
      effectiveOperations = [];
      const parentByCase = new Map(
        parents.rows.map((row) => [String(row.case_id), row]),
      );
      for (const row of rows.rows) {
        const caseId = row.case_id ? String(row.case_id) : null;
        if (caseId) {
          const original = parentByCase.get(caseId);
          if (
            !original ||
            String(original.case_revision_id) !== String(row.before_revision_id)
          )
            invalid("parent_record_invalid");
          if (row.deleted) {
            effectiveOperations.push({
              operation: "delete",
              caseId,
              beforeRevisionId: String(row.before_revision_id),
            });
          } else {
            const after = {
              question: String(row.question),
              expectedOutput: String(row.expected_output),
              metadata: row.metadata as SparseRecord["metadata"],
              ...(row.source
                ? { source: row.source as SparseRecord["source"] }
                : {}),
            };
            if (canonicalJson(after) !== canonicalJson(storedRecord(original)))
              effectiveOperations.push({
                operation: "update",
                caseId,
                beforeRevisionId: String(row.before_revision_id),
                after,
              });
          }
          parentByCase.delete(caseId);
        } else if (!row.deleted) {
          effectiveOperations.push({
            operation: "add",
            after: {
              question: String(row.question),
              expectedOutput: String(row.expected_output),
              metadata: row.metadata as SparseRecord["metadata"],
              ...(row.source
                ? { source: row.source as SparseRecord["source"] }
                : {}),
            },
          });
        }
      }
      if (parentByCase.size) invalid("draft_parent_incomplete");
      if (!rows.rows.some((row) => !row.deleted))
        invalid("test_set_records_required");
    }
    let highWater = await pathHighWater(
      client,
      request.parentVersionId,
      request.testSetId,
    );
    const touched = new Set<string>();
    const changes: PlannedChange[] = [];
    for (const operation of effectiveOperations) {
      if (operation.operation === "add") {
        const after = normalizeRecord(operation.after);
        if (highWater === 9_223_372_036_854_775_807n)
          invalid("version_position_exhausted");
        const caseId = id("case");
        const revisionId = id("revision");
        const position = ++highWater;
        const hash = sha256(canonicalJson(after));
        changes.push({
          caseId,
          operation: "add",
          position,
          beforeRevisionId: null,
          beforeContentHash: null,
          afterRevisionId: revisionId,
          afterContentHash: hash,
          after,
        });
        members.set(caseId, {
          caseId,
          revisionId,
          position,
          contentHash: hash,
          record: after,
        });
        continue;
      }
      if (
        (operation.operation !== "update" &&
          operation.operation !== "delete") ||
        !operation.caseId ||
        !operation.beforeRevisionId ||
        touched.has(operation.caseId)
      )
        invalid("parent_record_invalid");
      touched.add(operation.caseId);
      const before = members.get(operation.caseId);
      if (!before || before.revisionId !== operation.beforeRevisionId)
        invalid("parent_record_invalid");
      const current = before as Member;
      if (operation.operation === "delete") {
        changes.push({
          caseId: current.caseId,
          operation: "delete",
          position: current.position,
          beforeRevisionId: current.revisionId,
          beforeContentHash: current.contentHash,
          afterRevisionId: null,
          afterContentHash: null,
        });
        members.delete(current.caseId);
        continue;
      }
      const after = normalizeRecord(operation.after);
      if (canonicalJson(after) === canonicalJson(current.record)) continue;
      const revisionId = id("revision");
      const hash = sha256(canonicalJson(after));
      changes.push({
        caseId: current.caseId,
        operation: "update",
        position: current.position,
        beforeRevisionId: current.revisionId,
        beforeContentHash: current.contentHash,
        afterRevisionId: revisionId,
        afterContentHash: hash,
        after,
      });
      members.set(current.caseId, {
        ...current,
        revisionId,
        contentHash: hash,
        record: after,
      });
    }
    const ordered = [...members.values()].sort((a, b) =>
      a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
    );
    const cost = await replayCost(client, request.parentVersionId);
    const thresholds = checkpointThresholds(cost.baselineCount);
    const nextDepth = cost.depth + 1;
    const nextChanges = cost.changes + changes.length;
    const fullRecords = ordered.map((member) => member.record);
    if (
      fullRecords.length > 10_000 ||
      Buffer.byteLength(canonicalJson(fullRecords)) > 100_000_000
    )
      invalid("test_set_capacity_exceeded");
    const sources = await sourceFacts(client, request.projectId, fullRecords);
    const payloadHash = snapshotPayloadHash(fullRecords);
    const sourceList = [...sources.values()]
      .map((row) => ({
        assetId: String(row.asset_id),
        ordinal: Number(row.ordinal),
      }))
      .sort(
        (a, b) => a.assetId.localeCompare(b.assetId) || a.ordinal - b.ordinal,
      );
    const sourceAssets = [
      ...new Set(sourceList.map((source) => source.assetId)),
    ]
      .sort()
      .map((assetId) => ({ assetId }));
    const evidenceHash = sha256(
      canonicalJson({
        parentVersionId: request.parentVersionId,
        sources: sourceList,
        payloadHash,
      }),
    );
    const allocation = await client.query(
      `SELECT COALESCE(MAX(v.sequence),0)+1 AS sequence,
              COALESCE(MAX(v.publication_order),0)+1 AS publication_order,
              COALESCE(MAX(v.branch_number),0)+1 AS next_branch,
              EXISTS (SELECT 1 FROM test_set_version child
                      WHERE child.test_set_id=$1 AND child.parent_version_id=$2) AS parent_has_child
         FROM test_set_version v WHERE v.test_set_id=$1`,
      [request.testSetId, request.parentVersionId],
    );
    const sequence = Number(allocation.rows[0].sequence);
    const publicationOrder = Number(allocation.rows[0].publication_order);
    const generation = Number(parent.rows[0].generation) + 1;
    const branchNumber =
      allocation.rows[0].parent_has_child === true
        ? Number(allocation.rows[0].next_branch)
        : parent.rows[0].branch_number === null
          ? null
          : Number(parent.rows[0].branch_number);
    const label = `v${generation}${branchNumber === null ? "" : `-b${branchNumber}`}`;
    const versionId = id("version");
    const publishedAt = new Date().toISOString();
    const revisionRows = changes
      .filter((change) => change.after)
      .map((change) => {
        const after = change.after!;
        const source = after.source
          ? sources.get(sourceKey(after.source.assetId, after.source.ordinal))
          : undefined;
        const originRef = source
          ? {
              assetId: after.source!.assetId,
              parsedViewId: source.parsed_view_id,
              ordinal: after.source!.ordinal,
              locator: source.locator,
              recordHash: source.record_hash,
            }
          : { kind: "manual" };
        return {
          revision_id: change.afterRevisionId!,
          case_id: change.caseId,
          parent_revision_id: change.beforeRevisionId,
          input: { question: after.question },
          expected_output: { text: after.expectedOutput },
          metadata: after.metadata,
          source_record_ordinal: after.source?.ordinal ?? 0,
          content_hash: change.afterContentHash!,
          origin_kind: after.source ? "source_record" : "manual",
          origin_ref: originRef,
          lineage_fingerprint: sha256(
            canonicalJson({
              source: after.source ?? { kind: "manual" },
              contentHash: change.afterContentHash,
            }),
          ),
          lineage_level: "record_level",
        };
      })
      .sort((a, b) => a.revision_id.localeCompare(b.revision_id));
    const manifestChanges = [...changes]
      .sort((a, b) =>
        a.position < b.position
          ? -1
          : a.position > b.position
            ? 1
            : a.caseId.localeCompare(b.caseId),
      )
      .map((change) => ({
        case_id: change.caseId,
        operation: change.operation,
        position: change.position.toString(),
        before_revision_id: change.beforeRevisionId,
        before_content_hash: change.beforeContentHash,
        after_revision_id: change.afterRevisionId,
        after_content_hash: change.afterContentHash,
      }));
    const withoutHash = {
      format: "evalbase.test-set-delta-manifest",
      format_version: 1,
      version_id: versionId,
      test_set_id: request.testSetId,
      parent_version_id: request.parentVersionId,
      publication_order: publicationOrder,
      generation,
      branch_number: branchNumber,
      version_label: label,
      published_at: publishedAt,
      schema_revision_id: parent.rows[0].schema_revision_id,
      item_count: fullRecords.length,
      payload_hash: payloadHash,
      evidence_hash: evidenceHash,
      changes: manifestChanges,
      new_revisions: revisionRows,
    };
    const { bytes: manifestBytes, manifestHash } =
      encodeDeltaManifest(withoutHash);
    const stored = await artifacts.storeImmutable(
      manifestBytes,
      `sparse-version-${versionId}`,
    );
    storedObjectRef = stored.objectRef;
    const draftId = id("draft");
    const candidateId = id("candidate");
    await client.query(
      `INSERT INTO working_draft
         (id,test_set_id,status,updated_by,revision,version_description,base_version_id)
       VALUES ($1,$2,'published',$3,1,'',$4)`,
      [draftId, request.testSetId, request.actorId, request.parentVersionId],
    );
    await client.query(
      `INSERT INTO candidate_snapshot
         (id,draft_id,status,schema_revision_id,base_version_id,item_count,
          payload_hash,evidence_hash,object_ref,sources,attribution_revision_id)
       VALUES ($1,$2,'published_as_version',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        candidateId,
        draftId,
        parent.rows[0].schema_revision_id,
        request.parentVersionId,
        fullRecords.length,
        payloadHash,
        evidenceHash,
        stored.objectRef,
        JSON.stringify(sourceAssets),
        parent.rows[0].attribution_revision_id,
      ],
    );
    await client.query(
      `INSERT INTO test_set_version
         (id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,
          evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,
          published_at,parent_version_id,publication_order,generation,branch_number,
          version_label,storage_format)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'delta_v1')`,
      [
        versionId,
        request.testSetId,
        sequence,
        candidateId,
        parent.rows[0].schema_revision_id,
        payloadHash,
        evidenceHash,
        manifestHash,
        stored.objectRef,
        fullRecords.length,
        request.actorId,
        publishedAt,
        request.parentVersionId,
        publicationOrder,
        generation,
        branchNumber,
        label,
      ],
    );
    for (const change of changes) {
      if (change.operation === "add")
        await client.query(
          `INSERT INTO test_case (id,test_set_id) VALUES ($1,$2)`,
          [change.caseId, request.testSetId],
        );
      if (change.after) {
        const revision = revisionRows.find(
          (row) => row.revision_id === change.afterRevisionId,
        )!;
        await client.query(
          `INSERT INTO case_revision
             (id,case_id,parent_revision_id,input,expected_output,metadata,
              source_record_ordinal,content_hash,origin_kind,origin_ref,
              lineage_fingerprint,lineage_level)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            revision.revision_id,
            revision.case_id,
            revision.parent_revision_id,
            revision.input,
            revision.expected_output,
            { entries: revision.metadata },
            revision.source_record_ordinal,
            revision.content_hash,
            revision.origin_kind,
            revision.origin_ref,
            revision.lineage_fingerprint,
            revision.lineage_level,
          ],
        );
      }
      await client.query(
        `INSERT INTO version_change
           (version_id,case_id,operation,position,before_revision_id,before_content_hash,
            after_revision_id,after_content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          versionId,
          change.caseId,
          change.operation,
          change.position.toString(),
          change.beforeRevisionId,
          change.beforeContentHash,
          change.afterRevisionId,
          change.afterContentHash,
        ],
      );
    }
    if (nextDepth > 40 || nextChanges > thresholds.hardChanges) {
      if (
        (await createCheckpoint(
          client,
          versionId,
          "hard_limit",
          request.projectId,
        )) !== "created"
      )
        invalid("checkpoint_hard_limit_failed");
    } else if (nextDepth >= 20 || nextChanges >= thresholds.periodicChanges) {
      const jobId = id("job");
      await client.query(
        `INSERT INTO job
        (id,project_id,actor_id,kind,payload,status,correlation_id,idempotency_key)
        VALUES ($1,$2,$3,'materialize_version_checkpoint',$4,'queued',$1,$5)`,
        [
          jobId,
          request.projectId,
          request.actorId,
          JSON.stringify({ versionId }),
          `checkpoint:${versionId}`,
        ],
      );
    }
    await client.query(
      `INSERT INTO upload_idempotency
         (project_id,actor_id,operation,idempotency_key,status,
          request_fingerprint,asset_id,operation_id)
       VALUES ($1,$2,'sparse_version_publish',$3,'committed',$4,$5,$6)`,
      [
        request.projectId,
        request.actorId,
        request.idempotencyKey,
        fingerprint,
        versionId,
        `sparse-version-${versionId}`,
      ],
    );
    await client.query(
      `INSERT INTO audit_event
         (project_id,actor_id,action,object_type,object_id,details)
       VALUES ($1,$2,'solo_test_set_version_published','test_set_version',$3,$4)`,
      [
        request.projectId,
        request.actorId,
        versionId,
        {
          parentVersionId: request.parentVersionId,
          label,
          storageFormat: "delta_v1",
        },
      ],
    );
    if (collaborativeDraft) {
      const savedRows = await client.query(
        `SELECT id,case_id,field_attribution,updated_by,updated_at
        FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false ORDER BY position`,
        [request.draftId],
      );
      const added = changes.filter((change) => change.operation === "add");
      let nextAdded = 0;
      for (const row of savedRows.rows) {
        const caseId = row.case_id
          ? String(row.case_id)
          : added[nextAdded++]?.caseId;
        if (!caseId) invalid("draft_revision_conflict");
        await client.query(
          `INSERT INTO collaborative_draft_attribution
          (version_id,draft_row_id,case_id,field_attribution,saved_by,saved_at)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            versionId,
            row.id,
            caseId,
            row.field_attribution,
            row.updated_by,
            row.updated_at,
          ],
        );
      }
      await client.query(
        `UPDATE collaborative_draft SET status='published',
        published_version_id=$2,updated_by=$3,updated_at=now()
        WHERE id=$1 AND status='editing'`,
        [request.draftId, versionId, request.actorId],
      );
    }
    commitAttempted = true;
    await client.query("COMMIT");
    return { id: versionId, label, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (storedObjectRef && !commitAttempted)
      await artifacts.remove(storedObjectRef).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
