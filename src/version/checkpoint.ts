import type { PoolClient } from "pg";

import type { Database } from "../db/pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { snapshotPayloadHash, storedRecord } from "./snapshot-record.js";

type Reason = "initial" | "periodic" | "hard_limit" | "deletion_cut";
type Retention = "rebuildable" | "required_dependency";

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

export async function replayCost(
  client: PoolClient,
  parentVersionId: string,
): Promise<{
  baselineCount: number;
  depth: number;
  changes: number;
}> {
  const result = await client.query(
    `WITH RECURSIVE path AS (
      SELECT id,parent_version_id,storage_format,item_count,0 AS depth
        FROM test_set_version WHERE id=$1
      UNION ALL
      SELECT v.id,v.parent_version_id,v.storage_format,v.item_count,p.depth+1
        FROM path p JOIN test_set_version v ON v.id=p.parent_version_id
    ), anchor AS (
      SELECT p.id,p.item_count,p.depth FROM path p
       WHERE p.storage_format='legacy_full_v1'
          OR EXISTS (SELECT 1 FROM version_checkpoint cp WHERE cp.version_id=p.id
            AND cp.item_count=(SELECT count(*) FROM version_checkpoint_member m WHERE m.version_id=cp.version_id)
            AND cp.members_hash=checkpoint_members_hash(cp.version_id))
       ORDER BY p.depth LIMIT 1
    ) SELECT a.item_count AS baseline_count,
       (SELECT count(*)::int FROM path p WHERE p.depth<a.depth AND p.storage_format='delta_v1') AS depth,
       (SELECT count(*)::int FROM version_change c JOIN path p ON p.id=c.version_id
         WHERE p.depth<a.depth) AS changes
      FROM anchor a`,
    [parentVersionId],
  );
  if (result.rowCount !== 1) fail("checkpoint_baseline_missing");
  return {
    baselineCount: Number(result.rows[0].baseline_count),
    depth: Number(result.rows[0].depth),
    changes: Number(result.rows[0].changes),
  };
}

export function checkpointThresholds(baselineCount: number) {
  const denominator = Math.max(baselineCount, 1);
  return {
    periodicChanges: Math.ceil(denominator * 0.2),
    hardChanges: Math.ceil(denominator * 0.4),
  };
}

async function validatedSnapshot(
  client: PoolClient,
  versionId: string,
  itemCount: number,
  payloadHash: string,
  projectId: string,
  allowUnavailable = false,
) {
  const resolved = await client.query(
    `SELECT vm.case_id,vm.case_revision_id,
      vm.position::text AS position,cr.input,cr.expected_output,cr.metadata,
      cr.origin_kind,cr.origin_ref
    FROM resolve_version_members_internal($1, $2, true) vm
    JOIN case_revision cr ON cr.id=vm.case_revision_id
    ORDER BY vm.position,vm.case_id`,
    [versionId, allowUnavailable],
  );
  if (resolved.rows.length !== itemCount) fail("checkpoint_count_mismatch");
  let previous = 0n;
  const cases = new Set<string>();
  for (const row of resolved.rows) {
    const position = BigInt(row.position);
    if (position <= previous || cases.has(row.case_id))
      fail("checkpoint_order_invalid");
    previous = position;
    cases.add(row.case_id);
  }
  if (snapshotPayloadHash(resolved.rows.map(storedRecord)) !== payloadHash)
    fail("checkpoint_payload_mismatch");
  const sources = new Map<
    string,
    {
      asset_id: string;
      parsed_view_id: string;
      ordinal: number;
      record_hash: string;
    }
  >();
  for (const row of resolved.rows) {
    if (row.origin_kind !== "source_record") continue;
    const origin = row.origin_ref;
    if (
      !origin ||
      typeof origin.assetId !== "string" ||
      typeof origin.parsedViewId !== "string" ||
      !Number.isInteger(origin.ordinal) ||
      typeof origin.recordHash !== "string"
    )
      fail("checkpoint_source_invalid");
    const reference = {
      asset_id: origin.assetId,
      parsed_view_id: origin.parsedViewId,
      ordinal: origin.ordinal,
      record_hash: origin.recordHash,
    };
    sources.set(JSON.stringify(reference), reference);
  }
  if (sources.size) {
    const matched = await client.query(
      `WITH expected AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb)
          AS x(asset_id text,parsed_view_id text,ordinal integer,record_hash text)
      ) SELECT count(*)::int AS count FROM expected e
      JOIN data_asset da ON da.id=e.asset_id AND da.project_id=$1
        AND da.status NOT IN ('deletion_pending','tombstoned')
      JOIN parsed_view pv ON pv.id=e.parsed_view_id AND pv.asset_id=da.id
      JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.ordinal=e.ordinal
        AND sr.record_hash=e.record_hash AND sr.parse_status='valid'`,
      [projectId, JSON.stringify([...sources.values()])],
    );
    if (matched.rows[0].count !== sources.size)
      fail("checkpoint_source_invalid");
  }
  const membersHash = sha256(
    `[${resolved.rows
      .map(
        (row) =>
          `[${row.position},${canonicalJson(row.case_id)},${canonicalJson(row.case_revision_id)}]`,
      )
      .join(",")}]`,
  );
  return { rows: resolved.rows, membersHash };
}

/** Caller owns the transaction. This routine always takes test-set then version locks. */
export async function createCheckpoint(
  client: PoolClient,
  versionId: string,
  reason: Reason,
  projectId?: string,
): Promise<"created" | "existing" | "skipped"> {
  const identity = await client.query(
    `SELECT v.test_set_id,ts.project_id
    FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE v.id=$1`,
    [versionId],
  );
  if (!identity.rowCount) return "skipped";
  if (projectId && identity.rows[0].project_id !== projectId)
    fail("version_not_found");
  await client.query("SELECT id FROM test_set WHERE id=$1 FOR UPDATE", [
    identity.rows[0].test_set_id,
  ]);
  const version = await client.query(
    `SELECT id,status,storage_format,item_count,payload_hash
    FROM test_set_version WHERE id=$1 AND test_set_id=$2 FOR UPDATE`,
    [versionId, identity.rows[0].test_set_id],
  );
  if (
    !version.rowCount ||
    (version.rows[0].status !== "published" &&
      !(
        reason === "deletion_cut" &&
        ["trashed", "archived"].includes(version.rows[0].status)
      ))
  )
    return "skipped";
  if (
    version.rows[0].storage_format !== "delta_v1" &&
    !(
      reason === "deletion_cut" &&
      version.rows[0].storage_format === "legacy_full_v1"
    )
  )
    fail("checkpoint_format_invalid");
  const locked = await client.query(
    `SELECT 1 FROM deletion_lock
    WHERE project_id=$1 AND object_type='test_set_version' AND object_id=$2`,
    [identity.rows[0].project_id, versionId],
  );
  if (locked.rowCount) return "skipped";
  const existing = await client.query(
    `SELECT item_count,members_hash,retention_class
    FROM version_checkpoint WHERE version_id=$1 FOR UPDATE`,
    [versionId],
  );
  if (existing.rowCount) {
    const validity = await client.query(
      `SELECT count(*)::int AS count,
      checkpoint_members_hash($1) AS hash FROM version_checkpoint_member WHERE version_id=$1`,
      [versionId],
    );
    if (
      validity.rows[0].count !== Number(existing.rows[0].item_count) ||
      validity.rows[0].hash !== existing.rows[0].members_hash
    )
      fail("checkpoint_integrity_invalid");
    if (reason === "deletion_cut") {
      await validatedSnapshot(
        client,
        versionId,
        Number(version.rows[0].item_count),
        version.rows[0].payload_hash,
        identity.rows[0].project_id,
        reason === "deletion_cut",
      );
      if (existing.rows[0].retention_class !== "required_dependency")
        await client.query(
          `UPDATE version_checkpoint SET reason='deletion_cut',
          retention_class='required_dependency' WHERE version_id=$1`,
          [versionId],
        );
    }
    return "existing";
  }
  const { rows, membersHash } = await validatedSnapshot(
    client,
    versionId,
    Number(version.rows[0].item_count),
    version.rows[0].payload_hash,
    identity.rows[0].project_id,
    reason === "deletion_cut",
  );
  const retention: Retention =
    reason === "deletion_cut" ? "required_dependency" : "rebuildable";
  await client.query(
    `INSERT INTO version_checkpoint
    (version_id,reason,retention_class,item_count,members_hash)
    VALUES ($1,$2,$3,$4,$5)`,
    [versionId, reason, retention, rows.length, membersHash],
  );
  if (rows.length)
    await client.query(
      `INSERT INTO version_checkpoint_member
    (version_id,position,case_id,case_revision_id)
    SELECT $1,x.position::bigint,x.case_id,x.case_revision_id
      FROM jsonb_to_recordset($2::jsonb) AS x(position text,case_id text,case_revision_id text)`,
      [
        versionId,
        JSON.stringify(
          rows.map((row) => ({
            position: row.position,
            case_id: row.case_id,
            case_revision_id: row.case_revision_id,
          })),
        ),
      ],
    );
  const verified = await client.query(
    `SELECT checkpoint_members_hash($1) AS hash,
    (SELECT count(*)::int FROM version_checkpoint_member WHERE version_id=$1) AS count`,
    [versionId],
  );
  if (
    verified.rows[0].hash !== membersHash ||
    verified.rows[0].count !== rows.length
  )
    fail("checkpoint_integrity_invalid");
  return "created";
}

export async function materializePeriodicCheckpoint(
  db: Database,
  versionId: string,
  projectId: string,
): Promise<"created" | "existing" | "skipped"> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await createCheckpoint(
      client,
      versionId,
      "periodic",
      projectId,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
