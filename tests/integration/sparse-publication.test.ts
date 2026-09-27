import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import {
  encodeDeltaManifest,
  publishSparseVersion,
} from "../../src/version/publish-sparse.js";

const schema = `ticket35_${randomUUID().replaceAll("-", "")}`;
const config = loadConfig();
const schemaUrl = new URL(config.databaseUrl);
schemaUrl.searchParams.set("options", `-csearch_path=${schema}`);

describe("Ticket 35 sparse publication", () => {
  const admin = createPool(config.databaseUrl);
  const db = createPool(schemaUrl.toString());
  const artifacts = new ArtifactRepository(config.minio);

  it("encodes the frozen canonical manifest fixture", () => {
    const unsigned = {
      format: "evalbase.test-set-delta-manifest",
      format_version: 1,
      version_id: "v",
      test_set_id: "s",
      parent_version_id: "p",
      publication_order: 2,
      generation: 2,
      branch_number: null,
      version_label: "v2",
      published_at: "2026-09-18T00:00:00.000Z",
      schema_revision_id: "schema",
      item_count: 0,
      payload_hash: "p-hash",
      evidence_hash: "e-hash",
      changes: [
        {
          case_id: "large",
          operation: "delete",
          position: "9223372036854775807",
          before_revision_id: "old",
          before_content_hash: "hash",
          after_revision_id: null,
          after_content_hash: null,
        },
      ],
      new_revisions: [],
    };
    const encoded = encodeDeltaManifest(unsigned);
    expect(encoded.manifestHash).toBe(
      "d9b863bb486d3e220636df3f434b3033856bf45bb0d580a218ebf7d3d2b4f69f",
    );
    expect(encoded.bytes.toString()).toBe(
      '{"branch_number":null,"changes":[{"after_content_hash":null,"after_revision_id":null,"before_content_hash":"hash","before_revision_id":"old","case_id":"large","operation":"delete","position":"9223372036854775807"}],"delta_hash":"18f15082f4206eebfefd38b962cddb933a3e79852619ba9aecdd5fd014a8e35c","evidence_hash":"e-hash","format":"evalbase.test-set-delta-manifest","format_version":1,"generation":2,"item_count":0,"manifest_hash":"d9b863bb486d3e220636df3f434b3033856bf45bb0d580a218ebf7d3d2b4f69f","new_revisions":[],"parent_version_id":"p","payload_hash":"p-hash","publication_order":2,"published_at":"2026-09-18T00:00:00.000Z","schema_revision_id":"schema","test_set_id":"s","version_id":"v","version_label":"v2"}\n',
    );
    expect(JSON.parse(encoded.bytes.toString()).changes[0].position).toBe(
      "9223372036854775807",
    );
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(schemaUrl.toString());
    await artifacts.initialize();
    await db.query(`INSERT INTO app_user (id, username, password_hash, role)
                    VALUES ('owner35', 'owner35', 'test', 'owner')`);
    await db.query(`INSERT INTO project (id, name, owner_id)
                    VALUES ('project35', 'Synthetic sparse publication', 'owner35')`);
    await db.query(`INSERT INTO project_member (project_id, user_id, role)
                    VALUES ('project35', 'owner35', 'owner')`);
    await db.query(`INSERT INTO test_set (id, project_id, name, purpose, owner_id)
                    VALUES ('set35', 'project35', 'Synthetic', 'test', 'owner35')`);
    await db.query(`INSERT INTO formal_schema_revision
                    (id, test_set_id, mode, input_schema, expected_output_schema)
                    VALUES ('schema35', 'set35', 'gold_required', '{}', '{}')`);
    await db.query(`INSERT INTO working_draft (id, test_set_id, status, updated_by)
                    VALUES ('draft35', 'set35', 'published', 'owner35')`);
    await db.query(`INSERT INTO candidate_snapshot
                    (id, draft_id, status, schema_revision_id, item_count)
                    VALUES ('candidate35', 'draft35', 'published_as_version', 'schema35', 3)`);
    await db.query(`INSERT INTO test_set_version
                    (id, test_set_id, sequence, candidate_id, schema_revision_id,
                     payload_hash, evidence_hash, manifest_hash, manifest_object_ref,
                     item_count, published_by, published_at, publication_order,
                     generation, version_label)
                    VALUES ('base35', 'set35', 1, 'candidate35', 'schema35',
                            repeat('a',64), repeat('a',64), repeat('a',64),
                            'synthetic/base35', 3, 'owner35', now(), 1, 1, 'v1')`);
    await db.query(`INSERT INTO test_case (id, test_set_id)
                    VALUES ('case_a35','set35'), ('case_b35','set35'), ('case_c35','set35')`);
    await db.query(`INSERT INTO case_revision
                    (id, case_id, input, expected_output, metadata,
                     source_record_ordinal, content_hash, lineage_fingerprint, origin_kind)
                    VALUES
                    ('rev_a35','case_a35','{"question":"alpha"}',
                     '{"text":"answer"}','{"entries":[]}',0,repeat('a',64),repeat('a',64),'manual'),
                    ('rev_b35','case_b35','{"question":"bravo"}',
                     '{"text":"answer"}','{"entries":[]}',0,repeat('b',64),repeat('b',64),'manual'),
                    ('rev_c35','case_c35','{"question":"charlie"}',
                     '{"text":"answer"}','{"entries":[]}',0,repeat('c',64),repeat('c',64),'manual')`);
    await db.query(`INSERT INTO version_member (version_id, case_revision_id, ordinal)
                    VALUES ('base35','rev_a35',1), ('base35','rev_b35',2),
                           ('base35','rev_c35',3)`);
  });

  afterAll(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("publishes only net changes while preserving a complete logical snapshot", async () => {
    const result = await publishSparseVersion(db, artifacts, {
      projectId: "project35",
      testSetId: "set35",
      parentVersionId: "base35",
      actorId: "owner35",
      idempotencyKey: "first-delta",
      operations: [
        {
          operation: "delete",
          caseId: "case_a35",
          beforeRevisionId: "rev_a35",
        },
        {
          operation: "update",
          caseId: "case_b35",
          beforeRevisionId: "rev_b35",
          after: {
            question: "bravo updated",
            expectedOutput: "answer",
            metadata: [],
          },
        },
        {
          operation: "add",
          after: { question: "delta", expectedOutput: "answer", metadata: [] },
        },
      ],
    });
    const version = await db.query(
      "SELECT storage_format, manifest_object_ref FROM test_set_version WHERE id = $1",
      [result.id],
    );
    expect(version.rows[0].storage_format).toBe("delta_v1");
    const counts = await db.query(
      `SELECT (SELECT count(*) FROM version_change WHERE version_id=$1)::int AS changes,
              (SELECT count(*) FROM version_member WHERE version_id=$1)::int AS members`,
      [result.id],
    );
    expect(counts.rows[0]).toEqual({ changes: 3, members: 0 });
    const resolved = await db.query(
      `SELECT cr.input->>'question' AS question FROM resolve_version_members($1) vm
       JOIN case_revision cr ON cr.id=vm.case_revision_id ORDER BY vm.ordinal`,
      [result.id],
    );
    expect(resolved.rows.map((row) => row.question)).toEqual([
      "bravo updated",
      "charlie",
      "delta",
    ]);
    const manifest = JSON.parse(
      (
        await artifacts.readBytes(
          version.rows[0].manifest_object_ref,
          1_000_000,
        )
      ).toString(),
    );
    expect(manifest.new_revisions).toHaveLength(2);
    expect(
      manifest.new_revisions
        .map((row: { input: { question: string } }) => row.input.question)
        .sort(),
    ).toEqual(["bravo updated", "delta"]);
    expect(
      await artifacts.size(version.rows[0].manifest_object_ref),
    ).toBeGreaterThan(0);
    const marker = `markers/sha256/${version.rows[0].manifest_object_ref.split("/").at(-1)}.json`;
    expect(
      (await artifacts.list(marker)).some((item) => item.key === marker),
    ).toBe(true);
    expect(
      manifest.changes.map((change: { position: string }) => change.position),
    ).toEqual(["1", "2", "4"]);
  });

  it("replays the same key, rejects a changed request, and permits net-zero publication", async () => {
    const request = {
      projectId: "project35",
      testSetId: "set35",
      parentVersionId: "base35",
      actorId: "owner35",
      idempotencyKey: "empty-delta",
      operations: [],
    };
    const first = await publishSparseVersion(db, artifacts, request);
    const replay = await publishSparseVersion(db, artifacts, request);
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      publishSparseVersion(db, artifacts, {
        ...request,
        operations: [
          {
            operation: "delete",
            caseId: "case_a35",
            beforeRevisionId: "rev_a35",
          },
        ],
      }),
    ).rejects.toThrow("idempotency_conflict");
    const rows = await db.query(
      "SELECT count(*)::int AS n FROM version_change WHERE version_id=$1",
      [first.id],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("validates parent identity and source before allocating a visible version", async () => {
    const baseline = await db.query(
      "SELECT count(*)::int AS n FROM test_set_version",
    );
    const common = {
      projectId: "project35",
      testSetId: "set35",
      parentVersionId: "base35",
      actorId: "owner35",
    };
    await expect(
      publishSparseVersion(db, artifacts, {
        ...common,
        idempotencyKey: "wrong-parent",
        operations: [
          {
            operation: "delete",
            caseId: "case_a35",
            beforeRevisionId: "rev_b35",
          },
        ],
      }),
    ).rejects.toThrow("parent_record_invalid");
    await expect(
      publishSparseVersion(db, artifacts, {
        ...common,
        idempotencyKey: "missing-source",
        operations: [
          {
            operation: "add",
            after: {
              question: "source",
              expectedOutput: "answer",
              metadata: [],
              source: { assetId: "missing35", ordinal: 1 },
            },
          },
        ],
      }),
    ).rejects.toThrow("source_selection_invalid");
    expect(
      (await db.query("SELECT count(*)::int AS n FROM test_set_version"))
        .rows[0].n,
    ).toBe(baseline.rows[0].n);
  });

  it("keeps exact five-source/100MB references without copying all candidate items", async () => {
    await db.query(`INSERT INTO data_asset
      (id,project_id,blob_sha256,object_ref,size_bytes,mime_type,file_name,format,status,uploaded_by)
      SELECT 'source_asset35_'||i,'project35',repeat('a',64),'synthetic/source-'||i,
        CASE WHEN i<=5 THEN 20000000 ELSE 1 END,'text/csv','source-'||i||'.csv',
        'csv','stored','owner35' FROM generate_series(1,6) i`);
    await db.query(`INSERT INTO parsed_view
      (id,asset_id,format,parser_name,parser_version,parser_config,parser_config_hash,
       status,record_count,is_current)
      SELECT 'source_view35_'||i,'source_asset35_'||i,'csv','test','1','{}',
        'test-'||i,'ready',1,true FROM generate_series(1,6) i`);
    await db.query(`INSERT INTO source_record
      (parsed_view_id,ordinal,value,locator,record_hash,parse_status)
      SELECT 'source_view35_'||i,1,'{}','{}',repeat('b',64),'valid'
      FROM generate_series(1,6) i`);
    const fromAsset = (index: number) => ({
      operation: "add" as const,
      after: {
        question: `source ${index}`,
        expectedOutput: "answer",
        metadata: [],
        source: { assetId: `source_asset35_${index}`, ordinal: 1 },
      },
    });
    const common = {
      projectId: "project35",
      testSetId: "set35",
      parentVersionId: "base35",
      actorId: "owner35",
    };
    const accepted = await publishSparseVersion(db, artifacts, {
      ...common,
      idempotencyKey: "five-100mb",
      operations: [1, 2, 3, 4, 5].map(fromAsset),
    });
    const candidate = await db.query(
      `SELECT cs.sources,
      (SELECT count(*)::int FROM candidate_item ci WHERE ci.candidate_id=cs.id) AS items
      FROM test_set_version v JOIN candidate_snapshot cs ON cs.id=v.candidate_id
      WHERE v.id=$1`,
      [accepted.id],
    );
    expect(candidate.rows[0].sources).toHaveLength(5);
    expect(candidate.rows[0].items).toBe(0);
    await expect(
      publishSparseVersion(db, artifacts, {
        ...common,
        idempotencyKey: "six-sources",
        operations: [1, 2, 3, 4, 5, 6].map(fromAsset),
      }),
    ).rejects.toThrow("test_set_capacity_exceeded");
    await db.query(
      "UPDATE data_asset SET size_bytes=20000001 WHERE id='source_asset35_1'",
    );
    await expect(
      publishSparseVersion(db, artifacts, {
        ...common,
        idempotencyKey: "over-100mb",
        operations: [1, 2, 3, 4, 5].map(fromAsset),
      }),
    ).rejects.toThrow("test_set_capacity_exceeded");
  });

  it("serializes same-parent concurrent publications with unique labels", async () => {
    const common = {
      projectId: "project35",
      testSetId: "set35",
      parentVersionId: "base35",
      actorId: "owner35",
      operations: [],
    };
    const [a, b] = await Promise.all([
      publishSparseVersion(db, artifacts, {
        ...common,
        idempotencyKey: "parallel-a",
      }),
      publishSparseVersion(db, artifacts, {
        ...common,
        idempotencyKey: "parallel-b",
      }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(a.label).not.toBe(b.label);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM test_set_version WHERE parent_version_id='base35' AND version_label=$1",
          [a.label],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("rolls back PG publication after the immutable object succeeds, then retries", async () => {
    await db.query(`CREATE FUNCTION ticket35_abort_delta() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.storage_format='delta_v1' THEN RAISE EXCEPTION 'injected_delta_failure'; END IF;
      RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ticket35_abort_delta BEFORE INSERT ON test_set_version
      FOR EACH ROW EXECUTE FUNCTION ticket35_abort_delta()`);
    const request = {
      projectId: "project35",
      testSetId: "set35",
      parentVersionId: "base35",
      actorId: "owner35",
      idempotencyKey: "failed-then-retried",
      operations: [],
    };
    const before = (
      await db.query("SELECT count(*)::int AS n FROM test_set_version")
    ).rows[0].n;
    try {
      await expect(
        publishSparseVersion(db, artifacts, request),
      ).rejects.toThrow("injected_delta_failure");
      expect(
        (await db.query("SELECT count(*)::int AS n FROM test_set_version"))
          .rows[0].n,
      ).toBe(before);
    } finally {
      await db.query("DROP TRIGGER ticket35_abort_delta ON test_set_version");
      await db.query("DROP FUNCTION ticket35_abort_delta()");
    }
    const committed = await publishSparseVersion(db, artifacts, request);
    expect(committed.replayed).toBe(false);
    expect((await publishSparseVersion(db, artifacts, request)).id).toBe(
      committed.id,
    );
  });

  it("stores 100 edits to 10,000 records without copying unchanged bodies", async () => {
    await db.query(`INSERT INTO test_set (id, project_id, name, purpose, owner_id)
      VALUES ('scale35','project35','Scale','test','owner35')`);
    await db.query(`INSERT INTO formal_schema_revision
      (id,test_set_id,mode,input_schema,expected_output_schema)
      VALUES ('scale_schema35','scale35','gold_required','{}','{}')`);
    await db.query(`INSERT INTO working_draft (id,test_set_id,status,updated_by)
      VALUES ('scale_draft35','scale35','published','owner35')`);
    await db.query(`INSERT INTO candidate_snapshot
      (id,draft_id,status,schema_revision_id,item_count)
      VALUES ('scale_candidate35','scale_draft35','published_as_version','scale_schema35',10000)`);
    await db.query(`INSERT INTO test_set_version
      (id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,
       evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,
       published_at,publication_order,generation,version_label)
      VALUES ('scale_base35','scale35',1,'scale_candidate35','scale_schema35',
       repeat('a',64),repeat('a',64),repeat('a',64),'synthetic/scale',10000,
       'owner35',now(),1,1,'v1')`);
    await db.query(`INSERT INTO test_case (id,test_set_id)
      SELECT 'scale_case_'||i,'scale35' FROM generate_series(1,10000) i`);
    await db.query(`INSERT INTO case_revision
      (id,case_id,input,expected_output,metadata,source_record_ordinal,
       content_hash,lineage_fingerprint,origin_kind)
      SELECT 'scale_rev_'||i,'scale_case_'||i,
             jsonb_build_object('question','question '||i),
             '{"text":"answer"}'::jsonb,'{"entries":[]}'::jsonb,0,
             repeat('a',64),repeat('a',64),'manual'
      FROM generate_series(1,10000) i`);
    await db.query(`INSERT INTO version_member (version_id,case_revision_id,ordinal)
      SELECT 'scale_base35','scale_rev_'||i,i FROM generate_series(1,10000) i`);
    const operations = Array.from({ length: 100 }, (_, index) => ({
      operation: "update" as const,
      caseId: `scale_case_${index + 1}`,
      beforeRevisionId: `scale_rev_${index + 1}`,
      after: {
        question: `changed ${index + 1}`,
        expectedOutput: "answer",
        metadata: [],
      },
    }));
    const requestBytes = Buffer.byteLength(JSON.stringify(operations));
    const start = (await db.query("SELECT pg_current_wal_lsn()::text AS lsn"))
      .rows[0].lsn;
    const published = await publishSparseVersion(db, artifacts, {
      projectId: "project35",
      testSetId: "scale35",
      parentVersionId: "scale_base35",
      actorId: "owner35",
      idempotencyKey: "scale-100",
      operations,
    });
    const stats = await db.query(
      `SELECT
      (SELECT count(*)::int FROM version_change WHERE version_id=$1) AS changed,
      (SELECT count(*)::int FROM version_member WHERE version_id=$1) AS copied,
      (SELECT count(*)::int FROM case_revision WHERE id LIKE 'revision_%') AS new_revisions,
      pg_wal_lsn_diff(pg_current_wal_lsn(),$2::pg_lsn)::bigint::text AS wal_bytes,
      v.manifest_object_ref FROM test_set_version v WHERE v.id=$1`,
      [published.id, start],
    );
    expect(stats.rows[0].changed).toBe(100);
    expect(stats.rows[0].copied).toBe(0);
    expect(stats.rows[0].new_revisions).toBeGreaterThanOrEqual(100);
    const objectBytes = await artifacts.size(stats.rows[0].manifest_object_ref);
    expect(objectBytes).toBeLessThan(500_000);
    const resolved = await db.query(
      `SELECT count(*)::int AS count
      FROM resolve_version_members($1)`,
      [published.id],
    );
    expect(resolved.rows[0].count).toBe(10_000);
    console.info(
      JSON.stringify({
        ticket: 35,
        scenario: "100-of-10000",
        requestBytes,
        objectBytes,
        walBytes: Number(stats.rows[0].wal_bytes),
        changedRows: stats.rows[0].changed,
        copiedMembers: stats.rows[0].copied,
      }),
    );
    const singleOperations = [
      {
        operation: "update" as const,
        caseId: "scale_case_101",
        beforeRevisionId: "scale_rev_101",
        after: {
          question: "one changed",
          expectedOutput: "answer",
          metadata: [],
        },
      },
    ];
    const singleStart = (
      await db.query("SELECT pg_current_wal_lsn()::text AS lsn")
    ).rows[0].lsn;
    const single = await publishSparseVersion(db, artifacts, {
      projectId: "project35",
      testSetId: "scale35",
      parentVersionId: published.id,
      actorId: "owner35",
      idempotencyKey: "scale-1",
      operations: singleOperations,
    });
    const singleRows = await db.query(
      `SELECT v.manifest_object_ref,
      (SELECT count(*)::int FROM version_change WHERE version_id=v.id) AS changed,
      (SELECT count(*)::int FROM version_member WHERE version_id=v.id) AS copied
      FROM test_set_version v WHERE id=$1`,
      [single.id],
    );
    expect(singleRows.rows[0].changed).toBe(1);
    expect(singleRows.rows[0].copied).toBe(0);
    const singleWal = (
      await db.query(
        "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::bigint::text AS bytes",
        [singleStart],
      )
    ).rows[0].bytes;
    console.info(
      JSON.stringify({
        ticket: 35,
        scenario: "1-of-10000",
        requestBytes: Buffer.byteLength(JSON.stringify(singleOperations)),
        objectBytes: await artifacts.size(
          singleRows.rows[0].manifest_object_ref,
        ),
        walBytes: Number(singleWal),
        changedRows: 1,
        copiedMembers: 0,
      }),
    );
    await expect(
      publishSparseVersion(db, artifacts, {
        projectId: "project35",
        testSetId: "scale35",
        parentVersionId: single.id,
        actorId: "owner35",
        idempotencyKey: "scale-over-limit",
        operations: [
          {
            operation: "add",
            after: {
              question: "one too many",
              expectedOutput: "answer",
              metadata: [],
            },
          },
        ],
      }),
    ).rejects.toThrow("test_set_capacity_exceeded");
  }, 30_000);
});
