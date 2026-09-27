import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import {
  createCheckpoint,
  materializePeriodicCheckpoint,
} from "../../src/version/checkpoint.js";
import {
  publishSparseVersion,
  type SparseOperation,
} from "../../src/version/publish-sparse.js";

const schema = `ticket36_${randomUUID().replaceAll("-", "")}`;
const config = loadConfig();
const schemaUrl = new URL(config.databaseUrl);
schemaUrl.searchParams.set("options", `-csearch_path=${schema}`);

describe("Ticket 36 checkpoint limits", () => {
  const admin = createPool(config.databaseUrl);
  const db = createPool(schemaUrl.toString());
  const artifacts = new ArtifactRepository(config.minio);
  let key = 0;

  async function seed(name: string, count: number) {
    await db.query(
      `INSERT INTO test_set (id,project_id,name,purpose,owner_id)
      VALUES ($1,'project36',$1,'synthetic','owner36')`,
      [name],
    );
    await db.query(
      `INSERT INTO formal_schema_revision
      (id,test_set_id,mode,input_schema,expected_output_schema)
      VALUES ($1,$2,'gold_required','{}','{}')`,
      [`schema_${name}`, name],
    );
    await db.query(
      `INSERT INTO working_draft (id,test_set_id,status,updated_by)
      VALUES ($1,$2,'published','owner36')`,
      [`draft_${name}`, name],
    );
    await db.query(
      `INSERT INTO candidate_snapshot
      (id,draft_id,status,schema_revision_id,item_count)
      VALUES ($1,$2,'published_as_version',$3,$4)`,
      [`candidate_${name}`, `draft_${name}`, `schema_${name}`, count],
    );
    await db.query(
      `INSERT INTO test_set_version
      (id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,
       evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,
       published_at,publication_order,generation,version_label)
      VALUES ($1,$2,1,$3,$4,repeat('a',64),repeat('a',64),repeat('a',64),
       'synthetic/base',$5,'owner36',now(),1,1,'v1')`,
      [`base_${name}`, name, `candidate_${name}`, `schema_${name}`, count],
    );
    if (count) {
      await db.query(
        `INSERT INTO test_case (id,test_set_id)
        SELECT $1||'_case_'||i,$1 FROM generate_series(1,$2) i`,
        [name, count],
      );
      await db.query(
        `INSERT INTO case_revision
        (id,case_id,input,expected_output,metadata,source_record_ordinal,
         content_hash,lineage_fingerprint,origin_kind)
        SELECT $1||'_rev_'||i,$1||'_case_'||i,
          jsonb_build_object('question','question '||i),'{"text":"answer"}'::jsonb,
          '{"entries":[]}'::jsonb,0,repeat('a',64),repeat('a',64),'manual'
          FROM generate_series(1,$2) i`,
        [name, count],
      );
      await db.query(
        `INSERT INTO version_member (version_id,case_revision_id,ordinal)
        SELECT $1,$2||'_rev_'||i,i FROM generate_series(1,$3) i`,
        [`base_${name}`, name, count],
      );
    }
    return `base_${name}`;
  }

  const update = (name: string, index: number): SparseOperation => ({
    operation: "update",
    caseId: `${name}_case_${index}`,
    beforeRevisionId: `${name}_rev_${index}`,
    after: {
      question: `changed ${index}`,
      expectedOutput: "answer",
      metadata: [],
    },
  });
  async function publish(
    name: string,
    parentVersionId: string,
    operations: SparseOperation[],
  ) {
    return publishSparseVersion(db, artifacts, {
      projectId: "project36",
      testSetId: name,
      parentVersionId,
      actorId: "owner36",
      idempotencyKey: `checkpoint-${++key}`,
      operations,
    });
  }

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(schemaUrl.toString());
    await artifacts.initialize();
    await db.query(`INSERT INTO app_user (id,username,password_hash,role)
      VALUES ('owner36','owner36','test','owner')`);
    await db.query(`INSERT INTO project (id,name,owner_id)
      VALUES ('project36','Synthetic checkpoints','owner36')`);
    await db.query(`INSERT INTO project_member (project_id,user_id,role)
      VALUES ('project36','owner36','owner')`);
  });
  afterAll(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("queues a periodic checkpoint and materializes it idempotently", async () => {
    const base = await seed("periodic36", 5);
    const version = await publish("periodic36", base, [
      update("periodic36", 1),
    ]);
    const jobs = await db.query(
      `SELECT id,status FROM job
      WHERE kind='materialize_version_checkpoint' AND payload->>'versionId'=$1`,
      [version.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].status).toBe("queued");
    expect(
      await materializePeriodicCheckpoint(db, version.id, "project36"),
    ).toBe("created");
    expect(
      await materializePeriodicCheckpoint(db, version.id, "project36"),
    ).toBe("existing");
    const checkpoint = await db.query(
      `SELECT cp.reason,cp.item_count,cp.members_hash,
      checkpoint_members_hash(cp.version_id) AS actual_hash
      FROM version_checkpoint cp WHERE cp.version_id=$1`,
      [version.id],
    );
    expect(checkpoint.rows[0]).toMatchObject({
      reason: "periodic",
      item_count: 5,
    });
    expect(checkpoint.rows[0].members_hash).toBe(
      checkpoint.rows[0].actual_hash,
    );
    const child = await publish("periodic36", version.id, [
      update("periodic36", 2),
    ]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM resolve_version_members($1)",
          [child.id],
        )
      ).rows[0].n,
    ).toBe(5);
    const grandchild = await publish("periodic36", child.id, [
      update("periodic36", 3),
    ]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_checkpoint WHERE version_id=$1",
          [grandchild.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("allows equality at 40% and synchronously checkpoints a greater change count", async () => {
    const base = await seed("change36", 5);
    const equal = await publish("change36", base, [
      update("change36", 1),
      update("change36", 2),
    ]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_checkpoint WHERE version_id=$1",
          [equal.id],
        )
      ).rows[0].n,
    ).toBe(0);
    const hard = await publish("change36", equal.id, [update("change36", 3)]);
    const result = await db.query(
      `SELECT cp.reason,cp.item_count,
      (SELECT count(*)::int FROM version_checkpoint_member WHERE version_id=cp.version_id) AS members
      FROM version_checkpoint cp WHERE cp.version_id=$1`,
      [hard.id],
    );
    expect(result.rows[0]).toMatchObject({
      reason: "hard_limit",
      item_count: 5,
      members: 5,
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_member WHERE version_id=$1",
          [hard.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("bounds a zero-change chain at 40 generations even without Worker", async () => {
    const base = await seed("depth36", 5);
    let parent = base;
    let twentieth = "";
    for (let index = 1; index <= 40; index++) {
      parent = (await publish("depth36", parent, [])).id;
      if (index === 20) twentieth = parent;
    }
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM job
      WHERE kind='materialize_version_checkpoint' AND payload->>'versionId'=$1`,
          [twentieth],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_checkpoint WHERE version_id=$1",
          [parent],
        )
      ).rows[0].n,
    ).toBe(0);
    const fortyFirst = await publish("depth36", parent, []);
    expect(
      (
        await db.query(
          "SELECT reason FROM version_checkpoint WHERE version_id=$1",
          [fortyFirst.id],
        )
      ).rows[0].reason,
    ).toBe("hard_limit");
  }, 60_000);

  it("uses an empty baseline denominator of one", async () => {
    const base = await seed("empty36", 0);
    const one = await publish("empty36", base, [
      {
        operation: "add",
        after: {
          question: "first",
          expectedOutput: "answer",
          metadata: [],
        },
      },
    ]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_checkpoint WHERE version_id=$1",
          [one.id],
        )
      ).rows[0].n,
    ).toBe(0);
    const two = await publish("empty36", base, [
      {
        operation: "add",
        after: { question: "first", expectedOutput: "answer", metadata: [] },
      },
      {
        operation: "add",
        after: { question: "second", expectedOutput: "answer", metadata: [] },
      },
    ]);
    expect(
      (
        await db.query(
          "SELECT reason FROM version_checkpoint WHERE version_id=$1",
          [two.id],
        )
      ).rows[0].reason,
    ).toBe("hard_limit");
  });

  it("keeps the path position high-water after a checkpoint with deleted tail", async () => {
    const base = await seed("tail36", 5);
    const cut = await publish(
      "tail36",
      base,
      [3, 4, 5].map((index) => ({
        operation: "delete" as const,
        caseId: `tail36_case_${index}`,
        beforeRevisionId: `tail36_rev_${index}`,
      })),
    );
    expect(
      (
        await db.query(
          "SELECT reason FROM version_checkpoint WHERE version_id=$1",
          [cut.id],
        )
      ).rows[0].reason,
    ).toBe("hard_limit");
    const child = await publish("tail36", cut.id, [
      {
        operation: "add",
        after: {
          question: "new tail",
          expectedOutput: "answer",
          metadata: [],
        },
      },
    ]);
    const added = await db.query(
      `SELECT position::text AS position FROM version_change
      WHERE version_id=$1 AND operation='add'`,
      [child.id],
    );
    expect(added.rows[0].position).toBe("6");
    const questions = await db.query(
      `SELECT cr.input->>'question' AS question
      FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id=vm.case_revision_id
      ORDER BY vm.ordinal`,
      [child.id],
    );
    expect(questions.rows.map((row) => row.question)).toEqual([
      "question 1",
      "question 2",
      "new tail",
    ]);
  });

  it("rolls back a failed hard checkpoint without consuming a version label", async () => {
    const base = await seed("failure36", 5);
    await db.query(`CREATE FUNCTION ticket36_abort_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected_checkpoint_failure'; END $$`);
    await db.query(`CREATE TRIGGER ticket36_abort_checkpoint BEFORE INSERT ON version_checkpoint_member
      FOR EACH ROW EXECUTE FUNCTION ticket36_abort_checkpoint()`);
    const operations = [
      update("failure36", 1),
      update("failure36", 2),
      update("failure36", 3),
    ];
    try {
      await expect(publish("failure36", base, operations)).rejects.toThrow(
        "injected_checkpoint_failure",
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM test_set_version WHERE test_set_id='failure36'",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await db.query(
        "DROP TRIGGER ticket36_abort_checkpoint ON version_checkpoint_member",
      );
      await db.query("DROP FUNCTION ticket36_abort_checkpoint()");
    }
    const retry = await publish("failure36", base, operations);
    expect(retry.label).toBe("v2");
    expect(
      (
        await db.query(
          "SELECT reason FROM version_checkpoint WHERE version_id=$1",
          [retry.id],
        )
      ).rows[0].reason,
    ).toBe("hard_limit");
  });

  it("rejects payload corruption without publishing a checkpoint header", async () => {
    const base = await seed("payload36", 5);
    const version = await publish("payload36", base, [update("payload36", 1)]);
    await db.query(
      "UPDATE test_set_version SET payload_hash=repeat('f',64) WHERE id=$1",
      [version.id],
    );
    await expect(
      materializePeriodicCheckpoint(db, version.id, "project36"),
    ).rejects.toThrow("checkpoint_payload_mismatch");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_checkpoint WHERE version_id=$1",
          [version.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("preserves a deletion-cut checkpoint as a required dependency", async () => {
    const base = await seed("dependency36", 5);
    const version = await publish("dependency36", base, [
      update("dependency36", 1),
    ]);
    expect(
      await materializePeriodicCheckpoint(db, version.id, "project36"),
    ).toBe("created");
    const revision = (
      await db.query(
        `SELECT case_revision_id FROM version_checkpoint_member
      WHERE version_id=$1 AND case_id='dependency36_case_1'`,
        [version.id],
      )
    ).rows[0].case_revision_id;
    await db.query(
      `UPDATE case_revision SET input='{"question":"corrupted"}' WHERE id=$1`,
      [revision],
    );
    const corruptClient = await db.connect();
    try {
      await corruptClient.query("BEGIN");
      await expect(
        createCheckpoint(
          corruptClient,
          version.id,
          "deletion_cut",
          "project36",
        ),
      ).rejects.toThrow("checkpoint_payload_mismatch");
      await corruptClient.query("ROLLBACK");
    } finally {
      corruptClient.release();
    }
    expect(
      (
        await db.query(
          "SELECT retention_class FROM version_checkpoint WHERE version_id=$1",
          [version.id],
        )
      ).rows[0].retention_class,
    ).toBe("rebuildable");
    await db.query(
      `UPDATE case_revision SET input='{"question":"changed 1"}' WHERE id=$1`,
      [revision],
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      expect(
        await createCheckpoint(client, version.id, "deletion_cut", "project36"),
      ).toBe("existing");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const checkpoint = await db.query(
      `SELECT reason,retention_class
      FROM version_checkpoint WHERE version_id=$1`,
      [version.id],
    );
    expect(checkpoint.rows[0]).toMatchObject({
      reason: "deletion_cut",
      retention_class: "required_dependency",
    });
    await db.query(
      `UPDATE case_revision SET input='{"question":"corrupted again"}' WHERE id=$1`,
      [revision],
    );
    const retryClient = await db.connect();
    try {
      await retryClient.query("BEGIN");
      await expect(
        createCheckpoint(retryClient, version.id, "deletion_cut", "project36"),
      ).rejects.toThrow("checkpoint_payload_mismatch");
      await retryClient.query("ROLLBACK");
    } finally {
      retryClient.release();
    }
  });

  it("refuses to promote a checkpoint whose source reference disappeared", async () => {
    const base = await seed("source36", 5);
    await db.query(`INSERT INTO data_asset
      (id,project_id,blob_sha256,object_ref,size_bytes,mime_type,file_name,format,status,uploaded_by)
      VALUES ('source_asset36','project36',repeat('a',64),'synthetic/source36',20,
        'text/csv','source36.csv','csv','stored','owner36')`);
    await db.query(`INSERT INTO parsed_view
      (id,asset_id,format,parser_name,parser_version,parser_config,parser_config_hash,
       status,record_count,is_current)
      VALUES ('source_view36','source_asset36','csv','test','1','{}','test',
        'ready',1,true)`);
    await db.query(`INSERT INTO source_record
      (parsed_view_id,ordinal,value,locator,record_hash,parse_status)
      VALUES ('source_view36',1,'{}','{}',repeat('b',64),'valid')`);
    const version = await publish("source36", base, [
      {
        operation: "update",
        caseId: "source36_case_1",
        beforeRevisionId: "source36_rev_1",
        after: {
          question: "source question",
          expectedOutput: "answer",
          metadata: [],
          source: { assetId: "source_asset36", ordinal: 1 },
        },
      },
    ]);
    expect(
      await materializePeriodicCheckpoint(db, version.id, "project36"),
    ).toBe("created");
    await db.query(
      "DELETE FROM source_record WHERE parsed_view_id='source_view36'",
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await expect(
        createCheckpoint(client, version.id, "deletion_cut", "project36"),
      ).rejects.toThrow("checkpoint_source_invalid");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (
        await db.query(
          "SELECT retention_class FROM version_checkpoint WHERE version_id=$1",
          [version.id],
        )
      ).rows[0].retention_class,
    ).toBe("rebuildable");
  });

  it("does not materialize a deleted version from an old queued job", async () => {
    const base = await seed("deleted36", 5);
    const pending = await publish("deleted36", base, [update("deleted36", 1)]);
    await db.query(
      "UPDATE test_set_version SET status='degraded_by_deletion' WHERE id=$1",
      [pending.id],
    );
    expect(
      await materializePeriodicCheckpoint(db, pending.id, "project36"),
    ).toBe("skipped");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM version_checkpoint WHERE version_id=$1",
          [pending.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
