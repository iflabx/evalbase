import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const origin = "http://127.0.0.1:4217";
const databaseName = `raw_mapping_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("save originals and prepare fields later", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let projectId: string;
  let collectionId: string;
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
      password: "RawMapping123",
      confirmPassword: "RawMapping123",
      displayName: "管理员",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/installation/administrator",
          headers: { origin },
          payload: account,
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: account,
    });
    headers = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "原件整理测试" },
    });
    projectId = project.json().project.id;
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers,
    });
    collectionId = collections.json().collections[0].id;
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
  it("preserves original records, excludes unprepared data, and atomically prepares a fixed mapping once", async () => {
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "text/csv",
        "x-file-name": "original.csv",
      },
      payload: "prompt,answer,topic\nFirst,Yes,Alpha\nSecond,No,Beta\n",
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const confirmUrl = `/api/projects/${projectId}/pending-upload-batches/confirm`;
    const confirmHeaders = { ...headers, "idempotency-key": randomUUID() };
    const body = {
      collectionId,
      pendingUploadIds: [upload.json().pendingUpload.id],
      mode: "raw",
    };
    const confirmed = await app.inject({
      method: "POST",
      url: confirmUrl,
      headers: confirmHeaders,
      payload: body,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const assetId = confirmed.json().assets[0].id;
    const replay = await app.inject({
      method: "POST",
      url: confirmUrl,
      headers: confirmHeaders,
      payload: body,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().assets).toEqual(confirmed.json().assets);
    const changed = await app.inject({
      method: "POST",
      url: confirmUrl,
      headers: confirmHeaders,
      payload: { ...body, mode: "mapped" },
    });
    expect(changed.statusCode, changed.body).toBe(409);
    const filesUrl = `/api/projects/${projectId}/collaborative-draft-source-files`;
    const files = await app.inject({ method: "GET", url: filesUrl, headers });
    expect(files.json().files).toEqual([]);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {},
    });
    const previewUrl = `/api/projects/${projectId}/collaborative-drafts/${created.json().draft.id}/selection-previews`;
    const blocked = await app.inject({
      method: "POST",
      url: previewUrl,
      headers,
      payload: { assetIds: [assetId], conditions: [], method: "all" },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const mappingUrl = `/api/projects/${projectId}/assets/${assetId}/mapping`;
    const raw = await app.inject({ method: "GET", url: mappingUrl, headers });
    expect(raw.statusCode, raw.body).toBe(200);
    expect(raw.json()).toMatchObject({
      mappingReady: false,
      mappingRevision: 0,
      records: [
        {
          ordinal: 1,
          value: { prompt: "First", answer: "Yes", topic: "Alpha" },
        },
        { ordinal: 2 },
      ],
    });
    const mapping = {
      question: "/prompt",
      expectedOutput: "/answer",
      metadata: ["/topic"],
    };
    const payload = {
      parsedViewId: raw.json().parsedViewId,
      expectedRevision: 0,
      mapping,
    };
    const invalid = await app.inject({
      method: "PUT",
      url: mappingUrl,
      headers,
      payload: {
        ...payload,
        mapping: { ...mapping, question: "/nonexistent" },
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(422);
    for (const ambiguous of [
      { question: "/prompt", metadata: ["/prompt"] },
      { question: "prompt", expectedOutput: "/prompt", metadata: [] },
    ]) {
      const duplicate = await app.inject({
        method: "PUT",
        url: mappingUrl,
        headers,
        payload: { ...payload, mapping: ambiguous },
      });
      expect(duplicate.statusCode, duplicate.body).toBe(422);
    }
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: "PUT", url: mappingUrl, headers, payload }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const prepared = await app.inject({
      method: "GET",
      url: mappingUrl,
      headers,
    });
    expect(prepared.json()).toMatchObject({
      mappingReady: true,
      mappingRevision: 1,
      mapping,
    });
    expect(prepared.json().records).toEqual(raw.json().records);
    const attemptRemap = await app.inject({
      method: "PUT",
      url: mappingUrl,
      headers,
      payload: {
        ...payload,
        expectedRevision: 1,
        mapping: { ...mapping, question: "/answer", expectedOutput: "/prompt" },
      },
    });
    expect(attemptRemap.statusCode, attemptRemap.body).toBe(409);
    const selected = await app.inject({
      method: "POST",
      url: previewUrl,
      headers,
      payload: { assetIds: [assetId], conditions: [], method: "all" },
    });
    expect(selected.statusCode, selected.body).toBe(201);
    const page = await app.inject({
      method: "GET",
      url: `${previewUrl}/${selected.json().preview.id}`,
      headers,
    });
    expect(page.json().records[0]).toMatchObject({
      question: "First",
      expectedOutput: "Yes",
      metadata: [{ key: "topic", value: "Alpha" }],
    });
    const db = createPool(databaseUrl);
    try {
      const original = await db.query(
        "SELECT blob_sha256,object_ref FROM data_asset WHERE id=$1",
        [assetId],
      );
      expect(original.rows[0].blob_sha256).toBeTruthy();
      expect(original.rows[0].object_ref).toBeTruthy();
    } finally {
      await db.end();
    }
  });
  it("rechecks membership after waiting to confirm an original", async () => {
    const email = "editor@example.test",
      password = "RawEditor123";
    await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: { email, password, confirmPassword: password },
    });
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
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/me/invitations/${invitation.json().invitation.id}/accept`,
          headers: editorHeaders,
        })
      ).statusCode,
    ).toBe(200);
    const pending = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...editorHeaders,
        "content-type": "text/csv",
        "x-file-name": "revoked.csv",
      },
      payload: "prompt\nMust not commit\n",
    });
    const db = createPool(databaseUrl),
      blocker = await db.connect();
    let response: Promise<{ statusCode: number; body: string }> | undefined;
    try {
      const actorId = login.json().actor.id,
        key = randomUUID();
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agentbench:confirmed-upload:${projectId}:${actorId}:${key}`,
      ]);
      response = app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
        headers: { ...editorHeaders, "idempotency-key": key },
        payload: {
          collectionId,
          pendingUploadIds: [pending.json().pendingUpload.id],
          mode: "raw",
        },
      });
      void response.then(() => undefined);
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
              )
            ).rows[0].count,
        )
        .toBeGreaterThan(0);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/members/${actorId}`,
        headers,
      });
      expect(removed.statusCode, removed.body).toBe(204);
      await blocker.query("COMMIT");
      const result = await response;
      expect(result.statusCode, result.body).toBe(404);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM data_asset WHERE file_name='revoked.csv'",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await response;
      await db.end();
    }
  });
});
