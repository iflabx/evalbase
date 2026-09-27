import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";
import { bindLegacyAdministrator } from "../../src/security/bind-legacy-administrator.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

const databaseName = `evalbase_v2a_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("v2 account bootstrap", () => {
  let app: AgentBenchApp;
  beforeAll(async () => {
    const admin = createPool(baseUrl);
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await admin.end();
    }
    await migrate(testUrl);
    app = await buildApp(
      {
        databaseUrl: testUrl,
        appOrigin: "http://127.0.0.1:4215",
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
  });
  afterAll(async () => {
    await app?.close();
    const admin = createPool(baseUrl);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("creates exactly one first administrator and never grants it to a later visitor", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/installation",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ needsAdministrator: true });
    const earlyAccount = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin: "http://127.0.0.1:4215" },
      payload: {
        email: "early@example.test",
        password: "earlyPass123",
        confirmPassword: "earlyPass123",
      },
    });
    expect(earlyAccount.statusCode).toBe(409);

    const request = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/installation/administrator",
        headers: { origin: "http://127.0.0.1:4215" },
        payload: {
          email,
          displayName: "管理员",
          password: "v2AdminPass123",
          confirmPassword: "v2AdminPass123",
        },
      });
    const results = await Promise.all([
      request("first@example.test"),
      request("second@example.test"),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const after = await app.inject({ method: "GET", url: "/api/installation" });
    expect(after.json()).toEqual({ needsAdministrator: false });

    const db = createPool(testUrl);
    try {
      const users = await db.query(
        "SELECT email, role FROM app_user WHERE role = 'admin'",
      );
      expect(users.rowCount).toBe(1);
    } finally {
      await db.end();
    }
  });

  it("registers an ordinary account while only the administrator can create and read every project", async () => {
    const origin = "http://127.0.0.1:4215";
    const register = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: {
        email: "member@example.test",
        password: "memberPass123",
        confirmPassword: "memberPass123",
      },
    });
    expect(register.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: {
        email: " MEMBER@EXAMPLE.TEST ",
        password: "memberPass123",
        confirmPassword: "memberPass123",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    const db = createPool(testUrl);
    const adminEmail = (
      await db.query("SELECT email FROM app_user WHERE role = 'admin'")
    ).rows[0].email;
    await db.end();
    const login = async (email: string, password: string) => {
      const result = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { email, password },
      });
      expect(result.statusCode).toBe(200);
      return {
        cookie: `${result.cookies[0].name}=${result.cookies[0].value}`,
        csrf: result.json().csrfToken,
      };
    };
    const administrator = await login(adminEmail, "v2AdminPass123");
    const member = await login("member@example.test", "memberPass123");
    const create = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        origin,
        cookie: administrator.cookie,
        "x-csrf-token": administrator.csrf,
      },
      payload: { name: "v2 synthetic project" },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().project.id;
    const administratorProject = await app.inject({
      method: "GET",
      url: `/api/projects/${id}`,
      headers: { cookie: administrator.cookie },
    });
    expect(administratorProject.statusCode).toBe(200);
    const adminAccess = await app.inject({ method: "GET", url: `/api/projects/${id}/access`, headers: { cookie: administrator.cookie } });
    expect(adminAccess.statusCode).toBe(200);
    expect(adminAccess.json().access).toMatchObject({ role: "admin", capabilities: { manage: true } });
    const memberProject = await app.inject({
      method: "GET",
      url: `/api/projects/${id}`,
      headers: { cookie: member.cookie },
    });
    expect(memberProject.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/projects/${id}/access`, headers: { cookie: member.cookie } })).statusCode).toBe(404);
    const denied = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie: member.cookie, "x-csrf-token": member.csrf },
      payload: { name: "forbidden" },
    });
    expect(denied.statusCode).toBe(403);
    const listed = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: administrator.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed
        .json()
        .projects.some((project: { id: string }) => project.id === id),
    ).toBe(true);
    const logout = await app.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { origin, cookie: member.cookie, "x-csrf-token": member.csrf },
    });
    expect(logout.statusCode).toBe(204);
    const replay = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: member.cookie },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("allows only the administrator to invite a registered account into a project", async () => {
    const origin = "http://127.0.0.1:4215";
    const registered = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: {
        email: "invitee@example.test",
        password: "inviteePass123",
        confirmPassword: "inviteePass123",
      },
    });
    expect(registered.statusCode).toBe(201);
    const db = createPool(testUrl);
    const adminEmail = (
      await db.query("SELECT email FROM app_user WHERE role = 'admin'")
    ).rows[0].email;
    await db.end();
    const login = async (email: string, password: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      return {
        cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
        csrf: response.json().csrfToken,
      };
    };
    const admin = await login(adminEmail, "v2AdminPass123");
    const invitee = await login("invitee@example.test", "inviteePass123");
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin, cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { name: "Invitation project" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id;
    const unknown = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/invitations`,
      headers: { origin, cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { email: "absent@example.test", role: "editor" },
    });
    expect(unknown.statusCode).toBe(422);
    const invited = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/invitations`,
      headers: { origin, cookie: admin.cookie, "x-csrf-token": admin.csrf },
      payload: { email: "INVITEE@example.test", role: "editor" },
    });
    expect(invited.statusCode).toBe(201);
    const invitationId = invited.json().invitation.id;
    const inbox = await app.inject({
      method: "GET",
      url: "/api/me/invitations",
      headers: { cookie: invitee.cookie },
    });
    expect(inbox.statusCode).toBe(200);
    expect(
      inbox.json().invitations.map((item: { id: string }) => item.id),
    ).toContain(invitationId);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/me/invitations/${invitationId}/accept`,
      headers: { origin, cookie: invitee.cookie, "x-csrf-token": invitee.csrf },
    });
    expect(accepted.statusCode).toBe(200);
    const project = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
      headers: { cookie: invitee.cookie },
    });
    expect(project.statusCode).toBe(200);
    const editorAccess = await app.inject({ method: "GET", url: `/api/projects/${projectId}/access`, headers: { cookie: invitee.cookie } });
    expect(editorAccess.statusCode).toBe(200);
    expect(editorAccess.json().access).toMatchObject({ role: "editor", capabilities: { write: true, manage: false } });
  });
  it("enforces invitation ownership, revocation, expiry and immediate role changes", async () => {
    const origin = "http://127.0.0.1:4215";
    const auth = async (email: string, password: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      return {
        cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
        csrf: response.json().csrfToken,
      };
    };
    const headers = (actor: { cookie: string; csrf: string }) => ({
      origin,
      cookie: actor.cookie,
      "x-csrf-token": actor.csrf,
    });
    const db = createPool(testUrl);
    try {
      const adminEmail = (
        await db.query("SELECT email FROM app_user WHERE role = 'admin'")
      ).rows[0].email;
      const projectId = (
        await db.query(
          "SELECT id FROM project WHERE name = 'Invitation project'",
        )
      ).rows[0].id;
      const admin = await auth(adminEmail, "v2AdminPass123");
      const editor = await auth("invitee@example.test", "inviteePass123");
      const register = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { origin },
        payload: {
          email: "outsider@example.test",
          password: "outsiderPass123",
          confirmPassword: "outsiderPass123",
        },
      });
      expect(register.statusCode).toBe(201);
      const outsider = await auth("outsider@example.test", "outsiderPass123");
      const inviteUrl = `/api/projects/${projectId}/invitations`;
      const denyInvite = await app.inject({
        method: "POST",
        url: inviteUrl,
        headers: headers(editor),
        payload: { email: "outsider@example.test", role: "viewer" },
      });
      expect(denyInvite.statusCode).toBe(404);
      const create = async () =>
        app.inject({
          method: "POST",
          url: inviteUrl,
          headers: headers(admin),
          payload: { email: "outsider@example.test", role: "viewer" },
        });
      const first = await create();
      expect(first.statusCode).toBe(201);
      const firstId = first.json().invitation.id;
      expect((await create()).statusCode).toBe(409);
      const steal = await app.inject({
        method: "POST",
        url: `/api/me/invitations/${firstId}/accept`,
        headers: headers(editor),
      });
      expect(steal.statusCode).toBe(404);
      await db.query(
        "UPDATE project_invitation SET expires_at = now() - interval '1 second' WHERE id = $1",
        [firstId],
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/me/invitations/${firstId}/accept`,
            headers: headers(outsider),
          })
        ).statusCode,
      ).toBe(409);
      const second = await create();
      expect(second.statusCode).toBe(201);
      const secondId = second.json().invitation.id;
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `${inviteUrl}/${secondId}`,
            headers: headers(admin),
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/me/invitations/${secondId}/accept`,
            headers: headers(outsider),
          })
        ).statusCode,
      ).toBe(409);
      const third = await create();
      expect(third.statusCode).toBe(201);
      const thirdId = third.json().invitation.id;
      const acceptedPair = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.inject({
            method: "POST",
            url: `/api/me/invitations/${thirdId}/accept`,
            headers: headers(outsider),
          }),
        ),
      );
      expect(acceptedPair.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(acceptedPair[0]?.json()).toEqual(acceptedPair[1]?.json());
      expect(
        (
          await db.query(
            "SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = (SELECT id FROM app_user WHERE email = 'outsider@example.test')",
            [projectId],
          )
        ).rowCount,
      ).toBe(1);
      const testSet = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/solo-test-sets`,
        headers: { ...headers(editor), "idempotency-key": "v2a-editor-set" },
        payload: {
          name: "Editor synthetic set",
          purpose: "access check",
          selections: [],
          operations: [
            {
              operation: "add",
              after: { question: "Q", expectedOutput: "A", metadata: [] },
            },
          ],
        },
      });
      expect(testSet.statusCode).toBe(201);
      const testSetId = testSet.json().testSet.id;
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/solo-test-sets`,
            headers: { cookie: admin.cookie },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/trash`,
            headers: headers(editor),
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      const raw = Buffer.from("question,answer\nSynthetic,Yes\n");
      const artifacts = new ArtifactRepository(loadConfig().minio);
      await artifacts.initialize();
      const stored = await artifacts.storeImmutable(raw, `v2a-${randomUUID()}`);
      const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
      await db.query(
        `INSERT INTO data_asset (id, project_id, collection_id, blob_sha256, object_ref, size_bytes, mime_type, file_name, format, status, uploaded_by)
         VALUES ($1, $2, (SELECT id FROM raw_material_collection WHERE project_id = $2 AND is_unfiled), $3, $4, $5, 'text/csv', 'synthetic.csv', 'csv', 'stored', $6)`,
        [
          assetId,
          projectId,
          createHash("sha256").update(raw).digest("hex"),
          stored.objectRef,
          raw.length,
          (await db.query("SELECT id FROM app_user WHERE role = 'admin'"))
            .rows[0].id,
        ],
      );
      const preview = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/assets/${assetId}/download?view=raw`,
        headers: { cookie: admin.cookie },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().rawPreview.text).toContain("Synthetic,Yes");
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/assets/${assetId}/download?view=raw`,
            headers: { cookie: editor.cookie },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/assets/${assetId}/download?view=raw`,
            headers: { cookie: outsider.cookie },
          })
        ).statusCode,
      ).toBe(200);
      const memberId = (
        await db.query(
          "SELECT id FROM app_user WHERE email = 'invitee@example.test'",
        )
      ).rows[0].id;
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/projects/${projectId}/members/${memberId}`,
            headers: headers(admin),
            payload: { role: "viewer" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collections`,
            headers: headers(editor),
            payload: { name: "denied", description: "" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/projects/${projectId}/members/${memberId}`,
            headers: headers(admin),
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}`,
            headers: { cookie: editor.cookie },
          })
        ).statusCode,
      ).toBe(404);
      const profile = await app.inject({
        method: "PATCH",
        url: "/api/me",
        headers: headers(outsider),
        payload: { displayName: "新成员", avatarColor: "#9333ea" },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json().account.avatarColor).toBe("#9333ea");
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/me",
            headers: { cookie: outsider.cookie },
          })
        ).json().account.displayName,
      ).toBe("新成员");
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/me",
            headers: headers(outsider),
            payload: { role: "admin" },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/me",
            headers: headers(outsider),
            payload: { displayName: " " },
          })
        ).statusCode,
      ).toBe(422);
    } finally {
      await db.end();
    }
  });
  it("binds a synthetic legacy Owner without changing identity or password hash", async () => {
    const legacyName = `evalbase_v2a_legacy_${randomUUID().replaceAll("-", "")}`;
    const legacyUrl = baseUrl.replace(/\/[^/]+$/, `/${legacyName}`);
    const adminDb = createPool(baseUrl);
    await adminDb.query(`CREATE DATABASE ${legacyName}`);
    await adminDb.end();
    let legacyApp: AgentBenchApp | undefined;
    try {
      await migrate(legacyUrl);
      const db = createPool(legacyUrl);
      try {
        const hash = await hashPassword("legacyPass123");
        await db.query(
          "INSERT INTO app_user(id, username, password_hash, role) VALUES('user_owner','owner',$1,'owner')",
          [hash],
        );
        await db.query(
          "INSERT INTO project(id,name,owner_id) VALUES('legacy_project','Legacy project','user_owner')",
        );
        await db.query(
          "INSERT INTO project_member(project_id,user_id,role) VALUES('legacy_project','user_owner','owner')",
        );
        await db.query(
          "INSERT INTO test_set (id,project_id,name,purpose,owner_id) VALUES ('legacy_set','legacy_project','Legacy set','upgrade fixture','user_owner')",
        );
        await db.query(
          "INSERT INTO formal_schema_revision (id,test_set_id,mode,input_schema,expected_output_schema) VALUES ('legacy_schema','legacy_set','gold_required','{}'::jsonb,'{}'::jsonb)",
        );
        await db.query(
          "INSERT INTO working_draft (id,test_set_id,status,updated_by) VALUES ('legacy_draft','legacy_set','editing','user_owner')",
        );
        await db.query(
          "INSERT INTO candidate_snapshot (id,draft_id,status) VALUES ('legacy_candidate','legacy_draft','published_as_version')",
        );
        const contentHash = "a".repeat(64);
        await db.query(
          `INSERT INTO test_set_version
             (id,test_set_id,sequence,candidate_id,schema_revision_id,
              payload_hash,evidence_hash,manifest_hash,manifest_object_ref,
              item_count,published_by,published_at,publication_order,generation,version_label)
           VALUES ('legacy_version','legacy_set',1,'legacy_candidate','legacy_schema',
                   $1,$1,$1,'synthetic/legacy',1,'user_owner',now(),1,1,'v1')`,
          [contentHash],
        );
        await db.query(
          "INSERT INTO test_case (id,test_set_id) VALUES ('legacy_case','legacy_set')",
        );
        await db.query(
          `INSERT INTO case_revision
             (id,case_id,input,expected_output,metadata,source_record_ordinal,content_hash,lineage_fingerprint,origin_kind)
           VALUES ('legacy_revision','legacy_case','{"question":"preserved after upgrade"}'::jsonb,
                   '{"text":"answer"}'::jsonb,'{}'::jsonb,1,$1,$1,'manual')`,
          [contentHash],
        );
        await db.query(
          "INSERT INTO version_member (version_id,case_revision_id,ordinal) VALUES ('legacy_version','legacy_revision',1)",
        );
        await db.query(
          "INSERT INTO app_user(id, username, password_hash, role) VALUES('unreviewed','unknown',$1,'viewer')",
          [hash],
        );
        await expect(
          bindLegacyAdministrator(legacyUrl, "owner@example.test"),
        ).rejects.toThrow(/manual identity audit/);
        await db.query("DELETE FROM app_user WHERE id = 'unreviewed'");
        const bound = await bindLegacyAdministrator(
          legacyUrl,
          "OWNER@example.test",
        );
        expect(bound).toEqual({
          id: "user_owner",
          email: "owner@example.test",
        });
        const owner = (
          await db.query(
            "SELECT password_hash, role, email FROM app_user WHERE id = 'user_owner'",
          )
        ).rows[0];
        expect(owner).toEqual({
          password_hash: hash,
          role: "admin",
          email: "owner@example.test",
        });
        await expect(
          bindLegacyAdministrator(legacyUrl, "other@example.test"),
        ).rejects.toThrow(/already initialized/);
      } finally {
        await db.end();
      }
      legacyApp = await buildApp(
        {
          databaseUrl: legacyUrl,
          appOrigin: "http://127.0.0.1:4215",
          soloOwnerMode: false,
          allowTestIdentity: false,
        },
        { disableLegacyTestBootstrap: true },
      );
      const login = await legacyApp.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:4215" },
        payload: { email: "owner@example.test", password: "legacyPass123" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
      expect(
        (
          await legacyApp.inject({
            method: "GET",
            url: "/api/projects/legacy_project",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200);
      const legacyRecords = await legacyApp.inject({
        method: "GET",
        url: "/api/projects/legacy_project/solo-test-sets/legacy_set/versions/legacy_version/records?limit=10&offset=0",
        headers: { cookie },
      });
      expect(legacyRecords.statusCode, legacyRecords.body).toBe(200);
      expect(
        legacyRecords
          .json()
          .records.map((row: { question: string }) => row.question),
      ).toEqual(["preserved after upgrade"]);
    } finally {
      await legacyApp?.close();
      const admin = createPool(baseUrl);
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${legacyName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });
});
