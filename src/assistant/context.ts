import type { Database } from "../db/pool.js";
import { sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";
import { backgroundCatalog } from "./background.js";
import {
  AssistantError,
  type AssistantScope,
  type Dependency,
} from "./store.js";

/** Rebuild referenced business facts; conversation prose never supplies an identity. */
export async function assistantContext(
  db: Database,
  scope: AssistantScope,
  sessionId: string,
  page?: Dependency,
) {
  const canWrite = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  const [project, history, proposals] = await Promise.all([
    db.query("SELECT name FROM project WHERE id=$1", [scope.projectId]),
    db.query(
      "SELECT user_text,assistant_text,tool_results,dependencies FROM assistant_turn WHERE session_id=$1 AND status<>'running' ORDER BY created_at DESC,id DESC LIMIT 50",
      [sessionId],
    ),
    db.query(
      "SELECT action,status,summary,receipt FROM assistant_proposal WHERE session_id=$1 AND actor_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50",
      [sessionId, scope.actorId],
    ),
  ]);
  const confirmedOperations = proposals.rows
    .filter((p) => p.status === "succeeded")
    .map((p) => {
      const receipt = p.receipt?.receipt ?? p.receipt ?? {};
      return {
        action: p.action,
        status: p.status,
        target: p.summary.target,
        draftRef: receipt.draftId,
        versionRef: receipt.version?.id,
        assetRef: receipt.assetId,
        added: receipt.added,
        updated: receipt.updated,
        adopted: receipt.adopted,
        changedFields: receipt.changedFields,
      };
    });
  const previousCreated: string[] = history.rows
    .flatMap((t) => t.tool_results)
    .filter((t) => t.name === "create_draft" && t.status === "succeeded")
    .map((t) => t.result.draftId);
  const refs: Dependency[] = history.rows.flatMap((t) => t.dependencies);
  const previousPage = refs.find((ref) => ref.focus);
  if (page) refs.push(page);
  for (const op of confirmedOperations) {
    if (op.draftRef) refs.push({ kind: "draft", id: op.draftRef });
    if (op.assetRef) refs.push({ kind: "asset", id: op.assetRef });
    if (op.versionRef) refs.push({ kind: "version", id: op.versionRef });
  }
  const ids = (kind: Dependency["kind"]) => [
    ...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id)),
  ];
  const draftOrder = [
    ...(page?.kind === "draft" ? [page.id] : []),
    ...confirmedOperations.map((op) => op.draftRef).filter(Boolean),
    ...(previousPage?.kind === "draft" ? [previousPage.id] : []),
    ...previousCreated,
  ];
  const [assets, versions, drafts, testSets] = await Promise.all([
    db.query(
      "SELECT da.id,da.file_name AS name,pv.record_count AS count,pv.mapping_ready FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current WHERE da.project_id=$1 AND da.status='stored' AND da.id=ANY($2::text[]) ORDER BY da.file_name,da.id LIMIT 20",
      [scope.projectId, ids("asset")],
    ),
    db.query(
      "SELECT v.id,v.version_label AS label,v.item_count AS count,v.test_set_id,ts.name AS name FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1 AND ts.status='available' AND v.status='published' AND v.id=ANY($2::text[]) ORDER BY v.published_at DESC,v.id LIMIT 20",
      [scope.projectId, ids("version")],
    ),
    canWrite
      ? db.query(
          "SELECT d.id,d.name,d.revision,d.test_set_id,d.parent_version_id,(SELECT count(*)::int FROM collaborative_draft_record r WHERE r.draft_id=d.id AND NOT r.deleted) AS record_count FROM collaborative_draft d WHERE d.project_id=$1 AND d.status='editing' AND d.id=ANY($2::text[]) ORDER BY array_position($3::text[],d.id),d.updated_at DESC,d.id LIMIT 20",
          [scope.projectId, ids("draft"), draftOrder],
        )
      : Promise.resolve({ rows: [] as Record<string, any>[] }),
    db.query(
      "SELECT ts.id,ts.name FROM test_set ts WHERE ts.project_id=$1 AND ts.status='available' AND ts.id=ANY($2::text[]) ORDER BY ts.name,ts.id LIMIT 20",
      [scope.projectId, ids("testSet")],
    ),
  ]);
  const actualByRef = new Map<string, string>();
  const reference = (id: string) => {
    const prefix = id.startsWith("collabdraft_")
      ? "d"
      : id.startsWith("asset_")
        ? "f"
        : id.startsWith("version_")
          ? "v"
          : "o";
    const ref = `${prefix}:${sha256(id).slice(0, 16)}`;
    actualByRef.set(ref, id);
    return ref;
  };
  const convert = (value: unknown, decode: boolean, key = ""): any => {
    if (typeof value === "string") {
      if (!/(^id$|ref$|ids?$|focusDraft$)/i.test(key)) return value;
      if (decode) {
        if (/^[dfvo]:/.test(value) && !actualByRef.has(value))
          throw new AssistantError(422, "assistant_reference_invalid");
        return actualByRef.get(value) ?? value;
      }
      return /^[a-z][a-z0-9]*_[a-f0-9]{24,}(?::\d+)?$/i.test(value)
        ? reference(value)
        : value;
    }
    if (Array.isArray(value))
      return value.map((entry) => convert(entry, decode, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, entry]) => [
          k,
          convert(entry, decode, k),
        ]),
      );
    return value;
  };
  const encode = (value: unknown) => convert(value, false);
  const decode = (value: unknown) => convert(value, true);
  const focusDraft =
    draftOrder.find((id) => drafts.rows.some((d) => d.id === id)) ??
    (drafts.rows.length === 1 ? drafts.rows[0].id : undefined);
  const pageRow =
    page &&
    (page.kind === "draft"
      ? drafts
      : page.kind === "asset"
        ? assets
        : page.kind === "version"
          ? versions
          : testSets
    ).rows.find((r) => r.id === page.id);
  const state = encode({
    backgroundDocuments: await backgroundCatalog(db, scope, sessionId),
    project: project.rows[0]?.name,
    files: assets.rows.map((a) => ({
      ref: a.id,
      name: a.name,
      recordCount: a.count,
      ready: a.mapping_ready,
    })),
    versions: versions.rows.map((v) => ({
      ref: v.id,
      name: v.name,
      label: v.label,
      recordCount: v.count,
      testSetRef: v.test_set_id,
    })),
    drafts: drafts.rows.map((d) => ({
      ref: d.id,
      name: d.name,
      revision: Number(d.revision),
      recordCount: d.record_count,
      testSetRef: d.test_set_id,
      parentVersionRef: d.parent_version_id,
    })),
    focusDraft,
    pageObject: pageRow && {
      kind: page!.kind,
      ref: pageRow.id,
      name: pageRow.name,
      recordCount: pageRow.record_count ?? pageRow.count,
      label: pageRow.label,
    },
    confirmedOperations: confirmedOperations.slice(0, 10),
    pendingOperations: proposals.rows
      .filter((p) => p.status === "pending")
      .slice(0, 10)
      .map((p) => ({ action: p.action, ...p.summary })),
  });
  // Register past references even if their body is omitted from the bounded protocol history.
  encode(history.rows.map((t) => t.tool_results));
  return {
    state,
    encode,
    decode,
    history: history.rows.slice(0, 6).reverse(),
    drafts: drafts.rows,
    focusDraft,
    sessionDrafts: new Set(previousCreated),
    dependencies: [
      ...assets.rows.map((a) => ({ kind: "asset" as const, id: a.id })),
      ...versions.rows.map((v) => ({ kind: "version" as const, id: v.id })),
      ...drafts.rows.map((d) => ({ kind: "draft" as const, id: d.id })),
      ...testSets.rows.map((t) => ({ kind: "testSet" as const, id: t.id })),
    ],
  };
}
