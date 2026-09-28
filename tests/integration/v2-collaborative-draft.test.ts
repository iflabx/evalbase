import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const origin = "http://127.0.0.1:4217";
const databaseName = `evalbase_v2b_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);
type Session = { cookie: string; csrf: string };

describe("V2-03 shared draft and publication", () => {
  let app: AgentBenchApp;
  let projectId: string;
  let admin: Session;
  let editor: Session;
  let viewer: Session;
  let publishedRoot: { testSetId: string; versionId: string };
  let publishedLeafVersionId: string;
  let publishedThirdVersionId: string;
  const db = createPool(testUrl);
  const headers = (session: Session = admin) => ({
    cookie: session.cookie,
    origin,
    "x-csrf-token": session.csrf,
  });
  const base = () => `/api/projects/${projectId}/collaborative-drafts`;
  beforeAll(async () => {
    const root = createPool(baseUrl);
    try {
      await root.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await root.end();
    }
    await migrate(testUrl);
    app = await buildApp(
      {
        databaseUrl: testUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
    const createdAdmin = await app.inject({
      method: "POST",
      url: "/api/installation/administrator",
      headers: { origin },
      payload: {
        email: "admin@example.test",
        displayName: "管理员",
        password: "v2AdminPass123",
        confirmPassword: "v2AdminPass123",
      },
    });
    expect(createdAdmin.statusCode, createdAdmin.body).toBe(201);
    for (const [email, password] of [
      ["editor@example.test", "editorPass123"],
      ["viewer@example.test", "viewerPass123"],
    ]) {
      const registered = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { origin },
        payload: { email, password, confirmPassword: password },
      });
      expect(registered.statusCode, registered.body).toBe(201);
    }
    const login = async (email: string, password: string): Promise<Session> => {
      const result = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: { email, password },
      });
      expect(result.statusCode, result.body).toBe(200);
      return {
        cookie: `${result.cookies[0].name}=${result.cookies[0].value}`,
        csrf: result.json().csrfToken,
      };
    };
    admin = await login("admin@example.test", "v2AdminPass123");
    editor = await login("editor@example.test", "editorPass123");
    viewer = await login("viewer@example.test", "viewerPass123");
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: headers(),
      payload: { name: "V2-03 synthetic project" },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json().project.id;
    for (const [email, session, role] of [
      ["editor@example.test", editor, "editor"],
      ["viewer@example.test", viewer, "viewer"],
    ] as const) {
      const invite = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/invitations`,
        headers: headers(),
        payload: { email, role },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const accept = await app.inject({
        method: "POST",
        url: `/api/me/invitations/${invite.json().invitation.id}/accept`,
        headers: headers(session),
      });
      expect(accept.statusCode, accept.body).toBe(200);
    }
  });
  afterAll(async () => {
    await app?.close();
    await db.end();
    const root = createPool(baseUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });

  it("keeps new drafts independent and creates one shared draft per parent", async () => {
    const fresh = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: "POST",
          url: base(),
          headers: headers(),
          payload: {},
        }),
      ),
    );
    expect(fresh.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(fresh[0].json().draft.id).not.toBe(fresh[1].json().draft.id);
    const draftId: string = fresh[0].json().draft.id;
    const name = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}`,
      headers: headers(),
      payload: {
        field: "name",
        value: " 合成测试集 ",
        expectedFieldRevision: 0,
      },
    });
    expect(name.statusCode, name.body).toBe(200);
    const added = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/records`,
      headers: headers(),
      payload: {},
    });
    expect(added.statusCode, added.body).toBe(201);
    const recordId: string = added.json().record.id;
    const metadata = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}/records/${recordId}`,
      headers: headers(),
      payload: {
        field: "metadata",
        value: [{ key: "可空", value: "" }],
        expectedFieldRevision: 0,
      },
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    const snapshot = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: admin.cookie },
    });
    expect(snapshot.json().records[0].metadata).toEqual([
      { key: "可空", value: "" },
    ]);
    const published = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/publish`,
      headers: headers(),
      payload: { revision: snapshot.json().draft.revision },
    });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().testSet.name).toBe("合成测试集");
    const versionId: string = published.json().version.id;
    const testSetId: string = published.json().testSet.id;
    publishedRoot = { testSetId, versionId };
    const parent = { testSetId, parentVersionId: versionId };
    const shared = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: "POST",
          url: base(),
          headers: headers(editor),
          payload: parent,
        }),
      ),
    );
    expect(shared.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(shared[0].json().draft.id).toBe(shared[1].json().draft.id);
    const sharedId: string = shared[0].json().draft.id;
    const loaded = await app.inject({
      method: "GET",
      url: `${base()}/${sharedId}`,
      headers: { cookie: admin.cookie },
    });
    expect(loaded.json().records).toHaveLength(1);
    const inheritedId: string = loaded.json().records[0].id;
    const different = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `${base()}/${sharedId}/records/${inheritedId}`,
        headers: headers(),
        payload: { field: "question", value: "A", expectedFieldRevision: 0 },
      }),
      app.inject({
        method: "PATCH",
        url: `${base()}/${sharedId}/records/${inheritedId}`,
        headers: headers(editor),
        payload: {
          field: "expectedOutput",
          value: "B",
          expectedFieldRevision: 0,
        },
      }),
    ]);
    expect(different.map((r) => r.statusCode)).toEqual([200, 200]);
    const same = await app.inject({
      method: "PATCH",
      url: `${base()}/${sharedId}/records/${inheritedId}`,
      headers: headers(),
      payload: { field: "question", value: "C", expectedFieldRevision: 0 },
    });
    expect(same.statusCode).toBe(409);
    const ready = await app.inject({
      method: "GET",
      url: `${base()}/${sharedId}`,
      headers: { cookie: admin.cookie },
    });
    const revision: number = ready.json().draft.revision;
    const both = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: "POST",
          url: `${base()}/${sharedId}/publish`,
          headers: headers(editor),
          payload: { revision },
        }),
      ),
    );
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(both[0].json().version.id).toBe(both[1].json().version.id);
    publishedLeafVersionId = both[0].json().version.id;
    const persisted = await db.query(
      `SELECT count(*)::integer AS count FROM test_set_version WHERE parent_version_id=$1`,
      [versionId],
    );
    expect(persisted.rows[0].count).toBe(1);
    const attribution = await db.query(
      `SELECT field_attribution FROM collaborative_draft_attribution
      WHERE version_id=$1 AND case_id=$2`,
      [publishedLeafVersionId, loaded.json().records[0].caseId],
    );
    expect(attribution.rowCount).toBe(1);
    const actors = await db.query(
      "SELECT email,id FROM app_user WHERE email IN ('admin@example.test','editor@example.test')",
    );
    const byEmail = new Map(actors.rows.map((row) => [row.email, row.id]));
    expect(attribution.rows[0].field_attribution.question.userId).toBe(
      byEmail.get("admin@example.test"),
    );
    expect(attribution.rows[0].field_attribution.expectedOutput.userId).toBe(
      byEmail.get("editor@example.test"),
    );
  });
  it("hides draft bodies from viewers and preserves published blank metadata", async () => {
    const list = await app.inject({
      method: "GET",
      url: base(),
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(404);
    const draftId = (
      await db.query(
        "SELECT id FROM collaborative_draft WHERE project_id=$1 LIMIT 1",
        [projectId],
      )
    ).rows[0].id;
    const body = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: viewer.cookie },
    });
    expect(body.statusCode).toBe(404);
    const csv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${publishedRoot.testSetId}/versions/${publishedRoot.versionId}/data.csv`,
      headers: { cookie: admin.cookie },
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain("可空");
  });

  it("uses row revisions to reject a stale delete after another editor saves", async () => {
    const created = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(),
      payload: {},
    });
    const draftId = created.json().draft.id;
    const added = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/records`,
      headers: headers(),
      payload: {},
    });
    expect(added.statusCode, added.body).toBe(201);
    const rowId = added.json().record.id;
    const changed = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}/records/${rowId}`,
      headers: headers(editor),
      payload: {
        field: "question",
        value: "另一位编辑者已保存",
        expectedFieldRevision: 0,
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const stale = await app.inject({
      method: "DELETE",
      url: `${base()}/${draftId}/records/${rowId}`,
      headers: headers(),
      payload: { expectedRowRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    const current = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: admin.cookie },
    });
    expect(current.json().records[0].question).toBe("另一位编辑者已保存");
    const removed = await app.inject({
      method: "DELETE",
      url: `${base()}/${draftId}/records/${rowId}`,
      headers: headers(),
      payload: { expectedRowRevision: current.json().records[0].rowRevision },
    });
    expect(removed.statusCode).toBe(204);
  });

  it("selects paged source records once and preserves exclusions", async () => {
    const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
    const viewId = `view_${randomUUID().replaceAll("-", "")}`;
    const adminId = (
      await db.query("SELECT id FROM app_user WHERE email='admin@example.test'")
    ).rows[0].id;
    const collectionId = (
      await db.query(
        "SELECT id FROM raw_material_collection WHERE project_id=$1 AND is_unfiled",
        [projectId],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO data_asset (id,project_id,blob_sha256,object_ref,size_bytes,mime_type,file_name,format,status,uploaded_by,collection_id)
      VALUES ($1,$2,$3,$4,100,'text/csv','fifty.csv','csv','stored',$5,$6)`,
      [
        assetId,
        projectId,
        "a".repeat(64),
        "synthetic/no-object",
        adminId,
        collectionId,
      ],
    );
    await db.query(
      `INSERT INTO parsed_view (id,asset_id,format,parser_name,parser_version,parser_config,parser_config_hash,status,
      record_count,success_count,failure_count,boundary_trusted,draft_eligible,is_current,display_mapping)
      VALUES ($1,$2,'csv','synthetic','1','{}','synthetic','ready',50,50,0,true,true,true,$3)`,
      [
        viewId,
        assetId,
        JSON.stringify({
          question: "/q",
          expectedOutput: "/a",
          metadata: ["/m"],
        }),
      ],
    );
    for (let i = 0; i < 50; i++)
      await db.query(
        `INSERT INTO source_record (parsed_view_id,ordinal,value,locator,parse_status,record_hash)
      VALUES ($1,$2,$3,'{}','valid',$4)`,
        [
          viewId,
          i,
          JSON.stringify({ q: `Q${i}`, a: `A${i}`, m: "" }),
          "b".repeat(64),
        ],
      );
    const created = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(),
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json().draft.id;
    await db.query("UPDATE data_asset SET size_bytes=100000001 WHERE id=$1", [
      assetId,
    ]);
    const oversizedDirect = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/records`,
      headers: headers(),
      payload: { source: { assetId, ordinal: 0 } },
    });
    expect(oversizedDirect.statusCode).toBe(422);
    expect(oversizedDirect.json().error.code).toBe(
      "test_set_capacity_exceeded",
    );
    await db.query("UPDATE data_asset SET size_bytes=100 WHERE id=$1", [
      assetId,
    ]);
    const selectionUrl = `${base()}/${draftId}/source-selection`;
    const select = async (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: selectionUrl,
        headers: headers(editor),
        payload: { assetIds: [assetId], ...payload },
      });
    const first = await select({ mode: "add", ordinals: [0, 1] });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().changed).toBe(2);
    expect(
      (await select({ mode: "add", ordinals: [0, 1] })).json().changed,
    ).toBe(0);
    expect(
      (await select({ mode: "remove", ordinals: [0] })).json().changed,
    ).toBe(1);
    const again = await select({ mode: "add", ordinals: [0] });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().changed).toBe(1);
    const all = await select({ mode: "add" });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().changed).toBe(48);
    const page = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}?limit=20&offset=20`,
      headers: { cookie: admin.cookie },
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().total).toBe(50);
    expect(page.json().records).toHaveLength(20);
    const named = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}`,
      headers: headers(),
      payload: { field: "name", value: "来源草稿", expectedFieldRevision: 0 },
    });
    expect(named.statusCode, named.body).toBe(200);
    const ready = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}?limit=1`,
      headers: { cookie: admin.cookie },
    });
    const rootPublished = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/publish`,
      headers: headers(),
      payload: { revision: ready.json().draft.revision },
    });
    expect(rootPublished.statusCode, rootPublished.body).toBe(201);
    const inherited = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(editor),
      payload: {
        testSetId: rootPublished.json().testSet.id,
        parentVersionId: rootPublished.json().version.id,
      },
    });
    expect(inherited.statusCode, inherited.body).toBe(201);
    const inheritedId = inherited.json().draft.id;
    const inheritedUrl = `${base()}/${inheritedId}/source-selection`;
    const repeat = await app.inject({
      method: "POST",
      url: inheritedUrl,
      headers: headers(editor),
      payload: { assetIds: [assetId], mode: "add", ordinals: [1] },
    });
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json().changed).toBe(0);
    const removed = await app.inject({
      method: "POST",
      url: inheritedUrl,
      headers: headers(editor),
      payload: { assetIds: [assetId], mode: "remove", ordinals: [1] },
    });
    expect(removed.json().changed).toBe(1);
    const restored = await app.inject({
      method: "POST",
      url: inheritedUrl,
      headers: headers(editor),
      payload: { assetIds: [assetId], mode: "add", ordinals: [1] },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().changed).toBe(1);
    const current = await app.inject({
      method: "GET",
      url: `${base()}/${inheritedId}?limit=1`,
      headers: { cookie: admin.cookie },
    });
    expect(current.json().total).toBe(50);
    const derivedPublished = await app.inject({
      method: "POST",
      url: `${base()}/${inheritedId}/publish`,
      headers: headers(editor),
      payload: { revision: current.json().draft.revision },
    });
    expect(derivedPublished.statusCode, derivedPublished.body).toBe(201);
    const clean = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(),
      payload: {},
    });
    const excluded = await app.inject({
      method: "POST",
      url: `${base()}/${clean.json().draft.id}/source-selection`,
      headers: headers(),
      payload: {
        assetIds: [assetId],
        mode: "add",
        exclude: [{ assetId, ordinal: 2 }],
      },
    });
    expect(excluded.statusCode, excluded.body).toBe(200);
    expect(excluded.json().changed).toBe(49);
  });

  it("restores saved drafts after a server restart", async () => {
    const created = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(),
      payload: {},
    });
    const draftId = created.json().draft.id;
    const name = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}`,
      headers: headers(editor),
      payload: { field: "name", value: "重启后继续", expectedFieldRevision: 0 },
    });
    expect(name.statusCode, name.body).toBe(200);
    await app.close();
    app = await buildApp(
      {
        databaseUrl: testUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
    const loaded = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: admin.cookie },
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json().draft.name).toBe("重启后继续");
    expect(loaded.json().draft.updatedByName).toBeTruthy();
  });

  it("retries a failed publication after restart without a partial version or lost label", async () => {
    const created = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(editor),
      payload: {
        testSetId: publishedRoot.testSetId,
        parentVersionId: publishedLeafVersionId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json().draft.id;
    const page = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: editor.cookie },
    });
    const record = page.json().records[0];
    const changed = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}/records/${record.id}`,
      headers: headers(editor),
      payload: {
        field: "question",
        value: "故障后重试",
        expectedFieldRevision: 0,
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const ready = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}?limit=1`,
      headers: { cookie: editor.cookie },
    });
    const versionCount = await db.query(
      "SELECT count(*)::int AS count FROM test_set_version WHERE test_set_id=$1",
      [publishedRoot.testSetId],
    );
    await db.query(`CREATE FUNCTION v2b_fail_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'V2-03 injected publication failure'; END $$`);
    await db.query(`CREATE TRIGGER v2b_fail_version BEFORE INSERT ON test_set_version
      FOR EACH ROW EXECUTE FUNCTION v2b_fail_version_insert()`);
    try {
      const failed = await app.inject({
        method: "POST",
        url: `${base()}/${draftId}/publish`,
        headers: headers(editor),
        payload: { revision: ready.json().draft.revision },
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      await db.query(
        "DROP TRIGGER IF EXISTS v2b_fail_version ON test_set_version",
      );
      await db.query("DROP FUNCTION IF EXISTS v2b_fail_version_insert()");
    }
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM test_set_version WHERE test_set_id=$1",
          [publishedRoot.testSetId],
        )
      ).rows[0].count,
    ).toBe(versionCount.rows[0].count);
    expect(
      (
        await db.query("SELECT status FROM collaborative_draft WHERE id=$1", [
          draftId,
        ])
      ).rows[0].status,
    ).toBe("editing");
    await app.close();
    app = await buildApp(
      {
        databaseUrl: testUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
    const retry = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/publish`,
      headers: headers(admin),
      payload: { revision: ready.json().draft.revision },
    });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json().version.label).toBe("v3");
    publishedThirdVersionId = retry.json().version.id;
    const replay = await app.inject({
      method: "POST",
      url: `${base()}/${draftId}/publish`,
      headers: headers(editor),
      payload: { revision: ready.json().draft.revision },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().version.id).toBe(retry.json().version.id);
  });

  it("terminates a leaf-parent draft after permanent version deletion without harming its parent", async () => {
    const created = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(),
      payload: {
        testSetId: publishedRoot.testSetId,
        parentVersionId: publishedThirdVersionId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json().draft.id;
    const trash = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${publishedRoot.testSetId}/versions/${publishedThirdVersionId}/trash`,
      headers: headers(),
      payload: {},
    });
    expect(trash.statusCode, trash.body).toBe(201);
    const paused = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: admin.cookie },
    });
    expect(paused.json().draft.suspended).toBe(true);
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${trash.json().entry.id}/permanent-delete`,
      headers: headers(),
      payload: { confirmation: "v3" },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${base()}/${draftId}`,
          headers: { cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(404);
    const survivor = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${publishedRoot.testSetId}/versions/${publishedLeafVersionId}`,
      headers: { cookie: admin.cookie },
    });
    expect(survivor.statusCode, survivor.body).toBe(200);
  });

  it("pauses drafts during recycle, restores them, and rejects stale edits after permanent deletion", async () => {
    const newDraft = await app.inject({
      method: "POST",
      url: base(),
      headers: headers(),
      payload: {
        testSetId: publishedRoot.testSetId,
        parentVersionId: publishedRoot.versionId,
      },
    });
    expect(newDraft.statusCode, newDraft.body).toBe(201);
    const draftId = newDraft.json().draft.id;
    const trash = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${publishedRoot.testSetId}/trash`,
      headers: headers(),
      payload: {},
    });
    expect(trash.statusCode, trash.body).toBe(201);
    const paused = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: admin.cookie },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json().draft.suspended).toBe(true);
    const blocked = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}`,
      headers: headers(editor),
      payload: { field: "purpose", value: "late", expectedFieldRevision: 0 },
    });
    expect(blocked.statusCode).toBe(409);
    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${trash.json().entry.id}/restore`,
      headers: headers(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const resumed = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}`,
      headers: headers(editor),
      payload: { field: "purpose", value: "resumed", expectedFieldRevision: 0 },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const secondTrash = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${publishedRoot.testSetId}/trash`,
      headers: headers(),
      payload: {},
    });
    expect(secondTrash.statusCode, secondTrash.body).toBe(201);
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${secondTrash.json().entry.id}/permanent-delete`,
      headers: headers(),
      payload: { confirmation: "合成测试集" },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const terminated = await app.inject({
      method: "GET",
      url: `${base()}/${draftId}`,
      headers: { cookie: admin.cookie },
    });
    expect(terminated.statusCode).toBe(404);
    const late = await app.inject({
      method: "PATCH",
      url: `${base()}/${draftId}`,
      headers: headers(editor),
      payload: { field: "purpose", value: "late", expectedFieldRevision: 1 },
    });
    expect([404, 409]).toContain(late.statusCode);
    const cleared = await db.query(
      "SELECT name,purpose,status FROM collaborative_draft WHERE id=$1",
      [draftId],
    );
    expect(cleared.rows[0]).toMatchObject({
      name: "",
      purpose: "",
      status: "terminated",
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM collaborative_draft_record WHERE draft_id=$1",
          [draftId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
});
