import { BusinessError } from "../operations/errors.js";
import type { Database } from "../db/pool.js";
import type { OperationScope } from "../operations/commit.js";
import { hasProjectCapability } from "../security/project-access.js";
import { opaqueId, isPlainObject } from "../server/support.js";
import { managementMutation } from "./transaction.js";
export function accountOperations(
  db: Database,
  now = () => new Date(),
  check?: (c: Pick<Database, "query">) => Promise<void>,
) {
  const mutate = <T>(
    scope: OperationScope,
    run: (db: Pick<Database, "query">) => Promise<T>,
    self = false,
  ) => managementMutation(db, scope, run, self, check);
  return {
    async profile(scope: OperationScope, _input: any = {}) {
      const actor = { id: scope.actorId };
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
    },
    async updateProfile(scope: OperationScope, input: any = {}) {
      return mutate(
        scope,
        async (db) => {
          const actor = { id: scope.actorId };

          const body = input.body;
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
            throw new BusinessError(422, "profile_payload_invalid");
          const result = await db.query(
            `UPDATE app_user
       SET display_name = coalesce($2, display_name),
           avatar_color = coalesce($3, avatar_color)
       WHERE id = $1
       RETURNING id, email, display_name, avatar_color, role`,
            [
              actor.id,
              typeof body.displayName === "string"
                ? body.displayName.trim()
                : null,
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
        true,
      );
    },
    async members(scope: OperationScope, _input: any = {}) {
      const actor = { id: scope.actorId };
      if (!(await hasProjectCapability(db, scope.projectId, actor.id, "read")))
        throw new BusinessError(404, "project_not_found");
      const result = await db.query(
        `SELECT u.id, u.email, u.display_name, u.avatar_color,
                CASE WHEN u.role = 'admin' THEN 'admin' ELSE pm.role END AS role
         FROM app_user u
         LEFT JOIN project_member pm ON pm.user_id = u.id AND pm.project_id = $1
         WHERE u.role = 'admin' OR pm.role IN ('editor', 'viewer')
         ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.display_name, u.id`,
        [scope.projectId],
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
    async invitations(scope: OperationScope, _input: any = {}) {
      const actor = { id: scope.actorId };
      if (
        !(await hasProjectCapability(db, scope.projectId, actor.id, "manage"))
      )
        throw new BusinessError(404, "project_not_found");
      const result = await db.query(
        `SELECT id, email, role, status, expires_at, created_at
         FROM project_invitation WHERE project_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 100`,
        [scope.projectId],
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
    async invite(scope: OperationScope, input: any = {}) {
      return mutate(scope, async (db) => {
        const actor = { id: scope.actorId };

        if (
          !(await hasProjectCapability(db, scope.projectId, actor.id, "manage"))
        )
          throw new BusinessError(404, "project_not_found");
        const body = input.body;
        if (
          !isPlainObject(body) ||
          Object.keys(body).some((key) => !["email", "role"].includes(key)) ||
          typeof body.email !== "string" ||
          !["editor", "viewer"].includes(String(body.role))
        )
          throw new BusinessError(422, "invitation_payload_invalid");
        const email = body.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
          throw new BusinessError(422, "invitation_payload_invalid");
        const target = await db.query(
          "SELECT id FROM app_user WHERE lower(email) = $1 AND role = 'user'",
          [email],
        );
        if (!target.rowCount)
          throw new BusinessError(422, "account_not_registered");
        const targetId = String(target.rows[0].id);

        try {
          await db.query(
            `UPDATE project_invitation SET status = 'expired'
           WHERE project_id = $1 AND target_user_id = $2 AND status = 'pending'
             AND expires_at <= now()`,
            [scope.projectId, targetId],
          );
          const member = await db.query(
            "SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2",
            [scope.projectId, targetId],
          );
          if (member.rowCount) {
            throw new BusinessError(409, "already_project_member");
          }
          const id = opaqueId("invitation");
          const result = await db.query(
            `INSERT INTO project_invitation
             (id, project_id, target_user_id, email, role, invited_by, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + interval '7 days')
           RETURNING id, email, role, expires_at`,
            [id, scope.projectId, targetId, email, body.role, actor.id],
          );

          const row = result.rows[0];
          return {
            invitation: {
              id: row.id,
              email: row.email,
              role: row.role,
              expiresAt: row.expires_at,
            },
          };
        } catch (error) {
          if ((error as { code?: string }).code === "23505")
            throw new BusinessError(409, "invitation_pending");
          throw error;
        }
      });
    },
    async revokeInvitation(scope: OperationScope, input: any = {}) {
      return mutate(scope, async (db) => {
        const actor = { id: scope.actorId };

        if (
          !(await hasProjectCapability(db, scope.projectId, actor.id, "manage"))
        )
          throw new BusinessError(404, "project_not_found");
        const result = await db.query(
          `UPDATE project_invitation SET status = 'revoked'
         WHERE id = $1 AND project_id = $2 AND status = 'pending' RETURNING id`,
          [input.invitationId, scope.projectId],
        );
        if (!result.rowCount)
          throw new BusinessError(404, "invitation_not_found");
        return { done: true };
      });
    },
    async myInvitations(scope: OperationScope, _input: any = {}) {
      const actor = { id: scope.actorId };
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
    async acceptInvitation(scope: OperationScope, input: any = {}) {
      return mutate(
        scope,
        async (db) => {
          const actor = { id: scope.actorId };

          const result = await db.query(
            `SELECT id, project_id, target_user_id, role, status, expires_at
           FROM project_invitation WHERE id = $1 FOR UPDATE`,
            [input.invitationId],
          );
          const invitation = result.rows[0];
          if (!invitation || invitation.target_user_id !== actor.id) {
            throw new BusinessError(404, "invitation_not_found");
          }
          if (invitation.status === "accepted") {
            const member = (
              await db.query(
                "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
                [invitation.project_id, actor.id],
              )
            ).rows[0];
            if (!member) throw new BusinessError(409, "invitation_inactive");
            return { projectId: invitation.project_id, role: member.role };
          }
          if (
            invitation.status !== "pending" ||
            new Date(invitation.expires_at) <= now()
          ) {
            throw new BusinessError(409, "invitation_inactive");
          }
          await db.query(
            `INSERT INTO project_member (project_id, user_id, role)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [invitation.project_id, actor.id, invitation.role],
          );
          await db.query(
            "UPDATE project_invitation SET status = 'accepted', accepted_at = now() WHERE id = $1",
            [invitation.id],
          );
          const membership = await db.query(
            "SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2",
            [invitation.project_id, actor.id],
          );

          return {
            projectId: invitation.project_id,
            role: membership.rows[0].role,
          };
        },
        true,
      );
    },
    async changeRole(scope: OperationScope, input: any = {}) {
      return mutate(scope, async (db) => {
        const actor = { id: scope.actorId };

        if (
          !(await hasProjectCapability(db, scope.projectId, actor.id, "manage"))
        )
          throw new BusinessError(404, "project_not_found");
        const body = input.body;
        if (
          !isPlainObject(body) ||
          Object.keys(body).length !== 1 ||
          !["editor", "viewer"].includes(String(body.role))
        )
          throw new BusinessError(422, "member_payload_invalid");
        const result = await db.query(
          `UPDATE project_member SET role = $3
         WHERE project_id = $1 AND user_id = $2 AND role IN ('editor', 'viewer')
         RETURNING role`,
          [scope.projectId, input.userId, body.role],
        );
        if (!result.rowCount) throw new BusinessError(404, "member_not_found");
        return { userId: input.userId, role: result.rows[0].role };
      });
    },
    async removeMember(scope: OperationScope, input: any = {}) {
      return mutate(scope, async (db) => {
        const actor = { id: scope.actorId };

        if (
          !(await hasProjectCapability(db, scope.projectId, actor.id, "manage"))
        )
          throw new BusinessError(404, "project_not_found");
        const result = await db.query(
          `DELETE FROM project_member WHERE project_id = $1 AND user_id = $2
         AND role IN ('editor', 'viewer') RETURNING user_id`,
          [scope.projectId, input.userId],
        );
        if (!result.rowCount) throw new BusinessError(404, "member_not_found");
        return { done: true };
      });
    },
  };
}
