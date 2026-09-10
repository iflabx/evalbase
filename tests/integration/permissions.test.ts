import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPACITY_LIMITS } from "../../src/capacity.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import {
  canonicalJson,
  createStandardPackage,
  sha256,
  type StandardPackageInput,
} from "../../src/package/contract.js";
import { hashPassword } from "../../src/security/password.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

async function waitFor(
  request: () => Promise<{ json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await request().then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public permission state");
}

type PermissionMutationCommand = readonly [
  "POST" | "PUT" | "DELETE",
  string,
  Record<string, unknown>?,
];

function permissionMutationCommands(
  projectId: string,
  ids: {
    assetId: string;
    viewId: string;
    testSetId: string;
    draftId: string;
    sourceId: string;
    caseId: string;
    candidateId: string;
    jobId: string;
    runId: string;
    versionId: string;
    deliveryId: string;
  },
  transformationManifest: Record<string, unknown> = {},
): PermissionMutationCommand[] {
  const mapping = {
    input: { object: { message: { source: "/question" } } },
    expectedOutput: { source: "/answer" },
    metadata: { object: {} },
  };
  return [
    [
      "PUT",
      `/api/projects/${projectId}/assets/${ids.assetId}/attribution`,
      {
        sourceType: "synthetic",
        sourceName: "Cross-project synthetic fixture",
        responsiblePerson: "Project Owner",
        purpose: "Cross-project permission test",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        sourceAddress: null,
        acquiredAt: null,
        deidentificationConfirmed: false,
      },
    ],
    ["POST", `/api/projects/${projectId}/assets/${ids.assetId}/archive`],
    ["DELETE", `/api/projects/${projectId}/assets/${ids.assetId}`],
    [
      "POST",
      `/api/projects/${projectId}/assets/${ids.assetId}/parse-attempts`,
      {
        config: { encoding: "auto", delimiter: ",", headerRow: 1, quote: '"' },
      },
    ],
    ["POST", `/api/projects/${projectId}/parsed-views/${ids.viewId}/select`],
    [
      "POST",
      `/api/projects/${projectId}/parsed-views/${ids.viewId}/exclusions`,
      { locators: [{ row: 999 }] },
    ],
    [
      "POST",
      `/api/projects/${projectId}/test-sets`,
      {
        name: "Cross-project permission test",
        purpose: "Synthetic cross-project rejection",
        assetId: ids.assetId,
      },
    ],
    [
      "POST",
      `/api/projects/${projectId}/test-sets/${ids.testSetId}/drafts`,
      {},
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/mapping/preview`,
      {},
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/sources`,
      { assetId: ids.assetId },
    ],
    [
      "PUT",
      `/api/projects/${projectId}/drafts/${ids.draftId}/sources/${ids.sourceId}/mapping`,
      {
        leaseToken: "cross-project",
        expectedRevision: 1,
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    ],
    [
      "DELETE",
      `/api/projects/${projectId}/drafts/${ids.draftId}/sources/${ids.sourceId}`,
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/cases`,
      {
        reason: "permission test",
        input: {},
        expectedOutput: "denied",
        metadata: {},
      },
    ],
    [
      "PUT",
      `/api/projects/${projectId}/drafts/${ids.draftId}/cases/${ids.caseId}`,
      {},
    ],
    [
      "DELETE",
      `/api/projects/${projectId}/drafts/${ids.draftId}/cases/${ids.caseId}`,
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/recipe`,
      { steps: [] },
    ],
    ["POST", `/api/projects/${projectId}/drafts/${ids.draftId}/evaluate`, {}],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/lease/renew`,
      { leaseToken: "cross-project", expectedRevision: 1 },
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/lease/takeover`,
      { confirm: true, expectedRevision: 1 },
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/freeze`,
      { leaseToken: "cross-project", expectedRevision: 1 },
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/abandon`,
      { leaseToken: "cross-project", expectedRevision: 1 },
    ],
    [
      "PUT",
      `/api/projects/${projectId}/drafts/${ids.draftId}`,
      {
        leaseToken: "cross-project",
        expectedRevision: 1,
        proposalId: "cross-project",
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: { type: "object" },
          expectedOutput: { type: "string" },
        },
      },
    ],
    [
      "POST",
      `/api/projects/${projectId}/drafts/${ids.draftId}/candidates`,
      { leaseToken: "cross-project", expectedRevision: 1 },
    ],
    [
      "POST",
      `/api/projects/${projectId}/candidates/${ids.candidateId}/publish`,
    ],
    ["POST", `/api/projects/${projectId}/jobs/${ids.jobId}/cancel`],
    ["POST", `/api/projects/${projectId}/jobs/${ids.jobId}/retry`],
    [
      "POST",
      `/api/projects/${projectId}/transformation-runs`,
      transformationManifest,
    ],
    [
      "POST",
      `/api/projects/${projectId}/transformation-runs/${ids.runId}/complete`,
      transformationManifest,
    ],
    [
      "POST",
      `/api/projects/${projectId}/transformation-runs/${ids.runId}/annotations`,
      { note: "permission test" },
    ],
    [
      "POST",
      `/api/projects/${projectId}/test-sets/${ids.testSetId}/versions/${ids.versionId}/default`,
      {
        reason: "permission test",
        expectedDefaultVersionId: null,
        correlationId: randomUUID(),
      },
    ],
    [
      "POST",
      `/api/projects/${projectId}/test-sets/${ids.testSetId}/versions/${ids.versionId}/archive`,
      {
        reason: "permission test",
        expectedDefaultVersionId: null,
        correlationId: randomUUID(),
      },
    ],
    [
      "POST",
      `/api/projects/${projectId}/versions/${ids.versionId}/langfuse-csv`,
    ],
    [
      "POST",
      `/api/projects/${projectId}/deliveries/${ids.deliveryId}/imported`,
    ],
  ];
}

describe("Ticket 12 permissions and project isolation", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let owner: { cookie: string; csrf: string };
  let editor: { cookie: string; csrf: string };
  let viewer: { cookie: string; csrf: string };
  let editorId: string;
  let viewerId: string;
  let editorUsername: string;
  let viewerUsername: string;
  let unlinkedUsername: string;
  let unlinkedUserId: string;
  let permissionDraftId: string;
  let permissionTestSetId: string;
  let isolatedProjectId: string;
  let sourceAssetId: string;
  let sourceViewId: string;
  let sourceCandidateId: string;
  let sourceVersionId: string;
  let sourceCaseId: string;
  let sourceRevisionId: string;
  let sourceRunId: string;
  let sourceDeliveryId: string;
  let sourceJobId: string;
  let crossProjectJobId: string;
  let crossCancelJobIds: string[];
  let permissionSchemaId: string;
  let permissionSourceId: string;
  let worker: ChildProcess;
  let artifacts: ArtifactRepository;
  let permissionAssetBytes: Buffer;
  let permissionAssetHash: string;
  let permissionAssetObjectRef: string;
  let standardPackageObjectRef: string;
  let editorAssetId: string;
  let editorParsedViewId: string;
  let editorTestSetId: string;
  let editorDraftId: string;
  let editorCandidateId: string;
  let editorVersionId: string;
  let editorJobIds: string[];
  let bootstrapEditorMembershipAuditBaseline: string[] | null = null;

  async function loginSession(username: string, password: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: `${response.cookies[0]?.name}=${response.cookies[0]?.value}`,
      csrf: response.json<{ csrfToken: string }>().csrfToken,
    };
  }

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    editorId = `user_editor_${randomUUID().replaceAll("-", "")}`;
    viewerId = `user_viewer_${randomUUID().replaceAll("-", "")}`;
    unlinkedUserId = `user_unlinked_${randomUUID().replaceAll("-", "")}`;
    unlinkedUsername = `unlinked_${randomUUID().slice(0, 8)}`;
    permissionDraftId = `draft_perm_${randomUUID().replaceAll("-", "")}`;
    permissionTestSetId = `testset_perm_${randomUUID().replaceAll("-", "")}`;
    isolatedProjectId = `project_iso_${randomUUID().replaceAll("-", "")}`;
    sourceAssetId = `asset_perm_${randomUUID().replaceAll("-", "")}`;
    sourceViewId = `view_perm_${randomUUID().replaceAll("-", "")}`;
    sourceCandidateId = `candidate_perm_${randomUUID().replaceAll("-", "")}`;
    sourceVersionId = `version_perm_${randomUUID().replaceAll("-", "")}`;
    sourceCaseId = `case_perm_${randomUUID().replaceAll("-", "")}`;
    sourceRevisionId = `revision_perm_${randomUUID().replaceAll("-", "")}`;
    sourceRunId = `run_perm_${randomUUID().replaceAll("-", "")}`;
    sourceDeliveryId = `delivery_perm_${randomUUID().replaceAll("-", "")}`;
    sourceJobId = `job_perm_${randomUUID().replaceAll("-", "")}`;
    crossProjectJobId = `job_cross_${randomUUID().replaceAll("-", "")}`;
    crossCancelJobIds = [];
    permissionSchemaId = `schema_perm_${randomUUID().replaceAll("-", "")}`;
    permissionSourceId = `draftsrc_perm_${randomUUID().replaceAll("-", "")}`;
    permissionAssetBytes = Buffer.from(
      [
        "question,answer,category",
        "Editor synthetic question,Editor synthetic answer,billing",
      ].join("\n"),
    );
    permissionAssetHash = sha256(permissionAssetBytes);
    permissionAssetObjectRef = (
      await artifacts.storeImmutable(
        permissionAssetBytes,
        `ticket12-permission-${randomUUID()}`,
      )
    ).objectRef;
    const editorName = `editor_${randomUUID().slice(0, 8)}`;
    const viewerName = `viewer_${randomUUID().slice(0, 8)}`;
    editorUsername = editorName;
    viewerUsername = viewerName;
    await db.query(
      `INSERT INTO app_user (id, username, password_hash, role)
       VALUES ($1, $2, $3, 'editor'), ($4, $5, $6, 'viewer'),
              ($7, $8, $9, 'viewer')`,
      [
        editorId,
        editorName,
        await hashPassword("editor-test-password"),
        viewerId,
        viewerName,
        await hashPassword("viewer-test-password"),
        unlinkedUserId,
        unlinkedUsername,
        await hashPassword("unlinked-test-password"),
      ],
    );
    await db.query(
      `INSERT INTO project_member (project_id, user_id, role)
       VALUES ('project_demo', $1, 'editor'), ('project_demo', $2, 'viewer')`,
      [editorId, viewerId],
    );
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Ticket 12 permission fixture',
               'Synthetic permission boundary', 'user_owner')`,
      [permissionTestSetId],
    );
    await db.query(
      `INSERT INTO working_draft (id, test_set_id, status, recipe, updated_by)
       VALUES ($1, $2, 'editing', '{"steps":[]}'::jsonb, 'user_owner')`,
      [permissionDraftId, permissionTestSetId],
    );
    await db.query(
      `INSERT INTO project (id, name, owner_id)
       VALUES ($1, 'Ticket 12 isolated project', 'user_owner')`,
      [isolatedProjectId],
    );
    await db.query(
      `INSERT INTO project_member (project_id, user_id, role)
       VALUES ($1, 'user_owner', 'owner')`,
      [isolatedProjectId],
    );
    await db.query(
      `INSERT INTO data_asset
       (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
        file_name, format, status, uploaded_by)
      VALUES ($1, 'project_demo', $2, $3, 1, 'text/csv',
              'permission-fixture.csv', 'csv', 'stored', 'user_owner')`,
      [sourceAssetId, permissionAssetHash, permissionAssetObjectRef],
    );
    await db.query(
      `INSERT INTO parsed_view
       (id, asset_id, format, parser_name, parser_version, parser_config,
        parser_config_hash, status, record_count, success_count,
        failure_count, boundary_trusted, draft_eligible, is_current)
       VALUES ($1, $2, 'csv', 'format-adapter', 'parser-contract-v1',
               '{"encoding":"utf8","delimiter":",","headerRow":1,"quote":"\\""}'::jsonb,
               'permission-fixture', 'ready', 1, 1, 0, true, true, true)`,
      [sourceViewId, sourceAssetId],
    );
    await db.query(
      "UPDATE working_draft SET asset_id=$2, parsed_view_id=$3 WHERE id=$1",
      [permissionDraftId, sourceAssetId, sourceViewId],
    );
    await db.query(
      `INSERT INTO formal_schema_revision
       (id, test_set_id, mode, input_schema, expected_output_schema)
       VALUES ($1, $2, 'gold_required',
               '{"type":"object"}'::jsonb, '{"type":"string"}'::jsonb)`,
      [permissionSchemaId, permissionTestSetId],
    );
    await db.query(
      `INSERT INTO source_record
       (parsed_view_id, ordinal, value, locator, record_hash, parse_status)
       VALUES ($1, 1, $2, $3, $4, 'valid')`,
      [
        sourceViewId,
        JSON.stringify({
          question: "Editor synthetic question",
          answer: "Editor synthetic answer",
          category: "billing",
        }),
        JSON.stringify({ kind: "csv_row", dataRow: 1, physicalLine: 2 }),
        sha256(
          canonicalJson({
            question: "Editor synthetic question",
            answer: "Editor synthetic answer",
            category: "billing",
          }),
        ),
      ],
    );
    await db.query(
      `INSERT INTO draft_source
       (id, draft_id, asset_id, parsed_view_id, position, mapping,
        unmapped_fields, unmapped_confirmed, created_by)
       VALUES ($1, $2, $3, $4, 1, $5, '["/category"]'::jsonb, true,
               'user_owner')`,
      [
        permissionSourceId,
        permissionDraftId,
        sourceAssetId,
        sourceViewId,
        JSON.stringify({
          input: { object: { message: { source: "/question" } } },
          expectedOutput: { source: "/answer" },
          metadata: { object: {} },
        }),
      ],
    );
    await db.query("UPDATE working_draft SET formal_schema_id=$2 WHERE id=$1", [
      permissionDraftId,
      permissionSchemaId,
    ]);
    const packageInput: StandardPackageInput = {
      testSet: {
        id: permissionTestSetId,
        name: "Ticket 12 permission fixture",
      },
      version: {
        id: sourceVersionId,
        number: 1,
        publishedAt: new Date().toISOString(),
      },
      schema: {
        dialect: "https://json-schema.org/draft/2020-12/schema",
        revisionId: permissionSchemaId,
        mode: "gold_required",
        input: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
        expectedOutput: { type: "string" },
      },
      recipe: { steps: [] },
      attribution: { id: "attribution_permission", assetId: sourceAssetId },
      parsedView: {
        id: sourceViewId,
        assetId: sourceAssetId,
        parserName: "format-adapter",
        parserVersion: "parser-contract-v1",
        parserFormat: "csv",
        parserConfig: {
          encoding: "utf8",
          delimiter: ",",
          headerRow: 1,
          quote: '"',
        },
        recordCount: 1,
      },
      items: [
        {
          case_id: sourceCaseId,
          input: { message: "Editor synthetic question" },
          expected_output: "Editor synthetic answer",
          metadata: {},
          source: {
            assetId: sourceAssetId,
            parsedViewId: sourceViewId,
            ordinal: 1,
            locator: { kind: "csv_row", dataRow: 1, physicalLine: 2 },
            recordHash: sha256(
              canonicalJson({
                question: "Editor synthetic question",
                answer: "Editor synthetic answer",
                category: "billing",
              }),
            ),
          },
        },
      ],
    };
    const standardPackage = createStandardPackage(packageInput);
    standardPackageObjectRef = (
      await artifacts.storeImmutable(
        standardPackage.bytes,
        `ticket12-standard-${randomUUID()}`,
      )
    ).objectRef;
    editorJobIds = [];
    await db.query(
      `UPDATE test_set_version
       SET payload_hash=$2, evidence_hash=$3, manifest_hash=$4,
           manifest_object_ref=$5
       WHERE id=$1`,
      [
        sourceVersionId,
        standardPackage.payloadHash,
        standardPackage.evidenceHash,
        standardPackage.versionManifestHash,
        standardPackageObjectRef,
      ],
    );
    await db.query(
      `INSERT INTO candidate_snapshot
       (id, draft_id, status, schema_revision_id, recipe, item_count,
        payload_hash, evidence_hash, validation_report, object_ref,
        evidence_object_ref)
       SELECT $1, $2, 'published_as_version', fs.id, '{"steps":[]}'::jsonb,
              1, $3, $4, '{"valid":true}'::jsonb, $5, $6
       FROM formal_schema_revision fs WHERE fs.test_set_id=$7`,
      [
        sourceCandidateId,
        permissionDraftId,
        "b".repeat(64),
        "c".repeat(64),
        "objects/payload",
        "objects/evidence",
        permissionTestSetId,
      ],
    );
    await db.query(
      `INSERT INTO test_set_version
       (id, test_set_id, sequence, candidate_id, schema_revision_id,
        payload_hash, evidence_hash, manifest_hash, manifest_object_ref,
        item_count, published_by, published_at, status)
       SELECT $1, $2, 1, $3, fs.id, $4, $5, $6, 'objects/manifest', 1,
              'user_owner', now(), 'published'
       FROM formal_schema_revision fs WHERE fs.test_set_id=$7`,
      [
        sourceVersionId,
        permissionTestSetId,
        sourceCandidateId,
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        permissionTestSetId,
      ],
    );
    await db.query(`INSERT INTO test_case (id, test_set_id) VALUES ($1, $2)`, [
      sourceCaseId,
      permissionTestSetId,
    ]);
    await db.query(
      `INSERT INTO case_revision
       (id, case_id, input, expected_output, metadata,
        source_record_ordinal, content_hash, origin_kind, lineage_fingerprint)
       VALUES ($1, $2, '{"message":"synthetic"}'::jsonb,
               '"ok"'::jsonb, '{}'::jsonb, 1, $3, 'source_record', $3)`,
      [sourceRevisionId, sourceCaseId, "e".repeat(64)],
    );
    await db.query(
      `INSERT INTO version_member (version_id, case_revision_id, ordinal)
       VALUES ($1, $2, 1)`,
      [sourceVersionId, sourceRevisionId],
    );
    await db.query(
      `INSERT INTO transformation_run
       (id, project_id, status, operation_type, lineage_level, manifest,
        manifest_hash, validation_report, created_by)
       VALUES ($1, 'project_demo', 'complete', 'import', 'record_level',
               '{"inputs":[]}'::jsonb, $2, '{"valid":true}'::jsonb,
               'user_owner')`,
      [sourceRunId, "f".repeat(64)],
    );
    await db.query(
      `INSERT INTO delivery_record
       (id, version_id, project_id, target_type, package_type,
        package_format_version, object_ref, delivery_hash, status, created_by)
       VALUES ($1, $2, 'project_demo', 'standard_package', 'standard',
               '1.0', $3, $4, 'generated', 'user_owner')`,
      [
        sourceDeliveryId,
        sourceVersionId,
        standardPackageObjectRef,
        standardPackage.deliveryHash,
      ],
    );
    await db.query(
      `INSERT INTO job
       (id, project_id, actor_id, kind, payload, status, stage,
        correlation_id, idempotency_key, max_attempts)
       VALUES ($1, 'project_demo', 'user_owner', 'parse_asset',
               '{"assetId":"synthetic"}'::jsonb, 'succeeded', 'succeeded',
               $1, $2, 1)`,
      [sourceJobId, `permission-${randomUUID()}`],
    );

    owner = await loginSession("owner", "owner-test-password");
    editor = await loginSession(editorName, "editor-test-password");
    viewer = await loginSession(viewerName, "viewer-test-password");
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
  });

  afterAll(async () => {
    if (worker) {
      worker.kill("SIGTERM");
      await new Promise((resolve) => worker.once("exit", resolve));
    }
    if (!db) return;
    await app?.close();
    await db.query("DELETE FROM app_session WHERE user_id = ANY($1::text[])", [
      [editorId, viewerId, unlinkedUserId],
    ]);
    await db.query(
      "DELETE FROM project_member WHERE user_id = ANY($1::text[])",
      [[editorId, viewerId, unlinkedUserId]],
    );
    await db.query("DELETE FROM job WHERE id = $1", [sourceJobId]);
    await db.query("DELETE FROM job WHERE id = $1", [crossProjectJobId]);
    if (crossCancelJobIds.length)
      await db.query("DELETE FROM job WHERE id = ANY($1::text[])", [
        crossCancelJobIds,
      ]);
    if (editorJobIds.length)
      await db.query("DELETE FROM job WHERE id = ANY($1::text[])", [
        editorJobIds,
      ]);
    await db.query(
      `DELETE FROM job j
       USING candidate_snapshot cs
       WHERE j.payload->>'candidateId'=cs.id AND cs.draft_id=$1`,
      [permissionDraftId],
    );
    await db.query("DELETE FROM delivery_record WHERE id = $1", [
      sourceDeliveryId,
    ]);
    await db.query(
      `DELETE FROM delivery_record
       WHERE version_id IN (
         SELECT id FROM test_set_version WHERE test_set_id=$1
       )`,
      [permissionTestSetId],
    );
    await db.query("DELETE FROM version_member WHERE version_id = $1", [
      sourceVersionId,
    ]);
    await db.query(
      "DELETE FROM version_member WHERE version_id IN (SELECT id FROM test_set_version WHERE test_set_id=$1)",
      [permissionTestSetId],
    );
    await db.query("DELETE FROM test_set_version WHERE id = $1", [
      sourceVersionId,
    ]);
    await db.query("DELETE FROM test_set_version WHERE test_set_id = $1", [
      permissionTestSetId,
    ]);
    await db.query("DELETE FROM case_revision WHERE id = $1", [
      sourceRevisionId,
    ]);
    await db.query("DELETE FROM test_case WHERE id = $1", [sourceCaseId]);
    await db.query("DELETE FROM transformation_run WHERE id = $1", [
      sourceRunId,
    ]);
    await db.query("DELETE FROM candidate_snapshot WHERE id = $1", [
      sourceCandidateId,
    ]);
    await db.query("DELETE FROM candidate_snapshot WHERE draft_id = $1", [
      permissionDraftId,
    ]);
    if (editorVersionId) {
      await db.query("DELETE FROM delivery_record WHERE version_id = $1", [
        editorVersionId,
      ]);
      await db.query("DELETE FROM version_member WHERE version_id = $1", [
        editorVersionId,
      ]);
      await db.query("DELETE FROM test_set_version WHERE id = $1", [
        editorVersionId,
      ]);
    }
    if (editorCandidateId)
      await db.query("DELETE FROM candidate_item WHERE candidate_id = $1", [
        editorCandidateId,
      ]);
    if (editorCandidateId)
      await db.query("DELETE FROM candidate_snapshot WHERE id = $1", [
        editorCandidateId,
      ]);
    if (editorDraftId) {
      await db.query(
        `DELETE FROM draft_case_binding
         WHERE source_id IN (SELECT id FROM draft_source WHERE draft_id=$1)`,
        [editorDraftId],
      );
      await db.query("DELETE FROM draft_source WHERE draft_id = $1", [
        editorDraftId,
      ]);
      await db.query("DELETE FROM draft_revision WHERE draft_id = $1", [
        editorDraftId,
      ]);
      await db.query(
        "UPDATE working_draft SET mapping_revision_id=NULL WHERE id=$1",
        [editorDraftId],
      );
      await db.query(
        "UPDATE working_draft SET formal_schema_id=NULL WHERE id=$1",
        [editorDraftId],
      );
      await db.query("DELETE FROM mapping_revision WHERE draft_id = $1", [
        editorDraftId,
      ]);
      if (editorTestSetId)
        await db.query(
          "UPDATE formal_schema_revision SET proposal_id=NULL WHERE test_set_id=$1",
          [editorTestSetId],
        );
      await db.query("DELETE FROM formal_schema_proposal WHERE draft_id = $1", [
        editorDraftId,
      ]);
      await db.query("DELETE FROM working_draft WHERE id = $1", [
        editorDraftId,
      ]);
    }
    if (editorTestSetId) {
      await db.query(
        "UPDATE formal_schema_revision SET proposal_id=NULL WHERE test_set_id=$1",
        [editorTestSetId],
      );
      await db.query(
        "DELETE FROM formal_schema_revision WHERE test_set_id = $1",
        [editorTestSetId],
      );
      await db.query(
        `DELETE FROM case_revision
         WHERE case_id IN (SELECT id FROM test_case WHERE test_set_id=$1)`,
        [editorTestSetId],
      );
      await db.query("DELETE FROM test_case WHERE test_set_id = $1", [
        editorTestSetId,
      ]);
      await db.query("DELETE FROM test_set WHERE id = $1", [editorTestSetId]);
    }
    if (editorParsedViewId)
      await db.query("DELETE FROM source_record WHERE parsed_view_id = $1", [
        editorParsedViewId,
      ]);
    if (editorParsedViewId)
      await db.query("DELETE FROM parsed_view WHERE id = $1", [
        editorParsedViewId,
      ]);
    if (editorAssetId) {
      const object = await db.query(
        "SELECT object_ref FROM data_asset WHERE id=$1",
        [editorAssetId],
      );
      await db.query(
        "DELETE FROM source_attribution_revision WHERE asset_id=$1",
        [editorAssetId],
      );
      await db.query("DELETE FROM upload_idempotency WHERE asset_id=$1", [
        editorAssetId,
      ]);
      await db.query("DELETE FROM data_asset WHERE id = $1", [editorAssetId]);
      if (object.rows[0])
        await artifacts
          .remove(String(object.rows[0].object_ref))
          .catch(() => undefined);
    }
    await db.query(
      "UPDATE working_draft SET formal_schema_id=NULL WHERE id=$1",
      [permissionDraftId],
    );
    await db.query(
      `DELETE FROM draft_case_binding
       WHERE source_id IN (SELECT id FROM draft_source WHERE draft_id=$1)`,
      [permissionDraftId],
    );
    await db.query("DELETE FROM draft_source WHERE draft_id = $1", [
      permissionDraftId,
    ]);
    await db.query(
      "DELETE FROM formal_schema_revision WHERE test_set_id = $1",
      [permissionTestSetId],
    );
    await db.query("DELETE FROM working_draft WHERE id = $1", [
      permissionDraftId,
    ]);
    await db.query("DELETE FROM test_set WHERE id = $1", [permissionTestSetId]);
    await db.query("DELETE FROM source_record WHERE parsed_view_id = $1", [
      sourceViewId,
    ]);
    await db.query("DELETE FROM parsed_view WHERE id = $1", [sourceViewId]);
    await db.query("DELETE FROM data_asset WHERE id = $1", [sourceAssetId]);
    await db.query("DELETE FROM project_member WHERE project_id = $1", [
      isolatedProjectId,
    ]);
    await db.query("DELETE FROM audit_event WHERE project_id = $1", [
      isolatedProjectId,
    ]);
    await db.query("DELETE FROM project WHERE id = $1", [isolatedProjectId]);
    await artifacts.remove(permissionAssetObjectRef).catch(() => undefined);
    await artifacts.remove(standardPackageObjectRef).catch(() => undefined);
    if (bootstrapEditorMembershipAuditBaseline !== null) {
      const currentBootstrapAudits = await db.query(
        `SELECT id::text
         FROM audit_event
         WHERE project_id = 'project_demo'
           AND action = 'project_membership_changed'
           AND object_type = 'project_member'
           AND object_id = 'user_editor'`,
      );
      const baseline = new Set(bootstrapEditorMembershipAuditBaseline);
      const createdAuditIds = currentBootstrapAudits.rows
        .map((row) => String(row.id))
        .filter((id) => !baseline.has(id));
      if (createdAuditIds.length) {
        await db.query(
          `DELETE FROM audit_event
           WHERE project_id = 'project_demo'
             AND action = 'project_membership_changed'
             AND object_type = 'project_member'
             AND object_id = 'user_editor'
             AND id = ANY($1::bigint[])`,
          [createdAuditIds],
        );
      }
    }
    await db.query(
      `DELETE FROM audit_event
       WHERE project_id = 'project_demo'
         AND action = 'project_membership_changed'
         AND object_type = 'project_member'
         AND object_id = $1`,
      [unlinkedUserId],
    );
    await db.query("DELETE FROM job WHERE actor_id = ANY($1::text[])", [
      [editorId, viewerId, unlinkedUserId],
    ]);
    await db.query("DELETE FROM audit_event WHERE actor_id = ANY($1::text[])", [
      [editorId, viewerId, unlinkedUserId],
    ]);
    await db.query("DELETE FROM app_user WHERE id = ANY($1::text[])", [
      [editorId, viewerId, unlinkedUserId],
    ]);
    await db.end();
  });

  it("lets only the Owner list project membership", async () => {
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/members",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({
      error: { code: "authentication_required" },
    });

    const editorResponse = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/members",
      headers: { cookie: editor.cookie },
    });
    expect(editorResponse.statusCode).toBe(404);
    expect(editorResponse.json()).toMatchObject({
      error: { code: "project_not_found" },
    });

    const viewerResponse = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/members",
      headers: { cookie: viewer.cookie },
    });
    const isolatedEditorResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${isolatedProjectId}/members`,
      headers: { cookie: editor.cookie },
    });
    expect(isolatedEditorResponse.statusCode).toBe(404);
    expect(viewerResponse.statusCode).toBe(404);
    expect(viewerResponse.json()).toMatchObject({
      error: { code: "project_not_found" },
    });

    const ownerResponse = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/members",
      headers: { cookie: owner.cookie },
    });
    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.json().members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: editorId, role: "editor" }),
        expect.objectContaining({ userId: viewerId, role: "viewer" }),
        expect.objectContaining({ userId: "user_owner", role: "owner" }),
      ]),
    );
  });

  it("rejects anonymous access to UI data, resources, jobs, and downloads", async () => {
    const requests = [
      ["GET", `/api/projects/project_demo/assets/${sourceAssetId}`],
      ["GET", `/api/projects/project_demo/assets/${sourceAssetId}/records`],
      ["GET", `/api/projects/project_demo/assets/${sourceAssetId}/download`],
      [
        "GET",
        `/api/projects/project_demo/parsed-views/${sourceViewId}/records/1/location`,
      ],
      ["GET", `/api/projects/project_demo/drafts/${permissionDraftId}`],
      ["GET", `/api/projects/project_demo/candidates/${sourceCandidateId}`],
      ["GET", `/api/projects/project_demo/jobs/${sourceJobId}`],
      ["GET", `/api/projects/project_demo/transformation-runs/${sourceRunId}`],
      [
        "GET",
        `/api/projects/project_demo/test-sets/${permissionTestSetId}/versions/${sourceVersionId}/cases/${sourceCaseId}`,
      ],
      ["GET", `/api/projects/project_demo/versions/${sourceVersionId}/package`],
      [
        "GET",
        `/api/projects/project_demo/deliveries/${sourceDeliveryId}/download`,
      ],
      ["POST", "/api/projects/project_demo/assets"],
      [
        "POST",
        `/api/projects/project_demo/versions/${sourceVersionId}/packages`,
      ],
      [
        "POST",
        `/api/projects/project_demo/versions/${sourceVersionId}/langfuse-csv`,
      ],
      [
        "POST",
        `/api/projects/project_demo/deliveries/${sourceDeliveryId}/imported`,
      ],
    ] as const;

    for (const [method, url] of requests) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json(), `${method} ${url}`).toMatchObject({
        error: { code: "authentication_required" },
      });
    }
  });

  it("derives the actor only from the server-side session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: {
        cookie: owner.cookie,
        "x-actor-id": editorId,
        "x-user-id": viewerId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().actor).toMatchObject({
      id: "user_owner",
      username: "owner",
      projectRole: "owner",
    });
  });

  it("rejects every Viewer mutation command family on the server", async () => {
    const commands = permissionMutationCommands("project_demo", {
      assetId: sourceAssetId,
      viewId: sourceViewId,
      testSetId: permissionTestSetId,
      draftId: permissionDraftId,
      sourceId: permissionSourceId,
      caseId: sourceCaseId,
      candidateId: sourceCandidateId,
      jobId: sourceJobId,
      runId: sourceRunId,
      versionId: sourceVersionId,
      deliveryId: sourceDeliveryId,
    });

    for (const [method, url, payload] of commands) {
      const response = await app.inject({
        method,
        url,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: viewer.cookie,
          "x-csrf-token": viewer.csrf,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        payload,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json(), `${method} ${url}`).toMatchObject({
        error: { code: expect.stringMatching(/_not_found$/) },
      });
    }
  });

  it("applies the request-size limit before parsing any mutation body", async () => {
    const streamingMutation = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/members",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "text/csv; charset=utf-8",
      },
      payload: "{}",
    });
    expect(streamingMutation.statusCode).toBe(415);
    expect(streamingMutation.json()).toMatchObject({
      error: { code: "request_content_type_invalid" },
    });

    const oversized = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/members",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "text/csv; charset=utf-8",
      },
      payload: Buffer.alloc(CAPACITY_LIMITS.dataAssetBytes + 1),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "request_too_large" },
    });
  });

  it("lets only the Owner with CSRF add, update, and remove membership", async () => {
    const forgedOrigin = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/members",
      headers: {
        origin: "https://evil.example",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { username: unlinkedUsername, role: "viewer" },
    });
    expect(forgedOrigin.statusCode).toBe(403);
    expect(forgedOrigin.json()).toMatchObject({
      error: { code: "csrf_rejected" },
    });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/members",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "content-type": "application/json",
      },
      payload: { username: unlinkedUsername, role: "viewer" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({
      error: { code: "csrf_rejected" },
    });

    for (const session of [editor, viewer]) {
      const denied = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/members",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        payload: { username: unlinkedUsername, role: "viewer" },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toMatchObject({
        error: { code: "project_not_found" },
      });
    }

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/members",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { username: unlinkedUsername, role: "viewer" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().member).toEqual({
      userId: unlinkedUserId,
      username: unlinkedUsername,
      role: "viewer",
      isProjectOwner: false,
    });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/members/${unlinkedUserId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { role: "editor" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().member).toMatchObject({
      userId: unlinkedUserId,
      role: "editor",
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/project_demo/members/${unlinkedUserId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true });

    const audit = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/members",
      headers: { cookie: owner.cookie },
    });
    expect(audit.statusCode).toBe(200);
    const changes = audit
      .json()
      .changes.filter((change: any) => change.affectedUserId === unlinkedUserId)
      .reverse();
    expect(changes.map((change: any) => change.action)).toEqual([
      "added",
      "role_updated",
      "removed",
    ]);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "user_owner",
          actor: "owner",
          affectedUserId: unlinkedUserId,
          role: "viewer",
          occurredAt: expect.stringMatching(/Z$/),
        }),
        expect.objectContaining({
          actorId: "user_owner",
          actor: "owner",
          affectedUserId: unlinkedUserId,
          role: "editor",
          occurredAt: expect.stringMatching(/Z$/),
        }),
        expect.objectContaining({
          actorId: "user_owner",
          actor: "owner",
          affectedUserId: unlinkedUserId,
          occurredAt: expect.stringMatching(/Z$/),
        }),
      ]),
    );
  });

  it("preserves membership role changes and removals across Web bootstrap", async () => {
    const bootstrapEditorId = "user_editor";
    const existingAudits = await db.query(
      `SELECT id::text
       FROM audit_event
       WHERE project_id = 'project_demo'
         AND action = 'project_membership_changed'
         AND object_type = 'project_member'
         AND object_id = $1`,
      [bootstrapEditorId],
    );
    bootstrapEditorMembershipAuditBaseline = existingAudits.rows.map((row) =>
      String(row.id),
    );
    const updated = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/members/${bootstrapEditorId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { role: "viewer" },
    });
    expect(updated.statusCode).toBe(200);

    const restarted = await buildApp();
    try {
      const afterRestart = await restarted.inject({
        method: "GET",
        url: "/api/projects/project_demo/members",
        headers: { cookie: owner.cookie },
      });
      expect(afterRestart.statusCode).toBe(200);
      expect(afterRestart.json().members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: bootstrapEditorId,
            role: "viewer",
          }),
        ]),
      );

      const removed = await restarted.inject({
        method: "DELETE",
        url: `/api/projects/project_demo/members/${bootstrapEditorId}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
        },
      });
      expect(removed.statusCode).toBe(200);
    } finally {
      await restarted.close();
    }

    const afterRemovalRestart = await buildApp();
    try {
      const members = await afterRemovalRestart.inject({
        method: "GET",
        url: "/api/projects/project_demo/members",
        headers: { cookie: owner.cookie },
      });
      expect(members.statusCode).toBe(200);
      expect(members.json().members).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: bootstrapEditorId }),
        ]),
      );
    } finally {
      await afterRemovalRestart.close();
    }

    const restored = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/members",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { username: "editor", role: "editor" },
    });
    expect(restored.statusCode).toBe(201);
  });

  it("requires CSRF and write capability for curating POST commands", async () => {
    const commands = [
      {
        url: `/api/projects/project_demo/drafts/${permissionDraftId}/mapping/preview`,
        payload: {},
      },
      {
        url: `/api/projects/project_demo/drafts/${permissionDraftId}/evaluate`,
        payload: {},
      },
    ];

    for (const command of commands) {
      const missingCsrf = await app.inject({
        method: "POST",
        url: command.url,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "content-type": "application/json",
        },
        payload: command.payload,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json()).toMatchObject({
        error: { code: "csrf_rejected" },
      });

      const viewerCommand = await app.inject({
        method: "POST",
        url: command.url,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: viewer.cookie,
          "x-csrf-token": viewer.csrf,
          "content-type": "application/json",
        },
        payload: command.payload,
      });
      expect(viewerCommand.statusCode).toBe(404);
      expect(viewerCommand.json()).toMatchObject({
        error: { code: "project_not_found" },
      });
    }
  });

  it("activates stable development-only Editor and Viewer test identities", async () => {
    for (const username of ["editor", "viewer"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: {
          username,
          password: `${username}-test-password`,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().actor).toMatchObject({
        username,
        role: username,
        testIdentity: true,
      });
    }
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(ownerLogin.statusCode).toBe(200);
    expect(ownerLogin.json().actor).toMatchObject({
      role: "owner",
      testIdentity: false,
    });
  });

  it("disables persisted test identities and their sessions when activation is off", async () => {
    const disabledApp = await buildApp({ allowTestIdentity: false });
    try {
      for (const [username, session] of [
        [editorUsername, editor],
        [viewerUsername, viewer],
      ] as const) {
        const login = await disabledApp.inject({
          method: "POST",
          url: "/api/session",
          headers: { origin: "http://127.0.0.1:3000" },
          payload: {
            username,
            password: `${username.split("_")[0]}-test-password`,
          },
        });
        expect(login.statusCode).toBe(401);

        const oldSession = await disabledApp.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: session.cookie },
        });
        expect(oldSession.statusCode).toBe(401);
        const replayedSession = await disabledApp.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: session.cookie },
        });
        expect(replayedSession.statusCode).toBe(401);
      }
    } finally {
      await disabledApp.close();
    }
    editor = await loginSession(editorUsername, "editor-test-password");
    viewer = await loginSession(viewerUsername, "viewer-test-password");
  });

  it("rejects cross-project opaque IDs for every implemented object family", async () => {
    const requests = [
      ["GET", `/api/projects/${isolatedProjectId}/assets/${sourceAssetId}`],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/assets/${sourceAssetId}/records`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/assets/${sourceAssetId}/download`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/parsed-views/${sourceViewId}/records/1/location`,
      ],
      ["GET", `/api/projects/${isolatedProjectId}/drafts/${permissionDraftId}`],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/candidates/${sourceCandidateId}`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/test-sets/${permissionTestSetId}/versions`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/test-sets/${permissionTestSetId}/versions/${sourceVersionId}`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/test-sets/${permissionTestSetId}/versions/${sourceVersionId}/cases/${sourceCaseId}`,
      ],
      ["GET", `/api/projects/${isolatedProjectId}/jobs/${sourceJobId}`],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/lineage/trace?subjectType=case_revision&subjectId=${sourceRevisionId}`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/transformation-runs/${sourceRunId}`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/versions/${sourceVersionId}/deliveries`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/deliveries/${sourceDeliveryId}/preview`,
      ],
      [
        "GET",
        `/api/projects/${isolatedProjectId}/deliveries/${sourceDeliveryId}/download`,
      ],
    ] as const;

    for (const [method, url] of requests) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie: owner.cookie },
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("rejects cross-project mutation IDs without changing the source project", async () => {
    const transformationManifest = {
      schemaVersion: "1.0",
      operationType: "agent_augmentation",
      lineageLevel: "asset_level",
      purpose: "Synthetic cross-project permission fixture",
      tool: { name: "synthetic-tool", version: "1.0.0" },
      model: {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: {},
      },
      prompt: {
        version: "cross-project-permission-v1",
        sha256: sha256("Synthetic cross-project permission prompt"),
        content: "Synthetic cross-project permission prompt",
      },
      parameters: {},
      inputs: [
        {
          objectType: "test_set_version",
          id: sourceVersionId,
          sha256: "d".repeat(64),
          scope: { category: "billing" },
        },
      ],
      outputs: [
        {
          assetId: sourceAssetId,
          sha256: permissionAssetHash,
          recordCount: 1,
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-25T00:00:00.000Z",
      finishedAt: "2026-08-25T00:01:00.000Z",
    };
    const commands = permissionMutationCommands(
      isolatedProjectId,
      {
        assetId: sourceAssetId,
        viewId: sourceViewId,
        testSetId: permissionTestSetId,
        draftId: permissionDraftId,
        sourceId: permissionSourceId,
        caseId: sourceCaseId,
        candidateId: sourceCandidateId,
        jobId: sourceJobId,
        runId: sourceRunId,
        versionId: sourceVersionId,
        deliveryId: sourceDeliveryId,
      },
      transformationManifest,
    );
    commands.push([
      "POST",
      `/api/projects/${isolatedProjectId}/versions/${sourceVersionId}/packages`,
      { packageType: "standard", formatVersion: "1.0" },
    ]);

    const publicState = async () => {
      const requests = [
        ["members", "/api/projects/project_demo/members"],
        [
          "assetRecords",
          `/api/projects/project_demo/assets/${sourceAssetId}/records`,
        ],
        [
          "assetAttributions",
          `/api/projects/project_demo/assets/${sourceAssetId}/attributions`,
        ],
        [
          "assetAudit",
          `/api/projects/project_demo/assets/${sourceAssetId}/audit`,
        ],
        ["draft", `/api/projects/project_demo/drafts/${permissionDraftId}`],
        [
          "draftAudit",
          `/api/projects/project_demo/drafts/${permissionDraftId}/audit`,
        ],
        [
          "candidate",
          `/api/projects/project_demo/candidates/${sourceCandidateId}`,
        ],
        ["job", `/api/projects/project_demo/jobs/${sourceJobId}`],
        [
          "run",
          `/api/projects/project_demo/transformation-runs/${sourceRunId}`,
        ],
        [
          "deliveries",
          `/api/projects/project_demo/versions/${sourceVersionId}/deliveries`,
        ],
        [
          "lineage",
          `/api/projects/project_demo/lineage/trace?subjectType=case_revision&subjectId=${sourceRevisionId}`,
        ],
      ] as const;
      const state: Record<string, unknown> = {};
      for (const [name, url] of requests) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { cookie: owner.cookie },
        });
        state[name] = {
          statusCode: response.statusCode,
          body: response.json(),
        };
      }
      return state;
    };
    const before = await publicState();

    for (const [method, url, payload] of commands) {
      const response = await app.inject({
        method,
        url,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        payload,
      });
      const expectedStatus =
        method === "POST" &&
        (url.endsWith("/test-sets") || url.endsWith("/transformation-runs"))
          ? 422
          : method === "POST" && url.endsWith("/complete")
            ? 409
            : 404;
      expect(response.statusCode, `${method} ${url}`).toBe(expectedStatus);
      if (url.endsWith("/transformation-runs"))
        expect(response.json()).toMatchObject({
          error: { code: "transformation_input_invalid" },
        });
      if (url.endsWith("/complete"))
        expect(response.json()).toMatchObject({
          error: { code: "transformation_run_not_completable" },
        });
    }

    expect(await publicState()).toEqual(before);
    const source = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${sourceAssetId}/records`,
      headers: { cookie: owner.cookie },
    });
    expect(source.statusCode).toBe(200);
    expect(source.json().parsedView).toMatchObject({
      id: sourceViewId,
      status: "ready",
      recordCount: 1,
    });
  });

  it("enforces the server-side Owner/Editor/Viewer command matrix", async () => {
    const viewerUpload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: viewer.cookie,
        "x-csrf-token": viewer.csrf,
        "content-type": "text/csv; charset=utf-8",
        "idempotency-key": `viewer-denied-${randomUUID()}`,
        "x-file-name": "viewer-denied.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Viewer mutation denial",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic permission matrix",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from("question,answer\nviewer,cannot-write\n"),
    });
    expect(viewerUpload.statusCode).toBe(404);
    expect(viewerUpload.json()).toMatchObject({
      error: { code: "project_not_found" },
    });

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editor.cookie,
        "x-csrf-token": editor.csrf,
        "x-actor-id": "user_owner",
        "x-user-id": "user_owner",
        "content-type": "text/csv; charset=utf-8",
        "idempotency-key": `editor-allowed-${randomUUID()}`,
        "x-file-name": "editor-permission.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Editor permission matrix",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic permission matrix",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from(
        "question,answer,category\nEditor question,Editor answer,billing\n",
      ),
    });
    expect(uploaded.statusCode).toBe(201);
    editorAssetId = uploaded.json().asset.id;
    editorJobIds.push(uploaded.json().job.id);
    const preview = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${editorAssetId}/records`,
          headers: { cookie: editor.cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    editorParsedViewId = preview.parsedView.id as string;
    const assetAudit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${editorAssetId}/audit`,
      headers: { cookie: editor.cookie },
    });
    expect(assetAudit.statusCode).toBe(200);
    expect(assetAudit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "asset_upload_completed",
          actor: editorUsername,
        }),
      ]),
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editor.cookie,
        "x-csrf-token": editor.csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 12 Editor matrix ${randomUUID()}`,
        purpose: "Synthetic Editor permission proof",
        assetId: editorAssetId,
      },
    });
    expect(created.statusCode).toBe(201);
    editorTestSetId = created.json().testSet.id;
    editorDraftId = created.json().draft.id;
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
    const recipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${editorDraftId}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editor.cookie,
        "x-csrf-token": editor.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.json().draft.leaseToken,
        expectedRevision: created.json().draft.revision,
        versionDescription: "Editor independent publication",
        steps: [],
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(recipe.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${editorDraftId}/mapping/schema-suggestion`,
      headers: { cookie: editor.cookie },
    });
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${editorDraftId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editor.cookie,
        "x-csrf-token": editor.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: recipe.json().draft.leaseToken,
        expectedRevision: recipe.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);

    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${editorDraftId}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editor.cookie,
        "x-csrf-token": editor.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: recipe.json().draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    editorJobIds.push(materialized.json().job.id);
    editorCandidateId = materialized.json().candidate.id;
    const candidate = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${editorCandidateId}`,
          headers: { cookie: editor.cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate.status).toBe("ready_to_publish");

    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${editorCandidateId}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editor.cookie,
        "x-csrf-token": editor.csrf,
      },
    });
    expect(published.statusCode).toBe(202);
    editorJobIds.push(published.json().job.id);
    const publication = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${published.json().job.id}`,
          headers: { cookie: editor.cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(publication.job.status).toBe("succeeded");
    editorVersionId = publication.job.result.versionId;

    for (const session of [editor, viewer]) {
      const standardRequest = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/versions/${sourceVersionId}/packages`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        payload: { packageType: "standard", formatVersion: "1.0" },
      });
      expect(standardRequest.statusCode).toBe(202);
      const standardJob = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${standardRequest.json().job.id}`,
            headers: { cookie: session.cookie },
          }),
        (body) => ["succeeded", "failed"].includes(body.job?.status),
      );
      expect(standardJob.job.status).toBe("succeeded");
    }

    const viewerRecords = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${sourceAssetId}/records`,
      headers: { cookie: viewer.cookie },
    });
    expect(viewerRecords.statusCode).toBe(200);
    const viewerVersion = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${editorTestSetId}/versions/${editorVersionId}`,
      headers: { cookie: viewer.cookie },
    });
    expect(viewerVersion.statusCode).toBe(200);
    const rawAsset = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${sourceAssetId}/download`,
      headers: { cookie: viewer.cookie },
    });
    expect(rawAsset.statusCode).toBe(200);
    expect(rawAsset.rawPayload.equals(permissionAssetBytes)).toBe(true);
    expect(JSON.stringify(rawAsset.headers)).not.toContain(
      loadConfig().minio.accessKey,
    );
    expect(JSON.stringify(rawAsset.headers)).not.toContain(
      loadConfig().minio.secretKey,
    );

    const fullRequest = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${editorVersionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: viewer.cookie,
        "x-csrf-token": viewer.csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(fullRequest.statusCode).toBe(202);
    editorJobIds.push(fullRequest.json().job.id);
    const fullJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${fullRequest.json().job.id}`,
          headers: { cookie: viewer.cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(fullJob.job.status).toBe("succeeded");
    const fullDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${fullJob.job.result.deliveryId}/download`,
      headers: { cookie: viewer.cookie },
    });
    expect(fullDownload.statusCode).toBe(200);
  });

  it("makes the Worker re-resolve project ownership instead of trusting job payload", async () => {
    await db.query(
      `INSERT INTO job
       (id, project_id, actor_id, kind, payload, status, stage,
        correlation_id, idempotency_key, max_attempts)
       VALUES ($1, $2, 'user_owner', 'parse_asset', $3::jsonb, 'queued',
               'queued', $1, $4, 1)`,
      [
        crossProjectJobId,
        isolatedProjectId,
        JSON.stringify({
          assetId: sourceAssetId,
          parsedViewId: sourceViewId,
        }),
        `worker-cross-${randomUUID()}`,
      ],
    );

    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/jobs/${crossProjectJobId}`,
          headers: { cookie: owner.cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(job.job).toMatchObject({
      id: crossProjectJobId,
      status: "failed",
      errorCode: "job_failed",
    });

    const source = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${sourceAssetId}/records`,
      headers: { cookie: owner.cookie },
    });
    expect(source.statusCode).toBe(200);
    expect(source.json().parsedView).toMatchObject({
      id: sourceViewId,
      status: "ready",
      recordCount: 1,
    });
    expect(source.json().records).toHaveLength(1);
  });

  it("scopes Worker cancellation state changes to the job project", async () => {
    async function poisonCancellationJob(
      kind: "parse_asset" | "materialize_candidate" | "publish_version",
      payload: Record<string, unknown>,
    ) {
      const id = `job_cross_cancel_${randomUUID().replaceAll("-", "")}`;
      crossCancelJobIds.push(id);
      await db.query(
        `INSERT INTO job
         (id, project_id, actor_id, kind, payload, status, stage,
          correlation_id, idempotency_key, max_attempts)
         VALUES ($1, $2, 'user_owner', $3, $4::jsonb, 'cancel_requested',
                 'cancel_requested', $1, $5, 1)`,
        [id, isolatedProjectId, kind, JSON.stringify(payload), randomUUID()],
      );
      return id;
    }

    const parseJobId = await poisonCancellationJob("parse_asset", {
      assetId: sourceAssetId,
      parsedViewId: sourceViewId,
    });
    const parseJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/jobs/${parseJobId}`,
          headers: { cookie: owner.cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(parseJob.job.status).toBe("cancelled");
    const parseView = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${sourceAssetId}/records`,
      headers: { cookie: owner.cookie },
    });
    expect(parseView.json().parsedView).toMatchObject({
      id: sourceViewId,
      status: "ready",
    });

    await db.query(
      "UPDATE candidate_snapshot SET status='materializing' WHERE id=$1",
      [sourceCandidateId],
    );
    await db.query(
      "UPDATE working_draft SET status='materializing' WHERE id=$1",
      [permissionDraftId],
    );
    const materializeJobId = await poisonCancellationJob(
      "materialize_candidate",
      { candidateId: sourceCandidateId },
    );
    const materializeJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/jobs/${materializeJobId}`,
          headers: { cookie: owner.cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(materializeJob.job.status).toBe("cancelled");
    const materializedState = await db.query(
      `SELECT cs.status AS candidate_status, wd.status AS draft_status
       FROM candidate_snapshot cs JOIN working_draft wd ON wd.id=cs.draft_id
       WHERE cs.id=$1`,
      [sourceCandidateId],
    );
    expect(materializedState.rows[0]).toEqual({
      candidate_status: "materializing",
      draft_status: "materializing",
    });

    await db.query(
      "UPDATE candidate_snapshot SET status='publishing' WHERE id=$1",
      [sourceCandidateId],
    );
    const publishJobId = await poisonCancellationJob("publish_version", {
      candidateId: sourceCandidateId,
    });
    const publishJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/${isolatedProjectId}/jobs/${publishJobId}`,
          headers: { cookie: owner.cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(publishJob.job.status).toBe("cancelled");
    const publishedState = await db.query(
      "SELECT status FROM candidate_snapshot WHERE id=$1",
      [sourceCandidateId],
    );
    expect(publishedState.rows[0].status).toBe("publishing");
    await db.query("UPDATE working_draft SET status='editing' WHERE id=$1", [
      permissionDraftId,
    ]);
  });
});
