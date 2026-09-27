import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { canonicalJson } from "../package/contract.js";
import { ArtifactRepository } from "../storage/artifacts.js";
import { assertIsolatedSpikeEnvironment } from "./incremental-version-storage-environment.js";
import {
  resolveSpikeVersion,
  type VersionChange,
  type VersionMember,
} from "./incremental-version-resolver.js";

const RECORD_COUNT = 10_000;
const UPDATE_CASE_ID = 5_000;
const HUNDRED_UPDATE_COUNT = 100;
const CHAIN_LENGTH = 20;

interface Measure {
  elapsedMs: number;
  walBytes: number;
}

interface StoredObject {
  payloadBytes: number;
  markerBytes: number;
  totalBytes: number;
}

interface SpikeReport {
  generatedAt: string;
  gitSha: string;
  recordCount: number;
  scenarios: {
    legacyOneUpdate: Measure & StoredObject & { memberRows: number };
    legacyHundredUpdates: Measure & StoredObject & { memberRows: number };
    deltaOneUpdate: Measure & StoredObject & { changeRows: number };
    deltaHundredUpdates: Measure & StoredObject & { changeRows: number };
  };
  storage: {
    legacyMemberRows: number;
    deltaChangeRows: number;
    deltaCheckpointMemberRows: number;
    relationBytes: Record<string, number>;
  };
  correctness: {
    legacyAndDeltaV2Equal: boolean;
    legacyAndDeltaV100Equal: boolean;
    checkpointPreservesV20: boolean;
    checkpointReplaysV21: boolean;
    branchIsIndependent: boolean;
    addDeletePreservesOrder: boolean;
  };
}

type Queryable = Pick<ReturnType<typeof createPool>, "query">;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Spike assertion failed: ${message}`);
}

function memberKey(member: VersionMember) {
  return `${member.caseId}:${member.revisionId}:${member.position}`;
}

function sameMembers(left: VersionMember[], right: VersionMember[]) {
  return (
    left.length === right.length &&
    left.every((member, index) => memberKey(member) === memberKey(right[index]))
  );
}

async function lsn(db: Queryable) {
  const result = await db.query<{ lsn: string }>(
    "SELECT pg_current_wal_lsn()::text AS lsn",
  );
  return result.rows[0].lsn;
}

async function measure<T>(
  db: Queryable,
  action: () => Promise<T>,
): Promise<{ result: T; measure: Measure }> {
  const before = await lsn(db);
  const started = performance.now();
  const result = await action();
  const elapsedMs = performance.now() - started;
  const after = await lsn(db);
  const wal = await db.query<{ bytes: string }>(
    "SELECT pg_wal_lsn_diff($1, $2)::bigint::text AS bytes",
    [after, before],
  );
  return {
    result,
    measure: { elapsedMs, walBytes: Number(wal.rows[0].bytes) },
  };
}

async function store(
  artifacts: ArtifactRepository,
  bytes: Buffer,
  operationId: string,
): Promise<StoredObject> {
  const stored = await artifacts.storeImmutable(bytes, operationId);
  const marker = await artifacts.client.statObject(
    artifacts.bucket,
    `markers/sha256/${stored.sha256}.json`,
  );
  return {
    payloadBytes: stored.size,
    markerBytes: marker.size,
    totalBytes: stored.size + marker.size,
  };
}

async function insertRevision(db: Queryable, caseId: number, revision: number) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO spike_revision (case_id, revision, question, expected_output, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text AS id`,
    [
      caseId,
      revision,
      `synthetic question ${caseId} revision ${revision}`,
      `synthetic output ${caseId} revision ${revision}`,
      { source: "synthetic", ordinal: caseId, revision },
    ],
  );
  return result.rows[0].id;
}

async function loadLegacy(
  db: Queryable,
  versionId: string,
): Promise<VersionMember[]> {
  const result = await db.query<{
    case_id: string;
    revision_id: string;
    position: number;
  }>(
    `SELECT revision.case_id::text, member.revision_id::text, member.position
       FROM spike_legacy_member member
       JOIN spike_revision revision ON revision.id = member.revision_id
      WHERE member.version_id = $1
      ORDER BY member.position`,
    [versionId],
  );
  return result.rows.map((row) => ({
    caseId: row.case_id,
    revisionId: row.revision_id,
    position: row.position,
  }));
}

async function loadCheckpoint(
  db: Queryable,
  versionId: string,
): Promise<VersionMember[]> {
  const result = await db.query<{
    case_id: string;
    revision_id: string;
    position: number;
  }>(
    `SELECT revision.case_id::text, member.revision_id::text, member.position
       FROM spike_checkpoint_member member
       JOIN spike_revision revision ON revision.id = member.revision_id
      WHERE member.version_id = $1
      ORDER BY member.position`,
    [versionId],
  );
  return result.rows.map((row) => ({
    caseId: row.case_id,
    revisionId: row.revision_id,
    position: row.position,
  }));
}

async function writeChanges(
  db: Queryable,
  versionId: string,
  changes: VersionChange[],
) {
  for (const change of changes) {
    const caseId = Number(change.caseId);
    await db.query(
      `INSERT INTO spike_version_change
         (version_id, case_id, operation, revision_id, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        versionId,
        caseId,
        change.kind,
        change.kind === "upsert" ? change.revisionId : null,
        change.kind === "upsert" ? change.position : null,
      ],
    );
  }
}

async function addDeltaVersion(
  db: Queryable,
  versionId: string,
  parentVersionId: string,
  changes: VersionChange[],
) {
  await db.query("BEGIN");
  try {
    await db.query(
      "INSERT INTO spike_delta_version (id, parent_version_id, is_checkpoint) VALUES ($1, $2, false)",
      [versionId, parentVersionId],
    );
    await writeChanges(db, versionId, changes);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const config = loadConfig();
  assertIsolatedSpikeEnvironment(config);
  const pool = createPool(config.databaseUrl);
  const db = await pool.connect();
  const artifacts = new ArtifactRepository(config.minio);
  const runId = randomUUID();
  try {
    await artifacts.initialize();
    await db.query("DROP SCHEMA IF EXISTS spike CASCADE");
    await db.query("CREATE SCHEMA spike");
    await db.query("SET search_path TO spike");
    await db.query(`
      CREATE TABLE spike_revision (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        case_id integer NOT NULL,
        revision integer NOT NULL,
        question text NOT NULL,
        expected_output text NOT NULL,
        metadata jsonb NOT NULL,
        UNIQUE (case_id, revision)
      );
      CREATE TABLE spike_legacy_member (
        version_id text NOT NULL,
        position integer NOT NULL,
        revision_id bigint NOT NULL REFERENCES spike_revision(id),
        PRIMARY KEY (version_id, position)
      );
      CREATE TABLE spike_delta_version (
        id text PRIMARY KEY,
        parent_version_id text REFERENCES spike_delta_version(id),
        is_checkpoint boolean NOT NULL
      );
      CREATE TABLE spike_version_change (
        version_id text NOT NULL REFERENCES spike_delta_version(id),
        case_id integer NOT NULL,
        operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
        revision_id bigint REFERENCES spike_revision(id),
        position integer,
        PRIMARY KEY (version_id, case_id),
        CHECK (
          (operation = 'upsert' AND revision_id IS NOT NULL AND position IS NOT NULL)
          OR (operation = 'delete' AND revision_id IS NULL AND position IS NULL)
        )
      );
      CREATE TABLE spike_checkpoint_member (
        version_id text NOT NULL REFERENCES spike_delta_version(id),
        position integer NOT NULL,
        revision_id bigint NOT NULL REFERENCES spike_revision(id),
        PRIMARY KEY (version_id, position)
      );
    `);

    await db.query(
      `INSERT INTO spike_revision
         (case_id, revision, question, expected_output, metadata)
       SELECT ordinal, 1,
              'synthetic question ' || ordinal,
              'synthetic output ' || ordinal,
              jsonb_build_object('source', 'synthetic', 'ordinal', ordinal)
         FROM generate_series(1, $1) AS ordinal`,
      [RECORD_COUNT],
    );
    await db.query(
      `INSERT INTO spike_legacy_member (version_id, position, revision_id)
       SELECT 'legacy-v1', revision.case_id, revision.id
         FROM spike_revision revision
        WHERE revision.revision = 1
        ORDER BY revision.case_id`,
    );
    await db.query(
      "INSERT INTO spike_delta_version (id, parent_version_id, is_checkpoint) VALUES ('delta-v1', NULL, true)",
    );
    await db.query(
      `INSERT INTO spike_checkpoint_member (version_id, position, revision_id)
       SELECT 'delta-v1', revision.case_id, revision.id
         FROM spike_revision revision
        WHERE revision.revision = 1
        ORDER BY revision.case_id`,
    );

    const originalRows = await db.query<{
      case_id: number;
      revision_id: string;
      question: string;
      expected_output: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT revision.case_id, revision.id::text AS revision_id, revision.question,
              revision.expected_output, revision.metadata
         FROM spike_legacy_member member
         JOIN spike_revision revision ON revision.id = member.revision_id
        WHERE member.version_id = 'legacy-v1'
        ORDER BY member.position`,
    );
    const updatedRevisionId = await insertRevision(db, UPDATE_CASE_ID, 2);
    const legacyPayload = Buffer.from(
      `${canonicalJson({
        versionId: `legacy-v2-${runId}`,
        records: originalRows.rows.map((row) => ({
          question:
            row.case_id === UPDATE_CASE_ID
              ? `synthetic question ${UPDATE_CASE_ID} revision 2`
              : row.question,
          expectedOutput:
            row.case_id === UPDATE_CASE_ID
              ? `synthetic output ${UPDATE_CASE_ID} revision 2`
              : row.expected_output,
          metadata: row.metadata,
        })),
      })}\n`,
    );
    const legacy = await measure(db, async () => {
      const object = await store(artifacts, legacyPayload, `legacy-${runId}`);
      await db.query("BEGIN");
      try {
        await db.query(
          `INSERT INTO spike_legacy_member (version_id, position, revision_id)
           SELECT 'legacy-v2', member.position,
                  CASE WHEN revision.case_id = $1 THEN $2 ELSE member.revision_id END
             FROM spike_legacy_member member
             JOIN spike_revision revision ON revision.id = member.revision_id
            WHERE member.version_id = 'legacy-v1'
            ORDER BY member.position`,
          [UPDATE_CASE_ID, updatedRevisionId],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      return object;
    });

    const oneUpdate: VersionChange[] = [
      {
        kind: "upsert",
        caseId: String(UPDATE_CASE_ID),
        revisionId: updatedRevisionId,
        position: UPDATE_CASE_ID,
      },
    ];
    const deltaPayload = Buffer.from(
      `${canonicalJson({
        formatVersion: 1,
        versionId: `delta-v2-${runId}`,
        parentVersionId: "delta-v1",
        changes: oneUpdate,
      })}\n`,
    );
    const delta = await measure(db, async () => {
      const object = await store(artifacts, deltaPayload, `delta-${runId}`);
      await addDeltaVersion(db, "delta-v2", "delta-v1", oneUpdate);
      return object;
    });

    const hundredChanges: VersionChange[] = [];
    for (let caseId = 1; caseId <= HUNDRED_UPDATE_COUNT; caseId += 1) {
      const revisionId = await insertRevision(db, caseId, 2);
      hundredChanges.push({
        kind: "upsert",
        caseId: String(caseId),
        revisionId,
        position: caseId,
      });
    }
    const hundredCaseIds = hundredChanges.map((change) =>
      Number(change.caseId),
    );
    const hundredRevisionIds = hundredChanges.map((change) => {
      if (change.kind !== "upsert") throw new Error("Expected an upsert");
      return Number(change.revisionId);
    });
    const legacyHundredPayload = Buffer.from(
      `${canonicalJson({
        versionId: `legacy-v100-${runId}`,
        records: originalRows.rows.map((row) => ({
          question:
            row.case_id <= HUNDRED_UPDATE_COUNT
              ? `synthetic question ${row.case_id} revision 2`
              : row.question,
          expectedOutput:
            row.case_id <= HUNDRED_UPDATE_COUNT
              ? `synthetic output ${row.case_id} revision 2`
              : row.expected_output,
          metadata:
            row.case_id <= HUNDRED_UPDATE_COUNT
              ? { source: "synthetic", ordinal: row.case_id, revision: 2 }
              : row.metadata,
        })),
      })}\n`,
    );
    const legacyHundred = await measure(db, async () => {
      const object = await store(
        artifacts,
        legacyHundredPayload,
        `legacy-100-${runId}`,
      );
      await db.query("BEGIN");
      try {
        await db.query(
          `WITH changes(case_id, revision_id) AS (
             SELECT * FROM unnest($1::integer[], $2::bigint[])
           )
           INSERT INTO spike_legacy_member (version_id, position, revision_id)
           SELECT 'legacy-v100', member.position,
                  COALESCE(changes.revision_id, member.revision_id)
             FROM spike_legacy_member member
             JOIN spike_revision revision ON revision.id = member.revision_id
             LEFT JOIN changes ON changes.case_id = revision.case_id
            WHERE member.version_id = 'legacy-v1'
            ORDER BY member.position`,
          [hundredCaseIds, hundredRevisionIds],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      return object;
    });
    const hundredPayload = Buffer.from(
      `${canonicalJson({
        formatVersion: 1,
        versionId: `delta-v100-${runId}`,
        parentVersionId: "delta-v1",
        changes: hundredChanges,
      })}\n`,
    );
    const hundred = await measure(db, async () => {
      const object = await store(
        artifacts,
        hundredPayload,
        `delta-100-${runId}`,
      );
      await addDeltaVersion(db, "delta-v100", "delta-v1", hundredChanges);
      return object;
    });

    let parentVersionId = "delta-v2";
    const deltaChain: VersionChange[][] = [oneUpdate];
    for (let generation = 3; generation <= CHAIN_LENGTH; generation += 1) {
      const caseId = 100 + generation;
      const revisionId = await insertRevision(db, caseId, 2);
      const changes: VersionChange[] = [
        {
          kind: "upsert",
          caseId: String(caseId),
          revisionId,
          position: caseId,
        },
      ];
      const versionId = `delta-v${generation}`;
      await addDeltaVersion(db, versionId, parentVersionId, changes);
      parentVersionId = versionId;
      deltaChain.push(changes);
    }
    const v1Checkpoint = await loadCheckpoint(db, "delta-v1");
    const v20BeforeCheckpoint = resolveSpikeVersion(v1Checkpoint, deltaChain);
    await db.query(
      "UPDATE spike_delta_version SET is_checkpoint = true WHERE id = $1",
      [parentVersionId],
    );
    for (const member of v20BeforeCheckpoint)
      await db.query(
        `INSERT INTO spike_checkpoint_member (version_id, position, revision_id)
         VALUES ($1, $2, $3)`,
        [parentVersionId, member.position, member.revisionId],
      );
    const v20AfterCheckpoint = await loadCheckpoint(db, parentVersionId);

    const postCheckpointRevisionId = await insertRevision(db, 200, 2);
    const postCheckpointChange: VersionChange[] = [
      {
        kind: "upsert",
        caseId: "200",
        revisionId: postCheckpointRevisionId,
        position: 200,
      },
    ];
    await addDeltaVersion(
      db,
      "delta-v21",
      parentVersionId,
      postCheckpointChange,
    );
    const v21FromCheckpoint = resolveSpikeVersion(v20AfterCheckpoint, [
      postCheckpointChange,
    ]);
    const v21FromV1 = resolveSpikeVersion(v1Checkpoint, [
      ...deltaChain,
      postCheckpointChange,
    ]);

    const branchRevisionId = await insertRevision(db, 1, 3);
    const branchChange: VersionChange[] = [
      {
        kind: "upsert",
        caseId: "1",
        revisionId: branchRevisionId,
        position: 1,
      },
    ];
    await addDeltaVersion(db, "delta-v2-b1", "delta-v1", branchChange);
    const secondBranchRevisionId = await insertRevision(db, 2, 3);
    const secondBranchChange: VersionChange[] = [
      {
        kind: "upsert",
        caseId: "2",
        revisionId: secondBranchRevisionId,
        position: 2,
      },
    ];
    await addDeltaVersion(db, "delta-v2-b2", "delta-v1", secondBranchChange);
    const branch = resolveSpikeVersion(v1Checkpoint, [branchChange]);
    const secondBranch = resolveSpikeVersion(v1Checkpoint, [
      secondBranchChange,
    ]);
    const main = resolveSpikeVersion(v1Checkpoint, deltaChain);

    const addedRevisionId = await insertRevision(db, RECORD_COUNT + 1, 1);
    const addDelete: VersionChange[] = [
      { kind: "delete", caseId: String(RECORD_COUNT) },
      {
        kind: "upsert",
        caseId: String(RECORD_COUNT + 1),
        revisionId: addedRevisionId,
        position: RECORD_COUNT + 1,
      },
    ];
    const addDeleteResolved = resolveSpikeVersion(v1Checkpoint, [addDelete]);

    const legacyV2 = await loadLegacy(db, "legacy-v2");
    const legacyV100 = await loadLegacy(db, "legacy-v100");
    const deltaV2 = resolveSpikeVersion(v1Checkpoint, [oneUpdate]);
    const deltaV100 = resolveSpikeVersion(v1Checkpoint, [hundredChanges]);
    const relationBytesResult = await db.query<{
      relation: string;
      bytes: string;
    }>(
      `SELECT relname AS relation, pg_total_relation_size(oid)::bigint::text AS bytes
         FROM pg_class
        WHERE relname IN (
          'spike_legacy_member', 'spike_version_change', 'spike_checkpoint_member'
        )`,
    );
    const relationBytes = Object.fromEntries(
      relationBytesResult.rows.map((row) => [row.relation, Number(row.bytes)]),
    );
    const counts = await db.query<{
      legacy_members: string;
      delta_changes: string;
      checkpoint_members: string;
    }>(
      `SELECT
         (SELECT count(*) FROM spike_legacy_member)::text AS legacy_members,
         (SELECT count(*) FROM spike_version_change)::text AS delta_changes,
         (SELECT count(*) FROM spike_checkpoint_member)::text AS checkpoint_members`,
    );

    const report: SpikeReport = {
      generatedAt: new Date().toISOString(),
      gitSha: config.gitSha,
      recordCount: RECORD_COUNT,
      scenarios: {
        legacyOneUpdate: {
          ...legacy.measure,
          ...legacy.result,
          memberRows: RECORD_COUNT,
        },
        legacyHundredUpdates: {
          ...legacyHundred.measure,
          ...legacyHundred.result,
          memberRows: RECORD_COUNT,
        },
        deltaOneUpdate: {
          ...delta.measure,
          ...delta.result,
          changeRows: oneUpdate.length,
        },
        deltaHundredUpdates: {
          ...hundred.measure,
          ...hundred.result,
          changeRows: hundredChanges.length,
        },
      },
      storage: {
        legacyMemberRows: Number(counts.rows[0].legacy_members),
        deltaChangeRows: Number(counts.rows[0].delta_changes),
        deltaCheckpointMemberRows: Number(counts.rows[0].checkpoint_members),
        relationBytes,
      },
      correctness: {
        legacyAndDeltaV2Equal: sameMembers(legacyV2, deltaV2),
        legacyAndDeltaV100Equal: sameMembers(legacyV100, deltaV100),
        checkpointPreservesV20: sameMembers(
          v20BeforeCheckpoint,
          v20AfterCheckpoint,
        ),
        checkpointReplaysV21: sameMembers(v21FromCheckpoint, v21FromV1),
        branchIsIndependent:
          branch.find((member) => member.caseId === "1")?.revisionId ===
            branchRevisionId &&
          secondBranch.find((member) => member.caseId === "2")?.revisionId ===
            secondBranchRevisionId &&
          main.find((member) => member.caseId === "1")?.revisionId !==
            branchRevisionId &&
          main.find((member) => member.caseId === "2")?.revisionId !==
            secondBranchRevisionId,
        addDeletePreservesOrder:
          addDeleteResolved.length === RECORD_COUNT &&
          addDeleteResolved.at(-1)?.caseId === String(RECORD_COUNT + 1) &&
          !addDeleteResolved.some(
            (member) => member.caseId === String(RECORD_COUNT),
          ),
      },
    };
    for (const [name, value] of Object.entries(report.correctness))
      assert(value, name);
    const reportPath =
      process.env.SPIKE_REPORT_PATH ??
      "docs/spikes/incremental-test-set-version-storage.json";
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    db.release();
    await pool.end();
  }
}

await main();
