import { randomBytes } from "node:crypto";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { hashPassword, verifyPassword } from "../../security/password.js";
import {
  hasProjectCapability,
  isTestIdentityRole,
} from "../../security/project-access.js";
import type { ServerContext } from "../context.js";
import {
  AuthenticatedRequest,
  sessionActor,
  publicSessionActor,
  opaqueId,
  isPlainObject,
  sessionHash,
  normalizeDisplayMapping,
  MetadataEntry,
  mapMaterialRecord,
} from "../support.js";

export function registerAccounts(
  context: Pick<
    ServerContext,
    | "config"
    | "db"
    | "now"
    | "app"
    | "legacyTestBootstrap"
    | "writeAllowed"
    | "enforceDeletionLock"
  >,
) {
  const {
    config,
    db,
    now,
    app,
    legacyTestBootstrap,
    writeAllowed,
    enforceDeletionLock,
  } = context;
  app.get("/api/installation", async () => {
    const state = await db.query(
      `SELECT EXISTS(SELECT 1 FROM installation_state) AS initialized,
              EXISTS(SELECT 1 FROM app_user) AS has_users`,
    );
    const row = state.rows[0];
    return {
      needsAdministrator: !row.initialized && !row.has_users,
      ...(row.has_users && !row.initialized ? { needsMigration: true } : {}),
    };
  });

  app.post<{ Body: unknown }>(
    "/api/installation/administrator",
    async (request, reply) => {
      if (request.headers.origin !== config.appOrigin)
        return reply.code(403).send({ error: { code: "origin_rejected" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some(
          (key) =>
            !["email", "displayName", "password", "confirmPassword"].includes(
              key,
            ),
        ) ||
        typeof body.email !== "string" ||
        typeof body.displayName !== "string" ||
        typeof body.password !== "string" ||
        typeof body.confirmPassword !== "string" ||
        body.password !== body.confirmPassword ||
        body.password.length < 8 ||
        body.displayName.trim().length < 1 ||
        body.displayName.trim().length > 30
      )
        return reply
          .code(422)
          .send({ error: { code: "account_payload_invalid" } });
      const email = body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254)
        return reply
          .code(422)
          .send({ error: { code: "account_payload_invalid" } });
      const passwordHash = await hashPassword(body.password);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(91827463)");
        const prior = await client.query(
          `SELECT EXISTS(SELECT 1 FROM installation_state) AS initialized,
                  EXISTS(SELECT 1 FROM app_user) AS has_users`,
        );
        if (prior.rows[0].initialized || prior.rows[0].has_users) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "installation_already_initialized" } });
        }
        const id = opaqueId("user");
        await client.query(
          `INSERT INTO app_user (id, username, email, display_name, password_hash, role)
           VALUES ($1, $2, $2, $3, $4, 'admin')`,
          [id, email, body.displayName.trim(), passwordHash],
        );
        await client.query("INSERT INTO installation_state (id) VALUES (true)");
        await client.query("COMMIT");
        return reply.code(201).send({ administrator: { id, email } });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Body: unknown }>("/api/accounts", async (request, reply) => {
    if (request.headers.origin !== config.appOrigin)
      return reply.code(403).send({ error: { code: "origin_rejected" } });
    const body = request.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some(
        (key) => !["email", "password", "confirmPassword"].includes(key),
      ) ||
      typeof body.email !== "string" ||
      typeof body.password !== "string" ||
      typeof body.confirmPassword !== "string" ||
      body.password.length < 8 ||
      body.password !== body.confirmPassword
    )
      return reply
        .code(422)
        .send({ error: { code: "account_payload_invalid" } });
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254)
      return reply
        .code(422)
        .send({ error: { code: "account_payload_invalid" } });
    const passwordHash = await hashPassword(body.password);
    const id = opaqueId("user");
    const name = email.split("@", 1)[0].slice(0, 30);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(91827463)");
      const installed = await client.query(
        "SELECT 1 FROM installation_state LIMIT 1",
      );
      if (!installed.rowCount) {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: { code: "administrator_setup_required" } });
      }
      await client.query(
        `INSERT INTO app_user (id, username, email, display_name, password_hash, role)
         VALUES ($1, $2, $2, $3, $4, 'user')`,
        [id, email, name, passwordHash],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505")
        return reply
          .code(409)
          .send({ error: { code: "email_already_registered" } });
      throw error;
    } finally {
      client.release();
    }
    return reply.code(201).send({ account: { id, email, displayName: name } });
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/session",
    async (request, reply) => {
      if (
        request.headers.origin !== config.appOrigin &&
        !(
          config.allowTestIdentity &&
          request.headers.origin === "http://web:3000"
        )
      ) {
        return reply.code(403).send({ error: { code: "origin_rejected" } });
      }
      const body = request.body as unknown;
      const soloBootstrap =
        legacyTestBootstrap &&
        config.soloOwnerMode &&
        (body === undefined ||
          (isPlainObject(body) && Object.keys(body).length === 0));
      if (legacyTestBootstrap && config.soloOwnerMode && !soloBootstrap)
        return reply.code(404).send({ error: { code: "route_not_found" } });
      const username =
        isPlainObject(body) && typeof body.email === "string"
          ? body.email.trim().toLowerCase()
          : legacyTestBootstrap &&
              isPlainObject(body) &&
              typeof body.username === "string"
            ? body.username
            : undefined;
      const password =
        isPlainObject(body) && typeof body.password === "string"
          ? body.password
          : undefined;
      const result = await db.query(
        `SELECT u.id, u.username, u.email, u.display_name, u.avatar_color, u.role, u.password_hash,
                pm.role AS project_role
         FROM app_user u
         LEFT JOIN project_member pm
           ON pm.project_id='project_demo' AND pm.user_id=u.id
         WHERE ${soloBootstrap ? "u.id = 'user_owner'" : legacyTestBootstrap ? "u.email = $1 OR u.username = $1" : "u.email = $1"}`,
        soloBootstrap ? [] : [username],
      );
      const user = result.rows[0];
      if (
        !user ||
        (!soloBootstrap &&
          !(await verifyPassword(password ?? "", user.password_hash)))
      ) {
        return reply.code(401).send({ error: { code: "invalid_credentials" } });
      }
      if (
        !soloBootstrap &&
        ((!legacyTestBootstrap && !user.email) ||
          (!config.allowTestIdentity && isTestIdentityRole(user.role)))
      )
        return reply.code(401).send({ error: { code: "invalid_credentials" } });
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(24).toString("base64url");
      await db.query(
        `INSERT INTO app_session (token_hash, user_id, csrf_token, expires_at)
       VALUES ($1, $2, $3, now() + interval '8 hours')`,
        [sessionHash(token), user.id, csrfToken],
      );
      reply.setCookie("agentbench_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.appOrigin.startsWith("https://"),
        path: "/",
        maxAge: 8 * 60 * 60,
      });
      const actor = sessionActor(user, csrfToken);
      return { csrfToken, actor: publicSessionActor(actor) };
    },
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.agentbench_session;
    if (!token)
      return reply
        .code(401)
        .send({ error: { code: "authentication_required" } });
    const result = await db.query(
      `SELECT u.id, u.username, u.email, u.display_name, u.avatar_color, u.role, s.csrf_token,
              pm.role AS project_role
       FROM app_session s JOIN app_user u ON u.id = s.user_id
       LEFT JOIN project_member pm
         ON pm.project_id = 'project_demo' AND pm.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sessionHash(token)],
    );
    if (!result.rowCount)
      return reply
        .code(401)
        .send({ error: { code: "authentication_required" } });
    if (
      (!legacyTestBootstrap && !result.rows[0].email) ||
      (!config.allowTestIdentity && isTestIdentityRole(result.rows[0].role))
    ) {
      await db.query("DELETE FROM app_session WHERE token_hash = $1", [
        sessionHash(token),
      ]);
      return reply
        .code(401)
        .send({ error: { code: "authentication_required" } });
    }
    (request as AuthenticatedRequest).actor = sessionActor(
      result.rows[0],
      result.rows[0].csrf_token,
    );
    if (await enforceDeletionLock(request, reply)) return;
  }

  app.delete(
    "/api/session",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const token = request.cookies.agentbench_session;
      await db.query("DELETE FROM app_session WHERE token_hash = $1", [
        sessionHash(token!),
      ]);
      reply.clearCookie("agentbench_session", { path: "/" });
      return reply.code(204).send();
    },
  );

  app.get("/api/session", { preHandler: authenticate }, async (request) => {
    const actor = (request as AuthenticatedRequest).actor;
    return { csrfToken: actor.csrfToken, actor: publicSessionActor(actor) };
  });

  app.get("/api/me", { preHandler: authenticate }, async (request) => {
    const actor = (request as AuthenticatedRequest).actor;
    const result = await db.query(
      "SELECT id, email, display_name, avatar_color, role FROM app_user WHERE id = $1",
      [actor.id],
    );
    const user = result.rows[0];
    return {
      account: {
        id: user.id,
        email: user.email,
        displayName: user.display_name ?? user.username,
        avatarColor: user.avatar_color,
        role: user.role,
      },
    };
  });

  app.patch<{ Body: unknown }>(
    "/api/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(
          (key) => !["displayName", "avatarColor"].includes(key),
        ) ||
        (body.displayName !== undefined &&
          (typeof body.displayName !== "string" ||
            body.displayName.trim().length < 1 ||
            body.displayName.trim().length > 30)) ||
        (body.avatarColor !== undefined &&
          (typeof body.avatarColor !== "string" ||
            !/^#[0-9a-fA-F]{6}$/u.test(body.avatarColor)))
      )
        return reply
          .code(422)
          .send({ error: { code: "profile_payload_invalid" } });
      const result = await db.query(
        `UPDATE app_user
       SET display_name = coalesce($2, display_name),
           avatar_color = coalesce($3, avatar_color)
       WHERE id = $1
       RETURNING id, email, display_name, avatar_color, role`,
        [
          actor.id,
          typeof body.displayName === "string" ? body.displayName.trim() : null,
          typeof body.avatarColor === "string"
            ? body.avatarColor.toLowerCase()
            : null,
        ],
      );
      const user = result.rows[0];
      return {
        account: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          avatarColor: user.avatar_color,
          role: user.role,
        },
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/members",
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
      const result = await db.query(
        `SELECT u.id, u.email, u.display_name, u.avatar_color,
                CASE WHEN u.role = 'admin' THEN 'admin' ELSE pm.role END AS role
         FROM app_user u
         LEFT JOIN project_member pm ON pm.user_id = u.id AND pm.project_id = $1
         WHERE u.role = 'admin' OR pm.role IN ('editor', 'viewer')
         ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.display_name, u.id`,
        [request.params.projectId],
      );
      return {
        members: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          avatarColor: row.avatar_color,
          role: row.role,
        })),
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/invitations",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (
        !(await hasProjectCapability(
          db,
          request.params.projectId,
          actor.id,
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `SELECT id, email, role, status, expires_at, created_at
         FROM project_invitation WHERE project_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 100`,
        [request.params.projectId],
      );
      return {
        invitations: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          status:
            row.status === "pending" && new Date(row.expires_at) <= now()
              ? "expired"
              : row.status,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/invitations",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).some((key) => !["email", "role"].includes(key)) ||
        typeof body.email !== "string" ||
        !["editor", "viewer"].includes(String(body.role))
      )
        return reply
          .code(422)
          .send({ error: { code: "invitation_payload_invalid" } });
      const email = body.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
        return reply
          .code(422)
          .send({ error: { code: "invitation_payload_invalid" } });
      const target = await db.query(
        "SELECT id FROM app_user WHERE lower(email) = $1 AND role = 'user'",
        [email],
      );
      if (!target.rowCount)
        return reply
          .code(422)
          .send({ error: { code: "account_not_registered" } });
      const targetId = String(target.rows[0].id);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE project_invitation SET status = 'expired'
           WHERE project_id = $1 AND target_user_id = $2 AND status = 'pending'
             AND expires_at <= now()`,
          [request.params.projectId, targetId],
        );
        const member = await client.query(
          "SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2",
          [request.params.projectId, targetId],
        );
        if (member.rowCount) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "already_project_member" } });
        }
        const id = opaqueId("invitation");
        const result = await client.query(
          `INSERT INTO project_invitation
             (id, project_id, target_user_id, email, role, invited_by, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + interval '7 days')
           RETURNING id, email, role, expires_at`,
          [id, request.params.projectId, targetId, email, body.role, actor.id],
        );
        await client.query("COMMIT");
        const row = result.rows[0];
        return reply.code(201).send({
          invitation: {
            id: row.id,
            email: row.email,
            role: row.role,
            expiresAt: row.expires_at,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if ((error as { code?: string }).code === "23505")
          return reply
            .code(409)
            .send({ error: { code: "invitation_pending" } });
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { projectId: string; invitationId: string } }>(
    "/api/projects/:projectId/invitations/:invitationId",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `UPDATE project_invitation SET status = 'revoked'
         WHERE id = $1 AND project_id = $2 AND status = 'pending' RETURNING id`,
        [request.params.invitationId, request.params.projectId],
      );
      if (!result.rowCount)
        return reply
          .code(404)
          .send({ error: { code: "invitation_not_found" } });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/me/invitations",
    { preHandler: authenticate },
    async (request) => {
      const actor = (request as AuthenticatedRequest).actor;
      const result = await db.query(
        `SELECT i.id, i.project_id, p.name AS project_name, i.role, i.expires_at
       FROM project_invitation i JOIN project p ON p.id = i.project_id
       WHERE i.target_user_id = $1 AND i.status = 'pending' AND i.expires_at > now()
       ORDER BY i.created_at DESC`,
        [actor.id],
      );
      return {
        invitations: result.rows.map((row) => ({
          id: row.id,
          projectId: row.project_id,
          projectName: row.project_name,
          role: row.role,
          expiresAt: row.expires_at,
        })),
      };
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/api/me/invitations/:invitationId/accept",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT id, project_id, target_user_id, role, status, expires_at
           FROM project_invitation WHERE id = $1 FOR UPDATE`,
          [request.params.invitationId],
        );
        const invitation = result.rows[0];
        if (!invitation || invitation.target_user_id !== actor.id) {
          await client.query("ROLLBACK");
          return reply
            .code(404)
            .send({ error: { code: "invitation_not_found" } });
        }
        if (invitation.status === "accepted") {
          await client.query("COMMIT");
          return { projectId: invitation.project_id, role: invitation.role };
        }
        if (
          invitation.status !== "pending" ||
          new Date(invitation.expires_at) <= now()
        ) {
          await client.query("ROLLBACK");
          return reply
            .code(409)
            .send({ error: { code: "invitation_inactive" } });
        }
        await client.query(
          `INSERT INTO project_member (project_id, user_id, role)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [invitation.project_id, actor.id, invitation.role],
        );
        await client.query(
          "UPDATE project_invitation SET status = 'accepted', accepted_at = now() WHERE id = $1",
          [invitation.id],
        );
        const membership = await client.query(
          "SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2",
          [invitation.project_id, actor.id],
        );
        await client.query("COMMIT");
        return {
          projectId: invitation.project_id,
          role: membership.rows[0].role,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.patch<{ Params: { projectId: string; userId: string }; Body: unknown }>(
    "/api/projects/:projectId/members/:userId",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const body = request.body;
      if (
        !isPlainObject(body) ||
        Object.keys(body).length !== 1 ||
        !["editor", "viewer"].includes(String(body.role))
      )
        return reply
          .code(422)
          .send({ error: { code: "member_payload_invalid" } });
      const result = await db.query(
        `UPDATE project_member SET role = $3
         WHERE project_id = $1 AND user_id = $2 AND role IN ('editor', 'viewer')
         RETURNING role`,
        [request.params.projectId, request.params.userId, body.role],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "member_not_found" } });
      return { userId: request.params.userId, role: result.rows[0].role };
    },
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/api/projects/:projectId/members/:userId",
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
          "manage",
        ))
      )
        return reply.code(404).send({ error: { code: "project_not_found" } });
      const result = await db.query(
        `DELETE FROM project_member WHERE project_id = $1 AND user_id = $2
         AND role IN ('editor', 'viewer') RETURNING user_id`,
        [request.params.projectId, request.params.userId],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: { code: "member_not_found" } });
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { projectId: string };
  }>(
    "/api/projects/:projectId/solo-test-set-sources",
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
      const result = await db.query(
        `SELECT c.id AS collection_id, c.name AS collection_name,
                da.id AS asset_id, da.file_name, sr.ordinal, sr.value,
                pv.display_mapping
           FROM raw_material_collection c
           JOIN data_asset da
             ON da.collection_id = c.id AND da.project_id = c.project_id
           JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
           JOIN source_record sr ON sr.parsed_view_id = pv.id
          WHERE c.project_id = $1
            AND da.status NOT IN ('deletion_pending', 'tombstoned')
            AND pv.status = 'ready'
            AND sr.parse_status = 'valid'
          ORDER BY c.name, da.file_name, sr.ordinal`,
        [request.params.projectId],
      );
      const collections = new Map<
        string,
        {
          id: string;
          name: string;
          files: Array<{
            id: string;
            fileName: string;
            records: Array<{
              assetId: string;
              ordinal: number;
              question: string;
              expectedOutput: string;
              metadata: MetadataEntry[];
            }>;
          }>;
        }
      >();
      for (const row of result.rows) {
        let collection = collections.get(row.collection_id);
        if (!collection) {
          collection = {
            id: row.collection_id,
            name: row.collection_name,
            files: [],
          };
          collections.set(row.collection_id, collection);
        }
        let file = collection.files.at(-1);
        if (!file || file.id !== row.asset_id) {
          file = { id: row.asset_id, fileName: row.file_name, records: [] };
          collection.files.push(file);
        }
        file.records.push({
          assetId: row.asset_id,
          ordinal: Number(row.ordinal),
          ...mapMaterialRecord(
            row.value,
            normalizeDisplayMapping(row.display_mapping) ?? { metadata: [] },
          ),
        });
      }
      return { datasets: [...collections.values()] };
    },
  );

  return authenticate;
}
