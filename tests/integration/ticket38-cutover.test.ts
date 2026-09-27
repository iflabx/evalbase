import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { scanConsistency } from "../../src/observability/consistency.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const schema = `ticket38_${randomUUID().replaceAll("-", "")}`;
const config = loadConfig();
const schemaUrl = new URL(config.databaseUrl);
schemaUrl.searchParams.set("options", `-csearch_path=${schema}`);

describe("Ticket 38 public incremental publication", () => {
  const admin = createPool(config.databaseUrl);
  const db = createPool(schemaUrl.toString());
  let app: AgentBenchApp;
  let cookie: string;
  let csrf: string;
  let projectId: string;
  let testSetId: string;
  let rootVersionId: string;
  const artifacts = new ArtifactRepository(config.minio);

  const headers = () => ({
    cookie,
    origin: "http://127.0.0.1:3000",
    "x-csrf-token": csrf,
    "content-type": "application/json",
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(schemaUrl.toString());
    await artifacts.initialize();
    app = await buildApp({
      databaseUrl: schemaUrl.toString(),
      soloOwnerMode: true,
      appOrigin: "http://127.0.0.1:3000",
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(session.statusCode, session.body).toBe(200);
    cookie = `${session.cookies[0]?.name}=${session.cookies[0]?.value}`;
    csrf = session.json().csrfToken;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: headers(),
      payload: { name: `Ticket 38 ${randomUUID()}` },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json().project.id;
  });

  afterAll(async () => {
    await app?.close();
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("creates v1 as delta with an initial checkpoint and paged record identities", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...headers(), "idempotency-key": "ticket38-root" },
      payload: {
        name: "增量切换合成集",
        purpose: "Ticket 38",
        selections: [],
        operations: Array.from({ length: 21 }, (_, index) => ({
          operation: "add",
          after: {
            question: `合成问题 ${index + 1}`,
            expectedOutput: `合成答案 ${index + 1}`,
            metadata: [],
          },
        })),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    testSetId = created.json().testSet.id;
    rootVersionId = created.json().version.id;
    const version = await db.query(
      "SELECT storage_format FROM test_set_version WHERE id=$1",
      [rootVersionId],
    );
    expect(version.rows[0].storage_format).toBe("delta_v1");
    const checkpoint = await db.query(
      "SELECT reason,item_count FROM version_checkpoint WHERE version_id=$1",
      [rootVersionId],
    );
    expect(checkpoint.rows[0]).toMatchObject({
      reason: "initial",
      item_count: 21,
    });
    const page = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/editing-records?limit=10&offset=10`,
      headers: { cookie },
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().pagination).toMatchObject({
      total: 21,
      limit: 10,
      offset: 10,
    });
    expect(page.json().records[0]).toMatchObject({
      question: "合成问题 11",
      caseId: expect.any(String),
      revisionId: expect.any(String),
    });
    const candidate = await db.query(
      "SELECT candidate_id FROM test_set_version WHERE id=$1",
      [rootVersionId],
    );
    const candidateId = String(candidate.rows[0].candidate_id);
    expect(
      (
        await scanConsistency(db, artifacts, {
          objectIds: [candidateId, rootVersionId],
        })
      ).findings,
    ).toEqual([]);
    await db.query(
      "UPDATE test_set_version SET item_count=item_count+1 WHERE id=$1",
      [rootVersionId],
    );
    expect(
      (await scanConsistency(db, artifacts, { objectIds: [rootVersionId] }))
        .findings,
    ).toContainEqual(
      expect.objectContaining({
        object_type: "test_set_version",
        error_code: "manifest_count_mismatch",
      }),
    );
    await db.query(
      "UPDATE test_set_version SET item_count=item_count-1 WHERE id=$1",
      [rootVersionId],
    );
    expect(
      (await scanConsistency(db, artifacts, { objectIds: [rootVersionId] }))
        .findings,
    ).toEqual([]);
    const original = await db.query(
      "SELECT object_ref FROM candidate_snapshot WHERE id=$1",
      [candidateId],
    );
    await db.query(
      "UPDATE candidate_snapshot SET object_ref='immutable/sha256/missing' WHERE id=$1",
      [candidateId],
    );
    expect(
      (await scanConsistency(db, artifacts, { objectIds: [candidateId] }))
        .findings,
    ).toEqual([
      expect.objectContaining({
        object_type: "candidate_snapshot",
        error_code: "object_missing",
      }),
    ]);
    await db.query("UPDATE candidate_snapshot SET object_ref=$2 WHERE id=$1", [
      candidateId,
      original.rows[0].object_ref,
    ]);
    expect(
      (await scanConsistency(db, artifacts, { objectIds: [candidateId] }))
        .findings,
    ).toEqual([]);
  });

  it("publishes only a net update, delete and add through the existing route", async () => {
    const page = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/editing-records?limit=2&offset=0`,
      headers: { cookie },
    });
    const [first, second] = page.json().records;
    const payload = {
      operations: [
        {
          operation: "update",
          caseId: first.caseId,
          beforeRevisionId: first.revisionId,
          after: {
            question: "已修改",
            expectedOutput: first.expectedOutput,
            metadata: [],
          },
        },
        {
          operation: "delete",
          caseId: second.caseId,
          beforeRevisionId: second.revisionId,
        },
        {
          operation: "add",
          after: { question: "新增", expectedOutput: "答案", metadata: [] },
        },
      ],
    };
    const url = `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/derived-versions`;
    const key = "ticket38-derived";
    const published = await app.inject({
      method: "POST",
      url,
      headers: { ...headers(), "idempotency-key": key },
      payload,
    });
    expect(published.statusCode, published.body).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url,
      headers: { ...headers(), "idempotency-key": key },
      payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().version.id).toBe(published.json().version.id);
    const rows = await db.query(
      "SELECT storage_format FROM test_set_version WHERE id=$1",
      [published.json().version.id],
    );
    expect(rows.rows[0].storage_format).toBe("delta_v1");
    const candidateId = await db.query(
      "SELECT candidate_id FROM test_set_version WHERE id=$1",
      [published.json().version.id],
    );
    expect(
      (
        await scanConsistency(db, artifacts, {
          objectIds: [
            String(candidateId.rows[0].candidate_id),
            published.json().version.id,
          ],
        })
      ).findings,
    ).toEqual([]);
    const changes = await db.query(
      "SELECT operation FROM version_change WHERE version_id=$1 ORDER BY position",
      [published.json().version.id],
    );
    expect(changes.rows.map((row) => row.operation)).toEqual([
      "update",
      "delete",
      "add",
    ]);
    const full = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${published.json().version.id}/records?limit=100&offset=0`,
      headers: { cookie },
    });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().pagination.total).toBe(21);
    expect(
      full.json().records.map((row: { question: string }) => row.question),
    ).toEqual([
      "已修改",
      ...Array.from({ length: 19 }, (_, i) => `合成问题 ${i + 3}`),
      "新增",
    ]);
    const late = await db.query(
      `SELECT case_revision_id FROM version_checkpoint_member
       WHERE version_id=$1 ORDER BY position DESC LIMIT 1`,
      [rootVersionId],
    );
    await db.query(
      `UPDATE case_revision SET origin_kind='source_record',
       origin_ref=$2::jsonb, source_record_ordinal=9731 WHERE id=$1`,
      [
        late.rows[0].case_revision_id,
        JSON.stringify({ assetId: "asset_late", ordinal: 9731 }),
      ],
    );
    const lookup = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/editing-records?limit=1&offset=0&sourceAssetId=asset_late&sourceOrdinal=9731`,
      headers: { cookie },
    });
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json().pagination.total).toBe(1);
    expect(lookup.json().records[0]).toMatchObject({
      question: "合成问题 21",
      source: { assetId: "asset_late", ordinal: 9731 },
    });
    const absent = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/editing-records?limit=1&offset=0&sourceAssetId=asset_late&sourceOrdinal=9732`,
      headers: { cookie },
    });
    expect(absent.statusCode, absent.body).toBe(200);
    expect(absent.json().records).toEqual([]);
    const invalid = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/editing-records?sourceAssetId=asset_late`,
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(422);
    const overflow = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${rootVersionId}/editing-records?sourceAssetId=asset_late&sourceOrdinal=2147483648`,
      headers: { cookie },
    });
    expect(overflow.statusCode).toBe(422);
  });

  it("finds a source at the 10,000-record boundary with one filtered read", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: {
        name: "容量边界合成集",
        selections: [],
        operations: Array.from({ length: 10_000 }, (_, index) => ({
          operation: "add",
          after: {
            question: `边界问题 ${index + 1}`,
            expectedOutput: "答案",
            metadata: [],
          },
        })),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const versionId = created.json().version.id as string;
    const setId = created.json().testSet.id as string;
    const candidate = await db.query(
      "SELECT candidate_id FROM test_set_version WHERE id=$1",
      [versionId],
    );
    expect(
      (
        await scanConsistency(db, artifacts, {
          objectIds: [String(candidate.rows[0].candidate_id), versionId],
        })
      ).findings,
    ).toEqual([]);
    const last = await db.query(
      `SELECT case_revision_id FROM version_checkpoint_member
       WHERE version_id=$1 ORDER BY position DESC LIMIT 1`,
      [versionId],
    );
    await db.query(
      `UPDATE case_revision SET origin_kind='source_record',
       origin_ref=$2::jsonb, source_record_ordinal=9999 WHERE id=$1`,
      [
        last.rows[0].case_revision_id,
        JSON.stringify({ assetId: "asset_boundary", ordinal: 9999 }),
      ],
    );
    const lookup = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${setId}/versions/${versionId}/editing-records?limit=1&offset=0&sourceAssetId=asset_boundary&sourceOrdinal=9999`,
      headers: { cookie },
    });
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json().pagination.total).toBe(1);
    expect(lookup.json().records[0].question).toBe("边界问题 10000");
  }, 120_000);

  it("derives from a legacy parent and rejects the retired full-snapshot request", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: {
        name: "旧格式父版本合成集",
        selections: [],
        operations: [
          {
            operation: "add",
            after: {
              question: "旧问题",
              expectedOutput: "旧答案",
              metadata: [],
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const legacySetId = created.json().testSet.id as string;
    const legacyVersionId = created.json().version.id as string;
    // Convert only this isolated synthetic fixture to the relational legacy shape.
    await db.query(
      `INSERT INTO version_member (version_id,case_revision_id,ordinal)
       SELECT version_id,case_revision_id,position::integer
         FROM version_checkpoint_member WHERE version_id=$1`,
      [legacyVersionId],
    );
    await db.query(
      "UPDATE test_set_version SET storage_format='legacy_full_v1' WHERE id=$1",
      [legacyVersionId],
    );
    const edit = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${legacySetId}/versions/${legacyVersionId}/editing-records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const parent = edit.json().records[0] as {
      caseId: string;
      revisionId: string;
    };
    const url = `/api/projects/${projectId}/solo-test-sets/${legacySetId}/versions/${legacyVersionId}/derived-versions`;
    const retired = await app.inject({
      method: "POST",
      url,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: {
        selections: [],
        records: [
          { question: "旧问题", expectedOutput: "旧答案", metadata: [] },
        ],
      },
    });
    expect(retired.statusCode).toBe(422);
    const operation = {
      operations: [
        {
          operation: "update",
          caseId: parent.caseId,
          beforeRevisionId: parent.revisionId,
          after: { question: "新问题", expectedOutput: "新答案", metadata: [] },
        },
      ],
    };
    const published = await app.inject({
      method: "POST",
      url,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: operation,
    });
    expect(published.statusCode, published.body).toBe(201);
    const childId = published.json().version.id as string;
    const formats = await db.query(
      "SELECT id,storage_format FROM test_set_version WHERE id=ANY($1::text[]) ORDER BY id",
      [[legacyVersionId, childId]],
    );
    expect(
      formats.rows.find((row) => row.id === legacyVersionId)?.storage_format,
    ).toBe("legacy_full_v1");
    expect(formats.rows.find((row) => row.id === childId)?.storage_format).toBe(
      "delta_v1",
    );
    const csv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${legacySetId}/versions/${childId}/data.csv`,
      headers: { cookie },
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain("新问题");
    const legacyRead = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${legacySetId}/versions/${legacyVersionId}/records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(legacyRead.statusCode, legacyRead.body).toBe(200);
    expect(legacyRead.json().records[0].question).toBe("旧问题");
  });
});
