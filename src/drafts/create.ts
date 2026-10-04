import {
  guardAssistantCommit,
  type AssistantGuard,
} from "../assistant/fence.js";
import type { Database } from "../db/pool.js";
import { writeBatches } from "../db/batch.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";
import {
  isPlainObject,
  opaqueId,
  displayText,
  readMetadataEntries,
} from "../server/support.js";
export class DraftCreateError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const draftSummary = (row: Record<string, unknown>) => ({
  id: String(row.id),
  projectId: String(row.project_id),
  testSetId: row.test_set_id ? String(row.test_set_id) : null,
  parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
  parentVersionLabel: row.parent_version_label
    ? String(row.parent_version_label)
    : null,
  parentRecordCount:
    row.parent_record_count == null ? null : Number(row.parent_record_count),
  createdBy: row.created_by ? String(row.created_by) : null,
  createdByName: row.created_by
    ? String(row.created_by_name ?? row.created_by_username ?? row.created_by)
    : null,
  createdAt: row.created_at ?? null,
  name: String(row.name),
  purpose: String(row.purpose),
  status: String(row.status),
  suspended:
    row.status === "editing" &&
    ((row.test_set_status !== null && row.test_set_status !== "available") ||
      (row.parent_status !== null && row.parent_status !== "published")),
  revision: Number(row.revision),
  nameRevision: Number(row.name_revision),
  purposeRevision: Number(row.purpose_revision),
  nameUpdatedBy: row.name_updated_by ? String(row.name_updated_by) : null,
  purposeUpdatedBy: row.purpose_updated_by
    ? String(row.purpose_updated_by)
    : null,
  updatedBy: String(row.updated_by),
  updatedByName: String(
    row.updated_by_name ?? row.updated_by_username ?? row.updated_by,
  ),
  updatedAt: row.updated_at,
  publishedVersionId: row.published_version_id
    ? String(row.published_version_id)
    : null,
});
export const draftSelect = `SELECT d.*, ts.status AS test_set_status,
    v.status AS parent_status, v.version_label AS parent_version_label,
    v.item_count AS parent_record_count, published.status AS published_status,
    u.display_name AS updated_by_name, u.username AS updated_by_username,
    creator.display_name AS created_by_name,
    creator.username AS created_by_username FROM collaborative_draft d
    LEFT JOIN test_set ts ON ts.id=d.test_set_id
    LEFT JOIN test_set_version v ON v.id=d.parent_version_id
    LEFT JOIN test_set_version published ON published.id=d.published_version_id
    LEFT JOIN app_user u ON u.id=d.updated_by
    LEFT JOIN app_user creator ON creator.id=d.created_by`;
export const draftLive = (row: Record<string, unknown>) =>
  row.status === "editing" &&
  (row.test_set_status === null || row.test_set_status === "available") &&
  (row.parent_status === null || row.parent_status === "published");

export async function createSharedDraft(
  db: Database,
  scope: {
    projectId: string;
    actorId: string;
    assistantGuard?: AssistantGuard;
  },
  body: unknown,
  key: unknown,
) {
  if (
    !isPlainObject(body) ||
    Object.keys(body).some(
      (k) => !["testSetId", "parentVersionId", "name", "purpose"].includes(k),
    ) ||
    (body.name !== undefined &&
      (typeof body.name !== "string" || body.name.length > 200)) ||
    (body.purpose !== undefined &&
      (typeof body.purpose !== "string" || body.purpose.length > 2000)) ||
    (body.testSetId !== undefined &&
      (body.name !== undefined || body.purpose !== undefined)) ||
    (body.testSetId === undefined) !== (body.parentVersionId === undefined) ||
    (body.testSetId !== undefined &&
      (typeof body.testSetId !== "string" ||
        typeof body.parentVersionId !== "string"))
  )
    throw new DraftCreateError(422, "draft_request_invalid");
  if (
    key !== undefined &&
    (typeof key !== "string" || !key.trim() || key.length > 200)
  )
    throw new DraftCreateError(422, "idempotency_key_invalid");
  const requestHash = sha256(canonicalJson(body));
  const stableId =
    typeof key === "string"
      ? `collabdraft_${sha256(canonicalJson([scope.projectId, scope.actorId, key]))}`
      : undefined;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM app_user WHERE id=$1 FOR SHARE", [
      scope.actorId,
    ]);
    await client.query(
      "SELECT user_id FROM project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE",
      [scope.projectId, scope.actorId],
    );
    if (
      !(await hasProjectCapability(
        client,
        scope.projectId,
        scope.actorId,
        "write",
      ))
    ) {
      await client.query("ROLLBACK");
      throw new DraftCreateError(404, "project_not_found");
    }
    if (stableId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        stableId,
      ]);
      const prior = await client.query(
        `${draftSelect} JOIN draft_creation_receipt receipt ON receipt.draft_id=d.id WHERE receipt.project_id=$1 AND receipt.actor_id=$2 AND receipt.operation_key=$3`,
        [scope.projectId, scope.actorId, key],
      );
      const savedHash = await client.query(
        "SELECT request_hash FROM draft_creation_receipt WHERE project_id=$1 AND actor_id=$2 AND operation_key=$3",
        [scope.projectId, scope.actorId, key],
      );
      if (prior.rowCount) {
        if (savedHash.rows[0]?.request_hash !== requestHash) {
          await client.query("ROLLBACK");
          throw new DraftCreateError(409, "idempotency_conflict");
        }
        if (!draftLive(prior.rows[0]) && prior.rows[0].status !== "published") {
          await client.query("ROLLBACK");
          throw new DraftCreateError(409, "draft_not_editable");
        }
        await client.query("COMMIT");
        return {
          draft: draftSummary(prior.rows[0]),
          replayed: true,
          statusCode: 200,
        };
      }
    }
    let name = typeof body.name === "string" ? body.name.trim() : "",
      purpose = typeof body.purpose === "string" ? body.purpose : "";
    if (body.testSetId) {
      const parent = await client.query(
        `SELECT ts.name,ts.purpose,ts.status AS test_set_status,
            v.status AS parent_status FROM test_set ts JOIN test_set_version v
              ON v.test_set_id=ts.id AND v.id=$3
            WHERE ts.id=$2 AND ts.project_id=$1 FOR SHARE OF ts,v`,
        [scope.projectId, body.testSetId, body.parentVersionId],
      );
      if (
        !parent.rowCount ||
        parent.rows[0].test_set_status !== "available" ||
        parent.rows[0].parent_status !== "published"
      ) {
        await client.query("ROLLBACK");
        throw new DraftCreateError(404, "parent_version_not_found");
      }
      name = String(parent.rows[0].name);
      purpose = String(parent.rows[0].purpose);
    }
    await guardAssistantCommit(client, scope);
    const draftId = stableId ?? opaqueId("collabdraft");
    const inserted = await client.query(
      `INSERT INTO collaborative_draft
          (id,project_id,test_set_id,parent_version_id,name,purpose,updated_by,created_by,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7,now()) ON CONFLICT DO NOTHING RETURNING id`,
      [
        draftId,
        scope.projectId,
        body.testSetId ?? null,
        body.parentVersionId ?? null,
        name,
        purpose,
        scope.actorId,
      ],
    );
    const actualId = inserted.rowCount
      ? draftId
      : String(
          (
            await client.query(
              `SELECT id FROM collaborative_draft
          WHERE project_id=$1 AND test_set_id=$2 AND parent_version_id=$3 AND status='editing'`,
              [scope.projectId, body.testSetId, body.parentVersionId],
            )
          ).rows[0]?.id ?? "",
        );
    if (!actualId) throw new Error("draft_create_conflict");
    if (inserted.rowCount && body.parentVersionId) {
      const records = await client.query(
        `SELECT vm.position,vm.case_id,vm.case_revision_id,
            cr.input,cr.expected_output,cr.metadata,cr.origin_kind,cr.origin_ref,
            coalesce(attr.field_attribution,'{}'::jsonb) AS inherited_attribution
            FROM resolve_version_members($1) vm JOIN case_revision cr ON cr.id=vm.case_revision_id
            LEFT JOIN collaborative_draft_attribution attr
              ON attr.version_id=$1 AND attr.case_id=vm.case_id
            ORDER BY vm.ordinal`,
        [body.parentVersionId],
      );
      await writeBatches(
        client,
        `INSERT INTO collaborative_draft_record
            (draft_id,id,position,case_id,before_revision_id,question,expected_output,metadata,source,updated_by,field_attribution)
            SELECT $1,x.id,x.position,x.case_id,x.before_revision_id,x.question,x.expected_output,x.metadata,x.source,$2,x.field_attribution
            FROM jsonb_to_recordset($3::jsonb) AS x(id text,position bigint,case_id text,before_revision_id text,question text,expected_output text,metadata jsonb,source jsonb,field_attribution jsonb)`,
        [draftId, scope.actorId],
        records.rows.map((row) => ({
          id: opaqueId("draftrow"),
          position: row.position,
          case_id: row.case_id,
          before_revision_id: row.case_revision_id,
          question: isPlainObject(row.input)
            ? String(row.input.question ?? "")
            : displayText(row.input),
          expected_output: isPlainObject(row.expected_output)
            ? String(row.expected_output.text ?? "")
            : displayText(row.expected_output),
          metadata: readMetadataEntries(row.metadata),
          source:
            isPlainObject(row.origin_ref) &&
            row.origin_kind === "source_record" &&
            typeof row.origin_ref.assetId === "string"
              ? {
                  assetId: row.origin_ref.assetId,
                  ordinal: Number(row.origin_ref.ordinal),
                }
              : null,
          field_attribution: row.inherited_attribution,
        })),
      );
    }
    if (stableId)
      await client.query(
        "INSERT INTO draft_creation_receipt(project_id,actor_id,operation_key,request_hash,draft_id) VALUES($1,$2,$3,$4,$5)",
        [scope.projectId, scope.actorId, key, requestHash, actualId],
      );
    const draft = await client.query(`${draftSelect} WHERE d.id=$1`, [
      actualId,
    ]);
    await guardAssistantCommit(client, scope);
    await client.query("COMMIT");
    return {
      statusCode: inserted.rowCount ? 201 : 200,
      draft: draftSummary(draft.rows[0]),
      replayed: !inserted.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
