import { writeBatches } from "../../db/batch.js";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { hasProjectCapability } from "../../security/project-access.js";
import { publishSparseVersion } from "../../version/publish-sparse.js";
import type { ServerContext } from "../context.js";
import {
  AuthenticatedRequest,
  opaqueId,
  isPlainObject,
  normalizeDisplayMapping,
  displayText,
  MetadataEntry,
  normalizeMetadataEntries,
  readMetadataEntries,
  mapMaterialRecord,
} from "../support.js";

export function registerDrafts(
  context: Pick<
    ServerContext,
    | "db"
    | "artifacts"
    | "now"
    | "app"
    | "authenticate"
    | "writeAllowed"
    | "publishInitial"
  >,
) {
  const {
    db,
    artifacts,
    now,
    app,
    authenticate,
    writeAllowed,
    publishInitial,
  } = context;
  type PresenceEntry = {
    projectId: string;
    userId: string;
    clientId: string;
    seenAt: number;
    draftId: string | null;
    recordId: string | null;
    field: string | null;
  };
  const presence = new Map<string, PresenceEntry>();
  const expirePresence = () => {
    const cutoff = now().getTime() - 15_000;
    for (const [key, entry] of presence)
      if (entry.seenAt <= cutoff) presence.delete(key);
  };
  const presencePath = "/api/projects/:projectId/presence";
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    presencePath,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        typeof body.clientId !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(body.clientId) ||
        (body.draftId !== undefined &&
          body.draftId !== null &&
          typeof body.draftId !== "string") ||
        (body.recordId !== undefined &&
          body.recordId !== null &&
          typeof body.recordId !== "string") ||
        (body.field !== undefined &&
          body.field !== null &&
          ![
            "question",
            "expectedOutput",
            "metadata",
            "name",
            "purpose",
          ].includes(String(body.field))) ||
        (body.recordId && !body.draftId) ||
        (body.field && !body.draftId)
      )
        return reply.code(422).send({ error: { code: "presence_invalid" } });
      const draftId = body.draftId ? String(body.draftId) : null;
      if (draftId) {
        if (
          !(await hasProjectCapability(
            db,
            request.params.projectId,
            actor.id,
            "write",
          ))
        )
          return reply.code(404).send({ error: { code: "project_not_found" } });
        const draft = await db.query(
          `SELECT d.id FROM collaborative_draft d LEFT JOIN test_set ts ON ts.id=d.test_set_id
           LEFT JOIN test_set_version v ON v.id=d.parent_version_id
           WHERE d.id=$1 AND d.project_id=$2 AND d.status='editing'
             AND (ts.status IS NULL OR ts.status='available')
             AND (v.status IS NULL OR v.status='published')`,
          [draftId, request.params.projectId],
        );
        if (!draft.rowCount)
          return reply.code(404).send({ error: { code: "draft_not_found" } });
      }
      expirePresence();
      const clientId = String(body.clientId);
      presence.set(`${actor.id}:${clientId}`, {
        projectId: request.params.projectId,
        userId: actor.id,
        clientId,
        seenAt: now().getTime(),
        draftId,
        recordId: body.recordId ? String(body.recordId) : null,
        field: body.field ? String(body.field) : null,
      });
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { projectId: string; clientId: string } }>(
    `${presencePath}/:clientId`,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const key = `${actor.id}:${request.params.clientId}`;
      if (presence.get(key)?.projectId === request.params.projectId)
        presence.delete(key);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { projectId: string }; Querystring: { draftId?: string } }>(
    presencePath,
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "read",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const draftId = request.query.draftId;
      if (
        draftId &&
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "write",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      expirePresence();
      const entries = [...presence.values()].filter(
        (entry) => entry.projectId === request.params.projectId,
      );
      const ids = [...new Set(entries.map((entry) => entry.userId))];
      if (!ids.length) return { users: [] };
      const people = await db.query(
        `SELECT u.id,coalesce(u.display_name,u.username) AS name,u.avatar_color,
                u.role AS account_role,pm.role AS project_role
         FROM app_user u LEFT JOIN project_member pm ON pm.user_id=u.id AND pm.project_id=$1
         WHERE u.id=ANY($2::text[]) AND (u.role='admin' OR pm.role IN ('owner','editor','viewer'))`,
        [request.params.projectId, ids],
      );
      const users = people.rows.map((person) => {
        const active = entries.filter((entry) => entry.userId === person.id);
        const role =
          person.account_role === "admin"
            ? "admin"
            : String(person.project_role);
        const focused =
          draftId && role !== "viewer"
            ? active
                .filter((entry) => entry.draftId === draftId && entry.field)
                .sort((a, b) => b.seenAt - a.seenAt)[0]
            : undefined;
        return {
          id: String(person.id),
          name: String(person.name),
          avatarColor: String(person.avatar_color),
          role,
          ...(focused
            ? {
                focus: {
                  draftId,
                  recordId: focused.recordId,
                  field: focused.field,
                },
              }
            : {}),
        };
      });
      return { users };
    },
  );

  // V2 shared draft identities are separate from legacy lease-based working_draft.
  const draftPath = "/api/projects/:projectId/collaborative-drafts";
  const draftByIdPath = `${draftPath}/:draftId`;
  const draftSummary = (row: Record<string, unknown>) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    testSetId: row.test_set_id ? String(row.test_set_id) : null,
    parentVersionId: row.parent_version_id
      ? String(row.parent_version_id)
      : null,
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
  const draftSelect = `SELECT d.*, ts.status AS test_set_status,
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
  const publishedDraftUnavailable = (row: Record<string, unknown>) =>
    row.status === "published" &&
    (row.test_set_status !== "available" ||
      row.published_status !== "published");
  const draftWrite = async (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    if (!writeAllowed(request, actor)) {
      reply.code(403).send({ error: { code: "csrf_rejected" } });
      return false;
    }
    if (!(await hasProjectCapability(db, projectId, actor.id, "write"))) {
      reply.code(404).send({ error: { code: "project_not_found" } });
      return false;
    }
    return true;
  };
  const draftRead = async (
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ) => {
    const actor = (request as AuthenticatedRequest).actor;
    // Drafts are editable workspace content, not published content for viewers.
    if (!(await hasProjectCapability(db, projectId, actor.id, "write"))) {
      reply.code(404).send({ error: { code: "project_not_found" } });
      return false;
    }
    return true;
  };
  const draftRow = (row: Record<string, unknown>) => ({
    id: String(row.id),
    position: Number(row.position),
    activeOrdinal: row.active_ordinal ? Number(row.active_ordinal) : undefined,
    caseId: row.case_id ? String(row.case_id) : null,
    beforeRevisionId: row.before_revision_id
      ? String(row.before_revision_id)
      : null,
    question: String(row.question),
    expectedOutput: String(row.expected_output),
    metadata: row.metadata,
    source: row.source,
    sourceFileName: row.source_file_name ?? null,
    rowRevision: Number(row.row_revision),
    questionRevision: Number(row.question_revision),
    expectedOutputRevision: Number(row.expected_output_revision),
    metadataRevision: Number(row.metadata_revision),
    sourceRevision: Number(row.source_revision),
    fieldAttribution: row.field_attribution,
    updatedBy: String(row.updated_by),
    updatedByName: String(row.updated_by_name ?? row.updated_by),
    updatedAt: row.updated_at,
  });
  const draftLive = (row: Record<string, unknown>) =>
    row.status === "editing" &&
    (row.test_set_status === null || row.test_set_status === "available") &&
    (row.parent_status === null || row.parent_status === "published");
  const draftFieldValue = (field: string, value: unknown) => {
    if (field === "question" || field === "expectedOutput")
      return typeof value === "string" && value.length <= 100_000
        ? value
        : undefined;
    if (field === "metadata") return normalizeMetadataEntries(value);
    if (field === "source") {
      if (value === null) return null;
      if (
        isPlainObject(value) &&
        typeof value.assetId === "string" &&
        Number.isInteger(value.ordinal) &&
        Number(value.ordinal) >= 0
      )
        return { assetId: value.assetId, ordinal: Number(value.ordinal) };
    }
    return undefined;
  };

  app.get<{
    Params: { projectId: string };
    Querystring: { testSetId?: string };
  }>(draftPath, { preHandler: authenticate }, async (request, reply) => {
    if (!(await draftRead(request, reply, request.params.projectId))) return;
    const rows = await db.query(
      `${draftSelect} WHERE d.project_id=$1
        AND d.status='editing' AND ($2::text IS NULL OR d.test_set_id=$2)
        ORDER BY d.updated_at DESC,d.id DESC`,
      [request.params.projectId, request.query.testSetId ?? null],
    );
    return { drafts: rows.rows.map(draftSummary) };
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    draftPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (k) => !["testSetId", "parentVersionId"].includes(k),
        ) ||
        (body.testSetId === undefined) !==
          (body.parentVersionId === undefined) ||
        (body.testSetId !== undefined &&
          (typeof body.testSetId !== "string" ||
            typeof body.parentVersionId !== "string"))
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_request_invalid" } });
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        let name = "",
          purpose = "";
        if (body.testSetId) {
          const parent = await client.query(
            `SELECT ts.name,ts.purpose,ts.status AS test_set_status,
            v.status AS parent_status FROM test_set ts JOIN test_set_version v
              ON v.test_set_id=ts.id AND v.id=$3
            WHERE ts.id=$2 AND ts.project_id=$1 FOR SHARE OF ts,v`,
            [request.params.projectId, body.testSetId, body.parentVersionId],
          );
          if (
            !parent.rowCount ||
            parent.rows[0].test_set_status !== "available" ||
            parent.rows[0].parent_status !== "published"
          ) {
            await client.query("ROLLBACK");
            return reply
              .code(404)
              .send({ error: { code: "parent_version_not_found" } });
          }
          name = String(parent.rows[0].name);
          purpose = String(parent.rows[0].purpose);
        }
        const draftId = opaqueId("collabdraft");
        const inserted = await client.query(
          `INSERT INTO collaborative_draft
          (id,project_id,test_set_id,parent_version_id,name,purpose,updated_by,created_by,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$7,now()) ON CONFLICT DO NOTHING RETURNING id`,
          [
            draftId,
            request.params.projectId,
            body.testSetId ?? null,
            body.parentVersionId ?? null,
            name,
            purpose,
            actor.id,
          ],
        );
        const actualId = inserted.rowCount
          ? draftId
          : String(
              (
                await client.query(
                  `SELECT id FROM collaborative_draft
          WHERE project_id=$1 AND test_set_id=$2 AND parent_version_id=$3 AND status='editing'`,
                  [
                    request.params.projectId,
                    body.testSetId,
                    body.parentVersionId,
                  ],
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
            [draftId, actor.id],
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
        const draft = await client.query(`${draftSelect} WHERE d.id=$1`, [
          actualId,
        ]);
        await client.query("COMMIT");
        return reply.code(inserted.rowCount ? 201 : 200).send({
          draft: draftSummary(draft.rows[0]),
          replayed: !inserted.rowCount,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{
    Params: { projectId: string; draftId: string };
    Querystring: { limit?: string; offset?: string; search?: string };
  }>(draftByIdPath, { preHandler: authenticate }, async (request, reply) => {
    if (!(await draftRead(request, reply, request.params.projectId))) return;
    const draft = await db.query(
      `${draftSelect} WHERE d.id=$1 AND d.project_id=$2`,
      [request.params.draftId, request.params.projectId],
    );
    if (
      !draft.rowCount ||
      draft.rows[0].status === "discarded" ||
      draft.rows[0].status === "terminated" ||
      publishedDraftUnavailable(draft.rows[0])
    )
      return reply.code(404).send({ error: { code: "draft_not_found" } });
    const summary = draftSummary(draft.rows[0]);
    if (summary.suspended) return { draft: summary, records: [], total: 0 };
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
    const offset = Math.max(0, Number(request.query.offset) || 0);
    const search = String(request.query.search ?? "").slice(0, 200);
    const rows = await db.query(
      `SELECT dr.*, da.file_name AS source_file_name,
        coalesce(author.display_name,author.username) AS updated_by_name,
        count(*) OVER() AS total
        FROM (
          SELECT *, row_number() OVER (ORDER BY position) AS active_ordinal
          FROM collaborative_draft_record
          WHERE draft_id=$1 AND deleted=false
        ) dr
        LEFT JOIN app_user author ON author.id=dr.updated_by
        LEFT JOIN data_asset da ON da.id=dr.source->>'assetId'
        WHERE ($2='' OR question ILIKE '%'||$2||'%' OR expected_output ILIKE '%'||$2||'%')
        ORDER BY position LIMIT $3 OFFSET $4`,
      [request.params.draftId, search, limit, offset],
    );
    const authorIds = [
      ...new Set(
        [
          summary.nameUpdatedBy,
          summary.purposeUpdatedBy,
          ...rows.rows.flatMap((row) => [
            String(row.updated_by),
            ...Object.values(
              isPlainObject(row.field_attribution) ? row.field_attribution : {},
            ).flatMap((fact) =>
              isPlainObject(fact) && typeof fact.userId === "string"
                ? [fact.userId]
                : [],
            ),
          ]),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const people = authorIds.length
      ? await db.query(
          `SELECT id,coalesce(display_name,username) AS name,avatar_color FROM app_user WHERE id=ANY($1::text[])`,
          [authorIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };
    const authors = Object.fromEntries(
      people.rows.map((person) => [
        String(person.id),
        { name: String(person.name), avatarColor: String(person.avatar_color) },
      ]),
    );
    return {
      draft: summary,
      records: rows.rows.map(draftRow),
      authors,
      total: Number(rows.rows[0]?.total ?? 0),
    };
  });

  app.get<{
    Params: { projectId: string; draftId: string };
    Querystring: { after?: string };
  }>(
    `${draftByIdPath}/events`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      const after = Number(request.query.after ?? "0");
      if (!Number.isSafeInteger(after) || after < 0)
        return reply
          .code(422)
          .send({ error: { code: "draft_cursor_invalid" } });
      const draft = await db.query(
        `SELECT revision,status FROM collaborative_draft WHERE id=$1 AND project_id=$2`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount)
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const result = await db.query(
        `SELECT revision,status,changed_by,created_at,change_scope FROM collaborative_draft_event
         WHERE draft_id=$1 AND revision>$2 ORDER BY revision LIMIT 101`,
        [request.params.draftId, after],
      );
      const events = result.rows.slice(0, 100).map((row) => ({
        draftId: request.params.draftId,
        revision: Number(row.revision),
        status: String(row.status),
        changedBy: row.changed_by ? String(row.changed_by) : null,
        at: row.created_at,
        scope: row.change_scope,
      }));
      return {
        events,
        cursor: events.at(-1)?.revision ?? after,
        hasMore: result.rows.length > 100,
        needsSnapshot:
          Number(draft.rows[0].revision) < after ||
          (events.length > 0 && events[0].revision > after + 1) ||
          (events.length === 0 && Number(draft.rows[0].revision) > after),
        status: String(draft.rows[0].status),
      };
    },
  );

  app.patch<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    draftByIdPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !["name", "purpose"].includes(String(body.field)) ||
        typeof body.value !== "string" ||
        !Number.isInteger(body.expectedFieldRevision) ||
        body.value.length > (body.field === "name" ? 200 : 2000)
      )
        return reply.code(422).send({ error: { code: "draft_field_invalid" } });
      const field = String(body.field),
        revField = field === "name" ? "name_revision" : "purpose_revision";
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!current.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(current.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        if (Number(current.rows[0][revField]) !== body.expectedFieldRevision) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: { code: "draft_field_conflict" },
            draft: draftSummary(current.rows[0]),
          });
        }
        await client.query(
          `UPDATE collaborative_draft SET ${field}=$2,${revField}=${revField}+1,
          ${field}_updated_by=$3,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1`,
          [request.params.draftId, body.value, actor.id],
        );
        const updated = await client.query(`${draftSelect} WHERE d.id=$1`, [
          request.params.draftId,
        ]);
        await client.query("COMMIT");
        return { draft: draftSummary(updated.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/records`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (k) =>
            !["source", "question", "expectedOutput", "metadata"].includes(k),
        ) ||
        (body.source !== undefined &&
          (body.question !== undefined ||
            body.expectedOutput !== undefined ||
            body.metadata !== undefined ||
            draftFieldValue("source", body.source) === undefined)) ||
        (body.question !== undefined &&
          draftFieldValue("question", body.question) === undefined) ||
        (body.expectedOutput !== undefined &&
          draftFieldValue("expectedOutput", body.expectedOutput) ===
            undefined) ||
        (body.metadata !== undefined &&
          draftFieldValue("metadata", body.metadata) === undefined)
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_record_invalid" } });
      const source =
        body.source === undefined
          ? null
          : (draftFieldValue("source", body.source) as {
              assetId: string;
              ordinal: number;
            } | null);
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!current.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(current.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const count = await client.query(
          `SELECT count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
          FROM collaborative_draft_record WHERE draft_id=$1`,
          [request.params.draftId],
        );
        if (Number(count.rows[0].count) >= 10000) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        if (source) {
          const existing = await client.query(
            `SELECT * FROM collaborative_draft_record WHERE draft_id=$1
            AND source->>'assetId'=$2 AND (source->>'ordinal')::integer=$3
            AND deleted=false LIMIT 1`,
            [request.params.draftId, source.assetId, source.ordinal],
          );
          if (existing.rowCount) {
            await client.query("COMMIT");
            return reply
              .code(200)
              .send({ record: draftRow(existing.rows[0]), replayed: true });
          }
        }
        if (source) {
          const used = await client.query(
            `SELECT DISTINCT source->>'assetId' AS asset_id
            FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
            [request.params.draftId],
          );
          const assetIds = [
            ...new Set([
              ...used.rows.map((row) => String(row.asset_id)),
              source.assetId,
            ]),
          ];
          const size = await client.query(
            `SELECT coalesce(sum(size_bytes),0)::bigint AS total
            FROM data_asset WHERE project_id=$1 AND id=ANY($2::text[])`,
            [request.params.projectId, assetIds],
          );
          if (assetIds.length > 5 || Number(size.rows[0].total) > 100000000) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
        }
        let question = String(body.question ?? ""),
          expectedOutput = String(body.expectedOutput ?? ""),
          metadata: MetadataEntry[] =
            (body.metadata as MetadataEntry[] | undefined) ?? [];
        if (source) {
          const material = await client.query(
            `SELECT sr.value,pv.display_mapping FROM data_asset da
            JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
            JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.ordinal=$3 AND sr.parse_status='valid'
            WHERE da.id=$2 AND da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')`,
            [request.params.projectId, source.assetId, source.ordinal],
          );
          if (!material.rowCount) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "source_selection_invalid" } });
          }
          const mapped = mapMaterialRecord(
            material.rows[0].value,
            normalizeDisplayMapping(material.rows[0].display_mapping) ?? {
              metadata: [],
            },
          );
          question = mapped.question;
          expectedOutput = mapped.expectedOutput;
          metadata = mapped.metadata;
        }
        const rowId = opaqueId("draftrow");
        await client.query(
          `INSERT INTO collaborative_draft_record
          (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
            jsonb_build_object(
              'question',jsonb_build_object('userId',$8::text,'at',now()),
              'expectedOutput',jsonb_build_object('userId',$8::text,'at',now()),
              'metadata',jsonb_build_object('userId',$8::text,'at',now())
            ))`,
          [
            request.params.draftId,
            rowId,
            Number(count.rows[0].high_water) + 1,
            question,
            expectedOutput,
            JSON.stringify(metadata),
            source ? JSON.stringify(source) : null,
            actor.id,
          ],
        );
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
          [request.params.draftId, actor.id],
        );
        const inserted = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2`,
          [request.params.draftId, rowId],
        );
        await client.query("COMMIT");
        return reply.code(201).send({ record: draftRow(inserted.rows[0]) });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{
    Params: { projectId: string; draftId: string; recordId: string };
    Body: unknown;
  }>(
    `${draftByIdPath}/records/:recordId`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !["question", "expectedOutput", "metadata"].includes(
          String(body.field),
        ) ||
        !Number.isInteger(body.expectedFieldRevision) ||
        draftFieldValue(String(body.field), body.value) === undefined
      )
        return reply.code(422).send({ error: { code: "draft_field_invalid" } });
      const field = String(body.field);
      const column = field === "expectedOutput" ? "expected_output" : field;
      const revColumn = `${column}_revision`;
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const current = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 FOR UPDATE`,
          [request.params.draftId, request.params.recordId],
        );
        if (!current.rowCount || current.rows[0].deleted) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_record_removed" } });
        }
        if (Number(current.rows[0][revColumn]) !== body.expectedFieldRevision) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: { code: "draft_field_conflict" },
            record: draftRow(current.rows[0]),
          });
        }
        const value = draftFieldValue(field, body.value);
        await client.query(
          `UPDATE collaborative_draft_record SET ${column}=$3,
          ${revColumn}=${revColumn}+1,row_revision=row_revision+1,
          field_attribution=jsonb_set(field_attribution,$4::text[],jsonb_build_object('userId',$5::text,'at',now()),true),
          updated_by=$5,updated_at=now() WHERE draft_id=$1 AND id=$2`,
          [
            request.params.draftId,
            request.params.recordId,
            field === "metadata" ? JSON.stringify(value) : value,
            [field],
            actor.id,
          ],
        );
        await client.query(
          `SELECT set_config('evalbase.draft_change',$1,true)`,
          [
            JSON.stringify({
              recordId: request.params.recordId,
              rowRevision: Number(current.rows[0].row_revision) + 1,
            }),
          ],
        );
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
          [request.params.draftId, actor.id],
        );
        const updated = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2`,
          [request.params.draftId, request.params.recordId],
        );
        await client.query("COMMIT");
        return { record: draftRow(updated.rows[0]) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{
    Params: { projectId: string; draftId: string; recordId: string };
    Body: unknown;
  }>(
    `${draftByIdPath}/records/:recordId`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (!isPlainObject(body) || !Number.isInteger(body.expectedRowRevision))
        return reply
          .code(422)
          .send({ error: { code: "draft_row_revision_required" } });
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const current = await client.query(
          `SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 FOR UPDATE`,
          [request.params.draftId, request.params.recordId],
        );
        if (!current.rowCount || current.rows[0].deleted) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_record_removed" } });
        }
        if (Number(current.rows[0].row_revision) !== body.expectedRowRevision) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: { code: "draft_row_conflict" },
            record: draftRow(current.rows[0]),
          });
        }
        await client.query(
          `UPDATE collaborative_draft_record SET deleted=true,row_revision=row_revision+1,
          updated_by=$3,updated_at=now() WHERE draft_id=$1 AND id=$2`,
          [request.params.draftId, request.params.recordId, actor.id],
        );
        await client.query(
          `UPDATE collaborative_draft SET revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1`,
          [request.params.draftId, actor.id],
        );
        await client.query("COMMIT");
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { projectId: string; draftId: string } }>(
    draftByIdPath,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        await client.query(
          `DELETE FROM collaborative_draft_record WHERE draft_id=$1`,
          [request.params.draftId],
        );
        await client.query(
          `UPDATE collaborative_draft SET status='discarded',name='',purpose='',revision=revision+1,
          updated_at=now() WHERE id=$1`,
          [request.params.draftId],
        );
        await client.query("COMMIT");
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/publish`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !Number.isInteger(body.revision) ||
        Object.keys(body).some((key) => key !== "revision")
      )
        return reply
          .code(422)
          .send({ error: { code: "draft_revision_required" } });
      const actor = (request as AuthenticatedRequest).actor;
      const draft = await db.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount || publishedDraftUnavailable(draft.rows[0]))
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      const saved = draft.rows[0];
      if (saved.status === "published" && saved.published_version_id) {
        const result = await db.query(
          `SELECT v.id,v.version_label,v.item_count,v.test_set_id,
          ts.name,ts.purpose FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id
          WHERE v.id=$1 AND v.status='published' AND ts.status='available'`,
          [saved.published_version_id],
        );
        if (!result.rowCount)
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        return {
          testSet: {
            id: result.rows[0].test_set_id,
            name: result.rows[0].name,
            purpose: result.rows[0].purpose,
          },
          version: {
            id: result.rows[0].id,
            label: result.rows[0].version_label,
            recordCount: Number(result.rows[0].item_count),
          },
          replayed: true,
        };
      }
      if (!draftLive(saved))
        return reply.code(409).send({ error: { code: "draft_not_editable" } });
      if (Number(saved.revision) !== body.revision)
        return reply.code(409).send({
          error: { code: "draft_revision_conflict" },
          draft: draftSummary(saved),
        });
      if (!String(saved.name).trim())
        return reply
          .code(422)
          .send({ error: { code: "test_set_name_required" } });
      const records = await db.query(
        `SELECT * FROM collaborative_draft_record
        WHERE draft_id=$1 AND deleted=false ORDER BY position`,
        [request.params.draftId],
      );
      if (!records.rowCount)
        return reply
          .code(422)
          .send({ error: { code: "test_set_records_required" } });
      if (!saved.parent_version_id) {
        const normalized = records.rows.map((row) => ({
          question: String(row.question),
          expectedOutput: String(row.expected_output),
          metadata: row.metadata as MetadataEntry[],
          ...(row.source
            ? { source: row.source as { assetId: string; ordinal: number } }
            : {}),
        }));
        const selections = [
          ...new Map(
            normalized.flatMap((record) =>
              record.source
                ? [
                    [
                      `${record.source.assetId}:${record.source.ordinal}`,
                      record.source,
                    ] as const,
                  ]
                : [],
            ),
          ).values(),
        ];
        return publishInitial(
          Object.assign(Object.create(request), {
            headers: {
              cookie: String(request.headers.cookie ?? ""),
              origin: String(request.headers.origin ?? ""),
              "x-csrf-token": String(request.headers["x-csrf-token"] ?? ""),
              "idempotency-key": `draft:${request.params.draftId}:${body.revision}`,
            },
            body: {
              name: saved.name,
              purpose: saved.purpose,
              selections,
              operations: normalized.map((after) => ({
                operation: "add",
                after,
              })),
              collaborativeDraftId: request.params.draftId,
              draftRevision: body.revision,
            },
          }),
          reply,
        );
      }
      try {
        const published = await publishSparseVersion(db, artifacts, {
          projectId: request.params.projectId,
          testSetId: String(saved.test_set_id),
          parentVersionId: String(saved.parent_version_id),
          actorId: actor.id,
          idempotencyKey: `draft:${request.params.draftId}:${body.revision}`,
          operations: [],
          draftId: request.params.draftId,
          draftRevision: Number(body.revision),
        });
        const count = await db.query(
          `SELECT item_count FROM test_set_version WHERE id=$1`,
          [published.id],
        );
        return reply.code(published.replayed ? 200 : 201).send({
          testSet: {
            id: saved.test_set_id,
            name: saved.name,
            purpose: saved.purpose,
          },
          version: {
            id: published.id,
            label: published.label,
            recordCount: Number(count.rows[0]?.item_count ?? 0),
            parentVersionId: saved.parent_version_id,
          },
          replayed: published.replayed,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          code &&
          [
            "draft_not_found",
            "version_not_found",
            "test_set_not_found",
          ].includes(code)
        )
          return reply.code(404).send({ error: { code } });
        if (
          code &&
          ["draft_revision_conflict", "idempotency_conflict"].includes(code)
        )
          return reply.code(409).send({ error: { code } });
        if (
          code &&
          [
            "test_set_records_required",
            "test_record_invalid",
            "source_selection_invalid",
            "test_set_capacity_exceeded",
            "parent_record_invalid",
            "draft_parent_incomplete",
          ].includes(code)
        )
          return reply.code(422).send({ error: { code } });
        if (code === "checkpoint_hard_limit_failed")
          return reply.code(503).send({ error: { code } });
        throw error;
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { search?: string; limit?: string; offset?: string };
  }>(
    "/api/projects/:projectId/collaborative-draft-source-files",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      const limit = Math.min(
        100,
        Math.max(1, Number(request.query.limit) || 10),
      );
      const offset = Math.max(0, Number(request.query.offset) || 0);
      const search = String(request.query.search ?? "").slice(0, 200);
      const rows = await db.query(
        `SELECT da.id,da.file_name,c.name AS collection_name,
        count(sr.ordinal)::integer AS record_count,count(*) OVER() AS total
        FROM data_asset da JOIN raw_material_collection c ON c.id=da.collection_id
        JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
        JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
        WHERE da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')
          AND ($2='' OR da.file_name ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%')
        GROUP BY da.id,da.file_name,c.name ORDER BY c.name,da.file_name,da.id
        LIMIT $3 OFFSET $4`,
        [request.params.projectId, search, limit, offset],
      );
      return {
        files: rows.rows.map((row) => ({
          id: row.id,
          fileName: row.file_name,
          collectionName: row.collection_name,
          recordCount: Number(row.record_count),
        })),
        total: Number(rows.rows[0]?.total ?? 0),
      };
    },
  );
  app.get<{
    Params: { projectId: string };
    Querystring: {
      assetId?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/projects/:projectId/collaborative-draft-source-records",
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      if (!request.query.assetId)
        return reply
          .code(422)
          .send({ error: { code: "source_asset_required" } });
      const limit = Math.min(
        100,
        Math.max(1, Number(request.query.limit) || 20),
      );
      const offset = Math.max(0, Number(request.query.offset) || 0);
      const search = String(request.query.search ?? "").slice(0, 200);
      const rows = await db.query(
        `SELECT sr.ordinal,sr.value,pv.display_mapping,
        count(*) OVER() AS total FROM data_asset da
        JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
        JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
        WHERE da.id=$2 AND da.project_id=$1 AND da.status NOT IN ('deletion_pending','tombstoned')
          AND ($3='' OR sr.value::text ILIKE '%'||$3||'%')
        ORDER BY sr.ordinal LIMIT $4 OFFSET $5`,
        [
          request.params.projectId,
          request.query.assetId,
          search,
          limit,
          offset,
        ],
      );
      return {
        records: rows.rows.map((row) => ({
          assetId: request.query.assetId,
          ordinal: Number(row.ordinal),
          ...mapMaterialRecord(
            row.value,
            normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
          ),
        })),
        total: Number(rows.rows[0]?.total ?? 0),
      };
    },
  );

  app.get<{ Params: { projectId: string; draftId: string } }>(
    `${draftByIdPath}/selected-sources`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftRead(request, reply, request.params.projectId))) return;
      const draft = await db.query(
        `${draftSelect} WHERE d.id=$1 AND d.project_id=$2
        AND d.status IN ('editing','published')`,
        [request.params.draftId, request.params.projectId],
      );
      if (!draft.rowCount || publishedDraftUnavailable(draft.rows[0]))
        return reply.code(404).send({ error: { code: "draft_not_found" } });
      if (draftSummary(draft.rows[0]).suspended)
        return reply.code(409).send({ error: { code: "draft_not_editable" } });
      const rows = await db.query(
        `SELECT id, row_revision, source->>'assetId' AS asset_id,
        (source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record
        WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
        [request.params.draftId],
      );
      return {
        sources: rows.rows.map((row) => ({
          assetId: row.asset_id,
          ordinal: row.ordinal,
          recordId: row.id,
          rowRevision: Number(row.row_revision),
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string; draftId: string }; Body: unknown }>(
    `${draftByIdPath}/source-selection`,
    { preHandler: authenticate },
    async (request, reply) => {
      if (!(await draftWrite(request, reply, request.params.projectId))) return;
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !Array.isArray(body.assetIds) ||
        body.assetIds.length < 1 ||
        body.assetIds.length > 5 ||
        body.assetIds.some((id) => typeof id !== "string") ||
        new Set(body.assetIds).size !== body.assetIds.length ||
        !["add", "remove"].includes(String(body.mode)) ||
        (body.mode === "remove" &&
          (!Array.isArray(body.expectedRecords) ||
            body.expectedRecords.length > 10000 ||
            body.expectedRecords.some(
              (item) =>
                !isPlainObject(item) ||
                typeof item.id !== "string" ||
                !Number.isSafeInteger(item.rowRevision) ||
                Number(item.rowRevision) < 0,
            ) ||
            new Set(body.expectedRecords.map((item) => item.id)).size !==
              body.expectedRecords.length)) ||
        (body.search !== undefined &&
          (typeof body.search !== "string" || body.search.length > 200)) ||
        (body.exclude !== undefined &&
          (!Array.isArray(body.exclude) ||
            body.exclude.length > 10000 ||
            body.exclude.some(
              (item) =>
                !isPlainObject(item) ||
                typeof item.assetId !== "string" ||
                !Number.isInteger(item.ordinal) ||
                Number(item.ordinal) < 0,
            ))) ||
        (body.ordinals !== undefined &&
          (!Array.isArray(body.ordinals) ||
            body.ordinals.length > 10000 ||
            body.ordinals.some(
              (value) => !Number.isInteger(value) || Number(value) < 0,
            )))
      )
        return reply
          .code(422)
          .send({ error: { code: "source_selection_invalid" } });
      const assetIds = body.assetIds as string[];
      const excluded = new Set(
        (
          (body.exclude ?? []) as Array<{ assetId: string; ordinal: number }>
        ).map((item) => `${item.assetId}:${item.ordinal}`),
      );
      const actor = (request as AuthenticatedRequest).actor;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const draft = await client.query(
          `${draftSelect} WHERE d.id=$1 AND d.project_id=$2 FOR UPDATE OF d`,
          [request.params.draftId, request.params.projectId],
        );
        if (!draft.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: { code: "draft_not_found" } });
        }
        if (!draftLive(draft.rows[0])) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "draft_not_editable" } });
        }
        const assets = await client.query(
          `SELECT da.id,da.size_bytes FROM data_asset da
          JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
          WHERE da.project_id=$1 AND da.id=ANY($2::text[]) AND da.status NOT IN ('deletion_pending','tombstoned')`,
          [request.params.projectId, assetIds],
        );
        if (
          assets.rows.length !== assetIds.length ||
          assets.rows.reduce((sum, row) => sum + Number(row.size_bytes), 0) >
            100000000
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        const sources = await client.query(
          `SELECT da.id AS asset_id,sr.ordinal,sr.value,pv.display_mapping
          FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current AND pv.status='ready'
          JOIN source_record sr ON sr.parsed_view_id=pv.id AND sr.parse_status='valid'
          WHERE da.project_id=$1 AND da.id=ANY($2::text[])
            AND ($3='' OR sr.value::text ILIKE '%'||$3||'%')
            AND ($4::integer[] IS NULL OR sr.ordinal=ANY($4::integer[]))
          ORDER BY da.id,sr.ordinal LIMIT 10001`,
          [
            request.params.projectId,
            assetIds,
            String(body.search ?? ""),
            body.ordinals ?? null,
          ],
        );
        if (sources.rows.length > 10000) {
          await client.query("ROLLBACK");
          return reply
            .code(422)
            .send({ error: { code: "test_set_capacity_exceeded" } });
        }
        const selected = sources.rows.filter(
          (row) => !excluded.has(`${row.asset_id}:${row.ordinal}`),
        );
        let changed = 0;
        if (body.mode === "add") {
          const active = await client.query(
            `SELECT source->>'assetId' AS asset_id,
            (source->>'ordinal')::integer AS ordinal FROM collaborative_draft_record
            WHERE draft_id=$1 AND deleted=false AND source IS NOT NULL`,
            [request.params.draftId],
          );
          const activeKeys = new Set(
            active.rows.map((row) => `${row.asset_id}:${row.ordinal}`),
          );
          const additions = selected.filter(
            (row) => !activeKeys.has(`${row.asset_id}:${row.ordinal}`),
          );
          const allAssets = [
            ...new Set([
              ...active.rows.map((row) => String(row.asset_id)),
              ...additions.map((row) => String(row.asset_id)),
            ]),
          ];
          if (allAssets.length > 5) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
          const totalSize = await client.query(
            `SELECT coalesce(sum(size_bytes),0)::bigint AS size
            FROM data_asset WHERE id=ANY($1::text[])`,
            [allAssets],
          );
          if (Number(totalSize.rows[0].size) > 100000000) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
          const state = await client.query(
            `SELECT count(*) FILTER (WHERE deleted=false)::integer AS count,coalesce(max(position),0)::bigint AS high_water
            FROM collaborative_draft_record WHERE draft_id=$1`,
            [request.params.draftId],
          );
          if (Number(state.rows[0].count) + additions.length > 10000) {
            await client.query("ROLLBACK");
            return reply
              .code(422)
              .send({ error: { code: "test_set_capacity_exceeded" } });
          }
          let position = Number(state.rows[0].high_water);
          changed += await writeBatches(
            client,
            `INSERT INTO collaborative_draft_record
            (draft_id,id,position,question,expected_output,metadata,source,updated_by,field_attribution)
            SELECT $1,x.id,x.position,x.question,x.expected_output,x.metadata,x.source,$2,
              jsonb_build_object('question',jsonb_build_object('userId',$2::text,'at',now()),
                'expectedOutput',jsonb_build_object('userId',$2::text,'at',now()),
                'metadata',jsonb_build_object('userId',$2::text,'at',now()))
            FROM jsonb_to_recordset($3::jsonb) AS x(id text,position bigint,question text,expected_output text,metadata jsonb,source jsonb)
            ON CONFLICT DO NOTHING RETURNING id`,
            [request.params.draftId, actor.id],
            additions.map((row) => {
              const mapped = mapMaterialRecord(
                row.value,
                normalizeDisplayMapping(row.display_mapping) ?? {
                  metadata: [],
                },
              );
              return {
                id: opaqueId("draftrow"),
                position: ++position,
                question: mapped.question,
                expected_output: mapped.expectedOutput,
                metadata: mapped.metadata,
                source: {
                  assetId: String(row.asset_id),
                  ordinal: Number(row.ordinal),
                },
              };
            }),
          );
        } else {
          const expected = new Map(
            (
              body.expectedRecords as Array<{ id: string; rowRevision: number }>
            ).map((row) => [row.id, row.rowRevision]),
          );
          const selectedKeys = new Set(
            selected.map((row) => `${row.asset_id}:${row.ordinal}`),
          );
          const current = await client.query(
            `SELECT id,row_revision,source->>'assetId' AS asset_id,
              (source->>'ordinal')::integer AS ordinal
             FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false
               AND source->>'assetId'=ANY($2::text[]) FOR UPDATE`,
            [request.params.draftId, assetIds],
          );
          const affected = current.rows.filter((row) =>
            selectedKeys.has(`${row.asset_id}:${row.ordinal}`),
          );
          if (
            affected.some(
              (row) => expected.get(row.id) !== Number(row.row_revision),
            )
          ) {
            await client.query("ROLLBACK");
            return reply
              .code(409)
              .send({ error: { code: "draft_row_conflict" } });
          }
          if (affected.length) {
            const removed = await client.query(
              `UPDATE collaborative_draft_record SET deleted=true,
               row_revision=row_revision+1,updated_by=$3,updated_at=now()
               WHERE draft_id=$1 AND id=ANY($2::text[]) AND deleted=false`,
              [request.params.draftId, affected.map((row) => row.id), actor.id],
            );
            changed = removed.rowCount ?? 0;
          }
        }
        if (changed)
          await client.query(
            `UPDATE collaborative_draft SET revision=revision+1,
          updated_by=$2,updated_at=now() WHERE id=$1`,
            [request.params.draftId, actor.id],
          );
        await client.query("COMMIT");
        return { matched: selected.length, changed };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
