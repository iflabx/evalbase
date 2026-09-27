import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { buildApp } from "../../src/server/app.js";

const schema = `ticket33_${randomUUID().replaceAll("-", "")}`;
const databaseUrl =
  process.env.TICKET33_DATABASE_URL ?? loadConfig().databaseUrl;
const schemaUrl = new URL(databaseUrl);
schemaUrl.searchParams.set("options", `-csearch_path=${schema}`);

describe("Ticket 33 incremental storage migration", () => {
  const admin = createPool(databaseUrl);
  const db = createPool(schemaUrl.toString());

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(schemaUrl.toString());
  });

  afterAll(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("initializes the incremental schema on an empty database", async () => {
    const columns = await db.query<{
      column_name: string;
      column_default: string;
    }>(
      `SELECT column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'test_set_version'
          AND column_name = 'storage_format'`,
      [schema],
    );
    expect(columns.rows).toEqual([
      expect.objectContaining({
        column_name: "storage_format",
        column_default: "'legacy_full_v1'::text",
      }),
    ]);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name IN (
            'version_change',
            'version_checkpoint',
            'version_checkpoint_member'
          )
        ORDER BY table_name`,
      [schema],
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "version_change",
      "version_checkpoint",
      "version_checkpoint_member",
    ]);
  });

  it("upgrades legacy branches without changing their version or member facts", async () => {
    await db.query(
      `INSERT INTO app_user (id, username, password_hash, role)
       VALUES ('owner33', 'owner33', 'synthetic', 'owner')`,
    );
    await db.query(
      `INSERT INTO project (id, name, owner_id)
       VALUES ('project33', 'Ticket 33 synthetic', 'owner33')`,
    );
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ('set33', 'project33', 'Synthetic', 'migration', 'owner33'),
              ('other33', 'project33', 'Other', 'migration', 'owner33')`,
    );
    await db.query(
      `INSERT INTO formal_schema_revision
         (id, test_set_id, mode, input_schema, expected_output_schema)
       VALUES ('schema33', 'set33', 'gold_required', '{}'::jsonb, '{}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO working_draft (id, test_set_id, status, updated_by)
       VALUES ('draft33', 'set33', 'editing', 'owner33')`,
    );
    await db.query(
      `INSERT INTO candidate_snapshot (id, draft_id, status)
       VALUES ('candidate33a', 'draft33', 'published_as_version'),
              ('candidate33b', 'draft33', 'published_as_version'),
              ('candidate33c', 'draft33', 'published_as_version')`,
    );
    await db.query(
      `INSERT INTO test_set_version
         (id, test_set_id, sequence, candidate_id, schema_revision_id,
          payload_hash, evidence_hash, manifest_hash, manifest_object_ref,
          item_count, published_by, published_at, parent_version_id,
          publication_order, generation, branch_number, version_label)
       VALUES
         ('v33a', 'set33', 1, 'candidate33a', 'schema33', $1, $2, $3,
          'objects/legacy-v1', 1, 'owner33', now(), NULL, 1, 1, NULL, 'v1'),
         ('v33b', 'set33', 2, 'candidate33b', 'schema33', $2, $3, $1,
          'objects/legacy-v2', 1, 'owner33', now(), 'v33a', 2, 2, NULL, 'v2'),
         ('v33c', 'set33', 3, 'candidate33c', 'schema33', $3, $1, $2,
          'objects/legacy-branch', 1, 'owner33', now(), 'v33a', 3, 2, 1, 'v2-b1')`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    );
    await db.query(
      `INSERT INTO test_case (id, test_set_id)
       VALUES ('case33', 'set33'), ('other_case33', 'other33')`,
    );
    await db.query(
      `INSERT INTO case_revision
         (id, case_id, input, expected_output, metadata,
          source_record_ordinal, content_hash, lineage_fingerprint)
       VALUES
         ('revision33a', 'case33', '{}'::jsonb, '"answer"'::jsonb,
          '"old metadata"'::jsonb, 1, $1, $1),
         ('revision33b', 'case33', '{}'::jsonb, '"answer"'::jsonb,
          '{"source":"structured"}'::jsonb, 1, $2, $2),
         ('other_revision33', 'other_case33', '{}'::jsonb, 'null'::jsonb,
          '{}'::jsonb, 1, $3, $3)`,
      ["d".repeat(64), "e".repeat(64), "f".repeat(64)],
    );
    await db.query(
      `INSERT INTO version_member (version_id, case_revision_id, ordinal)
       VALUES ('v33a', 'revision33a', 1),
              ('v33b', 'revision33b', 1),
              ('v33c', 'revision33a', 1)`,
    );

    const legacyFacts = await db.query(
      `SELECT v.id, v.parent_version_id, v.version_label, v.payload_hash,
              v.evidence_hash, v.manifest_hash, v.manifest_object_ref,
              vm.ordinal, vm.case_revision_id, cr.metadata
         FROM test_set_version v
         JOIN version_member vm ON vm.version_id = v.id
         JOIN case_revision cr ON cr.id = vm.case_revision_id
        ORDER BY v.publication_order`,
    );
    await db.query(
      `DROP TABLE version_checkpoint_member, version_checkpoint, version_change;
       ALTER TABLE test_set_version DROP COLUMN storage_format`,
    );
    await migrate(schemaUrl.toString());
    await migrate(schemaUrl.toString());

    const upgradedFacts = await db.query(
      `SELECT v.id, v.parent_version_id, v.version_label, v.payload_hash,
              v.evidence_hash, v.manifest_hash, v.manifest_object_ref,
              vm.ordinal, vm.case_revision_id, cr.metadata
         FROM test_set_version v
         JOIN version_member vm ON vm.version_id = v.id
         JOIN case_revision cr ON cr.id = vm.case_revision_id
        ORDER BY v.publication_order`,
    );
    expect(upgradedFacts.rows).toEqual(legacyFacts.rows);
    const formats = await db.query<{ storage_format: string }>(
      `SELECT storage_format FROM test_set_version ORDER BY publication_order`,
    );
    expect(formats.rows.map((row) => row.storage_format)).toEqual([
      "legacy_full_v1",
      "legacy_full_v1",
      "legacy_full_v1",
    ]);
  });

  it("rejects invalid formats, operations, hashes, positions and duplicate changes", async () => {
    const hash = "a".repeat(64);
    const insertChange = (
      versionId: string,
      caseId: string,
      operation: string,
      position: string,
      beforeHash: string | null,
      afterRevisionId: string | null,
      afterHash: string | null,
    ) =>
      db.query(
        `INSERT INTO version_change
           (version_id, case_id, operation, position,
            before_content_hash, after_revision_id, after_content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          versionId,
          caseId,
          operation,
          position,
          beforeHash,
          afterRevisionId,
          afterHash,
        ],
      );

    await expect(
      db.query(
        `UPDATE test_set_version SET storage_format = 'unknown' WHERE id = 'v33a'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertChange("v33c", "case33", "move", "1", null, "revision33a", hash),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertChange("v33c", "case33", "add", "1", null, "revision33a", null),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertChange("v33c", "case33", "update", "1", null, "revision33b", hash),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertChange("v33c", "case33", "delete", "1", null, null, null),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertChange("v33c", "case33", "add", "0", null, "revision33a", hash),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertChange("v33c", "case33", "add", "1", null, "missing", hash),
    ).rejects.toMatchObject({ code: "23503" });

    await insertChange("v33b", "case33", "add", "1", null, "revision33b", hash);
    await expect(
      insertChange("v33b", "case33", "add", "2", null, "revision33b", hash),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insertChange(
        "v33b",
        "other_case33",
        "add",
        "1",
        null,
        "other_revision33",
        hash,
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // The FK proves existence; cross-test-set ownership belongs to the publishing transaction.
    await insertChange(
      "v33c",
      "other_case33",
      "add",
      "2",
      null,
      "other_revision33",
      hash,
    );
    await db.query(
      `DELETE FROM version_change WHERE version_id = 'v33c' AND case_id = 'other_case33'`,
    );
  });

  it("constrains checkpoint headers and distinct members", async () => {
    const hash = "b".repeat(64);
    await expect(
      db.query(
        `INSERT INTO version_checkpoint
           (version_id, reason, retention_class, item_count, members_hash)
         VALUES ('v33c', 'deletion_cut', 'rebuildable', 1, $1)`,
        [hash],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await db.query(
      `INSERT INTO version_checkpoint
         (version_id, reason, retention_class, item_count, members_hash)
       VALUES ('v33b', 'initial', 'rebuildable', 1, $1)`,
      [hash],
    );
    await db.query(
      `INSERT INTO version_checkpoint_member
         (version_id, position, case_id, case_revision_id)
       VALUES ('v33b', 1, 'case33', 'revision33b')`,
    );
    await expect(
      db.query(
        `INSERT INTO version_checkpoint_member
           (version_id, position, case_id, case_revision_id)
         VALUES ('v33b', 2, 'case33', 'revision33a')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query(
        `INSERT INTO version_checkpoint_member
           (version_id, position, case_id, case_revision_id)
         VALUES ('v33b', 1, 'other_case33', 'other_revision33')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query(
        `INSERT INTO version_checkpoint_member
           (version_id, position, case_id, case_revision_id)
         VALUES ('v33b', 3, 'missing', 'revision33b')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await db.query(
      `INSERT INTO version_checkpoint_member
         (version_id, position, case_id, case_revision_id)
       VALUES ('v33b', 2, 'other_case33', 'other_revision33')`,
    );
    await db.query(
      `DELETE FROM version_checkpoint_member
        WHERE version_id = 'v33b' AND case_id = 'other_case33'`,
    );
  });

  it("preserves 64-bit positions and adapts legacy ordinals without numeric rounding", async () => {
    const position = "9007199254740993";
    await db.query(
      `INSERT INTO version_change
         (version_id, case_id, operation, position, after_revision_id, after_content_hash)
       VALUES ('v33c', 'case33', 'add', $1, 'revision33a', $2)`,
      [position, "a".repeat(64)],
    );
    const delta = await db.query<{ position: string }>(
      `SELECT position FROM version_change WHERE version_id = 'v33c'`,
    );
    const legacy = await db.query<{ position: string }>(
      `SELECT ordinal::bigint AS position
         FROM version_member WHERE version_id = 'v33a'`,
    );
    expect(delta.rows[0].position).toBe(position);
    expect(legacy.rows[0].position).toBe("1");
  });

  it("keeps incremental branches browsable, downloadable and derivable after a repeated migration", async () => {
    const upgradeSchema = `ticket33_upgrade_${randomUUID().replaceAll("-", "")}`;
    const upgradeUrl = new URL(databaseUrl);
    upgradeUrl.searchParams.set("options", `-csearch_path=${upgradeSchema}`);
    await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(upgradeUrl.toString());
      app = await buildApp({
        databaseUrl: upgradeUrl.toString(),
        soloOwnerMode: true,
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: {},
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
      const mutationHeaders = () => ({
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": login.json().csrfToken as string,
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: mutationHeaders(),
        payload: { name: `Ticket 33 upgrade ${randomUUID()}` },
      });
      expect(project.statusCode, project.body).toBe(201);
      const projectId = project.json().project.id as string;
      const record = {
        question: "legacy question",
        expectedOutput: "legacy answer",
        metadata: [{ key: "source", value: "synthetic" }],
      };
      const created = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/solo-test-sets`,
        headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
        payload: {
          name: "Ticket 33 existing versions",
          selections: [],
          operations: [{ operation: "add", after: record }],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const testSetId = created.json().testSet.id as string;
      const v1Id = created.json().version.id as string;
      const edit = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${v1Id}/editing-records?limit=10&offset=0`,
        headers: { cookie },
      });
      expect(edit.statusCode, edit.body).toBe(200);
      const parent = edit.json().records[0] as {
        caseId: string;
        revisionId: string;
      };
      const derive = (expectedOutput: string) =>
        app!.inject({
          method: "POST",
          url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${v1Id}/derived-versions`,
          headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
          payload: {
            operations: [
              {
                operation: "update",
                caseId: parent.caseId,
                beforeRevisionId: parent.revisionId,
                after: { ...record, expectedOutput },
              },
            ],
          },
        });
      const v2 = await derive("main answer");
      const branch = await derive("branch answer");
      expect(v2.statusCode, v2.body).toBe(201);
      expect(branch.statusCode, branch.body).toBe(201);
      expect(v2.json().version.label).toBe("v2");
      expect(branch.json().version.label).toBe("v2-b1");
      const branchId = branch.json().version.id as string;
      const urls = [
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${v1Id}`,
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${branchId}`,
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${branchId}/records?limit=10&offset=0`,
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${branchId}/data.csv`,
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${branchId}/provenance.csv`,
      ];
      const read = async () =>
        Promise.all(
          urls.map(async (url) => {
            const response = await app!.inject({
              method: "GET",
              url,
              headers: { cookie },
            });
            expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
            return response.body;
          }),
        );
      const before = await read();

      await migrate(upgradeUrl.toString());
      expect(await read()).toEqual(before);
      const derivedAfterUpgrade = await derive("after upgrade");
      expect(derivedAfterUpgrade.statusCode, derivedAfterUpgrade.body).toBe(
        201,
      );
      expect(derivedAfterUpgrade.json().version.label).toBe("v2-b2");
    } finally {
      await app?.close();
      await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`);
    }
  });
});
