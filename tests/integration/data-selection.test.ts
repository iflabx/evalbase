import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const origin = "http://127.0.0.1:4217";
const databaseName = `selection_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("fixed selection preview and application", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let projectId: string;
  let draftId: string;
  let assetId: string;
  const path = () =>
    `/api/projects/${projectId}/collaborative-drafts/${draftId}/selection-previews`;
  beforeAll(async () => {
    const root = createPool(baseUrl);
    try {
      await root.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
    const account = {
      email: "admin@example.test",
      password: "TestSelection123",
      confirmPassword: "TestSelection123",
      displayName: "管理员",
    };
    const registration = await app.inject({
      method: "POST",
      url: "/api/installation/administrator",
      headers: { origin },
      payload: account,
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { email: account.email, password: account.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    headers = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "选取自动化项目" },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json().project.id;
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers,
    });
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "text/csv",
        "x-file-name": "selection.csv",
        "idempotency-key": randomUUID(),
      },
      payload:
        "question,answer,kind\nHello one,yes,safe\nHello two,no,safe\nOther,maybe,other\n",
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const pendingId = upload.json().pendingUpload.id;
    const mapping = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${pendingId}/preview`,
      headers,
      payload: {
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/kind"],
        },
      },
    });
    expect(mapping.statusCode, mapping.body).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        collectionId: collections.json().collections[0].id,
        pendingUploadIds: [pendingId],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    assetId = confirmed.json().assets[0].id;
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    draftId = created.json().draft.id;
  });
  afterAll(async () => {
    await app?.close();
    const root = createPool(baseUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });

  it("freezes matching records without adding them to the draft, and paginates without redrawing", async () => {
    const preview = await app.inject({
      method: "POST",
      url: path(),
      headers,
      payload: {
        assetIds: [assetId],
        conditions: [
          { field: "metadata", key: "kind", operator: "equals", value: "SAFE" },
        ],
        method: "random",
        mode: "count",
        value: 1,
        seed: "fixture",
      },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    expect(preview.json().preview).toMatchObject({
      candidateCount: 2,
      selectedCount: 1,
      scopeCount: 3,
      seed: "fixture",
      draftRevision: 0,
    });
    const id = preview.json().preview.id;
    const url = `${path()}/${id}?view=candidates&limit=1`;
    const first = await app.inject({ method: "GET", url, headers });
    const second = await app.inject({
      method: "GET",
      url: `${url}&offset=1`,
      headers,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().records[0]).toMatchObject({
      assetId,
      ordinal: 1,
      question: "Hello one",
    });
    expect(second.json().records[0]).toMatchObject({
      assetId,
      ordinal: 2,
      question: "Hello two",
    });
    expect(second.json().preview.selectedIds).toEqual(
      first.json().preview.selectedIds,
    );
    const includedId = JSON.stringify([assetId, 1]);
    const expanded = await app.inject({
      method: "POST",
      url: `${path()}/${id}/records`,
      headers,
      payload: { view: "selected", includeIds: [includedId], limit: "20" },
    });
    expect(expanded.statusCode, expanded.body).toBe(200);
    expect(
      expanded.json().records.map((record: { id: string }) => record.id),
    ).toContain(includedId);
    const files = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collaborative-draft-source-files`,
      headers,
    });
    expect(files.json().files[0].metadataKeys).toEqual(["kind"]);
    const sources = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/selected-sources`,
      headers,
    });
    expect(sources.json().sources).toEqual([]);
  });

  it("requires explicit revision review, validates manual choices, and applies once across retries", async () => {
    const preview = await app.inject({
      method: "POST",
      url: path(),
      headers,
      payload: { assetIds: [assetId], conditions: [], method: "all" },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    const id = preview.json().preview.id;
    const selectedIds = preview.json().preview.selectedIds.slice(1);
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
      headers,
      payload: {
        field: "purpose",
        value: "另一位协作者已保存",
        expectedFieldRevision: 0,
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const apply = (body: { selectedIds: string[]; expectedRevision: number }) =>
      app.inject({
        method: "POST",
        url: `${path()}/${id}/apply`,
        headers,
        payload: body,
      });
    const stale = await apply({ selectedIds, expectedRevision: 0 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: "draft_revision_conflict",
      currentRevision: 1,
    });
    const forged = await apply({
      selectedIds: ["not-a-candidate"],
      expectedRevision: 1,
    });
    expect(forged.statusCode, forged.body).toBe(422);
    const applied = await apply({ selectedIds, expectedRevision: 1 });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({
      added: 2,
      revision: 2,
      replayed: false,
    });
    const replay = await apply({ selectedIds, expectedRevision: 1 });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      added: 2,
      revision: 2,
      replayed: true,
    });
    const mismatch = await apply({
      selectedIds: preview.json().preview.selectedIds,
      expectedRevision: 2,
    });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    const draft = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
      headers,
    });
    expect(draft.json().total).toBe(2);
    expect(
      draft
        .json()
        .records.map((record: { question: string }) => record.question),
    ).toEqual(["Hello two", "Other"]);
    expect(draft.json().draft.purpose).toBe("另一位协作者已保存");
  });

  it("keeps accepted selection history through publication and skips existing source records", async () => {
    const create = () =>
      app.inject({
        method: "POST",
        url: path(),
        headers,
        payload: { assetIds: [assetId], conditions: [], method: "all" },
      });
    const preview = (await create()).json().preview;
    const body = { selectedIds: preview.selectedIds, expectedRevision: 2 };
    const applyUrl = `${path()}/${preview.id}/apply`;
    const accepted = await app.inject({
      method: "POST",
      url: applyUrl,
      headers,
      payload: body,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      added: 1,
      skipped: 2,
      revision: 3,
    });
    const emptyPreview = (await create()).json().preview;
    const empty = await app.inject({
      method: "POST",
      url: `${path()}/${emptyPreview.id}/apply`,
      headers,
      payload: { selectedIds: emptyPreview.selectedIds, expectedRevision: 3 },
    });
    expect(empty.statusCode, empty.body).toBe(422);
    expect(empty.json().error.code).toBe("selection_no_additions");
    const historyUrl = `/api/projects/${projectId}/collaborative-drafts/${draftId}/selection-history`;
    const history = await app.inject({
      method: "GET",
      url: historyUrl,
      headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().history).toHaveLength(2);
    expect(history.json().history[0]).toMatchObject({
      configuration: { method: "all" },
      added: 1,
      skipped: 2,
    });
    const named = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
      headers,
      payload: { field: "name", value: "选取结果", expectedFieldRevision: 0 },
    });
    expect(named.statusCode, named.body).toBe(200);
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/publish`,
      headers,
      payload: { revision: 4 },
    });
    expect(published.statusCode, published.body).toBe(201);
    const publishedHistory = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${published.json().testSet.id}/versions/${published.json().version.id}/selection-history`,
      headers,
    });
    expect(publishedHistory.statusCode, publishedHistory.body).toBe(200);
    expect(publishedHistory.json().history).toEqual(history.json().history);
    const replay = await app.inject({
      method: "POST",
      url: applyUrl,
      headers,
      payload: body,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      added: 1,
      revision: 3,
      replayed: true,
    });
  });

  it("attributes a shared preview to its actual confirmer and rejects removed members", async () => {
    const email = "editor@example.test";
    const password = "EditorSelection123";
    const registered = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: { email, password, confirmPassword: password },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { email, password },
    });
    const editorHeaders = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const invitation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/invitations`,
      headers,
      payload: { email, role: "editor" },
    });
    expect(invitation.statusCode, invitation.body).toBe(201);
    const joined = await app.inject({
      method: "POST",
      url: `/api/me/invitations/${invitation.json().invitation.id}/accept`,
      headers: editorHeaders,
    });
    expect(joined.statusCode, joined.body).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {},
    });
    const draftPath = `/api/projects/${projectId}/collaborative-drafts/${created.json().draft.id}`;
    const preview = await app.inject({
      method: "POST",
      url: `${draftPath}/selection-previews`,
      headers,
      payload: { assetIds: [assetId], conditions: [], method: "all" },
    });
    const applyUrl = `${draftPath}/selection-previews/${preview.json().preview.id}/apply`;
    const payload = {
      selectedIds: preview.json().preview.selectedIds,
      expectedRevision: 0,
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: applyUrl,
          headers: editorHeaders,
          payload,
        }),
      ),
    );
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(results.map((result) => result.json().replayed).sort()).toEqual([
      false,
      true,
    ]);
    const members = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/members`,
      headers,
    });
    const editor = members
      .json()
      .members.find((member: { email: string }) => member.email === email);
    const draft = await app.inject({ method: "GET", url: draftPath, headers });
    expect(draft.json().total).toBe(3);
    expect(draft.json().records[0].fieldAttribution).toMatchObject({
      question: { userId: editor.id },
      expectedOutput: { userId: editor.id },
      metadata: { userId: editor.id },
    });
    const history = await app.inject({
      method: "GET",
      url: `${draftPath}/selection-history`,
      headers,
    });
    expect(history.json().history[0].actorName).toBe(editor.displayName);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/members/${editor.id}`,
      headers,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const denied = await app.inject({
      method: "POST",
      url: applyUrl,
      headers: editorHeaders,
      payload,
    });
    expect(denied.statusCode, denied.body).toBe(404);
    const discarded = await app.inject({
      method: "DELETE",
      url: draftPath,
      headers,
    });
    expect(discarded.statusCode, discarded.body).toBe(204);
    const replayAfterDiscard = await app.inject({
      method: "POST",
      url: applyUrl,
      headers,
      payload,
    });
    expect(replayAfterDiscard.statusCode).toBe(409);
    const db = createPool(databaseUrl);
    try {
      // Security storage contract: the discarded draft must not retain filter literals.
      const remaining = await db.query(
        "SELECT count(*)::integer AS count FROM selection_preview WHERE draft_id=$1",
        [created.json().draft.id],
      );
      expect(remaining.rows[0].count).toBe(0);
    } finally {
      await db.end();
    }
  });
  it("rolls back an over-capacity confirmation and rejects a changed source snapshot", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {},
    });
    const id = created.json().draft.id;
    const url = `/api/projects/${projectId}/collaborative-drafts/${id}/selection-previews`;
    const preview = (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { assetIds: [assetId], conditions: [], method: "all" },
      })
    ).json().preview;
    const db = createPool(databaseUrl);
    try {
      // Large fixture is deliberately confined to this disposable database.
      await db.query(
        `INSERT INTO collaborative_draft_record(draft_id,id,position,question,expected_output,metadata,updated_by)
        SELECT d.id,'capacity_'||n,n,'fixture','','[]',d.updated_by FROM collaborative_draft d,generate_series(1,9999) n WHERE d.id=$1`,
        [id],
      );
      const overflow = await app.inject({
        method: "POST",
        url: `${url}/${preview.id}/apply`,
        headers,
        payload: { selectedIds: preview.selectedIds, expectedRevision: 0 },
      });
      expect(overflow.statusCode, overflow.body).toBe(422);
      expect(overflow.json().error.code).toBe("test_set_capacity_exceeded");
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${id}`,
        headers,
      });
      expect(draft.json().total).toBe(9999);
      expect(draft.json().draft.revision).toBe(0);
      const history = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${id}/selection-history`,
        headers,
      });
      expect(history.json().history).toEqual([]);
      await db.query(
        "UPDATE parsed_view SET display_mapping=jsonb_set(display_mapping,'{question}','\"/answer\"') WHERE asset_id=$1 AND is_current",
        [assetId],
      );
      const invalidated = await app.inject({
        method: "GET",
        url: `${url}/${preview.id}`,
        headers,
      });
      expect(invalidated.statusCode, invalidated.body).toBe(409);
      expect(invalidated.json().error.code).toBe("selection_source_changed");
    } finally {
      await db.end();
    }
  });
});
