import type { FastifyRequest, FastifyReply } from "fastify";
import { writeBatches } from "../../db/batch.js";
import type { PoolClient } from "pg";
import { canonicalJson, sha256 } from "../../package/contract.js";
import { hasProjectCapability } from "../../security/project-access.js";
import {
  encodeDeltaManifest,
  publishSparseVersion,
  type SparseOperation,
} from "../../version/publish-sparse.js";
import {
  snapshotPayloadHash,
  storedRecord,
} from "../../version/snapshot-record.js";
import type { ServerContext } from "../context.js";
import {
  AuthenticatedRequest,
  opaqueId,
  isPlainObject,
  normalizeDisplayMapping,
  displayText,
  MetadataEntry,
  normalizeMetadataEntries,
  readMetadataEntries,
  metadataText,
} from "../support.js";

export function registerVersions(
  context: Pick<
    ServerContext,
    "db" | "artifacts" | "app" | "authenticate" | "writeAllowed"
  >,
) {
  const { db, artifacts, app, authenticate, writeAllowed } = context;
  const publishInitial = async (
    request: FastifyRequest<{ Params: { projectId: string }; Body: unknown }>,
    reply: FastifyReply,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor))
      return reply.code(403).send({ error: { code: "csrf_rejected" } });
    if (
      !(await hasProjectCapability(
        db,
        request.params.projectId,
        actor.id,
        "write",
      ))
    )
      return reply.code(404).send({ error: { code: "project_not_found" } });
    if (
      !isPlainObject(request.body) ||
      Object.keys(request.body).some(
        (key) =>
          ![
            "name",
            "purpose",
            "selections",
            "operations",
            "collaborativeDraftId",
            "draftRevision",
          ].includes(key),
      ) ||
      typeof request.body.name !== "string" ||
      request.body.name.trim().length < 1 ||
      request.body.name.trim().length > 200 ||
      (request.body.purpose !== undefined &&
        (typeof request.body.purpose !== "string" ||
          request.body.purpose.length > 2_000)) ||
      !Array.isArray(request.body.selections) ||
      !Array.isArray(request.body.operations)
    )
      return reply
        .code(422)
        .send({ error: { code: "test_set_payload_invalid" } });
    const selections = request.body.selections;
    const operations = request.body.operations;
    if (
      operations.some(
        (operation) =>
          !isPlainObject(operation) ||
          Object.keys(operation).length !== 2 ||
          operation.operation !== "add" ||
          !Object.keys(operation).includes("after"),
      )
    )
      return reply
        .code(422)
        .send({ error: { code: "test_set_payload_invalid" } });
    const records = operations.map((operation) => operation.after);
    if (!records.length)
      return reply
        .code(422)
        .send({ error: { code: "test_set_records_required" } });
    if (selections.length > 10_000 || records.length > 10_000)
      return reply
        .code(422)
        .send({ error: { code: "test_set_capacity_exceeded" } });
    const selected = selections.map((selection) => {
      if (!isPlainObject(selection)) return undefined;
      const assetId = selection.assetId;
      const ordinal = selection.ordinal;
      return Object.keys(selection).every((key) =>
        ["assetId", "ordinal"].includes(key),
      ) &&
        typeof assetId === "string" &&
        typeof ordinal === "number" &&
        Number.isInteger(ordinal) &&
        ordinal >= 0
        ? { assetId, ordinal }
        : undefined;
    });
    if (selected.some((selection) => !selection))
      return reply
        .code(422)
        .send({ error: { code: "source_selection_invalid" } });
    const selectedSources = selected as Array<{
      assetId: string;
      ordinal: number;
    }>;
    const selectedKeys = new Set(
      selectedSources.map(({ assetId, ordinal }) => `${assetId}:${ordinal}`),
    );
    if (selectedKeys.size !== selectedSources.length)
      return reply
        .code(422)
        .send({ error: { code: "source_selection_invalid" } });
    const edited = records.map((record) => {
      const metadata = isPlainObject(record)
        ? normalizeMetadataEntries(record.metadata)
        : undefined;
      if (
        !isPlainObject(record) ||
        Object.keys(record).some(
          (key) =>
            !["question", "expectedOutput", "metadata", "source"].includes(key),
        ) ||
        typeof record.question !== "string" ||
        typeof record.expectedOutput !== "string" ||
        !metadata ||
        record.question.length > 100_000 ||
        record.expectedOutput.length > 100_000 ||
        Buffer.byteLength(canonicalJson(metadata)) > 100_000
      )
        return undefined;
      if (record.source === undefined)
        return {
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata,
        };
      if (!isPlainObject(record.source)) return undefined;
      const sourceAssetId = record.source.assetId;
      const sourceOrdinal = record.source.ordinal;
      if (
        Object.keys(record.source).some(
          (key) => !["assetId", "ordinal"].includes(key),
        ) ||
        typeof sourceAssetId !== "string" ||
        typeof sourceOrdinal !== "number" ||
        !Number.isInteger(sourceOrdinal) ||
        sourceOrdinal < 0 ||
        !selectedKeys.has(`${sourceAssetId}:${sourceOrdinal}`)
      )
        return undefined;
      return {
        question: record.question,
        expectedOutput: record.expectedOutput,
        metadata,
        source: {
          assetId: sourceAssetId,
          ordinal: sourceOrdinal,
        },
      };
    });
    if (edited.some((record) => !record))
      return reply.code(422).send({ error: { code: "test_record_invalid" } });
    const testRecords = edited as Array<{
      question: string;
      expectedOutput: string;
      metadata: MetadataEntry[];
      source?: { assetId: string; ordinal: number };
    }>;
    const normalizedBytes = Buffer.byteLength(canonicalJson(testRecords));
    if (normalizedBytes > 100_000_000)
      return reply
        .code(422)
        .send({ error: { code: "test_set_capacity_exceeded" } });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 1 || key.length > 200)
      return reply
        .code(422)
        .send({ error: { code: "idempotency_key_required" } });
    const requestFingerprint = sha256(
      canonicalJson({
        name: request.body.name.trim(),
        purpose: request.body.purpose?.trim() ?? "",
        selections: selectedSources,
        records: testRecords,
      }),
    );
    const client = await db.connect();
    let storedManifest: { objectRef: string } | undefined;
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      const collaborativeDraftId =
        typeof request.body.collaborativeDraftId === "string"
          ? request.body.collaborativeDraftId
          : null;
      if (
        request.body.collaborativeDraftId !== undefined &&
        (!collaborativeDraftId || !Number.isInteger(request.body.draftRevision))
      ) {
        await client.query("ROLLBACK");
        return reply
          .code(422)
          .send({ error: { code: "draft_request_invalid" } });
      }
      if (collaborativeDraftId) {
        const locked = await client.query(
          `SELECT * FROM collaborative_draft
            WHERE id=$1 AND project_id=$2 AND parent_version_id IS NULL
            FOR UPDATE`,
          [collaborativeDraftId, request.params.projectId],
        );
        if (!locked.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        const draft = locked.rows[0];
        if (draft.status === "published" && draft.published_version_id) {
          const published = await client.query(
            `SELECT ts.id AS test_set_id,ts.name,ts.purpose,
              v.id AS version_id,v.item_count FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
              WHERE v.id=$1`,
            [draft.published_version_id],
          );
          await client.query("COMMIT");
          if (!published.rowCount)
            return reply
              .code(409)
              .send({ error: { code: "idempotency_result_missing" } });
          return {
            testSet: {
              id: published.rows[0].test_set_id,
              name: published.rows[0].name,
              purpose: published.rows[0].purpose,
            },
            version: {
              id: published.rows[0].version_id,
              label: "v1",
              recordCount: Number(published.rows[0].item_count),
            },
            replayed: true,
          };
        }
        if (
          draft.status !== "editing" ||
          Number(draft.revision) !== request.body.draftRevision
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_revision_conflict" } });
        }
        const rows = await client.query(
          `SELECT * FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false ORDER BY position`,
          [collaborativeDraftId],
        );
        const savedRecords = rows.rows.map((row) => ({
          question: String(row.question),
          expectedOutput: String(row.expected_output),
          metadata: row.metadata as MetadataEntry[],
          ...(row.source
            ? { source: row.source as { assetId: string; ordinal: number } }
            : {}),
        }));
        const savedSelections = [
          ...new Map(
            savedRecords.flatMap((record) =>
              record.source
                ? [
                    [
                      `${record.source.assetId}:${record.source.ordinal}`,
                      record.source,
                    ] as const,
                  ]
                : [],
            ),
          ).values(),
        ];
        if (
          draft.name !== request.body.name ||
          draft.purpose !== (request.body.purpose ?? "") ||
          canonicalJson(savedRecords) !== canonicalJson(testRecords) ||
          canonicalJson(savedSelections) !== canonicalJson(selectedSources)
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_revision_conflict" } });
        }
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agentbench:solo-test-set:${request.params.projectId}:${actor.id}:${key}`,
      ]);
      const replay = await client.query(
        `SELECT asset_id, request_fingerprint
             FROM upload_idempotency
            WHERE project_id = $1 AND actor_id = $2
              AND operation = 'solo_test_set_publish' AND idempotency_key = $3
              AND status = 'committed'`,
        [request.params.projectId, actor.id, key],
      );
      if (replay.rowCount) {
        if (replay.rows[0].request_fingerprint !== requestFingerprint) {
          await client.query("COMMIT");
          return reply
            .code(409)
            .send({ error: { code: "idempotency_conflict" } });
        }
        const reopened = await client.query(
          `SELECT ts.id, ts.name, ts.purpose, v.id AS version_id, v.item_count
               FROM test_set ts
               JOIN test_set_version v ON v.test_set_id = ts.id AND v.sequence = 1
              WHERE ts.project_id = $1 AND ts.id = $2`,
          [request.params.projectId, replay.rows[0].asset_id],
        );
        await client.query("COMMIT");
        if (!reopened.rowCount)
          return reply
            .code(409)
            .send({ error: { code: "idempotency_result_missing" } });
        return {
          testSet: {
            id: reopened.rows[0].id,
            name: reopened.rows[0].name,
            purpose: reopened.rows[0].purpose,
          },
          version: {
            id: reopened.rows[0].version_id,
            label: "v1",
            recordCount: Number(reopened.rows[0].item_count),
          },
          dataCheck: dataCheck(testRecords),
          replayed: true,
        };
      }
      const sourceRows = selectedSources.length
        ? await client.query(
            `WITH selected(asset_id, ordinal) AS (
                 SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(asset_id text, ordinal integer)
               )
               SELECT selected.asset_id, selected.ordinal, da.size_bytes, pv.id AS parsed_view_id,
                      sr.locator, sr.record_hash
                 FROM selected
                 JOIN data_asset da ON da.id = selected.asset_id AND da.project_id = $1
                 JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current AND pv.status = 'ready'
                 JOIN source_record sr
                   ON sr.parsed_view_id = pv.id AND sr.ordinal = selected.ordinal
                WHERE da.status NOT IN ('deletion_pending', 'tombstoned')
                  AND sr.parse_status = 'valid'`,
            [
              request.params.projectId,
              JSON.stringify(
                selectedSources.map(({ assetId, ordinal }) => ({
                  asset_id: assetId,
                  ordinal,
                })),
              ),
            ],
          )
        : { rows: [] as Array<Record<string, unknown>> };
      if (sourceRows.rows.length !== selectedSources.length) {
        await client.query("COMMIT");
        return reply
          .code(422)
          .send({ error: { code: "source_selection_invalid" } });
      }
      const sourceAssetBytes = new Map<string, number>();
      for (const row of sourceRows.rows)
        sourceAssetBytes.set(row.asset_id as string, Number(row.size_bytes));
      if (
        sourceAssetBytes.size > 5 ||
        [...sourceAssetBytes.values()].reduce((sum, value) => sum + value, 0) >
          100_000_000
      ) {
        await client.query("COMMIT");
        return reply
          .code(422)
          .send({ error: { code: "test_set_capacity_exceeded" } });
      }
      const sourceByKey = new Map(
        sourceRows.rows.map((row) => [`${row.asset_id}:${row.ordinal}`, row]),
      );
      const testSetId = opaqueId("testset");
      const draftId = opaqueId("draft");
      const schemaId = opaqueId("schema");
      const candidateId = opaqueId("candidate");
      const versionId = opaqueId("version");
      const payload = Buffer.from(
        `${testRecords.map((record) => canonicalJson(record)).join("\n")}\n`,
      );
      const payloadHash = sha256(payload);
      const evidenceHash = sha256(
        canonicalJson({ sources: selectedSources, payloadHash }),
      );
      const planned = testRecords.map((record, index) => {
        const source = record.source
          ? sourceByKey.get(`${record.source.assetId}:${record.source.ordinal}`)
          : undefined;
        const contentHash = sha256(canonicalJson(record));
        return {
          record,
          position: String(index + 1),
          caseId: opaqueId("case"),
          revisionId: opaqueId("revision"),
          contentHash,
          source,
          originRef: source
            ? {
                assetId: record.source!.assetId,
                parsedViewId: source.parsed_view_id,
                ordinal: record.source!.ordinal,
                locator: source.locator,
                recordHash: source.record_hash,
              }
            : { kind: "manual" },
          lineageFingerprint: sha256(
            canonicalJson({
              source: record.source ?? { kind: "manual" },
              contentHash,
            }),
          ),
        };
      });
      const publishedAt = new Date().toISOString();
      const { bytes: manifest, manifestHash } = await encodeDeltaManifest({
        format: "evalbase.test-set-delta-manifest",
        format_version: 1,
        version_id: versionId,
        test_set_id: testSetId,
        parent_version_id: null,
        publication_order: 1,
        generation: 1,
        branch_number: null,
        version_label: "v1",
        published_at: publishedAt,
        schema_revision_id: schemaId,
        item_count: testRecords.length,
        payload_hash: payloadHash,
        evidence_hash: evidenceHash,
        changes: planned.map((item) => ({
          case_id: item.caseId,
          operation: "add",
          position: item.position,
          before_revision_id: null,
          before_content_hash: null,
          after_revision_id: item.revisionId,
          after_content_hash: item.contentHash,
        })),
        new_revisions: [...planned]
          .sort((a, b) => a.revisionId.localeCompare(b.revisionId))
          .map((item) => ({
            revision_id: item.revisionId,
            case_id: item.caseId,
            parent_revision_id: null,
            input: { question: item.record.question },
            expected_output: { text: item.record.expectedOutput },
            metadata: item.record.metadata,
            source_record_ordinal: item.record.source?.ordinal ?? 0,
            content_hash: item.contentHash,
            origin_kind: item.record.source ? "source_record" : "manual",
            origin_ref: item.originRef,
            lineage_fingerprint: item.lineageFingerprint,
            lineage_level: "record_level",
          })),
      });
      storedManifest = await artifacts.storeImmutable(
        manifest,
        `solo-test-set-${testSetId}`,
      );
      await client.query(
        `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
           VALUES ($1, $2, $3, $4, $5)`,
        [
          testSetId,
          request.params.projectId,
          request.body.name.trim(),
          request.body.purpose?.trim() ?? "",
          actor.id,
        ],
      );
      await client.query(
        `INSERT INTO working_draft (id, test_set_id, status, updated_by, revision, version_description)
           VALUES ($1, $2, 'published', $3, 1, '')`,
        [draftId, testSetId, actor.id],
      );
      await client.query(
        `INSERT INTO formal_schema_revision
             (id, test_set_id, mode, input_schema, expected_output_schema)
           VALUES ($1, $2, 'gold_required', $3, $4)`,
        [
          schemaId,
          testSetId,
          { type: "object", properties: { question: { type: "string" } } },
          { type: "string" },
        ],
      );
      await client.query(
        `INSERT INTO candidate_snapshot
             (id, draft_id, status, item_count, payload_hash, evidence_hash, object_ref)
           VALUES ($1, $2, 'published_as_version', $3, $4, $5, $6)`,
        [
          candidateId,
          draftId,
          testRecords.length,
          payloadHash,
          evidenceHash,
          storedManifest.objectRef,
        ],
      );
      await client.query(
        `INSERT INTO test_set_version
             (id, test_set_id, sequence, candidate_id, schema_revision_id, payload_hash,
              evidence_hash, manifest_hash, manifest_object_ref, item_count, published_by,
              published_at, publication_order, generation, branch_number, version_label,
              storage_format)
           VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1, NULL, 'v1',
                   'delta_v1')`,
        [
          versionId,
          testSetId,
          candidateId,
          schemaId,
          payloadHash,
          evidenceHash,
          manifestHash,
          storedManifest.objectRef,
          testRecords.length,
          actor.id,
          publishedAt,
        ],
      );
      await writeBatches(
        client,
        `INSERT INTO test_case (id,test_set_id)
          SELECT x.case_id,$1 FROM jsonb_to_recordset($2::jsonb) AS x(case_id text)`,
        [testSetId],
        planned.map((item) => ({ case_id: item.caseId })),
      );
      await writeBatches(
        client,
        `INSERT INTO case_revision
          (id,case_id,input,expected_output,metadata,source_record_ordinal,content_hash,origin_kind,origin_ref,lineage_fingerprint)
          SELECT x.id,x.case_id,x.input,x.expected_output,x.metadata,x.ordinal,x.content_hash,x.origin_kind,x.origin_ref,x.lineage_fingerprint
          FROM jsonb_to_recordset($1::jsonb) AS x(id text,case_id text,input jsonb,expected_output jsonb,metadata jsonb,ordinal integer,content_hash text,origin_kind text,origin_ref jsonb,lineage_fingerprint text)`,
        [],
        planned.map((item) => ({
          id: item.revisionId,
          case_id: item.caseId,
          input: { question: item.record.question },
          expected_output: { text: item.record.expectedOutput },
          metadata: { entries: item.record.metadata },
          ordinal: item.record.source?.ordinal ?? 0,
          content_hash: item.contentHash,
          origin_kind: item.record.source ? "source_record" : "manual",
          origin_ref: item.originRef,
          lineage_fingerprint: item.lineageFingerprint,
        })),
      );
      await writeBatches(
        client,
        `INSERT INTO candidate_item
          (candidate_id,ordinal,case_id,source_record_ordinal,content_hash,parsed_view_id,origin_kind,origin_ref)
          SELECT $1,x.position,x.case_id,x.ordinal,x.content_hash,x.parsed_view_id,x.origin_kind,x.origin_ref
          FROM jsonb_to_recordset($2::jsonb) AS x(position integer,case_id text,ordinal integer,content_hash text,parsed_view_id text,origin_kind text,origin_ref jsonb)`,
        [candidateId],
        planned.map((item) => ({
          position: Number(item.position),
          case_id: item.caseId,
          ordinal: item.record.source?.ordinal ?? 0,
          content_hash: item.contentHash,
          parsed_view_id: item.source?.parsed_view_id ?? null,
          origin_kind: item.record.source ? "source_record" : "manual",
          origin_ref: item.record.source
            ? item.record.source
            : { kind: "manual" },
        })),
      );
      await writeBatches(
        client,
        `INSERT INTO version_change
          (version_id,case_id,operation,position,before_revision_id,before_content_hash,after_revision_id,after_content_hash)
          SELECT $1,x.case_id,'add',x.position,NULL,NULL,x.revision_id,x.content_hash
          FROM jsonb_to_recordset($2::jsonb) AS x(case_id text,position bigint,revision_id text,content_hash text)`,
        [versionId],
        planned.map((item) => ({
          case_id: item.caseId,
          position: item.position,
          revision_id: item.revisionId,
          content_hash: item.contentHash,
        })),
      );
      const membersHash = sha256(
        canonicalJson(
          planned.map(({ position, caseId, revisionId }) => [
            Number(position),
            caseId,
            revisionId,
          ]),
        ),
      );
      await client.query(
        `INSERT INTO version_checkpoint
             (version_id,reason,retention_class,item_count,members_hash)
           VALUES ($1,'initial','rebuildable',$2,$3)`,
        [versionId, planned.length, membersHash],
      );
      if (planned.length)
        await client.query(
          `INSERT INTO version_checkpoint_member
               (version_id,position,case_id,case_revision_id)
             SELECT $1,x.position::bigint,x.case_id,x.case_revision_id
               FROM jsonb_to_recordset($2::jsonb)
                 AS x(position text,case_id text,case_revision_id text)`,
          [
            versionId,
            JSON.stringify(
              planned.map(({ position, caseId, revisionId }) => ({
                position,
                case_id: caseId,
                case_revision_id: revisionId,
              })),
            ),
          ],
        );
      const verified = await client.query(
        `SELECT checkpoint_members_hash($1) AS hash,
                  (SELECT count(*)::int FROM version_checkpoint_member
                    WHERE version_id=$1) AS count`,
        [versionId],
      );
      if (
        verified.rows[0].hash !== membersHash ||
        verified.rows[0].count !== planned.length
      )
        throw new Error("initial_checkpoint_failed");
      const resolved = await client.query(
        `SELECT cr.input,cr.expected_output,cr.metadata,cr.origin_kind,cr.origin_ref
             FROM resolve_version_members($1) vm
             JOIN case_revision cr ON cr.id=vm.case_revision_id
            ORDER BY vm.ordinal`,
        [versionId],
      );
      if (
        resolved.rowCount !== planned.length ||
        snapshotPayloadHash(resolved.rows.map(storedRecord)) !== payloadHash
      )
        throw new Error("initial_checkpoint_failed");
      await client.query(
        "UPDATE test_set SET default_version_id = $2 WHERE id = $1",
        [testSetId, versionId],
      );
      await client.query(
        `INSERT INTO upload_idempotency
             (project_id, actor_id, operation, idempotency_key, status,
              request_fingerprint, asset_id, operation_id)
           VALUES ($1, $2, 'solo_test_set_publish', $3, 'committed', $4, $5, $6)`,
        [
          request.params.projectId,
          actor.id,
          key,
          requestFingerprint,
          testSetId,
          `solo-test-set-${testSetId}`,
        ],
      );
      await client.query(
        `INSERT INTO audit_event
             (project_id, actor_id, action, object_type, object_id, details)
           VALUES ($1, $2, 'solo_test_set_v1_published', 'test_set_version', $3, $4)`,
        [request.params.projectId, actor.id, versionId, { testSetId }],
      );
      if (collaborativeDraftId) {
        const savedRows = await client.query(
          `SELECT id,field_attribution,updated_by,updated_at
            FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false ORDER BY position`,
          [collaborativeDraftId],
        );
        if (savedRows.rows.length !== planned.length)
          throw new Error("draft_revision_conflict");
        await writeBatches(
          client,
          `INSERT INTO collaborative_draft_attribution
            (version_id,draft_row_id,case_id,field_attribution,saved_by,saved_at)
            SELECT $1,x.draft_row_id,x.case_id,x.field_attribution,x.saved_by,x.saved_at
            FROM jsonb_to_recordset($2::jsonb) AS x(draft_row_id text,case_id text,field_attribution jsonb,saved_by text,saved_at timestamptz)`,
          [versionId],
          savedRows.rows.map((row, index) => ({
            draft_row_id: row.id,
            case_id: planned[index].caseId,
            field_attribution: row.field_attribution,
            saved_by: row.updated_by,
            saved_at: row.updated_at,
          })),
        );
        await client.query(
          `INSERT INTO collaborative_draft_attribution
              (version_id,draft_row_id,case_id,field_attribution,saved_by,saved_at)
             SELECT $2,id,case_id,'{}'::jsonb,updated_by,updated_at
             FROM collaborative_draft_record
             WHERE draft_id=$1 AND deleted=true AND case_id IS NOT NULL`,
          [collaborativeDraftId, versionId],
        );
        await client.query(
          `UPDATE collaborative_draft SET status='published',
            test_set_id=$2,published_version_id=$3,revision=revision+1,updated_by=$4,updated_at=now()
            WHERE id=$1 AND status='editing'`,
          [collaborativeDraftId, testSetId, versionId, actor.id],
        );
      }
      commitAttempted = true;
      await client.query("COMMIT");
      return reply.code(201).send({
        testSet: {
          id: testSetId,
          name: request.body.name.trim(),
          purpose: request.body.purpose?.trim() ?? "",
        },
        version: {
          id: versionId,
          label: "v1",
          recordCount: testRecords.length,
        },
        dataCheck: dataCheck(testRecords),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (storedManifest && !commitAttempted)
        await artifacts.remove(storedManifest.objectRef).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  app.post<{
    Params: { projectId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets",
    { preHandler: authenticate },
    publishInitial,
  );

  function dataCheck(
    records: Array<{
      question: string;
      expectedOutput: string;
      metadata: MetadataEntry[];
      source?: unknown;
    }>,
  ) {
    const fingerprints = records.map(({ question, expectedOutput, metadata }) =>
      canonicalJson({ question, expectedOutput, metadata }),
    );
    return {
      missingQuestionCount: records.filter((record) => !record.question.trim())
        .length,
      exactDuplicateCount: fingerprints.length - new Set(fingerprints).size,
      traceableRecordCount: records.filter((record) => record.source).length,
    };
  }

  type SoloVersionRecord = {
    id: string;
    ordinal: number;
    parentRevisionId: string;
    question: string;
    expectedOutput: string;
    metadata: MetadataEntry[];
    source: {
      assetId: string;
      ordinal: number;
      fileName?: string;
      collectionId?: string;
    } | null;
  };

  type SoloVersionChange = {
    id: string;
    changeType: "unchanged" | "modified" | "added" | "removed";
    current: Omit<
      SoloVersionRecord,
      "id" | "ordinal" | "parentRevisionId"
    > | null;
    previous: Omit<
      SoloVersionRecord,
      "id" | "ordinal" | "parentRevisionId"
    > | null;
    source: SoloVersionRecord["source"];
    changedFields: string[];
    fieldEditors: Record<
      string,
      { userId: string; name: string; avatarColor: string; at: string }
    >;
    recordEditor: {
      userId: string;
      name: string;
      avatarColor: string;
      at: string;
    } | null;
  };

  function soloVersionRecord(row: Record<string, unknown>): SoloVersionRecord {
    const origin = isPlainObject(row.origin_ref) ? row.origin_ref : undefined;
    return {
      id: String(row.case_id),
      ordinal: Number(row.ordinal),
      parentRevisionId: String(row.case_revision_id),
      question:
        isPlainObject(row.input) && typeof row.input.question === "string"
          ? row.input.question
          : displayText(row.input),
      expectedOutput:
        isPlainObject(row.expected_output) &&
        typeof row.expected_output.text === "string"
          ? row.expected_output.text
          : displayText(row.expected_output),
      metadata: readMetadataEntries(row.metadata),
      source:
        row.origin_kind === "source_record" && origin
          ? { assetId: String(origin.assetId), ordinal: Number(origin.ordinal) }
          : null,
    };
  }

  async function soloVersionChanges(
    projectId: string,
    testSetId: string,
    versionId: string,
    queryClient: Pick<PoolClient, "query"> = db,
  ) {
    const version = await queryClient.query(
      `SELECT ts.id AS test_set_id, ts.name, v.id, v.version_label, v.item_count,
              v.parent_version_id, v.published_at, v.evidence_hash
         FROM test_set ts
         JOIN test_set_version v ON v.test_set_id = ts.id
        WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
          AND ts.status = 'available' AND v.status = 'published'`,
      [projectId, testSetId, versionId],
    );
    if (!version.rowCount) return undefined;

    const members = async (id: string, pending = false) => {
      const result = await queryClient.query(
        `SELECT vm.ordinal, cr.case_id, cr.input, cr.expected_output, cr.metadata,
                cr.origin_kind, cr.origin_ref
           FROM ${pending ? "resolve_version_members_internal($1,true,true)" : "resolve_version_members($1)"} vm
           JOIN case_revision cr ON cr.id = vm.case_revision_id
          WHERE vm.version_id = $1
          ORDER BY vm.ordinal`,
        [id],
      );
      return result.rows.map(soloVersionRecord);
    };
    const current = await members(versionId);
    const parentVersionId = version.rows[0].parent_version_id as string | null;
    const parentState = parentVersionId
      ? await queryClient.query(
          "SELECT status,cleanup_pending,manifest_object_ref FROM test_set_version WHERE id = $1",
          [parentVersionId],
        )
      : { rows: [] as Array<{ status: string }> };
    const parentUnavailable =
      parentState.rows[0] &&
      ["tombstoned", "permanently_deleted", "degraded_by_deletion"].includes(
        parentState.rows[0].status,
      );
    const cutState = parentUnavailable
      ? await queryClient.query(
          "SELECT 1 FROM version_provenance_cut_state WHERE version_id=$1 AND parent_version_id=$2",
          [versionId, parentVersionId],
        )
      : { rowCount: 0 };
    const parentPendingContent =
      parentUnavailable &&
      !cutState.rowCount &&
      parentState.rows[0].cleanup_pending &&
      !String(parentState.rows[0].manifest_object_ref).startsWith(
        "tombstone:",
      ) &&
      !String(parentState.rows[0].manifest_object_ref).startsWith("deleted:");
    const previous =
      parentVersionId && (!parentUnavailable || parentPendingContent)
        ? await members(parentVersionId, Boolean(parentPendingContent))
        : [];
    const cutFacts = parentUnavailable
      ? await queryClient.query(
          `SELECT case_id, change_type, changed_fields
             FROM version_provenance_cut_fact WHERE version_id = $1`,
          [versionId],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const factById = new Map(
      cutFacts.rows.map((row) => [String(row.case_id), row]),
    );
    const currentById = new Map(current.map((record) => [record.id, record]));
    const previousById = new Map(previous.map((record) => [record.id, record]));
    const changes: SoloVersionChange[] = [];
    for (const id of new Set([
      ...previousById.keys(),
      ...currentById.keys(),
      ...factById.keys(),
    ])) {
      const currentRecord = currentById.get(id);
      const previousRecord = previousById.get(id);
      const cutFact = factById.get(id);
      const currentValue = currentRecord
        ? (({
            id: _id,
            ordinal: _ordinal,
            parentRevisionId: _parentRevisionId,
            ...value
          }) => value)(currentRecord)
        : null;
      const previousValue =
        previousRecord && !parentUnavailable
          ? (({
              id: _id,
              ordinal: _ordinal,
              parentRevisionId: _parentRevisionId,
              ...value
            }) => value)(previousRecord)
          : null;
      const changedFields: string[] =
        currentRecord && previousRecord
          ? (["question", "expectedOutput", "metadata"] as const).filter(
              (field) =>
                field === "metadata"
                  ? canonicalJson(currentRecord.metadata) !==
                    canonicalJson(previousRecord.metadata)
                  : currentRecord[field] !== previousRecord[field],
            )
          : [];
      if (
        currentRecord &&
        previousRecord &&
        (currentRecord.source?.assetId !== previousRecord.source?.assetId ||
          currentRecord.source?.ordinal !== previousRecord.source?.ordinal)
      )
        changedFields.push("source");
      changes.push({
        id,
        changeType: cutFact
          ? (String(cutFact.change_type) as SoloVersionChange["changeType"])
          : !previousRecord
            ? "added"
            : !currentRecord
              ? "removed"
              : changedFields.length ||
                  currentRecord.source?.assetId !==
                    previousRecord.source?.assetId ||
                  currentRecord.source?.ordinal !==
                    previousRecord.source?.ordinal
                ? "modified"
                : "unchanged",
        current: currentValue,
        previous: previousValue,
        source:
          currentRecord?.source ??
          (!parentUnavailable ? previousRecord?.source : null) ??
          null,
        changedFields:
          cutFact && Array.isArray(cutFact.changed_fields)
            ? (cutFact.changed_fields as string[])
            : changedFields,
        fieldEditors: {},
        recordEditor: null,
      });
    }

    const attributionRows = await queryClient.query(
      `SELECT case_id,field_attribution,saved_by,saved_at
       FROM collaborative_draft_attribution WHERE version_id=$1`,
      [versionId],
    );
    const attributionByCase = new Map(
      attributionRows.rows.map((row) => [String(row.case_id), row]),
    );
    const authorIds = [
      ...new Set(
        attributionRows.rows.flatMap((row) => [
          String(row.saved_by),
          ...Object.values(
            isPlainObject(row.field_attribution) ? row.field_attribution : {},
          ).flatMap((fact) =>
            isPlainObject(fact) && typeof fact.userId === "string"
              ? [fact.userId]
              : [],
          ),
        ]),
      ),
    ];
    const authorRows = authorIds.length
      ? await queryClient.query(
          `SELECT id,coalesce(display_name,username) AS name,avatar_color FROM app_user WHERE id=ANY($1::text[])`,
          [authorIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const authors = new Map(
      authorRows.rows.map((row) => [String(row.id), row]),
    );
    for (const change of changes) {
      const row = attributionByCase.get(change.id);
      if (!row) continue;
      const savedBy = authors.get(String(row.saved_by));
      if (savedBy)
        change.recordEditor = {
          userId: String(row.saved_by),
          name: String(savedBy.name),
          avatarColor: String(savedBy.avatar_color),
          at: String(row.saved_at),
        };
      if (isPlainObject(row.field_attribution)) {
        for (const [field, fact] of Object.entries(row.field_attribution)) {
          if (
            !isPlainObject(fact) ||
            typeof fact.userId !== "string" ||
            typeof fact.at !== "string"
          )
            continue;
          const person = authors.get(fact.userId);
          if (!person) continue;
          change.fieldEditors[field] = {
            userId: fact.userId,
            name: String(person.name),
            avatarColor: String(person.avatar_color),
            at: fact.at,
          };
        }
      }
    }
    const sourceAssetIds = [
      ...new Set(
        changes.flatMap((change) =>
          [
            change.current?.source,
            change.previous?.source,
            change.source,
          ].flatMap((source) => (source ? [source.assetId] : [])),
        ),
      ),
    ];
    const assets = sourceAssetIds.length
      ? await queryClient.query(
          `SELECT da.id, da.file_name, da.collection_id, da.status, pv.display_mapping
             FROM data_asset da
             LEFT JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
            WHERE da.project_id = $1 AND da.id = ANY($2::text[])
            ORDER BY da.id`,
          [projectId, sourceAssetIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const assetById = new Map(
      assets.rows.map((asset) => [String(asset.id), asset]),
    );
    const enrichSource = (source: SoloVersionRecord["source"]) => {
      if (source) {
        const asset = assetById.get(source.assetId);
        source.fileName = String(asset?.file_name ?? "未记录资料");
        source.collectionId = String(asset?.collection_id ?? "");
      }
    };
    for (const change of changes) {
      enrichSource(change.current?.source ?? null);
      enrichSource(change.previous?.source ?? null);
      enrichSource(change.source);
    }
    const addedFileCounts = new Map<string, number>();
    for (const change of changes) {
      const assetId = change.current?.source?.assetId;
      if (
        assetId &&
        (change.changeType === "added" ||
          (change.changeType === "modified" &&
            change.changedFields.includes("source")))
      )
        addedFileCounts.set(assetId, (addedFileCounts.get(assetId) ?? 0) + 1);
    }
    const addedFiles = [...addedFileCounts].map(([assetId, recordCount]) => {
      const asset = assetById.get(assetId);
      const mapping = normalizeDisplayMapping(asset?.display_mapping) ?? {
        metadata: [],
      };
      return {
        assetId,
        fileName: String(asset?.file_name ?? "未记录资料"),
        recordCount,
        mapping: {
          question: mapping.question ?? null,
          expectedOutput: mapping.expectedOutput ?? null,
          metadata: mapping.metadata,
        },
      };
    });
    const parent = parentVersionId
      ? await queryClient.query(
          `SELECT version_label FROM test_set_version WHERE id = $1`,
          [parentVersionId],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    return {
      version: version.rows[0],
      parentLabel: parent.rows[0]?.version_label ?? null,
      changes,
      current,
      addedFiles,
      manualAddedCount: changes.filter(
        (change) => change.changeType === "added" && !change.source,
      ).length,
      sourceFingerprint: sha256(canonicalJson(assets.rows)),
      parentStatus: parentState.rows[0]?.status ?? null,
    };
  }

  function csvField(value: string) {
    const protectedValue = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(protectedValue)
      ? `"${protectedValue.replaceAll('"', '""')}"`
      : protectedValue;
  }

  async function soloVersionExportEvidence(
    projectId: string,
    testSetId: string,
    versionId: string,
    client: PoolClient,
  ) {
    const state = await client.query(
      `SELECT v.version_label, v.parent_version_id, to_jsonb(v) AS version_evidence,
              to_jsonb(p) AS parent_evidence, p.status AS parent_status,
              p.cleanup_pending AS parent_cleanup_pending, p.manifest_object_ref AS parent_manifest,
              EXISTS(SELECT 1 FROM version_provenance_cut_state c
                     WHERE c.version_id=v.id AND c.parent_version_id=p.id) AS parent_cut
       FROM test_set ts JOIN test_set_version v ON v.test_set_id=ts.id
       LEFT JOIN test_set_version p ON p.id=v.parent_version_id
       WHERE ts.project_id=$1 AND ts.id=$2 AND v.id=$3
         AND ts.status='available' AND v.status='published'`,
      [projectId, testSetId, versionId],
    );
    if (!state.rowCount) return undefined;
    const version = state.rows[0];
    const parentUnavailable = [
      "tombstoned",
      "permanently_deleted",
      "degraded_by_deletion",
    ].includes(version.parent_status);
    const parentPending =
      parentUnavailable &&
      !version.parent_cut &&
      version.parent_cleanup_pending &&
      !String(version.parent_manifest).startsWith("tombstone:") &&
      !String(version.parent_manifest).startsWith("deleted:");
    const parentId =
      !parentUnavailable || parentPending ? version.parent_version_id : null;
    // Validate all logical members before accepting a cache hit. Hash actual bodies
    // in PostgreSQL as well as IDs; a stale stored content_hash is not sufficient.
    const facts = await client.query(
      `WITH members AS MATERIALIZED (
         SELECT 'current' AS side,vm.ordinal,vm.case_id,vm.case_revision_id
         FROM resolve_version_members($1) vm
         UNION ALL
         SELECT 'parent',vm.ordinal,vm.case_id,vm.case_revision_id
         FROM resolve_version_members_internal($2,$3,true) vm
       ), body_facts AS MATERIALIZED (
         SELECT m.side,m.ordinal,m.case_revision_id,
                encode(sha256(convert_to(jsonb_build_array(m.case_id,cr.input,cr.expected_output,
                  cr.metadata,cr.origin_kind,cr.origin_ref)::text,'UTF8')),'hex') AS body_hash,
                CASE WHEN cr.origin_kind='source_record' THEN cr.origin_ref->>'assetId' END AS asset_id
         FROM members m JOIN case_revision cr ON cr.id=m.case_revision_id
       )
       SELECT
         encode(sha256(convert_to(coalesce((SELECT string_agg(
           jsonb_build_array(side,ordinal,case_revision_id,body_hash)::text,',' ORDER BY side,ordinal)
           FROM body_facts),''),'UTF8')),'hex') AS members,
         coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM (
           SELECT da.id,da.file_name,da.collection_id,da.status,pv.display_mapping
           FROM data_asset da LEFT JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current
           WHERE da.project_id=$4 AND da.id IN (SELECT asset_id FROM body_facts)
         ) s),'[]'::jsonb) AS sources,
         coalesce((SELECT jsonb_agg(jsonb_build_array(case_id,change_type,changed_fields) ORDER BY case_id)
           FROM version_provenance_cut_fact WHERE version_id=$1),'[]'::jsonb) AS cuts`,
      [versionId, parentId, Boolean(parentPending), projectId],
    );
    return {
      label: String(version.version_label),
      fingerprint: sha256(
        canonicalJson({
          version: version.version_evidence,
          parent: version.parent_evidence,
          parentCut: version.parent_cut,
          facts: facts.rows[0],
        }),
      ),
    };
  }

  function csvDocument(rows: string[][]) {
    return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
  }

  app.post<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Body: unknown;
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/derived-versions",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some((key) => key !== "operations") ||
        !Array.isArray(body.operations) ||
        body.operations.length > 10_000
      )
        return reply
          .code(422)
          .send({ error: { code: "test_set_payload_invalid" } });
      const operations = body.operations;
      for (const operation of operations) {
        if (!isPlainObject(operation))
          return reply
            .code(422)
            .send({ error: { code: "test_record_invalid" } });
        const fields =
          operation.operation === "add"
            ? ["operation", "after"]
            : operation.operation === "update"
              ? ["operation", "caseId", "beforeRevisionId", "after"]
              : operation.operation === "delete"
                ? ["operation", "caseId", "beforeRevisionId"]
                : [];
        if (
          !fields.length ||
          Object.keys(operation).length !== fields.length ||
          Object.keys(operation).some((field) => !fields.includes(field)) ||
          (operation.operation !== "delete" &&
            !isPlainObject(operation.after)) ||
          (operation.operation !== "add" &&
            (typeof operation.caseId !== "string" ||
              !operation.caseId ||
              typeof operation.beforeRevisionId !== "string" ||
              !operation.beforeRevisionId))
        )
          return reply
            .code(422)
            .send({ error: { code: "test_record_invalid" } });
      }
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 1 || key.length > 200)
        return reply
          .code(422)
          .send({ error: { code: "idempotency_key_required" } });
      try {
        const published = await publishSparseVersion(db, artifacts, {
          projectId: request.params.projectId,
          testSetId: request.params.testSetId,
          parentVersionId: request.params.versionId,
          actorId: actor.id,
          idempotencyKey: key,
          operations: operations as SparseOperation[],
        });
        const result = await db.query(
          `SELECT v.item_count, cr.input, cr.expected_output, cr.metadata,
                  cr.origin_kind, cr.origin_ref
             FROM test_set_version v
             JOIN LATERAL resolve_version_members(v.id) vm ON true
             JOIN case_revision cr ON cr.id=vm.case_revision_id
            WHERE v.id=$1 ORDER BY vm.ordinal`,
          [published.id],
        );
        const version = {
          id: published.id,
          label: published.label,
          recordCount: Number(result.rows[0]?.item_count ?? 0),
          parentVersionId: request.params.versionId,
        };
        return reply.code(published.replayed ? 200 : 201).send({
          version,
          dataCheck: dataCheck(result.rows.map(storedRecord)),
          ...(published.replayed ? { replayed: true } : {}),
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "test_set_not_found" || code === "version_not_found")
          return reply.code(404).send({ error: { code } });
        if (code === "idempotency_conflict")
          return reply.code(409).send({ error: { code } });
        if (
          code === "sparse_publication_request_invalid" ||
          code === "parent_record_invalid" ||
          code === "test_record_invalid" ||
          code === "source_selection_invalid" ||
          code === "test_set_capacity_exceeded" ||
          code === "version_position_exhausted"
        )
          return reply.code(422).send({ error: { code } });
        if (code === "checkpoint_hard_limit_failed")
          return reply.code(503).send({ error: { code } });
        throw error;
      }
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: {
      search?: string;
      limit?: string;
      offset?: string;
      sourceAssetId?: string | string[];
      question?: string;
      origin?: string;
      metadataField?: string;
      metadata?: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/records",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const allowed = new Set([
        "search",
        "limit",
        "offset",
        "sourceAssetId",
        "question",
        "origin",
        "metadataField",
        "metadata",
      ]);
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      const question = request.query.question ?? "all";
      const origin = request.query.origin ?? "all";
      const sourceAssetIds = (
        Array.isArray(request.query.sourceAssetId)
          ? request.query.sourceAssetId
          : [request.query.sourceAssetId]
      ).filter((value): value is string => typeof value === "string");
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        !["all", "present", "missing"].includes(question) ||
        !["all", "source", "manual"].includes(origin) ||
        sourceAssetIds.some((id) => !id || id.length > 200) ||
        (request.query.search !== undefined &&
          request.query.search.length > 200) ||
        (request.query.metadataField !== undefined &&
          request.query.metadataField.length > 200) ||
        (request.query.metadata !== undefined &&
          request.query.metadata.length > 200)
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const values: unknown[] = [
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      ];
      const conditions = [
        "ts.project_id = $1",
        "ts.id = $2",
        "v.id = $3",
        "ts.status = 'available'",
        "v.status = 'published'",
      ];
      const add = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      const search = request.query.search?.trim();
      if (search) {
        const parameter = add(search);
        conditions.push(
          `LOWER(CONCAT_WS(' ', cr.input ->> 'question', cr.expected_output ->> 'text',
             da.file_name, cr.metadata::text)) LIKE '%' || LOWER(${parameter}) || '%'`,
        );
      }
      if (sourceAssetIds.length)
        conditions.push(
          `(cr.origin_ref ->> 'assetId') = ANY(${add(sourceAssetIds)}::text[])`,
        );
      if (question === "present")
        conditions.push("COALESCE(cr.input ->> 'question', '') <> ''");
      if (question === "missing")
        conditions.push("COALESCE(cr.input ->> 'question', '') = ''");
      if (origin === "source")
        conditions.push("cr.origin_kind = 'source_record'");
      if (origin === "manual")
        conditions.push("cr.origin_kind <> 'source_record'");
      const metadataField = request.query.metadataField?.trim();
      const metadata = request.query.metadata?.trim();
      if (metadata) {
        const fieldParameter = add(metadataField || null);
        const valueParameter = add(metadata);
        conditions.push(`(
          (jsonb_typeof(cr.metadata -> 'entries') = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(cr.metadata -> 'entries') AS entry
             WHERE (${fieldParameter}::text IS NULL OR LOWER(entry ->> 'key') = LOWER(${fieldParameter}))
               AND LOWER(entry ->> 'value') LIKE '%' || LOWER(${valueParameter}) || '%'
          ))
          OR
          (jsonb_typeof(cr.metadata -> 'entries') IS DISTINCT FROM 'array'
            AND (${fieldParameter}::text IS NULL OR LOWER(${fieldParameter}) = 'metadata')
            AND LOWER(COALESCE(
              cr.metadata ->> 'text',
              CASE WHEN jsonb_typeof(cr.metadata) = 'string' THEN cr.metadata #>> '{}' ELSE '' END
            )) LIKE '%' || LOWER(${valueParameter}) || '%')
        )`);
      }
      const where = conditions.slice(5).join(" AND ") || "true";
      const pageLimit = add(limit),
        pageOffset = add(offset);
      const page = await db.query(
        `WITH visible_version AS MATERIALIZED (
          SELECT v.id,ts.project_id FROM test_set ts JOIN test_set_version v ON v.test_set_id=ts.id
          WHERE ts.project_id=$1 AND ts.id=$2 AND v.id=$3 AND ts.status='available' AND v.status='published'
        ), members AS MATERIALIZED (
          SELECT vm.ordinal,vm.case_revision_id
          FROM visible_version v CROSS JOIN LATERAL resolve_version_members(v.id) vm
        ), filtered AS MATERIALIZED (
          SELECT vm.ordinal,vm.case_revision_id FROM members vm
          JOIN case_revision cr ON cr.id=vm.case_revision_id
          LEFT JOIN data_asset da ON da.id=cr.origin_ref->>'assetId' AND da.project_id=$1
          WHERE ${where}
        )
        SELECT EXISTS(SELECT 1 FROM visible_version) AS visible,
          (SELECT count(*)::integer FROM filtered) AS total,
          coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.ordinal) FROM
            (SELECT vm.ordinal,cr.input,cr.expected_output,cr.metadata,cr.origin_kind,cr.origin_ref,da.file_name
             FROM (SELECT * FROM filtered ORDER BY ordinal LIMIT ${pageLimit} OFFSET ${pageOffset}) vm
             JOIN case_revision cr ON cr.id=vm.case_revision_id
             LEFT JOIN data_asset da ON da.id=cr.origin_ref->>'assetId' AND da.project_id=$1) p),'[]'::jsonb) AS records,
          coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.name) FROM
            (SELECT DISTINCT cr.origin_ref->>'assetId' AS id,da.file_name AS name FROM members vm
             JOIN case_revision cr ON cr.id=vm.case_revision_id
             JOIN data_asset da ON da.id=cr.origin_ref->>'assetId' AND da.project_id=$1
             WHERE cr.origin_kind='source_record' AND da.file_name IS NOT NULL) f),'[]'::jsonb) AS source_files,
          coalesce((SELECT jsonb_agg(key ORDER BY key) FROM (
            SELECT DISTINCT entry->>'key' AS key FROM members vm
            JOIN case_revision cr ON cr.id=vm.case_revision_id
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(cr.metadata->'entries')='array'
              THEN cr.metadata->'entries' ELSE '[{"key":"Metadata"}]'::jsonb END) entry
          ) fields WHERE key IS NOT NULL AND key<>''),'[]'::jsonb) AS metadata_fields`,
        values,
      );
      const summary = page.rows[0];
      if (!summary.visible)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const result = {
        rows: summary.records as Array<Record<string, unknown>>,
      };
      const total = summary.total;
      const records = result.rows.map((row) => {
        const record = soloVersionRecord(row);
        return {
          ordinal: record.ordinal,
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata: record.metadata,
          source: record.source
            ? {
                ordinal: record.source.ordinal,
                fileName: String(row.file_name ?? "未记录资料"),
              }
            : null,
        };
      });
      return {
        records,
        pagination: {
          total: Number(total),
          limit,
          offset,
        },
        filterOptions: {
          sourceFiles: (
            summary.source_files as Array<Record<string, unknown>>
          ).map((row) => ({
            id: String(row.id),
            name: String(row.name),
          })),
          metadataFields: summary.metadata_fields as string[],
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      sourceAssetId?: string;
      sourceOrdinal?: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/editing-records",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const limit = Number(request.query.limit ?? 100);
      const offset = Number(request.query.offset ?? 0);
      const sourceAssetId = request.query.sourceAssetId;
      const sourceOrdinal =
        request.query.sourceOrdinal === undefined
          ? undefined
          : Number(request.query.sourceOrdinal);
      if (
        Object.keys(request.query).some(
          (key) =>
            !["limit", "offset", "sourceAssetId", "sourceOrdinal"].includes(
              key,
            ),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (sourceAssetId === undefined) !== (sourceOrdinal === undefined) ||
        (sourceAssetId !== undefined &&
          (typeof sourceAssetId !== "string" ||
            !sourceAssetId ||
            sourceAssetId.length > 200)) ||
        (request.query.sourceOrdinal !== undefined &&
          (typeof request.query.sourceOrdinal !== "string" ||
            !/^(0|[1-9]\d*)$/.test(request.query.sourceOrdinal) ||
            sourceOrdinal === undefined ||
            !Number.isSafeInteger(sourceOrdinal) ||
            sourceOrdinal > 2_147_483_647))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const result = await db.query(
        `SELECT vm.ordinal, vm.case_revision_id, cr.case_id, cr.input, cr.expected_output,
                cr.metadata, cr.origin_kind, cr.origin_ref, COUNT(*) OVER () AS total
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
            AND ts.status = 'available' AND v.status = 'published'
            AND ($6::text IS NULL OR (cr.origin_kind = 'source_record'
              AND cr.origin_ref ->> 'assetId' = $6
              AND cr.source_record_ordinal = $7))
          ORDER BY vm.ordinal LIMIT $4 OFFSET $5`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          limit,
          offset,
          sourceAssetId ?? null,
          sourceOrdinal ?? null,
        ],
      );
      if (!result.rowCount && offset === 0) {
        const version = await db.query(
          `SELECT 1 FROM test_set ts JOIN test_set_version v ON v.test_set_id = ts.id
            WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
              AND ts.status = 'available' AND v.status = 'published'`,
          [
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
          ],
        );
        if (!version.rowCount)
          return reply.code(404).send({ error: { code: "version_not_found" } });
      }
      return {
        records: result.rows.map((row) => {
          const record = soloVersionRecord(row);
          return {
            ordinal: record.ordinal,
            parentOrdinal: record.ordinal,
            caseId: String(row.case_id),
            revisionId: String(row.case_revision_id),
            question: record.question,
            expectedOutput: record.expectedOutput,
            metadata: record.metadata,
            source: record.source
              ? {
                  assetId: record.source.assetId,
                  ordinal: record.source.ordinal,
                }
              : null,
          };
        }),
        pagination: {
          total: Number(result.rows[0]?.total ?? 0),
          limit,
          offset,
        },
      };
    },
  );

  app.get<{
    Params: {
      projectId: string;
      testSetId: string;
      versionId: string;
      ordinal: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/records/:ordinal",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const ordinal = Number(request.params.ordinal);
      if (!Number.isInteger(ordinal) || ordinal < 1)
        return reply
          .code(422)
          .send({ error: { code: "record_ordinal_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const result = await db.query(
        `SELECT vm.ordinal, cr.input, cr.expected_output, cr.metadata, cr.origin_kind,
                cr.origin_ref, da.file_name
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
           JOIN LATERAL resolve_version_members(v.id) vm ON true
           JOIN case_revision cr ON cr.id = vm.case_revision_id
           LEFT JOIN data_asset da
             ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3 AND vm.ordinal = $4
            AND ts.status = 'available' AND v.status = 'published'`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
          ordinal,
        ],
      );
      if (!result.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "version_record_not_found" } });
      const record = soloVersionRecord(result.rows[0]);
      return {
        record: {
          ordinal: record.ordinal,
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata: record.metadata,
          source: record.source
            ? {
                ordinal: record.source.ordinal,
                fileName: String(result.rows[0].file_name ?? "未记录资料"),
              }
            : null,
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { name?: string; limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/solo-test-sets",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some(
          (key) => !["name", "limit", "offset"].includes(key),
        ) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.name !== undefined &&
          (request.query.name.trim().length < 1 ||
            request.query.name.length > 200))
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const name = request.query.name?.trim();
      const result = await db.query(
        `SELECT ts.id, ts.name, v.id AS version_id, v.version_label, v.item_count, v.published_at,
                coalesce(
                  array_to_string(
                    array_agg(DISTINCT coalesce(da.file_name, '已删除资料')
                      ORDER BY coalesce(da.file_name, '已删除资料'))
                      FILTER (WHERE cr.origin_kind = 'source_record'),
                    '、'
                  ),
                  '手工新增'
                ) AS source
           FROM test_set ts
           JOIN LATERAL (
             SELECT * FROM test_set_version
              WHERE test_set_id = ts.id AND status = 'published'
              ORDER BY publication_order DESC, id DESC
              LIMIT 1
           ) v ON true
           LEFT JOIN LATERAL resolve_version_members(v.id) vm ON true
           LEFT JOIN case_revision cr ON cr.id = vm.case_revision_id
           LEFT JOIN data_asset da
             ON da.id = cr.origin_ref ->> 'assetId' AND da.project_id = ts.project_id
          WHERE ts.project_id = $1
            AND ts.status = 'available'
            AND ($2::text IS NULL OR ts.name ILIKE '%' || $2 || '%')
          GROUP BY ts.id, ts.name, v.id, v.version_label, v.item_count, v.published_at
          ORDER BY v.published_at DESC, ts.id DESC
          LIMIT $3 OFFSET $4`,
        [request.params.projectId, name ?? null, limit, offset],
      );
      const total = await db.query(
        `SELECT count(*)::integer AS total
           FROM test_set
          WHERE project_id = $1 AND status = 'available'
            AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')`,
        [request.params.projectId, name ?? null],
      );
      return {
        testSets: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          currentVersionId: row.version_id,
          currentVersion: row.version_label,
          recordCount: Number(row.item_count),
          source: row.source,
          status: "已发布",
          updatedAt: new Date(row.published_at).toISOString(),
        })),
        pagination: { total: Number(total.rows[0]?.total ?? 0), limit, offset },
      };
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const version = await db.query(
        `SELECT ts.id AS test_set_id, ts.name, ts.purpose, v.id AS version_id,
                v.version_label, v.item_count, v.parent_version_id, v.published_at,
                v.publication_order, v.generation, v.branch_number
           FROM test_set ts
           JOIN test_set_version v ON v.test_set_id = ts.id
          WHERE ts.project_id = $1 AND ts.id = $2 AND v.id = $3
            AND ts.status = 'available' AND v.status = 'published'`,
        [
          request.params.projectId,
          request.params.testSetId,
          request.params.versionId,
        ],
      );
      if (!version.rowCount)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const provenance = await soloVersionChanges(
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      );
      if (!provenance)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const changes = { modified: 0, added: 0, removed: 0 };
      for (const change of provenance.changes) {
        if (change.changeType === "modified") changes.modified += 1;
        else if (change.changeType === "added") changes.added += 1;
        else if (change.changeType === "removed") changes.removed += 1;
      }
      const graph = await db.query(
        `SELECT id, parent_version_id, version_label, item_count, published_at,
                tombstoned_at, publication_order, generation, branch_number, status
           FROM test_set_version
          WHERE test_set_id = $1 AND status IN ('published', 'tombstoned')
          ORDER BY publication_order, id`,
        [request.params.testSetId],
      );
      const current = version.rows[0];
      return {
        testSet: {
          id: current.test_set_id,
          name: current.name,
          purpose: current.purpose,
        },
        version: {
          id: current.version_id,
          label: current.version_label,
          recordCount: Number(current.item_count),
          parentVersionId: current.parent_version_id,
          createdAt: new Date(current.published_at).toISOString(),
        },
        versionSummary: {
          sourceFiles: [
            ...new Set(
              provenance.current.flatMap((record) =>
                record.source?.fileName ? [record.source.fileName] : [],
              ),
            ),
          ],
          manualRecordCount: provenance.current.filter(
            (record) => !record.source,
          ).length,
          changes,
        },
        dataCheck: dataCheck(provenance.current),
        graph: {
          nodes: graph.rows.map((row) => ({
            id: row.id,
            label: row.version_label,
            parentVersionId: row.parent_version_id,
            recordCount: Number(row.item_count),
            publicationOrder: Number(row.publication_order),
            generation: Number(row.generation),
            branchNumber:
              row.branch_number === null ? null : Number(row.branch_number),
            createdAt: new Date(row.published_at).toISOString(),
            tombstoned: row.status === "tombstoned",
            tombstonedAt:
              row.tombstoned_at === null
                ? undefined
                : new Date(row.tombstoned_at).toISOString(),
          })),
        },
      };
    },
  );

  app.get<{
    Params: { projectId: string; testSetId: string; versionId: string };
    Querystring: {
      status?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/provenance",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const allowed = new Set(["status", "search", "limit", "offset"]);
      const status = request.query.status ?? "changed";
      const limit = Number(request.query.limit ?? 10);
      const offset = Number(request.query.offset ?? 0);
      if (
        Object.keys(request.query).some((key) => !allowed.has(key)) ||
        ![
          "changed",
          "all",
          "unchanged",
          "modified",
          "added",
          "removed",
        ].includes(status) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        (request.query.search !== undefined &&
          request.query.search.length > 200)
      )
        return reply
          .code(422)
          .send({ error: { code: "query_parameter_invalid" } });
      const result = await soloVersionChanges(
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      );
      if (!result)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const search = request.query.search?.trim().toLowerCase();
      const matching = result.changes.filter((change) => {
        if (status === "changed" && change.changeType === "unchanged")
          return false;
        if (
          status !== "all" &&
          status !== "changed" &&
          change.changeType !== status
        )
          return false;
        if (!search) return true;
        return [
          change.changeType,
          change.current?.question,
          change.current?.expectedOutput,
          change.current ? metadataText(change.current.metadata) : undefined,
          change.previous?.question,
          change.previous?.expectedOutput,
          change.previous ? metadataText(change.previous.metadata) : undefined,
          change.source?.fileName,
          String(change.source?.ordinal ?? ""),
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase()
          .includes(search);
      });
      const counts = Object.fromEntries(
        ["unchanged", "modified", "added", "removed"].map((changeType) => [
          changeType,
          result.changes.filter((change) => change.changeType === changeType)
            .length,
        ]),
      );
      return {
        summary: {
          parentVersion: result.version.parent_version_id
            ? {
                id: result.version.parent_version_id,
                label: result.parentLabel,
              }
            : null,
          currentVersion: {
            id: result.version.id,
            label: result.version.version_label,
            recordCount: Number(result.version.item_count),
            createdAt: new Date(result.version.published_at).toISOString(),
          },
          counts,
          addedFiles: result.addedFiles,
          manualAddedCount: result.manualAddedCount,
        },
        changes: matching.slice(offset, offset + limit),
        pagination: { total: matching.length, limit, offset },
      };
    },
  );

  app.get<{
    Params: {
      projectId: string;
      testSetId: string;
      versionId: string;
      changeId: string;
    };
  }>(
    "/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/provenance/:changeId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "test_set_not_found" } });
      const result = await soloVersionChanges(
        request.params.projectId,
        request.params.testSetId,
        request.params.versionId,
      );
      if (!result)
        return reply.code(404).send({ error: { code: "version_not_found" } });
      const change = result.changes.find(
        (item) => item.id === request.params.changeId,
      );
      if (!change)
        return reply.code(404).send({ error: { code: "change_not_found" } });
      return { change };
    },
  );

  for (const [name, rows] of [
    [
      "data.csv",
      (result: Awaited<ReturnType<typeof soloVersionChanges>>) => [
        ["question", "expected_output", "metadata"],
        ...result!.current.map((record) => [
          record.question,
          record.expectedOutput,
          metadataText(record.metadata),
        ]),
      ],
    ],
    [
      "provenance.csv",
      (result: Awaited<ReturnType<typeof soloVersionChanges>>) => [
        [
          "change_type",
          "question",
          "expected_output",
          "metadata",
          "previous_question",
          "previous_expected_output",
          "previous_metadata",
          "source_file",
          "source_record",
        ],
        ...result!.changes.map((change) => [
          change.changeType,
          change.current?.question ?? "",
          change.current?.expectedOutput ?? "",
          change.current ? metadataText(change.current.metadata) : "",
          change.previous?.question ?? "",
          change.previous?.expectedOutput ?? "",
          change.previous ? metadataText(change.previous.metadata) : "",
          change.source?.fileName ?? "手工新增",
          change.source ? String(change.source.ordinal) : "",
        ]),
      ],
    ],
  ] as const) {
    app.get<{
      Params: { projectId: string; testSetId: string; versionId: string };
    }>(
      `/api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/${name}`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = (request as AuthenticatedRequest).actor;
        if (
          !(await hasProjectCapability(
            db,
            request.params.projectId,
            actor.id,
            "read",
          ))
        )
          return reply
            .code(404)
            .send({ error: { code: "test_set_not_found" } });
        const lock = await db.connect();
        try {
          await lock.query("BEGIN");
          await lock.query(
            "SELECT pg_advisory_xact_lock_shared(hashtext($1))",
            [
              `agentbench:controlled-deletion-project:${request.params.projectId}`,
            ],
          );
          await lock.query(
            `SELECT id FROM test_set WHERE id=$1 AND project_id=$2 FOR SHARE`,
            [request.params.testSetId, request.params.projectId],
          );
          const evidence = await soloVersionExportEvidence(
            request.params.projectId,
            request.params.testSetId,
            request.params.versionId,
            lock,
          );
          if (!evidence) {
            await lock.query("COMMIT");
            return reply
              .code(404)
              .send({ error: { code: "version_not_found" } });
          }
          const evidenceFingerprint = evidence.fingerprint;
          await lock.query(
            `DELETE FROM version_export_cache
            WHERE version_id=$1 AND export_type=$2
              AND (serializer_version<>2 OR evidence_fingerprint<>$3)`,
            [request.params.versionId, name, evidenceFingerprint],
          );
          const cached = await lock.query(
            `SELECT document FROM version_export_cache
            WHERE version_id=$1 AND export_type=$2
              AND serializer_version=2 AND evidence_fingerprint=$3`,
            [request.params.versionId, name, evidenceFingerprint],
          );
          let document = cached.rows[0]?.document as string | undefined;
          if (document === undefined) {
            const result = await soloVersionChanges(
              request.params.projectId,
              request.params.testSetId,
              request.params.versionId,
              lock,
            );
            if (!result) {
              await lock.query("COMMIT");
              return reply
                .code(404)
                .send({ error: { code: "version_not_found" } });
            }
            document = csvDocument(rows(result));
            await lock.query(
              `INSERT INTO version_export_cache
             (version_id,export_type,serializer_version,evidence_fingerprint,document)
             SELECT v.id,$2,2,$3,$4 FROM test_set_version v
              JOIN test_set ts ON ts.id=v.test_set_id
              WHERE v.id=$1 AND v.status='published'
                AND ts.status='available' AND ts.project_id=$5
             ON CONFLICT DO NOTHING`,
              [
                request.params.versionId,
                name,
                evidenceFingerprint,
                document,
                request.params.projectId,
              ],
            );
          }
          await lock.query("COMMIT");
          return reply
            .type("text/csv; charset=utf-8")
            .header(
              "content-disposition",
              `attachment; filename="agentbench-${evidence.label}-${name}"`,
            )
            .send(document);
        } catch (error) {
          await lock.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          lock.release();
        }
      },
    );
  }

  return publishInitial;
}
