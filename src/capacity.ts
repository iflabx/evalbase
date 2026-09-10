export const CAPACITY_LIMITS = Object.freeze({
  dataAssetBytes: 50_000_000,
  parsedViewRecords: 10_000,
  draftAssets: 5,
  draftOriginalBytes: 100_000_000,
  draftSourceRecords: 10_000,
  candidateItems: 10_000,
  itemsBytes: 100_000_000,
  inputBytes: 10_000_000,
});

export interface DraftCapacityTotals {
  assets: number;
  originalBytes: number;
  sourceRecords: number;
  largestAssetBytes?: number;
  largestAssetRecords?: number;
}

export const DRAFT_CAPACITY_SQL = `
  SELECT count(*)::int AS assets,
         coalesce(sum(da.size_bytes), 0)::bigint AS original_bytes,
         coalesce(sum(pv.record_count), 0)::int AS source_records,
         coalesce(max(da.size_bytes), 0)::bigint AS largest_asset_bytes,
         coalesce(max(pv.record_count), 0)::int AS largest_asset_records
  FROM draft_source ds
  JOIN data_asset da ON da.id = ds.asset_id
  JOIN parsed_view pv ON pv.id = ds.parsed_view_id
  WHERE ds.draft_id = $1 AND ds.removed_at IS NULL`;

export const CANDIDATE_CAPACITY_SQL = `
  SELECT count(*)::int AS assets,
         coalesce(sum(da.size_bytes), 0)::bigint AS original_bytes,
         coalesce(sum(frozen."recordCount"), 0)::int AS source_records,
         coalesce(max(da.size_bytes), 0)::bigint AS largest_asset_bytes,
         coalesce(max(frozen."recordCount"), 0)::int AS largest_asset_records
  FROM jsonb_to_recordset($1::jsonb) AS frozen("assetId" text, "parsedViewId" text, "recordCount" int)
  JOIN data_asset da ON da.id = frozen."assetId"
  JOIN parsed_view pv ON pv.id = frozen."parsedViewId"`;

export function draftCapacityFromRow(row: Record<string, unknown>) {
  return {
    assets: Number(row.assets),
    originalBytes: Number(row.original_bytes),
    sourceRecords: Number(row.source_records),
    largestAssetBytes: Number(row.largest_asset_bytes),
    largestAssetRecords: Number(row.largest_asset_records),
  };
}

export function draftCapacityExceeded(
  totals: DraftCapacityTotals,
): keyof DraftCapacityTotals | undefined {
  if (totals.assets > CAPACITY_LIMITS.draftAssets) return "assets";
  if (totals.originalBytes > CAPACITY_LIMITS.draftOriginalBytes)
    return "originalBytes";
  if (totals.sourceRecords > CAPACITY_LIMITS.draftSourceRecords)
    return "sourceRecords";
  return undefined;
}
