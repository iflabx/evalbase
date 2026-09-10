import type { PoolClient } from "pg";

import { canonicalJson, sha256 } from "../package/contract.js";
import { ArtifactRepository } from "../storage/artifacts.js";

type Queryable = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{
    rows: Array<Record<string, any>>;
    rowCount?: number | null;
  }>;
};

export type DeletionTargetType = "data_asset" | "test_set_version" | "test_set";

export interface DeletionTarget {
  targetType: DeletionTargetType;
  targetId: string;
}

export interface DeletionClosure {
  target: { type: DeletionTargetType; id: string };
  testSets: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  parsedViews: Array<Record<string, unknown>>;
  sourceRecords: Array<Record<string, unknown>>;
  draftSources: Array<Record<string, unknown>>;
  draftRevisions: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  caseRevisions: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  transformationRuns: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  sharedBlobs: Array<Record<string, unknown>>;
  externalCopies: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  defaultImpacts: Array<Record<string, unknown>>;
}

export const DELETION_REASON_CODES = new Set([
  "owner_requested",
  "nonproduction_test",
  "nonproduction_validation",
  "data_correction",
  "retention_cleanup",
  "other",
]);

export async function lockDeletionBlob(
  queryable: Queryable,
  blobSha256: string,
): Promise<void> {
  await queryable.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `agentbench:deletion-blob:${blobSha256}`,
  ]);
}

function idempotencyKeyDigest(key: string): string {
  // Hash every client key; shape-based detection would preserve a legitimate
  // 64-character hexadecimal key in the post-deletion tombstone.
  return sha256(key);
}

export function deletionReasonValid(
  reasonCode: unknown,
  note: unknown,
): boolean {
  if (typeof reasonCode !== "string" || !DELETION_REASON_CODES.has(reasonCode))
    return false;
  return (
    typeof note === "string" && note.trim().length > 0 && note.length <= 500
  );
}

function sorted<T extends Record<string, unknown>>(rows: T[], key = "id"): T[] {
  return rows.sort((left, right) =>
    String(left[key] ?? "").localeCompare(String(right[key] ?? "")),
  );
}

function addJsonReferences(
  values: unknown,
  assets: Set<string>,
  views: Set<string>,
  versions: Set<string>,
) {
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.assetId === "string") assets.add(item.assetId);
    if (typeof item.parsedViewId === "string") views.add(item.parsedViewId);
    if (item.objectType === "test_set_version" && typeof item.id === "string")
      versions.add(item.id);
    Object.values(item).forEach(visit);
  };
  visit(values);
}

async function rowsFor(
  queryable: Queryable,
  sql: string,
  ids: Set<string>,
  projectId: string,
): Promise<Array<Record<string, any>>> {
  if (!ids.size) return [];
  return (await queryable.query(sql, [[...ids], projectId])).rows;
}

/**
 * Build the user-visible, content-free dependency closure. The closure is
 * deliberately represented by opaque IDs and hashes; raw record values never
 * enter the preview or its hash.
 */
export async function collectDeletionClosure(
  queryable: Queryable,
  projectId: string,
  target: DeletionTarget,
): Promise<DeletionClosure> {
  const assets = new Set<string>();
  const testSets = new Set<string>();
  const views = new Set<string>();
  const drafts = new Set<string>();
  const candidates = new Set<string>();
  const revisions = new Set<string>();
  const versions = new Set<string>();
  const runs = new Set<string>();
  const includeTestSetDrafts = target.targetType === "test_set";

  if (target.targetType === "data_asset") assets.add(target.targetId);
  if (target.targetType === "test_set_version") versions.add(target.targetId);
  if (target.targetType === "test_set") {
    const testSet = await queryable.query(
      "SELECT id FROM test_set WHERE id = $1 AND project_id = $2",
      [target.targetId, projectId],
    );
    if (!testSet.rows.length)
      throw Object.assign(new Error("deletion_target_not_found"), {
        code: "deletion_target_not_found",
      });
    const result = await queryable.query(
      `SELECT ts.id AS test_set_id, v.id
       FROM test_set_version v
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.id = $1 AND ts.project_id = $2`,
      [target.targetId, projectId],
    );
    testSets.add(target.targetId);
    result.rows.forEach((row) => versions.add(String(row.id)));
  }
  if (target.targetType !== "test_set") {
    const targetRow = await queryable.query(
      target.targetType === "data_asset"
        ? "SELECT id FROM data_asset WHERE id = $1 AND project_id = $2"
        : "SELECT v.id, v.test_set_id FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id WHERE v.id = $1 AND ts.project_id = $2",
      [target.targetId, projectId],
    );
    if (!targetRow.rows.length)
      throw Object.assign(new Error("deletion_target_not_found"), {
        code: "deletion_target_not_found",
      });
    if (target.targetType === "test_set_version")
      testSets.add(String(targetRow.rows[0].test_set_id));
  }

  // Every relation is represented by a finite set, so iterate until no new
  // opaque IDs are discovered instead of silently returning a partial closure.
  for (;;) {
    const before = [
      assets.size,
      testSets.size,
      views.size,
      drafts.size,
      candidates.size,
      revisions.size,
      versions.size,
      runs.size,
    ].join(":");

    for (const row of await rowsFor(
      queryable,
      `SELECT id FROM parsed_view
       WHERE asset_id = ANY($1::text[])
         AND EXISTS (SELECT 1 FROM data_asset WHERE id = parsed_view.asset_id AND project_id = $2)`,
      assets,
      projectId,
    ))
      views.add(String(row.id));

    const draftSourceIds = new Set([...assets, ...views]);
    if (includeTestSetDrafts)
      for (const testSetId of testSets) draftSourceIds.add(testSetId);
    if (target.targetType === "test_set_version")
      draftSourceIds.add(target.targetId);
    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT ds.draft_id
       FROM draft_source ds
       JOIN working_draft wd ON wd.id = ds.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2
         AND (ds.asset_id = ANY($1::text[])
              OR ds.parsed_view_id = ANY($1::text[])
              OR wd.test_set_id = ANY($1::text[])
              OR wd.base_version_id = ANY($1::text[]))`,
      draftSourceIds,
      projectId,
    ))
      drafts.add(String(row.draft_id));

    for (const row of await queryable
      .query(
        `SELECT ds.asset_id, ds.parsed_view_id
       FROM draft_source ds
       JOIN working_draft wd ON wd.id = ds.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ds.draft_id = ANY($1::text[]) AND ds.removed_at IS NULL
         AND ts.project_id = $2`,
        [[...drafts], projectId],
      )
      .then((result) => result.rows)) {
      if (row.asset_id) assets.add(String(row.asset_id));
      if (row.parsed_view_id) views.add(String(row.parsed_view_id));
    }

    if (drafts.size) {
      const revisionInputs = await queryable.query(
        `SELECT dr.sources, dr.recipe, dr.base_version_id
         FROM draft_revision dr
         JOIN working_draft wd ON wd.id = dr.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE dr.draft_id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...drafts], projectId],
      );
      for (const row of revisionInputs.rows) {
        addJsonReferences(row.sources, assets, views, versions);
        addJsonReferences(row.recipe, assets, views, versions);
        if (row.base_version_id) versions.add(String(row.base_version_id));
      }
    }

    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT wd.test_set_id
       FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND wd.id = ANY($1::text[])`,
      drafts,
      projectId,
    ))
      testSets.add(String(row.test_set_id));

    for (const row of await rowsFor(
      queryable,
      `SELECT v.candidate_id AS id
       FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2 AND v.id = ANY($1::text[])`,
      versions,
      projectId,
    ))
      candidates.add(String(row.id));

    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT cs.id, cs.draft_id, cs.asset_id, cs.parsed_view_id,
              cs.object_ref, cs.evidence_object_ref, cs.payload_hash,
              cs.evidence_hash, cs.sources, wd.test_set_id
       FROM candidate_snapshot cs
       JOIN working_draft wd ON wd.id = cs.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2
         AND (
           cs.id = ANY($1::text[]) OR cs.draft_id = ANY($1::text[])
           OR cs.asset_id = ANY($1::text[])
           OR cs.parsed_view_id = ANY($1::text[])
           OR EXISTS (
             SELECT 1 FROM candidate_item ci
             WHERE ci.candidate_id = cs.id AND ci.parsed_view_id = ANY($1::text[])
           )
         )`,
      new Set([...candidates, ...drafts, ...assets, ...views]),
      projectId,
    )) {
      candidates.add(String(row.id));
      if (row.draft_id) drafts.add(String(row.draft_id));
      if (row.asset_id) assets.add(String(row.asset_id));
      if (row.parsed_view_id) views.add(String(row.parsed_view_id));
      if (row.test_set_id) testSets.add(String(row.test_set_id));
      addJsonReferences(row.sources, assets, views, versions);
    }

    if (candidates.size) {
      const itemRows = await queryable.query(
        `SELECT ci.candidate_id, ci.parsed_view_id, ci.draft_source_id,
                ci.transformation_run_id, ci.origin_ref,
                pv.asset_id
         FROM candidate_item ci
         JOIN candidate_snapshot cs ON cs.id = ci.candidate_id
         JOIN working_draft wd ON wd.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         LEFT JOIN parsed_view pv ON pv.id = ci.parsed_view_id
         WHERE ci.candidate_id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...candidates], projectId],
      );
      for (const row of itemRows.rows) {
        if (row.parsed_view_id) views.add(String(row.parsed_view_id));
        if (row.asset_id) assets.add(String(row.asset_id));
        if (row.transformation_run_id)
          runs.add(String(row.transformation_run_id));
        addJsonReferences(row.origin_ref, assets, views, versions);
      }
    }

    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT v.id
       FROM test_set_version v
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2
         AND (v.id = ANY($1::text[]) OR v.candidate_id = ANY($1::text[]))`,
      new Set([...versions, ...candidates]),
      projectId,
    ))
      versions.add(String(row.id));

    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT v.test_set_id
       FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2 AND v.id = ANY($1::text[])`,
      versions,
      projectId,
    ))
      testSets.add(String(row.test_set_id));

    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT vm.case_revision_id
       FROM version_member vm
       JOIN test_set_version v ON v.id = vm.version_id
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2 AND vm.version_id = ANY($1::text[])`,
      versions,
      projectId,
    ))
      revisions.add(String(row.case_revision_id));

    // A case revision can be shared by more than one immutable version. Any
    // version that would otherwise retain a now-deleted revision is affected
    // too; propagating here keeps the deletion fail-closed instead of leaving
    // a complete version pointing at tombstoned content.
    for (const row of await rowsFor(
      queryable,
      `SELECT DISTINCT vm.version_id AS id
       FROM version_member vm
       JOIN test_set_version v ON v.id = vm.version_id
       JOIN test_set ts ON ts.id = v.test_set_id
       WHERE ts.project_id = $2 AND vm.case_revision_id = ANY($1::text[])`,
      revisions,
      projectId,
    ))
      versions.add(String(row.id));

    if (revisions.size) {
      const originRows = await queryable.query(
        `SELECT cr.origin_ref, cr.transformation_run_id, cr.parent_revision_id
         FROM case_revision cr
         JOIN test_case tc ON tc.id = cr.case_id
         JOIN test_set ts ON ts.id = tc.test_set_id
         WHERE cr.id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...revisions], projectId],
      );
      for (const row of originRows.rows) {
        if (row.parent_revision_id)
          revisions.add(String(row.parent_revision_id));
        if (row.transformation_run_id)
          runs.add(String(row.transformation_run_id));
        addJsonReferences(row.origin_ref, assets, views, versions);
      }
    }

    {
      for (const row of await rowsFor(
        queryable,
        `SELECT DISTINCT ctr.run_id
       FROM candidate_transformation_run ctr
       JOIN candidate_snapshot cs ON cs.id = ctr.candidate_id
       JOIN working_draft wd ON wd.id = cs.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE ts.project_id = $2 AND ctr.candidate_id = ANY($1::text[])
       UNION
       SELECT DISTINCT tri.run_id
       FROM transformation_run_input tri
       JOIN transformation_run tr ON tr.id = tri.run_id
       WHERE tr.project_id = $2
         AND ((tri.object_type = 'data_asset' AND tri.object_id = ANY($1::text[]))
           OR (tri.object_type = 'test_set_version' AND tri.object_id = ANY($1::text[])))
       UNION
       SELECT DISTINCT tro.run_id
       FROM transformation_run_output tro
       JOIN transformation_run tr ON tr.id = tro.run_id
       WHERE tr.project_id = $2 AND tro.asset_id = ANY($1::text[])`,
        new Set([...candidates, ...assets, ...versions]),
        projectId,
      ))
        runs.add(String(row.run_id));
    }

    if (runs.size) {
      // A run can be frozen into more than one Candidate. Pull every
      // same-project consumer into the closure before deleting run evidence;
      // otherwise an unaffected-looking Candidate could retain the run's
      // prompt or other payload-bearing evidence.
      const candidateRunRows = await queryable.query(
        `SELECT DISTINCT ctr.candidate_id
         FROM candidate_transformation_run ctr
         JOIN transformation_run tr ON tr.id = ctr.run_id
         JOIN candidate_snapshot cs ON cs.id = ctr.candidate_id
         JOIN working_draft wd ON wd.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE ctr.run_id = ANY($1::text[])
           AND tr.project_id = $2 AND ts.project_id = $2`,
        [[...runs], projectId],
      );
      for (const row of candidateRunRows.rows)
        candidates.add(String(row.candidate_id));

      const runRows = await queryable.query(
        `SELECT tr.id, tro.asset_id AS output_asset_id
         FROM transformation_run tr
         LEFT JOIN transformation_run_output tro ON tro.run_id = tr.id
         WHERE tr.project_id = $2 AND tr.id = ANY($1::text[])`,
        [[...runs], projectId],
      );
      for (const row of runRows.rows)
        if (row.output_asset_id) assets.add(String(row.output_asset_id));
      const inputRows = await queryable.query(
        `SELECT object_type, object_id
         FROM transformation_run_input tri
         JOIN transformation_run tr ON tr.id = tri.run_id
         WHERE tr.project_id = $2 AND tri.run_id = ANY($1::text[])`,
        [[...runs], projectId],
      );
      for (const row of inputRows.rows) {
        if (row.object_type === "data_asset") assets.add(String(row.object_id));
        if (row.object_type === "test_set_version")
          versions.add(String(row.object_id));
      }
      const edgeRows = await queryable.query(
        `SELECT output_parsed_view_id, input_type, input_ref
         FROM transformation_record_edge tre
         JOIN transformation_run tr ON tr.id = tre.run_id
         WHERE tr.project_id = $2 AND tre.run_id = ANY($1::text[])`,
        [[...runs], projectId],
      );
      for (const row of edgeRows.rows) {
        if (row.output_parsed_view_id)
          views.add(String(row.output_parsed_view_id));
        const input = row.input_ref as Record<string, unknown> | null;
        if (input?.parsedViewId) views.add(String(input.parsedViewId));
        if (row.input_type === "case_revision" && input?.id)
          revisions.add(String(input.id));
      }
    }

    const after = [
      assets.size,
      testSets.size,
      views.size,
      drafts.size,
      candidates.size,
      revisions.size,
      versions.size,
      runs.size,
    ].join(":");
    if (before === after) break;
  }

  const assetRows = await queryable.query(
    `SELECT da.id, da.blob_sha256, da.object_ref, da.size_bytes, da.file_name,
            da.status, sar.id AS attribution_revision_id
     FROM data_asset da
     LEFT JOIN LATERAL (
       SELECT id FROM source_attribution_revision
       WHERE asset_id = da.id ORDER BY created_at DESC, id DESC LIMIT 1
     ) sar ON true
     WHERE da.id = ANY($1::text[]) AND da.project_id = $2`,
    [[...assets], projectId],
  );
  if (target.targetType === "data_asset" && !assetRows.rows.length)
    throw Object.assign(new Error("deletion_target_not_found"), {
      code: "deletion_target_not_found",
    });

  const viewRows = views.size
    ? await queryable.query(
        `SELECT id, asset_id, status, parser_config_hash, record_count
         FROM parsed_view WHERE id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM data_asset WHERE id = parsed_view.asset_id AND project_id = $2)`,
        [[...views], projectId],
      )
    : { rows: [] };
  const recordRows = views.size
    ? await queryable.query(
        `SELECT sr.parsed_view_id, sr.ordinal, sr.record_hash
         FROM source_record sr
         JOIN parsed_view pv ON pv.id = sr.parsed_view_id
         JOIN data_asset da ON da.id = pv.asset_id
         WHERE sr.parsed_view_id = ANY($1::text[]) AND da.project_id = $2`,
        [[...views], projectId],
      )
    : { rows: [] };
  const draftRows = drafts.size
    ? await queryable.query(
        `SELECT wd.id, wd.test_set_id, wd.status, wd.revision, wd.recipe,
                wd.mapping_revision_id, wd.formal_schema_id,
                mr.mapping AS mapping_revision_mapping,
                mr.unmapped_fields AS mapping_revision_unmapped_fields,
                mr.unmapped_confirmed AS mapping_revision_unmapped_confirmed,
                fs.dialect AS formal_schema_dialect, fs.mode AS formal_schema_mode,
                fs.input_schema AS formal_schema_input,
                fs.expected_output_schema AS formal_schema_output,
                current_dr.id AS draft_revision_id,
                current_dr.revision AS draft_revision_number,
                current_dr.revision_hash AS draft_revision_hash
         FROM working_draft wd
         LEFT JOIN mapping_revision mr ON mr.id = wd.mapping_revision_id
         LEFT JOIN formal_schema_revision fs ON fs.id = wd.formal_schema_id
         LEFT JOIN LATERAL (
           SELECT dr.id, dr.revision, dr.revision_hash
           FROM draft_revision dr
           WHERE dr.draft_id = wd.id
           ORDER BY (dr.revision = wd.revision) DESC, dr.revision DESC, dr.id DESC
           LIMIT 1
         ) current_dr ON true
         WHERE wd.id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM test_set WHERE id = wd.test_set_id AND project_id = $2)`,
        [[...drafts], projectId],
      )
    : { rows: [] };
  const draftSourceRows = drafts.size
    ? await queryable.query(
        `SELECT ds.id, ds.draft_id, ds.asset_id, ds.parsed_view_id,
                ds.position, ds.removed_at, ds.mapping, ds.unmapped_fields,
                ds.unmapped_confirmed
         FROM draft_source ds
         JOIN working_draft wd ON wd.id = ds.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE ds.draft_id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...drafts], projectId],
      )
    : { rows: [] };
  const draftRevisionRows = drafts.size
    ? await queryable.query(
        `SELECT dr.id, dr.draft_id, dr.revision, dr.recipe, dr.sources,
                dr.operations, dr.schema_revision_id, dr.base_version_id,
                dr.version_description, dr.revision_hash
         FROM draft_revision dr
         JOIN working_draft wd ON wd.id = dr.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE dr.draft_id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...drafts], projectId],
      )
    : { rows: [] };
  const candidateRows = candidates.size
    ? await queryable.query(
        `SELECT id, draft_id, payload_hash, evidence_hash, object_ref, evidence_object_ref,
                status, recipe, schema_revision_id, draft_revision_id, materializer_version
         FROM candidate_snapshot WHERE id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = candidate_snapshot.draft_id AND ts.project_id = $2
           )`,
        [[...candidates], projectId],
      )
    : { rows: [] };
  const revisionRows = revisions.size
    ? await queryable.query(
        `SELECT cr.id, cr.case_id, cr.content_hash, cr.origin_ref,
                cr.transformation_run_id, cr.parent_revision_id
         FROM case_revision cr
         WHERE cr.id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM test_case tc JOIN test_set ts ON ts.id = tc.test_set_id
             WHERE tc.id = cr.case_id AND ts.project_id = $2
           )`,
        [[...revisions], projectId],
      )
    : { rows: [] };
  const versionRows = versions.size
    ? await queryable.query(
        `SELECT v.id, v.test_set_id, v.sequence, v.status, v.manifest_hash,
                v.manifest_object_ref, v.schema_revision_id,
                fs.dialect AS formal_schema_dialect, fs.mode AS formal_schema_mode,
                fs.input_schema AS formal_schema_input,
                fs.expected_output_schema AS formal_schema_output,
                (ts.default_version_id = v.id) AS is_default
         FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
         LEFT JOIN formal_schema_revision fs ON fs.id = v.schema_revision_id
         WHERE v.id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...versions], projectId],
      )
    : { rows: [] };
  const runRows = runs.size
    ? await queryable.query(
        `SELECT id, operation_type, lineage_level, manifest_hash
         FROM transformation_run WHERE id = ANY($1::text[]) AND project_id = $2`,
        [[...runs], projectId],
      )
    : { rows: [] };
  const deliveryRows = versions.size
    ? await queryable.query(
        `SELECT dr.id, dr.version_id, dr.status, dr.object_ref, dr.delivery_hash,
                dr.package_type, dr.external_copy_recorded
         FROM delivery_record dr
         JOIN test_set_version v ON v.id = dr.version_id
         JOIN test_set ts ON ts.id = v.test_set_id
         WHERE dr.version_id = ANY($1::text[]) AND ts.project_id = $2`,
        [[...versions], projectId],
      )
    : { rows: [] };
  const testSetRows = testSets.size
    ? await queryable.query(
        `SELECT id, status FROM test_set WHERE id = ANY($1::text[]) AND project_id = $2`,
        [[...testSets], projectId],
      )
    : { rows: [] };

  const scopeCheck = (
    name: string,
    expected: Set<string>,
    rows: Array<Record<string, any>>,
  ) => {
    if (rows.length !== expected.size)
      throw Object.assign(new Error(`deletion_scope_mismatch:${name}`), {
        code: "deletion_scope_mismatch",
      });
  };
  scopeCheck("asset", assets, assetRows.rows);
  scopeCheck("view", views, viewRows.rows);
  scopeCheck("draft", drafts, draftRows.rows);
  scopeCheck("candidate", candidates, candidateRows.rows);
  scopeCheck("revision", revisions, revisionRows.rows);
  scopeCheck("version", versions, versionRows.rows);
  scopeCheck("run", runs, runRows.rows);
  scopeCheck("test_set", testSets, testSetRows.rows);

  if (draftSourceRows.rows.some((row) => !drafts.has(String(row.draft_id))))
    throw Object.assign(new Error("deletion_scope_mismatch:draft_source"), {
      code: "deletion_scope_mismatch",
    });
  if (draftRevisionRows.rows.some((row) => !drafts.has(String(row.draft_id))))
    throw Object.assign(new Error("deletion_scope_mismatch:draft_revision"), {
      code: "deletion_scope_mismatch",
    });

  const blobHashes = [
    ...new Set(assetRows.rows.map((row) => String(row.blob_sha256))),
  ];
  const sharedRows = blobHashes.length
    ? await queryable.query(
        `SELECT blob_sha256,
                array_agg(id ORDER BY id) FILTER (WHERE project_id = $2) AS asset_ids,
                bool_or(project_id <> $2) AS has_external_reference
         FROM data_asset
         WHERE blob_sha256 = ANY($1::text[])
         GROUP BY blob_sha256`,
        [blobHashes, projectId],
      )
    : { rows: [] };
  const sharedBlobs = sharedRows.rows.map((row) => {
    const assetIds = ((row.asset_ids as string[] | null) ?? []).map(String);
    return {
      sha256: row.blob_sha256,
      assetIds,
      opaqueObjectId: assetIds.length ? `blob:${assetIds[0]}` : null,
      deleteObject:
        !row.has_external_reference && assetIds.every((id) => assets.has(id)),
    };
  });
  const externalCopies = deliveryRows.rows
    .filter(
      (row) =>
        row.external_copy_recorded ||
        ["downloaded", "user_confirmed_imported"].includes(row.status),
    )
    .map((row) => ({
      deliveryId: row.id,
      versionId: row.version_id,
      dispositionId: `external-copy:${row.id}`,
      disposition: "manual_external_copy_review",
      status: "not_recalled_or_verified",
    }));
  const artifacts = [
    ...assetRows.rows
      .filter(
        (row) =>
          sharedBlobs.find((blob) => blob.sha256 === row.blob_sha256)
            ?.deleteObject !== false,
      )
      .map((row) => ({
        type: "data_asset_blob",
        id: row.id,
        objectRef: row.object_ref,
      })),
    ...candidateRows.rows.flatMap((row) =>
      [
        ["candidate_payload", row.object_ref],
        ["candidate_evidence", row.evidence_object_ref],
      ]
        .filter(
          (item): item is [string, string] =>
            typeof item[1] === "string" && item[1].length > 0,
        )
        .map(([type, objectRef]) => ({ type, id: row.id, objectRef })),
    ),
    ...deliveryRows.rows.map((row) => ({
      type: "delivery",
      id: row.id,
      objectRef: row.object_ref,
    })),
    ...versionRows.rows
      .filter(
        (row) =>
          typeof row.manifest_object_ref === "string" &&
          row.manifest_object_ref.length > 0,
      )
      .map((row) => ({
        type: "version_manifest",
        id: row.id,
        objectRef: row.manifest_object_ref,
      })),
    ...sharedBlobs
      .filter((row) => row.deleteObject)
      .map((row) => ({
        type: "shared_blob",
        id: row.opaqueObjectId,
        objectRef: `blobs/sha256/${row.sha256}`,
      })),
  ];
  const closure: DeletionClosure = {
    target: { type: target.targetType, id: target.targetId },
    testSets: sorted(
      testSetRows.rows.map((row) => ({ id: row.id, status: row.status })),
    ),
    assets: sorted(
      assetRows.rows.map((row) => ({
        id: row.id,
        blobSha256: row.blob_sha256,
        attributionRevisionId: row.attribution_revision_id ?? null,
        sizeBytes: Number(row.size_bytes),
        status: row.status,
      })),
    ),
    parsedViews: sorted(
      viewRows.rows.map((row) => ({
        id: row.id,
        assetId: row.asset_id,
        status: row.status,
        parserConfigHash: row.parser_config_hash,
        recordCount:
          row.record_count === null ? null : Number(row.record_count),
      })),
    ),
    sourceRecords: sorted(
      recordRows.rows.map((row) => ({
        id: `${row.parsed_view_id}:${row.ordinal}`,
        parsedViewId: row.parsed_view_id,
        ordinal: Number(row.ordinal),
        recordHash: row.record_hash,
      })),
    ),
    drafts: sorted(
      draftRows.rows.map((row) => ({
        id: row.id,
        testSetId: row.test_set_id,
        status: row.status,
        revision: Number(row.revision),
        recipeHash:
          row.recipe === null || typeof row.recipe === "undefined"
            ? null
            : sha256(canonicalJson(row.recipe)),
        mappingRevisionId: row.mapping_revision_id ?? null,
        mappingRevisionHash:
          row.mapping_revision_id === null ||
          typeof row.mapping_revision_id === "undefined"
            ? null
            : sha256(
                canonicalJson({
                  mapping: row.mapping_revision_mapping,
                  unmappedFields: row.mapping_revision_unmapped_fields,
                  unmappedConfirmed: row.mapping_revision_unmapped_confirmed,
                }),
              ),
        formalSchemaId: row.formal_schema_id ?? null,
        formalSchemaHash:
          row.formal_schema_id === null ||
          typeof row.formal_schema_id === "undefined"
            ? null
            : sha256(
                canonicalJson({
                  dialect: row.formal_schema_dialect,
                  mode: row.formal_schema_mode,
                  input: row.formal_schema_input,
                  expectedOutput: row.formal_schema_output,
                }),
              ),
        draftRevisionId: row.draft_revision_id ?? null,
        draftRevisionNumber:
          row.draft_revision_number === null ||
          typeof row.draft_revision_number === "undefined"
            ? null
            : Number(row.draft_revision_number),
        draftRevisionHash: row.draft_revision_hash ?? null,
      })),
    ),
    draftSources: sorted(
      draftSourceRows.rows.map((row) => ({
        id: row.id,
        draftId: row.draft_id,
        assetId: row.asset_id,
        parsedViewId: row.parsed_view_id,
        position: Number(row.position),
        removedAt: row.removed_at
          ? new Date(row.removed_at).toISOString()
          : null,
        mappingHash:
          row.mapping === null || typeof row.mapping === "undefined"
            ? null
            : sha256(
                canonicalJson({
                  mapping: row.mapping,
                  unmappedFields: row.unmapped_fields,
                  unmappedConfirmed: row.unmapped_confirmed,
                }),
              ),
      })),
      "id",
    ),
    draftRevisions: sorted(
      draftRevisionRows.rows.map((row) => ({
        id: row.id,
        draftId: row.draft_id,
        revision: Number(row.revision),
        recipeHash:
          row.recipe === null || typeof row.recipe === "undefined"
            ? null
            : sha256(canonicalJson(row.recipe)),
        sourcesHash:
          row.sources === null || typeof row.sources === "undefined"
            ? null
            : sha256(canonicalJson(row.sources)),
        operationsHash:
          row.operations === null || typeof row.operations === "undefined"
            ? null
            : sha256(canonicalJson(row.operations)),
        schemaRevisionId: row.schema_revision_id ?? null,
        baseVersionId: row.base_version_id ?? null,
        versionDescriptionHash: sha256(
          canonicalJson(row.version_description ?? ""),
        ),
        revisionHash: row.revision_hash,
      })),
      "id",
    ),
    candidates: sorted(
      candidateRows.rows.map((row) => ({
        id: row.id,
        draftId: row.draft_id,
        payloadHash: row.payload_hash,
        evidenceHash: row.evidence_hash,
        status: row.status,
        recipeHash:
          row.recipe === null || typeof row.recipe === "undefined"
            ? null
            : sha256(canonicalJson(row.recipe)),
        schemaRevisionId: row.schema_revision_id ?? null,
        materializerVersion: row.materializer_version ?? null,
        draftRevisionId: row.draft_revision_id ?? null,
      })),
    ),
    caseRevisions: sorted(
      revisionRows.rows.map((row) => ({
        id: row.id,
        caseId: row.case_id,
        contentHash: row.content_hash,
      })),
    ),
    versions: sorted(
      versionRows.rows.map((row) => ({
        id: row.id,
        testSetId: row.test_set_id,
        sequence: Number(row.sequence),
        status: row.status,
        manifestHash: row.manifest_hash,
        schemaRevisionId: row.schema_revision_id ?? null,
        schemaRevisionHash:
          row.schema_revision_id === null ||
          typeof row.schema_revision_id === "undefined"
            ? null
            : sha256(
                canonicalJson({
                  dialect: row.formal_schema_dialect,
                  mode: row.formal_schema_mode,
                  input: row.formal_schema_input,
                  expectedOutput: row.formal_schema_output,
                }),
              ),
        isDefault: Boolean(row.is_default),
      })),
    ),
    transformationRuns: sorted(
      runRows.rows.map((row) => ({
        id: row.id,
        operationType: row.operation_type,
        lineageLevel: row.lineage_level,
        manifestHash: row.manifest_hash,
      })),
    ),
    deliveries: sorted(
      deliveryRows.rows.map((row) => ({
        id: row.id,
        versionId: row.version_id,
        status: row.status,
        packageType: row.package_type,
        deliveryHash: row.delivery_hash,
        externalCopyRecorded: Boolean(row.external_copy_recorded),
      })),
    ),
    sharedBlobs: sorted(sharedBlobs),
    externalCopies: sorted(externalCopies, "deliveryId"),
    // Only opaque IDs are part of the preview. Worker-only object references
    // are resolved after the lock is committed, never exposed to callers.
    artifacts: sorted(
      artifacts.map(({ type, id }) => ({ type, id })),
      "id",
    ),
    defaultImpacts: sorted(
      versionRows.rows
        .filter((row) => row.is_default)
        .map((row) => ({
          versionId: row.id,
          testSetId: row.test_set_id,
          action: "clear_default_pointer",
        })),
      "versionId",
    ),
  };
  return closure;
}

export function deletionPreviewHash(closure: DeletionClosure): string {
  return sha256(canonicalJson(closure));
}

export function closureTombstoneObjects(closure: DeletionClosure) {
  const versions = closure.versions.map((version) => version.id);
  return [
    ...closure.assets.map((item) => ({
      type: "data_asset",
      id: item.id,
      priorHash: item.blobSha256,
    })),
    ...closure.parsedViews.map((item) => ({
      type: "parsed_view",
      id: item.id,
      priorHash: item.parserConfigHash,
    })),
    ...closure.candidates.map((item) => ({
      type: "candidate_snapshot",
      id: item.id,
      priorHash: item.payloadHash,
    })),
    ...closure.caseRevisions.map((item) => ({
      type: "case_revision",
      id: item.id,
      priorHash: item.contentHash,
    })),
    ...closure.versions.map((item) => ({
      type: "test_set_version",
      id: item.id,
      priorHash: item.manifestHash,
    })),
    ...closure.transformationRuns.map((item) => ({
      type: "transformation_run",
      id: item.id,
      priorHash: item.manifestHash,
    })),
    ...closure.deliveries.map((item) => ({
      type: "delivery_record",
      id: item.id,
      priorHash: item.deliveryHash,
    })),
    ...closure.sharedBlobs
      .filter((item) => item.deleteObject)
      .map((item) => ({
        type: "data_blob",
        id: item.opaqueObjectId,
        priorHash: item.sha256,
      })),
  ].map((item) => ({ ...item, affectedVersionIds: versions }));
}

export class ControlledDeletionError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message = code,
  ) {
    super(message);
  }
}

async function removeIfPresent(
  artifacts: ArtifactRepository,
  objectRef: string,
) {
  try {
    await artifacts.remove(objectRef);
  } catch (error) {
    const value = error as {
      code?: string;
      statusCode?: number;
      $metadata?: { httpStatusCode?: number };
    };
    const code = String(value.code ?? "");
    const status = value.statusCode ?? value.$metadata?.httpStatusCode;
    if (!["NoSuchKey", "NotFound"].includes(code) && status !== 404)
      throw error;
  }
}

async function deletionObjectRefs(
  db: Queryable,
  artifacts: ArtifactRepository,
  projectId: string,
  closure: DeletionClosure,
): Promise<string[]> {
  const idsByType = new Map<string, string[]>();
  for (const item of closure.artifacts ?? []) {
    if (typeof item.type !== "string" || typeof item.id !== "string") continue;
    const ids = idsByType.get(item.type) ?? [];
    ids.push(item.id);
    idsByType.set(item.type, ids);
  }
  const assetIds = idsByType.get("data_asset_blob") ?? [];
  const candidateIds = [
    ...new Set([
      ...(idsByType.get("candidate_payload") ?? []),
      ...(idsByType.get("candidate_evidence") ?? []),
    ]),
  ];
  const deliveryIds = idsByType.get("delivery") ?? [];
  const manifestIds = idsByType.get("version_manifest") ?? [];
  const targetRows = await db.query(
    `SELECT 'data_asset_blob' AS owner_type, id AS owner_id, object_ref
       FROM data_asset WHERE id = ANY($1::text[]) AND project_id = $5
         AND object_ref IS NOT NULL
     UNION ALL
     SELECT 'candidate_snapshot' AS owner_type, id AS owner_id, object_ref
       FROM candidate_snapshot cs
       WHERE cs.id = ANY($2::text[]) AND cs.object_ref IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = cs.draft_id AND ts.project_id = $5
         )
     UNION ALL
     SELECT 'candidate_snapshot' AS owner_type, id AS owner_id, evidence_object_ref
       FROM candidate_snapshot cs
       WHERE cs.id = ANY($2::text[]) AND cs.evidence_object_ref IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
           WHERE wd.id = cs.draft_id AND ts.project_id = $5
         )
     UNION ALL
     SELECT 'delivery_record' AS owner_type, id AS owner_id, object_ref
       FROM delivery_record dr
       WHERE dr.id = ANY($3::text[]) AND dr.object_ref IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
           WHERE v.id = dr.version_id AND ts.project_id = $5
         )
     UNION ALL
     SELECT 'test_set_version' AS owner_type, id AS owner_id, manifest_object_ref
       FROM test_set_version v
       WHERE v.id = ANY($4::text[]) AND v.manifest_object_ref IS NOT NULL
         AND EXISTS (SELECT 1 FROM test_set ts WHERE ts.id = v.test_set_id AND ts.project_id = $5)`,
    [assetIds, candidateIds, deliveryIds, manifestIds, projectId],
  );
  const targetRefs = targetRows.rows
    .filter((row) => typeof row.object_ref === "string")
    .map((row) => ({
      ownerType: String(row.owner_type),
      ownerId: String(row.owner_id),
      objectRef: String(row.object_ref),
    }));
  const objectRefs = [...new Set(targetRefs.map((row) => row.objectRef))];
  // This is deliberately a global reference scan: an object can be shared by
  // assets in another project, and those references must veto physical delete.
  const allRefs = objectRefs.length
    ? await db.query(
        `SELECT 'data_asset_blob' AS owner_type, id AS owner_id, object_ref
           FROM data_asset WHERE object_ref = ANY($1::text[])
         UNION ALL
         SELECT 'candidate_snapshot' AS owner_type, id AS owner_id, object_ref
           FROM candidate_snapshot WHERE object_ref = ANY($1::text[])
         UNION ALL
         SELECT 'candidate_snapshot' AS owner_type, id AS owner_id, evidence_object_ref
           FROM candidate_snapshot WHERE evidence_object_ref = ANY($1::text[])
         UNION ALL
         SELECT 'delivery_record' AS owner_type, id AS owner_id, object_ref
           FROM delivery_record WHERE object_ref = ANY($1::text[])
         UNION ALL
         SELECT 'test_set_version' AS owner_type, id AS owner_id, manifest_object_ref
           FROM test_set_version WHERE manifest_object_ref = ANY($1::text[])`,
        [objectRefs],
      )
    : { rows: [] };
  const closureOwners = new Set<string>([
    ...assetIds.map((id) => `data_asset_blob:${id}`),
    ...candidateIds.map((id) => `candidate_snapshot:${id}`),
    ...deliveryIds.map((id) => `delivery_record:${id}`),
    ...manifestIds.map((id) => `test_set_version:${id}`),
  ]);
  const deferredAssetIds = new Set(
    closure.assets
      .filter((asset) =>
        closure.sharedBlobs.some(
          (blob) =>
            blob.sha256 === asset.blobSha256 && blob.deleteObject === false,
        ),
      )
      .map((asset) => String(asset.id)),
  );
  const safeRef = (objectRef: string) =>
    !allRefs.rows.some(
      (row) =>
        String(row.object_ref) === objectRef &&
        !closureOwners.has(`${row.owner_type}:${row.owner_id}`),
    );
  const refs = new Set<string>();
  for (const row of targetRefs)
    if (
      (row.ownerType !== "data_asset_blob" ||
        !deferredAssetIds.has(row.ownerId)) &&
      safeRef(row.objectRef)
    )
      refs.add(row.objectRef);

  // Candidate evidence is a content-addressed collection: protect both its
  // descriptor and any child object still referenced by an unaffected candidate.
  // Evidence descriptors may be shared across project boundaries; scan all
  // candidates so a cross-project child reference remains protected.
  const evidenceRows = await db.query(
    `SELECT id, evidence_object_ref FROM candidate_snapshot
     WHERE evidence_object_ref IS NOT NULL`,
  );
  const targetEvidenceRows = candidateIds.length
    ? await db.query(
        `SELECT cs.evidence_object_ref FROM candidate_snapshot cs
         JOIN working_draft wd ON wd.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE cs.id = ANY($1::text[]) AND ts.project_id = $2
           AND cs.evidence_object_ref IS NOT NULL`,
        [candidateIds, projectId],
      )
    : { rows: [] };
  const targetEvidenceRefs = new Set(
    targetEvidenceRows.rows.map((row) => String(row.evidence_object_ref)),
  );
  const collectionChildren = new Map<string, Set<string>>();
  const readCollection = async (row: Record<string, any>) => {
    const descriptor = String(row.evidence_object_ref);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        (await artifacts.readBytes(descriptor, 1_000_000)).toString("utf8"),
      );
    } catch (error) {
      const value = error as { code?: string; statusCode?: number };
      if (
        ["NoSuchKey", "NotFound"].includes(String(value.code ?? "")) ||
        value.statusCode === 404
      )
        return;
      throw error;
    }
    const objects =
      parsed && typeof parsed === "object" && "objects" in parsed
        ? (parsed as { objects?: unknown }).objects
        : undefined;
    if (!Array.isArray(objects)) return;
    const children = new Set(
      objects
        .map((object) =>
          object && typeof object === "object" && "objectRef" in object
            ? (object as { objectRef?: unknown }).objectRef
            : undefined,
        )
        .filter(
          (ref): ref is string => typeof ref === "string" && ref.length > 0,
        ),
    );
    collectionChildren.set(descriptor, children);
  };
  // Bound MinIO round trips when historical candidates make the descriptor set large.
  for (let offset = 0; offset < evidenceRows.rows.length; offset += 16)
    await Promise.all(
      evidenceRows.rows
        .slice(offset, offset + 16)
        .map((row) => readCollection(row)),
    );
  for (const descriptor of targetEvidenceRefs) {
    const children = collectionChildren.get(descriptor) ?? new Set<string>();
    for (const child of children) {
      const referencedByUnaffected = evidenceRows.rows.some(
        (candidate) =>
          !closureOwners.has(`candidate_snapshot:${candidate.id}`) &&
          collectionChildren
            .get(String(candidate.evidence_object_ref))
            ?.has(child),
      );
      if (!referencedByUnaffected) refs.add(child);
    }
  }

  // Data-asset blob hashes can be shared even when legacy rows used different
  // object refs; retain the explicit hash guard for that migration case.
  const targetAssetRows = await db.query(
    `SELECT id, object_ref, blob_sha256 FROM data_asset
     WHERE id = ANY($1::text[]) AND project_id = $2`,
    [assetIds, projectId],
  );
  const blobHashes = [
    ...new Set(targetAssetRows.rows.map((row) => String(row.blob_sha256))),
  ];
  if (blobHashes.length) {
    // Blob hashes are global content-addressed references, so cross-project
    // assets intentionally participate in this safety check.
    const blobRefs = await db.query(
      `SELECT blob_sha256, array_agg(id) AS asset_ids
       FROM data_asset WHERE blob_sha256 = ANY($1::text[])
       GROUP BY blob_sha256`,
      [blobHashes],
    );
    const deletableHashes = new Set(
      blobRefs.rows
        .filter((row) =>
          (row.asset_ids as string[]).every((id) =>
            assetIds.includes(String(id)),
          ),
        )
        .map((row) => String(row.blob_sha256)),
    );
    for (const row of targetAssetRows.rows)
      if (!deletableHashes.has(String(row.blob_sha256)))
        refs.delete(String(row.object_ref));
  }
  return [...refs].filter(Boolean);
}

export async function executeControlledDeletion(
  db: Queryable,
  artifacts: ArtifactRepository,
  eventId: string,
  projectId: string,
  expectedPreviewHash: string,
): Promise<Record<string, unknown>> {
  const event = await db.query(
    `SELECT id, project_id, status, stage, preview_hash, closure, reason_code, reason_note,
            initiated_by, confirmed_by, initiated_at, confirmed_at,
            external_copy_dispositions
     FROM deletion_event WHERE id = $1 AND project_id = $2`,
    [eventId, projectId],
  );
  if (!event.rows.length)
    throw new ControlledDeletionError("deletion_event_not_found", "load");
  if (
    typeof expectedPreviewHash !== "string" ||
    expectedPreviewHash !== event.rows[0].preview_hash
  )
    throw new ControlledDeletionError("deletion_job_payload_mismatch", "load");
  if (event.rows[0].status === "completed")
    return { eventId, status: "completed" };
  const closure = event.rows[0].closure as DeletionClosure;
  const deferredBlobTombstones: Array<{
    type: "data_blob";
    id: string;
    priorHash: string;
    affectedVersionIds: string[];
  }> = [];
  await db.query(
    `UPDATE deletion_event SET status = 'running', stage = 'payload_removal'
     WHERE id = $1 AND project_id = $2
       AND status IN ('confirmed', 'failed', 'running')`,
    [eventId, event.rows[0].project_id],
  );
  try {
    const refs = await deletionObjectRefs(
      db,
      artifacts,
      event.rows[0].project_id,
      closure,
    );
    for (const objectRef of refs) await removeIfPresent(artifacts, objectRef);
  } catch (error) {
    const value = error as { code?: string };
    throw new ControlledDeletionError(
      value.code ?? "artifact_delete_failed",
      "payload_removal",
    );
  }

  const client = await (
    db as { connect?: () => Promise<PoolClient> }
  ).connect?.();
  if (!client)
    throw new ControlledDeletionError("database_unavailable", "finalize");
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, project_id, status, reason_code, reason_note, initiated_by,
              initiated_at, confirmed_at
       FROM deletion_event WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [eventId, event.rows[0].project_id],
    );
    if (!locked.rows.length)
      throw new ControlledDeletionError("deletion_event_not_found", "finalize");
    if (locked.rows[0].status === "completed") {
      await client.query("COMMIT");
      return { eventId, status: "completed" };
    }
    if (!["confirmed", "running", "failed"].includes(locked.rows[0].status))
      throw new ControlledDeletionError("deletion_not_executable", "finalize");
    const projectId = locked.rows[0].project_id;
    const assetIds = closure.assets.map((item) => item.id as string);
    const viewIds = closure.parsedViews.map((item) => item.id as string);
    const candidateIds = closure.candidates.map((item) => item.id as string);
    const revisionIds = closure.caseRevisions.map((item) => item.id as string);
    const versionIds = closure.versions.map((item) => item.id as string);
    const deliveryIds = closure.deliveries.map((item) => item.id as string);
    const draftIds = closure.drafts.map((item) => item.id as string);
    const runIds = closure.transformationRuns.map((item) => item.id as string);
    const assetBlobRows = assetIds.length
      ? await client.query(
          `SELECT id, blob_sha256, object_ref
           FROM data_asset
           WHERE id = ANY($1::text[]) AND project_id = $2
           ORDER BY id FOR UPDATE`,
          [assetIds, projectId],
        )
      : { rows: [] };
    for (const row of assetBlobRows.rows)
      if (typeof row.blob_sha256 === "string")
        await lockDeletionBlob(client, row.blob_sha256);
    const deferredBlobRows = assetBlobRows.rows.filter((row) =>
      closure.sharedBlobs.some(
        (blob) =>
          blob.sha256 === row.blob_sha256 && blob.deleteObject === false,
      ),
    );

    if (viewIds.length) {
      await client.query(
        `DELETE FROM source_record sr
         USING parsed_view pv JOIN data_asset da ON da.id = pv.asset_id
         WHERE sr.parsed_view_id = ANY($1::text[]) AND pv.id = sr.parsed_view_id
           AND da.project_id = $2`,
        [viewIds, projectId],
      );
      await client.query(
        `DELETE FROM parsed_view_exclusion pve
         USING parsed_view pv JOIN data_asset da ON da.id = pv.asset_id
         WHERE pve.parsed_view_id = ANY($1::text[]) AND pv.id = pve.parsed_view_id
           AND da.project_id = $2`,
        [viewIds, projectId],
      );
      await client.query(
        `UPDATE parsed_view SET status = 'tombstoned', record_count = 0,
          success_count = 0, failure_count = 0, field_summary = NULL,
          error_summary = NULL, draft_eligible = false, parser_config = '{}'::jsonb
         WHERE id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM data_asset da
             WHERE da.id = parsed_view.asset_id AND da.project_id = $2
           )`,
        [viewIds, projectId],
      );
    }
    if (candidateIds.length) {
      await client.query(
        `UPDATE candidate_snapshot cs SET status = 'tombstoned', item_count = 0,
          payload_hash = NULL, evidence_hash = NULL, object_ref = NULL,
          evidence_object_ref = NULL, recipe = NULL, sources = NULL,
          validation_report = NULL, attribution_revision_id = NULL,
          asset_id = NULL, parsed_view_id = NULL, schema_revision_id = NULL,
          draft_revision_id = NULL, base_version_id = NULL
         WHERE cs.id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = cs.draft_id AND ts.project_id = $2
           )`,
        [candidateIds, projectId],
      );
      await client.query(
        `DELETE FROM candidate_transformation_run ctr
         USING candidate_snapshot cs JOIN working_draft wd ON wd.id = cs.draft_id
         JOIN test_set ts ON ts.id = wd.test_set_id
         WHERE ctr.candidate_id = ANY($1::text[]) AND cs.id = ctr.candidate_id
           AND ts.project_id = $2`,
        [candidateIds, projectId],
      );
      await client.query(
        `UPDATE candidate_item ci SET content_hash = 'deleted', origin_ref = NULL,
          manual_reason = NULL, lineage_fingerprint = NULL, transformation_run_id = NULL
         WHERE ci.candidate_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM candidate_snapshot cs
             JOIN working_draft wd ON wd.id = cs.draft_id
             JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE cs.id = ci.candidate_id AND ts.project_id = $2
           )`,
        [candidateIds, projectId],
      );
    }
    if (revisionIds.length) {
      await client.query(
        `UPDATE case_revision cr SET input = '{}'::jsonb, expected_output = '{}'::jsonb,
          metadata = '{}'::jsonb, content_hash = 'deleted', origin_ref = NULL,
          reason = NULL WHERE cr.id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM test_case tc JOIN test_set ts ON ts.id = tc.test_set_id
             WHERE tc.id = cr.case_id AND ts.project_id = $2
           )`,
        [revisionIds, projectId],
      );
    }
    if (draftIds.length) {
      await client.query(
        `UPDATE working_draft wd
         SET recipe = NULL, formal_schema_id = NULL, mapping_revision_id = NULL,
             base_version_id = NULL, version_description = ''
         WHERE wd.id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM test_set ts WHERE ts.id = wd.test_set_id AND ts.project_id = $2)`,
        [draftIds, projectId],
      );
      await client.query(
        `UPDATE draft_source ds
         SET mapping = NULL, unmapped_fields = '[]'::jsonb,
             unmapped_confirmed = false, removed_at = COALESCE(removed_at, now())
         WHERE ds.draft_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = ds.draft_id AND ts.project_id = $2
           )`,
        [draftIds, projectId],
      );
      await client.query(
        `UPDATE draft_revision dr
         SET recipe = NULL, sources = NULL, operations = '[]'::jsonb,
             schema_revision_id = NULL, base_version_id = NULL,
             version_description = ''
         WHERE dr.draft_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = dr.draft_id AND ts.project_id = $2
           )`,
        [draftIds, projectId],
      );
      await client.query(
        `UPDATE draft_case_operation dco
         SET input = NULL, expected_output = NULL, metadata = NULL,
             reason = NULL, previous_content = NULL, diff = NULL
         WHERE dco.draft_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = dco.draft_id AND ts.project_id = $2
           )`,
        [draftIds, projectId],
      );
      await client.query(
        `UPDATE mapping_revision mr
         SET mapping = '{}'::jsonb, unmapped_fields = '[]'::jsonb,
             unmapped_confirmed = false
         WHERE mr.draft_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = mr.draft_id AND ts.project_id = $2
           )`,
        [draftIds, projectId],
      );
      await client.query(
        `UPDATE formal_schema_proposal fsp
         SET suggestion = '{}'::jsonb
         WHERE fsp.draft_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = fsp.draft_id AND ts.project_id = $2
           )`,
        [draftIds, projectId],
      );
    }
    if (runIds.length) {
      await client.query(
        `DELETE FROM candidate_transformation_run ctr
         USING transformation_run tr, candidate_snapshot cs,
               working_draft wd, test_set ts
         WHERE ctr.run_id = ANY($1::text[]) AND tr.id = ctr.run_id
           AND tr.project_id = $2 AND cs.id = ctr.candidate_id
           AND wd.id = cs.draft_id AND ts.id = wd.test_set_id
           AND ts.project_id = $2`,
        [runIds, projectId],
      );
      await client.query(
        `UPDATE transformation_run tr SET manifest = '{}'::jsonb,
          validation_report = '{}'::jsonb WHERE tr.id = ANY($1::text[])
          AND tr.project_id = $2`,
        [runIds, projectId],
      );
      await client.query(
        `UPDATE transformation_run_annotation tra SET note = ''
         WHERE tra.run_id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM transformation_run tr WHERE tr.id = tra.run_id AND tr.project_id = $2)`,
        [runIds, projectId],
      );
      await client.query(
        `DELETE FROM transformation_run_input tri
         USING transformation_run tr
         WHERE tri.run_id = ANY($1::text[]) AND tr.id = tri.run_id AND tr.project_id = $2`,
        [runIds, projectId],
      );
      await client.query(
        `DELETE FROM transformation_record_edge tre
         USING transformation_run tr
         WHERE tre.run_id = ANY($1::text[]) AND tr.id = tre.run_id AND tr.project_id = $2`,
        [runIds, projectId],
      );
      await client.query(
        `DELETE FROM transformation_run_output tro
         USING transformation_run tr
         WHERE tro.run_id = ANY($1::text[])
           AND tr.id = tro.run_id AND tr.project_id = $2`,
        [runIds, projectId],
      );
    }
    if (deliveryIds.length) {
      await client.query(
        `UPDATE delivery_record dr SET status = 'tombstoned', object_ref = $2,
          deletion_event_id = $3, external_copy_disposition = $4::jsonb
         WHERE dr.id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM test_set_version v JOIN test_set ts ON ts.id = v.test_set_id
             WHERE v.id = dr.version_id AND ts.project_id = $5
           )`,
        [
          deliveryIds,
          `tombstone:${eventId}`,
          eventId,
          JSON.stringify(closure.externalCopies ?? []),
          projectId,
        ],
      );
    }
    if (assetIds.length) {
      await client.query(
        `DELETE FROM source_attribution_revision sar
         USING data_asset da
         WHERE sar.asset_id = ANY($1::text[]) AND da.id = sar.asset_id AND da.project_id = $2`,
        [assetIds, projectId],
      );
      await client.query(
        `UPDATE draft_source ds SET mapping = NULL, unmapped_fields = '[]'::jsonb,
          unmapped_confirmed = false, removed_at = now()
         WHERE ds.asset_id = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM working_draft wd JOIN test_set ts ON ts.id = wd.test_set_id
             WHERE wd.id = ds.draft_id AND ts.project_id = $2
           )`,
        [assetIds, projectId],
      );
      const idempotencyRows = await client.query(
        `SELECT project_id, actor_id, operation, idempotency_key,
                idempotency_key_digest, asset_id
         FROM upload_idempotency
         WHERE project_id = $1 AND asset_id = ANY($2::text[])
         FOR UPDATE`,
        [projectId, assetIds],
      );
      for (const row of idempotencyRows.rows) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `agentbench:upload-idempotency:${row.project_id}:${row.actor_id}:${sha256(String(row.idempotency_key))}`,
        ]);
        await client.query(
          `UPDATE upload_idempotency SET status = 'tombstoned',
            idempotency_key = $5, idempotency_key_digest = $6,
            request_fingerprint = NULL, asset_id = NULL,
            deleted_resource_id = COALESCE(deleted_resource_id, asset_id),
            result_kind = 'idempotency_resource_gone', tombstoned_at = now(), updated_at = now()
           WHERE project_id = $1 AND actor_id = $2 AND operation = $3
             AND idempotency_key = $4`,
          [
            row.project_id,
            row.actor_id,
            row.operation,
            row.idempotency_key,
            `tombstone:${eventId}:${idempotencyKeyDigest(String(row.idempotency_key))}`,
            row.idempotency_key_digest ??
              idempotencyKeyDigest(String(row.idempotency_key)),
          ],
        );
      }
      await client.query(
        `UPDATE data_asset da SET status = 'tombstoned', blob_sha256 = '', object_ref = $2,
          size_bytes = 0, mime_type = 'application/octet-stream', file_name = ''
         WHERE da.project_id = $1 AND da.id = ANY($3::text[])`,
        [projectId, `tombstone:${eventId}`, assetIds],
      );
    }
    if (deferredBlobRows.length) {
      const blobHashes = [
        ...new Set(
          deferredBlobRows
            .map((row) => row.blob_sha256)
            .filter((hash): hash is string => typeof hash === "string"),
        ),
      ];
      const activeBlobRefs = blobHashes.length
        ? await client.query(
            `SELECT DISTINCT blob_sha256
             FROM data_asset
             WHERE blob_sha256 = ANY($1::text[])
               AND status NOT IN ('deletion_pending', 'tombstoned')`,
            [blobHashes],
          )
        : { rows: [] };
      const activeHashes = new Set(
        activeBlobRefs.rows.map((row) => String(row.blob_sha256)),
      );
      const deletedHashes = new Set<string>();
      for (const row of deferredBlobRows) {
        const blobSha256 = String(row.blob_sha256);
        if (activeHashes.has(blobSha256) || deletedHashes.has(blobSha256))
          continue;
        const lock = await client.query(
          `INSERT INTO deletion_lock (event_id, project_id, object_type, object_id)
           VALUES ($1, $2, 'data_blob', $3)
           ON CONFLICT (object_type, object_id) DO NOTHING
           RETURNING event_id`,
          [eventId, projectId, blobSha256],
        );
        if (!lock.rowCount) {
          const existing = await client.query(
            `SELECT event_id FROM deletion_lock
             WHERE object_type = 'data_blob' AND object_id = $1`,
            [blobSha256],
          );
          if (existing.rows[0]?.event_id !== eventId) continue;
        }
        try {
          await removeIfPresent(
            artifacts,
            typeof row.object_ref === "string"
              ? row.object_ref
              : `blobs/sha256/${blobSha256}`,
          );
          await removeIfPresent(artifacts, `markers/sha256/${blobSha256}.json`);
        } catch {
          throw new ControlledDeletionError(
            "artifact_delete_failed",
            "payload_removal",
          );
        }
        deferredBlobTombstones.push({
          type: "data_blob",
          id: String(
            closure.sharedBlobs.find((blob) => blob.sha256 === blobSha256)
              ?.opaqueObjectId ?? `blob:${String(row.id)}`,
          ),
          priorHash: blobSha256,
          affectedVersionIds: versionIds,
        });
        deletedHashes.add(blobSha256);
      }
    }
    // Blob locks only protect the physical delete window. Other object locks
    // remain as tombstone guards after completion.
    await client.query(
      `DELETE FROM deletion_lock
       WHERE event_id = $1 AND project_id = $2 AND object_type = 'data_blob'`,
      [eventId, projectId],
    );
    if (versionIds.length) {
      await client.query(
        `UPDATE test_set_version v SET manifest_object_ref = $2
         WHERE v.id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM test_set ts WHERE ts.id = v.test_set_id AND ts.project_id = $3)`,
        [versionIds, `tombstone:${eventId}`, projectId],
      );
      await client.query(
        `UPDATE test_set_version v SET status = 'degraded_by_deletion'
         WHERE v.id = ANY($1::text[])
           AND EXISTS (SELECT 1 FROM test_set ts WHERE ts.id = v.test_set_id AND ts.project_id = $2)`,
        [versionIds, projectId],
      );
      await client.query(
        `UPDATE test_set ts SET default_version_id = NULL
         WHERE ts.project_id = $1 AND ts.default_version_id = ANY($2::text[])`,
        [projectId, versionIds],
      );
      await client.query(
        `UPDATE test_set ts SET status = 'unavailable_by_deletion'
         WHERE ts.project_id = $1 AND ts.id = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM test_set_version v WHERE v.test_set_id = ts.id AND v.status <> 'degraded_by_deletion')`,
        [projectId, closure.testSets.map((item) => item.id as string)],
      );
    }

    for (const item of [
      ...closureTombstoneObjects(closure),
      ...deferredBlobTombstones,
    ]) {
      await client.query(
        `INSERT INTO deletion_tombstone
         (event_id, object_type, opaque_object_id, prior_hash,
          affected_version_ids, actor_id, reason_code, reason_note,
          initiated_at, confirmed_at, completed_at, result_status)
         SELECT $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,now(),'completed'
         WHERE EXISTS (
           SELECT 1 FROM deletion_event WHERE id = $1 AND project_id = $11
         )
         ON CONFLICT (event_id, object_type, opaque_object_id)
         DO UPDATE SET completed_at = EXCLUDED.completed_at,
           result_status = EXCLUDED.result_status`,
        [
          eventId,
          item.type,
          item.id,
          item.priorHash ?? null,
          JSON.stringify(item.affectedVersionIds),
          locked.rows[0].initiated_by,
          locked.rows[0].reason_code,
          locked.rows[0].reason_note ?? null,
          locked.rows[0].initiated_at,
          locked.rows[0].confirmed_at,
          projectId,
        ],
      );
    }
    const completedClosure = {
      ...closure,
      assets: closure.assets.map(
        ({ fileName: _fileName, objectRef: _objectRef, ...asset }) => asset,
      ),
      candidates: closure.candidates.map(
        ({
          objectRef: _objectRef,
          evidenceObjectRef: _evidenceObjectRef,
          ...candidate
        }) => candidate,
      ),
      deliveries: closure.deliveries.map(
        ({ objectRef: _objectRef, ...delivery }) => delivery,
      ),
      artifacts: [],
    };
    await client.query(
      `UPDATE deletion_event SET status = 'completed', stage = 'completed',
        completed_at = now(), closure = $2, failed_at = NULL,
        failure_code = NULL, failure_message = NULL
       WHERE id = $1 AND project_id = $3`,
      [eventId, completedClosure, projectId],
    );
    await client.query(
      `INSERT INTO audit_event
       (project_id, actor_id, action, object_type, object_id, details)
       VALUES ($1,$2,'deletion_completed','deletion_event',$3,$4)`,
      [
        projectId,
        locked.rows[0].initiated_by,
        eventId,
        { outcome: "completed", externalCopies: closure.externalCopies ?? [] },
      ],
    );
    await client.query("COMMIT");
    return {
      eventId,
      status: "completed",
      affectedVersions: versionIds,
      externalCopies: closure.externalCopies ?? [],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof ControlledDeletionError) throw error;
    throw new ControlledDeletionError("deletion_finalize_failed", "finalize");
  } finally {
    client.release();
  }
}

export async function markDeletionFailure(
  db: Queryable,
  eventId: string,
  projectId: string,
  errorCode: string,
  stage: string,
): Promise<void> {
  await db.query(
    `UPDATE deletion_event SET status = 'failed', stage = $2,
      failed_at = now(), failure_code = $3, failure_message = $3
     WHERE id = $1 AND project_id = $4 AND status <> 'completed'`,
    [eventId, stage, errorCode, projectId],
  );
}
