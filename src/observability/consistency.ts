import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { CAPACITY_LIMITS } from "../capacity.js";
import type { Database } from "../db/pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import type { ArtifactRepository } from "../storage/artifacts.js";

export interface ConsistencyFinding {
  project_id: string | null;
  error_code: string;
  object_type: string;
  object_id: string;
}

export interface ConsistencyScanResult {
  scanned: number;
  findings: ConsistencyFinding[];
  hashMismatches: number;
  orphanCount: number;
}

interface Reference {
  projectId: string;
  objectType: string;
  objectId: string;
  objectRef: string;
  expectedHash: string;
  semanticHash?: string;
  itemCount?: number;
  storageFormat?: string;
}

async function hashObject(
  stream: Readable,
): Promise<{ hash: string; size: number }> {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    digest.update(chunk);
    size += Buffer.byteLength(chunk);
  }
  return { hash: digest.digest("hex"), size };
}

interface MarkerObject {
  path: string;
  sha256: string;
  size: number;
}

function markerMismatch(
  bytes: Buffer,
  objectRef: string,
  expectedHash: string,
  expectedSize: number,
): boolean {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      objects?: unknown;
      rootHash?: unknown;
    };
    if (!Array.isArray(parsed.objects) || typeof parsed.rootHash !== "string")
      return true;
    const objects: MarkerObject[] = [];
    for (const value of parsed.objects) {
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { path?: unknown }).path !== "string" ||
        typeof (value as { sha256?: unknown }).sha256 !== "string" ||
        !Number.isSafeInteger((value as { size?: unknown }).size) ||
        ((value as { size: number }).size ?? -1) < 0
      )
        return true;
      objects.push({
        path: (value as { path: string }).path,
        sha256: (value as { sha256: string }).sha256,
        size: (value as { size: number }).size,
      });
    }
    if (sha256(canonicalJson(objects)) !== parsed.rootHash) return true;
    const entry = objects.find((item) => item.path === objectRef);
    return (
      !entry || entry.sha256 !== expectedHash || entry.size !== expectedSize
    );
  } catch {
    return true;
  }
}

async function listObjects(artifacts: ArtifactRepository, prefix: string) {
  const objects = [];
  let startAfter: string | undefined;
  do {
    const page = await artifacts.list(prefix, startAfter, 1000);
    const pageComplete = page.length === 1000;
    objects.push(...page);
    startAfter = page.at(-1)?.key;
    if (!pageComplete) break;
  } while (startAfter);
  return objects;
}

async function listStagingObjects(artifacts: ArtifactRepository) {
  return listObjects(artifacts, "staging/");
}

async function references(
  db: Database,
  objectIds?: string[],
): Promise<Reference[]> {
  const filter = objectIds?.length
    ? "AND base.object_id = ANY($1::text[])"
    : "";
  const query = `
    WITH base AS (
      SELECT da.id AS object_id, da.project_id, da.object_ref,
             da.blob_sha256 AS expected_hash, 'data_asset' AS object_type,
             NULL::text AS semantic_hash, NULL::integer AS item_count,
             da.uploaded_at AS scanned_at, NULL::text AS storage_format
      FROM data_asset da
      WHERE da.object_ref IS NOT NULL
        AND da.status NOT IN ('deletion_pending', 'tombstoned')
      UNION ALL
      SELECT cs.id, ts.project_id, cs.object_ref,
             CASE WHEN v.storage_format = 'delta_v1'
               THEN regexp_replace(v.manifest_object_ref, '^.*/', '')
               ELSE cs.payload_hash END AS expected_hash,
             'candidate_snapshot', NULL::text AS semantic_hash, NULL::integer AS item_count,
             cs.created_at, v.storage_format
      FROM candidate_snapshot cs
      LEFT JOIN test_set_version v ON v.candidate_id = cs.id
      JOIN working_draft wd ON wd.id = cs.draft_id
      JOIN test_set ts ON ts.id = wd.test_set_id
      WHERE cs.object_ref IS NOT NULL
        AND cs.status NOT IN ('deletion_pending', 'tombstoned')
      UNION ALL
      SELECT cs.id, ts.project_id, cs.evidence_object_ref,
             NULL::text AS expected_hash, 'candidate_evidence',
             cs.evidence_hash AS semantic_hash, NULL::integer AS item_count,
             cs.created_at, NULL::text AS storage_format
      FROM candidate_snapshot cs
      JOIN working_draft wd ON wd.id = cs.draft_id
      JOIN test_set ts ON ts.id = wd.test_set_id
      WHERE cs.evidence_object_ref IS NOT NULL
        AND cs.status NOT IN ('deletion_pending', 'tombstoned')
      UNION ALL
      SELECT v.id, ts.project_id, v.manifest_object_ref,
             NULL::text AS expected_hash, 'test_set_version',
             v.manifest_hash AS semantic_hash, v.item_count, v.published_at,
             v.storage_format
      FROM test_set_version v
      JOIN test_set ts ON ts.id = v.test_set_id
      WHERE v.status <> 'degraded_by_deletion'
      UNION ALL
      SELECT dr.id, ts.project_id, dr.object_ref, dr.delivery_hash,
             'delivery_record', NULL::text AS semantic_hash, NULL::integer AS item_count,
             dr.created_at, NULL::text AS storage_format
      FROM delivery_record dr
      JOIN test_set_version v ON v.id = dr.version_id
      JOIN test_set ts ON ts.id = v.test_set_id
      WHERE dr.status NOT IN ('deletion_pending', 'tombstoned')
    )
    SELECT * FROM base WHERE TRUE ${filter}
    ORDER BY scanned_at DESC
  `;
  const result = await db.query(query, objectIds?.length ? [objectIds] : []);
  return result.rows.map((row: Record<string, unknown>) => {
    const objectRef = String(row.object_ref);
    const objectType = String(row.object_type);
    return {
      projectId: String(row.project_id),
      objectType,
      objectId: String(row.object_id),
      objectRef,
      expectedHash:
        objectType === "candidate_evidence" || objectType === "test_set_version"
          ? (objectRef.split("/").pop() as string)
          : String(row.expected_hash),
      semanticHash:
        row.semantic_hash === null || row.semantic_hash === undefined
          ? undefined
          : String(row.semantic_hash),
      itemCount:
        row.item_count === null || row.item_count === undefined
          ? undefined
          : Number(row.item_count),
      storageFormat:
        row.storage_format == null ? undefined : String(row.storage_format),
    };
  });
}

async function inspectReference(
  artifacts: ArtifactRepository,
  reference: Reference,
): Promise<string | undefined> {
  try {
    const structured =
      reference.objectType === "test_set_version" ||
      reference.objectType === "candidate_evidence"
        ? await artifacts.readBytes(
            reference.objectRef,
            reference.objectType === "test_set_version"
              ? CAPACITY_LIMITS.itemsBytes + 20_000_000
              : 1_000_000,
          )
        : undefined;
    const actual = structured
      ? {
          hash: createHash("sha256").update(structured).digest("hex"),
          size: structured.byteLength,
        }
      : await hashObject(await artifacts.read(reference.objectRef));
    if (actual.hash !== reference.expectedHash) return "object_hash_mismatch";
    const markerRef = `markers/sha256/${reference.expectedHash}.json`;
    let marker: Buffer;
    try {
      marker = await artifacts.readBytes(markerRef, 100_000);
    } catch {
      return "marker_missing";
    }
    if (
      markerMismatch(
        marker,
        reference.objectRef,
        reference.expectedHash,
        actual.size,
      )
    )
      return "marker_hash_mismatch";
    if (structured && reference.objectType === "candidate_evidence") {
      const descriptor = JSON.parse(structured.toString("utf8")) as {
        objects?: Array<{
          path?: unknown;
          sha256?: unknown;
          size?: unknown;
          objectRef?: unknown;
        }>;
        rootHash?: string;
      };
      if (!Array.isArray(descriptor.objects)) return "evidence_hash_mismatch";
      const objects: Array<
        MarkerObject & {
          objectRef: string;
        }
      > = [];
      for (const object of descriptor.objects) {
        const size = object.size;
        if (
          typeof object.objectRef !== "string" ||
          typeof object.path !== "string" ||
          typeof object.sha256 !== "string" ||
          !Number.isSafeInteger(size) ||
          (size as number) < 0
        )
          return "evidence_hash_mismatch";
        objects.push({
          path: object.path,
          sha256: object.sha256,
          size: size as number,
          objectRef: object.objectRef,
        });
      }
      if (
        descriptor.rootHash !== sha256(canonicalJson(objects)) ||
        sha256(
          canonicalJson(
            objects
              .map(({ path, sha256: hash, size }) => ({
                path,
                sha256: hash,
                size,
              }))
              .sort((left, right) => left.path.localeCompare(right.path)),
          ),
        ) !== reference.semanticHash
      )
        return "evidence_hash_mismatch";
      for (const object of objects) {
        const child = await hashObject(await artifacts.read(object.objectRef));
        if (child.hash !== object.sha256 || child.size !== object.size)
          return "object_hash_mismatch";
        const childMarker = await artifacts.readBytes(
          `markers/sha256/${object.sha256}.json`,
          100_000,
        );
        if (
          markerMismatch(
            childMarker,
            object.objectRef,
            object.sha256,
            object.size,
          )
        )
          return "marker_hash_mismatch";
      }
    }
    if (structured && reference.objectType === "test_set_version") {
      const manifest = JSON.parse(structured.toString("utf8")) as {
        counts?: { items?: number };
        version?: { version_manifest_hash?: string };
        format?: string;
        format_version?: number;
        item_count?: number;
        manifest_hash?: string;
      };
      if (reference.storageFormat === "delta_v1") {
        if (manifest.item_count !== reference.itemCount)
          return "manifest_count_mismatch";
        if (
          manifest.format !== "evalbase.test-set-delta-manifest" ||
          manifest.format_version !== 1 ||
          manifest.manifest_hash !== reference.semanticHash
        )
          return "manifest_hash_mismatch";
      } else {
        if (Number(manifest.counts?.items) !== reference.itemCount)
          return "manifest_count_mismatch";
        if (manifest.version?.version_manifest_hash !== reference.semanticHash)
          return "manifest_hash_mismatch";
      }
    }
    return undefined;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "NoSuchKey" || code === "NotFound") return "object_missing";
    return "consistency_check_failed";
  }
}

async function upsertFinding(
  db: Database,
  finding: ConsistencyFinding,
  details: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO consistency_finding
       (project_id, error_code, object_type, object_id, details)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (error_code, object_type, object_id) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       details = EXCLUDED.details,
       status = 'open',
       last_seen_at = now(),
       resolved_at = NULL`,
    [
      finding.project_id,
      finding.error_code,
      finding.object_type,
      finding.object_id,
      details,
    ],
  );
}

export async function scanConsistency(
  db: Database,
  artifacts: ArtifactRepository,
  options: { objectIds?: string[]; orphanGraceMs?: number } = {},
): Promise<ConsistencyScanResult> {
  // ponytail: one full read-only scan; add checkpoints if the object catalog outgrows Phase 1A.
  const refs = await references(db, options.objectIds);
  const extraObjectIds: string[] = [];
  for (const reference of refs) {
    const errorCode = await inspectReference(artifacts, reference);
    if (errorCode) {
      await upsertFinding(
        db,
        {
          project_id: reference.projectId,
          error_code: errorCode,
          object_type: reference.objectType,
          object_id: reference.objectId,
        },
        { objectRef: reference.objectRef },
      );
    } else {
      await db.query(
        `UPDATE consistency_finding
         SET status='resolved', resolved_at=now(), last_seen_at=now()
         WHERE error_code IN ('object_missing','object_hash_mismatch',
                              'marker_missing','marker_hash_mismatch',
                              'manifest_count_mismatch','manifest_hash_mismatch',
                              'evidence_hash_mismatch',
                              'consistency_check_failed')
           AND object_type=$1 AND object_id=$2 AND status='open'`,
        [reference.objectType, reference.objectId],
      );
    }
  }

  const memberCounts = await db.query(
    options.objectIds?.length
      ? `SELECT v.id, ts.project_id, v.item_count,
                count(vm.case_revision_id)::int AS actual_count
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         LEFT JOIN LATERAL resolve_version_members_internal(v.id, true, false) vm ON true
         WHERE v.status <> 'degraded_by_deletion'
           AND v.id = ANY($1::text[])
         GROUP BY v.id, ts.project_id, v.item_count`
      : `SELECT v.id, ts.project_id, v.item_count,
                count(vm.case_revision_id)::int AS actual_count
         FROM test_set_version v
         JOIN test_set ts ON ts.id = v.test_set_id
         LEFT JOIN LATERAL resolve_version_members_internal(v.id, true, false) vm ON true
         WHERE v.status <> 'degraded_by_deletion'
         GROUP BY v.id, ts.project_id, v.item_count
         ORDER BY v.published_at DESC
       `,
    options.objectIds?.length ? [options.objectIds] : [],
  );
  const healthyVersions: string[] = [];
  for (const row of memberCounts.rows as Array<Record<string, unknown>>) {
    const objectId = String(row.id);
    if (Number(row.item_count) !== Number(row.actual_count)) {
      extraObjectIds.push(objectId);
      await upsertFinding(
        db,
        {
          project_id: String(row.project_id),
          error_code: "version_member_count_mismatch",
          object_type: "test_set_version",
          object_id: objectId,
        },
        { expected: Number(row.item_count), actual: Number(row.actual_count) },
      );
    } else {
      healthyVersions.push(objectId);
    }
  }
  if (healthyVersions.length) {
    await db.query(
      `UPDATE consistency_finding
       SET status='resolved', resolved_at=now(), last_seen_at=now()
       WHERE error_code='version_member_count_mismatch' AND status='open'
         AND object_id = ANY($1::text[])`,
      [healthyVersions],
    );
  }

  const fullScan = !options.objectIds?.length;
  const orphanCutoff = Date.now() - (options.orphanGraceMs ?? 120_000);
  const referencedMarkerRefs = new Set(
    refs.map((reference) => `markers/sha256/${reference.expectedHash}.json`),
  );
  for (const reference of refs.filter(
    (candidate) => candidate.objectType === "candidate_evidence",
  )) {
    try {
      const descriptor = JSON.parse(
        (await artifacts.readBytes(reference.objectRef, 1_000_000)).toString(
          "utf8",
        ),
      ) as { objects?: Array<{ sha256?: string }> };
      for (const object of descriptor.objects ?? [])
        if (typeof object.sha256 === "string")
          referencedMarkerRefs.add(`markers/sha256/${object.sha256}.json`);
    } catch {
      // The reference finding already records an unreadable collection.
    }
  }
  const stagedOrphans = fullScan
    ? (await listStagingObjects(artifacts)).filter(
        (object) => object.lastModified.getTime() < orphanCutoff,
      )
    : [];
  const markerOrphans = fullScan
    ? (await listObjects(artifacts, "markers/")).filter(
        (object) =>
          object.lastModified.getTime() < orphanCutoff &&
          !referencedMarkerRefs.has(object.key),
      )
    : [];
  const agedOrphans = [...stagedOrphans, ...markerOrphans];
  for (const orphan of agedOrphans) {
    extraObjectIds.push(orphan.key);
    await upsertFinding(
      db,
      {
        project_id: null,
        error_code: "aged_orphan",
        object_type: "storage_object",
        object_id: orphan.key,
      },
      { lastModified: orphan.lastModified.toISOString() },
    );
  }
  if (fullScan)
    await db.query(
      `UPDATE consistency_finding
       SET status='resolved', resolved_at=now(), last_seen_at=now()
       WHERE error_code='aged_orphan' AND status='open'
         AND NOT (object_id = ANY($1::text[]))`,
      [agedOrphans.map((orphan) => orphan.key)],
    );

  const counts = await db.query(
    `SELECT count(*) FILTER (
         WHERE error_code IN ('object_hash_mismatch','marker_missing',
                            'marker_hash_mismatch','manifest_hash_mismatch',
                            'evidence_hash_mismatch')
         AND status='open'
     )::int AS hash_mismatches,
       count(*) FILTER (
         WHERE error_code='aged_orphan' AND status='open'
       )::int AS orphan_count
     FROM consistency_finding`,
  );
  const findings = await db.query(
    `SELECT project_id, error_code, object_type, object_id
     FROM consistency_finding WHERE status='open'
     AND object_id = ANY($1::text[])
     ORDER BY last_seen_at DESC, id DESC`,
    [[...refs.map((reference) => reference.objectId), ...extraObjectIds]],
  );
  return {
    scanned: refs.length,
    findings: findings.rows,
    hashMismatches: Number(counts.rows[0].hash_mismatches),
    orphanCount: Number(counts.rows[0].orphan_count),
  };
}
