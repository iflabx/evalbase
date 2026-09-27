import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

const schema = `ticket34_${randomUUID().replaceAll("-", "")}`;
const databaseUrl =
  process.env.TICKET34_DATABASE_URL ?? loadConfig().databaseUrl;
const schemaUrl = new URL(databaseUrl);
schemaUrl.searchParams.set("options", `-csearch_path=${schema}`);

describe("Ticket 34 unified version resolution", () => {
  const admin = createPool(databaseUrl);
  const db = createPool(schemaUrl.toString());
  let app!: AgentBenchApp;
  let cookie: string;
  let projectId: string;
  const setId = "set34";
  const hash = "a".repeat(64);

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(schemaUrl.toString());
    app = await buildApp({
      databaseUrl: schemaUrl.toString(),
      soloOwnerMode: true,
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: {},
    });
    expect(session.statusCode).toBe(200);
    cookie = `${session.cookies[0].name}=${session.cookies[0].value}`;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": session.json().csrfToken,
      },
      payload: { name: "Ticket 34 synthetic" },
    });
    expect(project.statusCode).toBe(201);
    projectId = project.json().project.id;
    const owner = await db.query<{ owner_id: string }>(
      "SELECT owner_id FROM project WHERE id = $1",
      [projectId],
    );
    const ownerId = owner.rows[0].owner_id;
    await db.query(
      `INSERT INTO data_asset
         (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
          file_name, format, status, uploaded_by)
       VALUES ('asset34', $1, $2, 'synthetic/source', 12, 'text/csv',
               'synthetic.csv', 'csv', 'stored', $3)`,
      [projectId, hash, ownerId],
    );
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, $2, 'Version resolution', 'synthetic', $3)`,
      [setId, projectId, ownerId],
    );
    await db.query(
      `INSERT INTO formal_schema_revision
         (id, test_set_id, mode, input_schema, expected_output_schema)
       VALUES ('schema34', $1, 'gold_required', '{}'::jsonb, '{}'::jsonb)`,
      [setId],
    );
    await db.query(
      `INSERT INTO working_draft (id, test_set_id, status, updated_by)
       VALUES ('draft34', $1, 'editing', $2)`,
      [setId, ownerId],
    );
    for (const id of ["v1", "v2", "v3", "v4", "branch", "legacy_equiv"]) {
      await db.query(
        `INSERT INTO candidate_snapshot (id, draft_id, status)
         VALUES ($1, 'draft34', 'published_as_version')`,
        [`candidate34_${id}`],
      );
    }
    const versions = [
      ["v1", null, 1, 1, "v1", "legacy_full_v1", 3],
      ["v2", "v1", 2, 2, "v2", "delta_v1", 3],
      ["v3", "v2", 3, 3, "v3", "delta_v1", 3],
      ["v4", "v3", 4, 4, "v4", "delta_v1", 3],
      ["branch", "v1", 5, 2, "v2-b1", "delta_v1", 3],
      ["legacy_equiv", null, 6, 1, "v1-legacy-equivalent", "legacy_full_v1", 3],
    ] as const;
    for (const [
      id,
      parent,
      order,
      generation,
      label,
      format,
      count,
    ] of versions)
      await db.query(
        `INSERT INTO test_set_version
           (id, test_set_id, sequence, candidate_id, schema_revision_id,
            payload_hash, evidence_hash, manifest_hash, manifest_object_ref,
            item_count, published_by, published_at, parent_version_id,
            publication_order, generation, version_label, storage_format)
         VALUES ($1, $2, $3, $4, 'schema34', $5, $5, $5, $6, $7, $8, now(),
                 $9, $3, $10, $11, $12)`,
        [
          id,
          setId,
          order,
          `candidate34_${id}`,
          hash,
          `synthetic/${id}`,
          count,
          ownerId,
          parent,
          generation,
          label,
          format,
        ],
      );
    await db.query(
      `INSERT INTO test_case (id, test_set_id)
       VALUES ('case_a', $1), ('case_b', $1), ('case_c', $1), ('case_d', $1)`,
      [setId],
    );
    for (const [id, caseId, question] of [
      ["rev_a", "case_a", "alpha"],
      ["rev_b", "case_b", "bravo"],
      ["rev_b2", "case_b", "bravo updated"],
      ["rev_c", "case_c", "charlie"],
      ["rev_c2", "case_c", "charlie branch"],
      ["rev_d", "case_d", "delta"],
    ])
      await db.query(
        `INSERT INTO case_revision
           (id, case_id, input, expected_output, metadata,
            source_record_ordinal, content_hash, lineage_fingerprint, origin_kind)
         VALUES ($1, $2, jsonb_build_object('question', $3::text),
                 '{"text":"answer"}'::jsonb,
                 '{"entries":[{"key":"tag","value":"synthetic"}]}'::jsonb,
                 1, $4, $4, 'manual')`,
        [id, caseId, question, hash],
      );
    await db.query(
      `INSERT INTO version_member (version_id, case_revision_id, ordinal)
       VALUES ('v1', 'rev_a', 1), ('v1', 'rev_b', 2), ('v1', 'rev_c', 3),
              ('legacy_equiv', 'rev_b2', 1),
              ('legacy_equiv', 'rev_c', 2),
              ('legacy_equiv', 'rev_d', 3)`,
    );
    await db.query(
      `UPDATE case_revision
          SET origin_kind = 'source_record',
              origin_ref = '{"assetId":"asset34","ordinal":2}'::jsonb
        WHERE id IN ('rev_b', 'rev_b2')`,
    );
    await db.query(
      `INSERT INTO version_change
         (version_id, case_id, operation, position, before_revision_id,
          before_content_hash, after_revision_id, after_content_hash)
       VALUES
         ('v2','case_a','delete',1,'rev_a',$1,NULL,NULL),
         ('v2','case_b','update',2,'rev_b',$1,'rev_b2',$1),
         ('v2','case_d','add',4,NULL,NULL,'rev_d',$1),
         ('branch','case_c','update',3,'rev_c',$1,'rev_c2',$1)`,
      [hash],
    );
    await db.query(
      `INSERT INTO version_checkpoint
         (version_id, reason, retention_class, item_count, members_hash)
       VALUES ('v3', 'periodic', 'rebuildable', 3, $1)`,
      [hash],
    );
    await db.query(
      `INSERT INTO version_checkpoint_member
         (version_id, position, case_id, case_revision_id)
       VALUES ('v3',2,'case_b','rev_b2'), ('v3',3,'case_c','rev_c'),
              ('v3',4,'case_d','rev_d')`,
    );
    await db.query(
      `UPDATE version_checkpoint
          SET members_hash = checkpoint_members_hash('v3')
        WHERE version_id = 'v3'`,
    );
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ('empty34', $1, 'Empty synthetic', 'synthetic', $2)`,
      [projectId, ownerId],
    );
    await db.query(
      `INSERT INTO formal_schema_revision
         (id, test_set_id, mode, input_schema, expected_output_schema)
       VALUES ('empty_schema34', 'empty34', 'input_only', '{}'::jsonb, '{}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO working_draft (id, test_set_id, status, updated_by)
       VALUES ('empty_draft34', 'empty34', 'editing', $1)`,
      [ownerId],
    );
    await db.query(
      `INSERT INTO candidate_snapshot (id, draft_id, status)
       VALUES ('empty_candidate34', 'empty_draft34', 'published_as_version')`,
    );
    await db.query(
      `INSERT INTO test_set_version
         (id, test_set_id, sequence, candidate_id, schema_revision_id,
          payload_hash, evidence_hash, manifest_hash, manifest_object_ref,
          item_count, published_by, published_at, publication_order, generation,
          version_label)
       VALUES ('empty_v1', 'empty34', 1, 'empty_candidate34', 'empty_schema34',
               $1, $1, $1, 'synthetic/empty', 0, $2, now(), 1, 1, 'v1')`,
      [hash, ownerId],
    );
    await db.query(
      `INSERT INTO test_case (id, test_set_id) VALUES ('foreign_case34', 'empty34');
       INSERT INTO case_revision
         (id, case_id, input, expected_output, metadata, source_record_ordinal,
          content_hash, lineage_fingerprint, origin_kind)
       VALUES ('foreign_rev34', 'foreign_case34',
               '{"question":"foreign private content"}'::jsonb, 'null'::jsonb,
               '{}'::jsonb, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'manual')`,
    );
  });

  afterAll(async () => {
    await app?.close();
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const read = (versionId: string, query = "") =>
    app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${setId}/versions/${versionId}/records?limit=10&offset=0${query}`,
      headers: { cookie },
    });

  it("reads legacy, Delta and nearest Checkpoint as ordered logical snapshots", async () => {
    const legacy = await read("v1");
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(
      legacy.json().records.map((row: { question: string }) => row.question),
    ).toEqual(["alpha", "bravo", "charlie"]);
    for (const id of ["v2", "v3", "v4", "legacy_equiv"]) {
      const response = await read(id);
      expect(response.statusCode, response.body).toBe(200);
      expect(
        response
          .json()
          .records.map((row: { question: string }) => row.question),
      ).toEqual(["bravo updated", "charlie", "delta"]);
      expect(response.json().pagination.total).toBe(3);
    }
    const branch = await read("branch");
    expect(
      branch.json().records.map((row: { question: string }) => row.question),
    ).toEqual(["alpha", "bravo", "charlie branch"]);
  });

  it("filters and paginates after replay, preserving source and CSV results", async () => {
    const prefix = `/api/projects/${projectId}/solo-test-sets/${setId}/versions/v2`;
    const get = (suffix: string) =>
      app.inject({ method: "GET", url: prefix + suffix, headers: { cookie } });
    const page = await get("/records?limit=1&offset=1");
    expect(page.statusCode, page.body).toBe(200);
    expect(
      page.json().records.map((row: { question: string }) => row.question),
    ).toEqual(["charlie"]);
    expect(page.json().pagination.total).toBe(3);
    const pastEnd = await get("/records?limit=1&offset=3");
    expect(pastEnd.json().records).toEqual([]);
    expect(pastEnd.json().pagination.total).toBe(3);
    const searched = await get("/records?limit=10&offset=0&search=bravo");
    expect(searched.json().pagination.total).toBe(1);
    expect(searched.json().records[0].source.fileName).toBe("synthetic.csv");
    const metadata = await get(
      "/records?limit=10&offset=0&metadataField=tag&metadata=synthetic",
    );
    expect(metadata.json().pagination.total).toBe(3);
    const detail = await get("/records/1");
    expect(detail.statusCode, detail.body).toBe(200);
    const editing = await get("/editing-records?limit=10&offset=0");
    expect(editing.statusCode, editing.body).toBe(200);
    expect(editing.json().pagination.total).toBe(3);
    const version = await get("");
    expect(version.statusCode, version.body).toBe(200);
    expect(version.json().versionSummary.changes).toEqual({
      modified: 1,
      added: 1,
      removed: 1,
    });
    const dataCsv = await get("/data.csv");
    const provenanceCsv = await get("/provenance.csv");
    expect(dataCsv.statusCode, dataCsv.body).toBe(200);
    expect(provenanceCsv.statusCode, provenanceCsv.body).toBe(200);
    expect(dataCsv.body).toContain("bravo updated");
    expect(dataCsv.body).not.toContain("alpha");
    expect(provenanceCsv.body).toContain("synthetic.csv");
    expect(provenanceCsv.body).toContain("removed");
    const positions = await db.query<{ position: string }>(
      "SELECT position FROM resolve_version_members('v2') ORDER BY ordinal",
    );
    expect(positions.rows.map((row) => row.position)).toEqual(["2", "3", "4"]);
  });

  it("returns the same records, source facts and exports in all three formats", async () => {
    const responses = await Promise.all(
      ["legacy_equiv", "v2", "v3"].map(async (id) => {
        const base = `/api/projects/${projectId}/solo-test-sets/${setId}/versions/${id}`;
        const get = (suffix: string) =>
          app.inject({
            method: "GET",
            url: base + suffix,
            headers: { cookie },
          });
        const [records, dataCsv, provenanceCsv] = await Promise.all([
          get("/records?limit=10&offset=0"),
          get("/data.csv"),
          get("/provenance.csv"),
        ]);
        expect(records.statusCode, records.body).toBe(200);
        expect(dataCsv.statusCode, dataCsv.body).toBe(200);
        expect(provenanceCsv.statusCode, provenanceCsv.body).toBe(200);
        return {
          records: records
            .json()
            .records.map((row: { question: string; source: unknown }) => ({
              question: row.question,
              source: row.source,
            })),
          dataCsv: dataCsv.body,
          provenanceCsv: provenanceCsv.body,
        };
      }),
    );
    for (const response of responses.slice(1)) {
      expect(response.records).toEqual(responses[0].records);
      expect(response.dataCsv).toBe(responses[0].dataCsv);
      expect(response.provenanceCsv).toContain("bravo updated");
      expect(response.provenanceCsv).toContain("synthetic.csv");
    }
    expect(responses[1].provenanceCsv).toContain("modified,bravo updated");
    expect(responses[0].provenanceCsv).toContain("added,bravo updated");
  });

  it("ignores a Checkpoint whose members no longer match its hash", async () => {
    await db.query(
      "UPDATE version_checkpoint_member SET case_revision_id = 'rev_b' WHERE version_id = 'v3' AND case_id = 'case_b'",
    );
    try {
      expect((await read("v3")).json().records[0].question).toBe(
        "bravo updated",
      );
    } finally {
      await db.query(
        "UPDATE version_checkpoint_member SET case_revision_id = 'rev_b2' WHERE version_id = 'v3' AND case_id = 'case_b'",
      );
    }
  });

  it("rejects cross-project and tombstoned public reads", async () => {
    const otherProject = await app.inject({
      method: "GET",
      url: `/api/projects/other-project/solo-test-sets/${setId}/versions/v2/records`,
      headers: { cookie },
    });
    expect(otherProject.statusCode).toBe(404);
    await db.query(
      "UPDATE test_set_version SET status = 'tombstoned' WHERE id = 'v2'",
    );
    try {
      const blocked = await read("v2");
      expect(blocked.statusCode).toBe(404);
      const checkpointDescendant = await read("v3");
      expect(checkpointDescendant.statusCode).toBe(200);
      expect(checkpointDescendant.json().pagination.total).toBe(3);
    } finally {
      await db.query(
        "UPDATE test_set_version SET status = 'published' WHERE id = 'v2'",
      );
    }
  });

  it("keeps empty versions visible in the test-set list", async () => {
    const records = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/empty34/versions/empty_v1/records`,
      headers: { cookie },
    });
    expect(records.statusCode, records.body).toBe(200);
    expect(records.json().pagination.total).toBe(0);
    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets?name=Empty&limit=10&offset=0`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().testSets).toEqual([
      expect.objectContaining({ id: "empty34", recordCount: 0 }),
    ]);
  });

  it("fails closed on a Delta revision from another test set", async () => {
    await db.query(
      `UPDATE version_change SET after_revision_id = 'foreign_rev34'
       WHERE version_id = 'v2' AND case_id = 'case_b'`,
    );
    try {
      await expect(
        db.query("SELECT * FROM resolve_version_members('v2')"),
      ).rejects.toThrow(/version_resolution_cross_test_set_reference/);
    } finally {
      await db.query(
        `UPDATE version_change SET after_revision_id = 'rev_b2'
         WHERE version_id = 'v2' AND case_id = 'case_b'`,
      );
    }
  });

  it("lets consistency scans count damaged and tombstoned snapshots", async () => {
    await db.query(
      "UPDATE test_set_version SET item_count = 4 WHERE id = 'v2'",
    );
    try {
      await expect(
        db.query("SELECT * FROM resolve_version_members('v2')"),
      ).rejects.toThrow(/version_resolution_count_mismatch/);
      const damaged = await db.query<{ actual_count: string }>(
        `SELECT count(vm.case_revision_id)::int AS actual_count
         FROM test_set_version v
         LEFT JOIN LATERAL resolve_version_members_internal(v.id, true, false) vm ON true
         WHERE v.id = 'v2'`,
      );
      expect(Number(damaged.rows[0].actual_count)).toBe(3);
      await db.query(
        "UPDATE test_set_version SET status = 'tombstoned' WHERE id = 'v2'",
      );
      const tombstoned = await db.query<{ actual_count: string }>(
        `SELECT count(vm.case_revision_id)::int AS actual_count
         FROM test_set_version v
         LEFT JOIN LATERAL resolve_version_members_internal(v.id, true, false) vm ON true
         WHERE v.id = 'v2'`,
      );
      expect(Number(tombstoned.rows[0].actual_count)).toBe(3);
    } finally {
      await db.query(
        "UPDATE test_set_version SET item_count = 3, status = 'published' WHERE id = 'v2'",
      );
    }
  });
});
