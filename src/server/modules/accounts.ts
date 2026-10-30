import { accountOperations } from "../../management/accounts.js";
import { BusinessError } from "../../operations/errors.js";
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
  const management = accountOperations(db, now);
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

  app.get(
    "/api/session",
    { preHandler: authenticate },
    async (request) => {
      const actor = (request as AuthenticatedRequest).actor;
      return { csrfToken: actor.csrfToken, actor: publicSessionActor(actor) };
    },
  );

  app.get("/api/me", { preHandler: authenticate }, async (request, reply) => {
    const actor = (request as AuthenticatedRequest).actor;
    try {
      const result = await management.profile(
        { actorId: actor.id, projectId: "" },
        { ...{} },
      );
      return reply.code(200).send(result);
    } catch (e) {
      if (e instanceof BusinessError)
        return reply.code(e.status).send({ error: { code: e.code } });
      throw e;
    }
  });

  app.patch<{ Body: unknown }>(
    "/api/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await management.updateProfile(
          { actorId: actor.id, projectId: "" },
          { ...{}, body: request.body },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/members",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      try {
        const result = await management.members(
          { actorId: actor.id, projectId: request.params.projectId },
          { ...request.params },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/invitations",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      try {
        const result = await management.invitations(
          { actorId: actor.id, projectId: request.params.projectId },
          { ...request.params },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/invitations",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await management.invite(
          { actorId: actor.id, projectId: request.params.projectId },
          { ...request.params, body: request.body },
        );
        return reply.code(201).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
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
      try {
        await management.revokeInvitation(
          { actorId: actor.id, projectId: request.params.projectId },
          { ...request.params, body: request.body },
        );
        return reply.code(204).send(undefined);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
    },
  );

  app.get(
    "/api/me/invitations",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      try {
        const result = await management.myInvitations(
          { actorId: actor.id, projectId: "" },
          { ...{} },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
    },
  );

  app.post<{ Params: { invitationId: string } }>(
    "/api/me/invitations/:invitationId/accept",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        const result = await management.acceptInvitation(
          { actorId: actor.id, projectId: "" },
          { ...request.params, body: request.body },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
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
      try {
        const result = await management.changeRole(
          { actorId: actor.id, projectId: request.params.projectId },
          { ...request.params, body: request.body },
        );
        return reply.code(200).send(result);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
    },
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/api/projects/:projectId/members/:userId",
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (!writeAllowed(request, actor))
        return reply.code(403).send({ error: { code: "csrf_rejected" } });
      try {
        await management.removeMember(
          { actorId: actor.id, projectId: request.params.projectId },
          { ...request.params, body: request.body },
        );
        return reply.code(204).send(undefined);
      } catch (e) {
        if (e instanceof BusinessError)
          return reply.code(e.status).send({ error: { code: e.code } });
        throw e;
      }
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
            AND pv.status = 'ready' AND pv.mapping_ready
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
