import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 21 confirmed upload", () => {
  let app!: AgentBenchApp;
  let db!: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  let projectId: string;
  let collectionId: string;
  let otherProjectId: string | undefined;

  beforeAll(async () => {
    app = await buildApp({ soloOwnerMode: true });
    db = createPool(loadConfig().databaseUrl);
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: {},
    });
    cookie = `${session.cookies[0]?.name}=${session.cookies[0]?.value}`;
    csrf = session.json().csrfToken;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: mutationHeaders(),
      payload: { name: `Ticket 21 ${randomUUID()}` },
    });
    projectId = project.json().project.id;
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    collectionId = collections.json().collections[0].id;
  });

  afterAll(async () => {
    for (const cleanupProjectId of db ? [projectId, otherProjectId].filter(Boolean) : []) {
      await db.query(
        `DELETE FROM source_record sr USING parsed_view pv, data_asset da
         WHERE sr.parsed_view_id = pv.id AND pv.asset_id = da.id
           AND da.project_id = $1`,
        [cleanupProjectId],
      );
      await db.query(
        `DELETE FROM parsed_view pv USING data_asset da
         WHERE pv.asset_id = da.id AND da.project_id = $1`,
        [cleanupProjectId],
      );
      await db.query(
        `DELETE FROM source_attribution_revision sar USING data_asset da
         WHERE sar.asset_id = da.id AND da.project_id = $1`,
        [cleanupProjectId],
      );
      await db.query("DELETE FROM data_asset WHERE project_id = $1", [
        cleanupProjectId,
      ]);
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        cleanupProjectId,
      ]);
      await db.query("DELETE FROM project_member WHERE project_id = $1", [
        cleanupProjectId,
      ]);
      await db.query("DELETE FROM project WHERE id = $1", [cleanupProjectId]);
    }
    await db?.end();
    await app?.close();
  });

  it("previews a CSV and JSON batch before one confirmation makes both files visible", async () => {
    const csv = await start(
      "questions.csv",
      "question,answer,topic\nWhat?,Yes,alpha\n",
    );
    const json = await start(
      "questions.json",
      JSON.stringify([{ prompt: "Why?", expected: "Because", tag: "beta" }]),
    );

    const before = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    expect(before.json().collections[0].fileCount).toBe(0);

    for (const [pendingId, mapping] of [
      [
        csv.id,
        {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/topic"],
        },
      ],
      [
        json.id,
        {
          question: "/prompt",
          expectedOutput: "/expected",
          metadata: ["/tag"],
        },
      ],
    ] as const) {
      const preview = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/pending-uploads/${pendingId}/preview`,
        headers: mutationHeaders(),
        payload: { mapping },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toMatchObject({
        recordCount: 1,
        preview: [{ question: expect.any(String) }],
      });
    }

    const idempotencyKey = randomUUID();
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": idempotencyKey },
      payload: { collectionId, pendingUploadIds: [csv.id, json.id] },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(confirmed.json()).toEqual({
      assets: expect.arrayContaining([
        expect.objectContaining({ fileName: "questions.csv" }),
        expect.objectContaining({ fileName: "questions.json" }),
      ]),
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": idempotencyKey },
      payload: { collectionId, pendingUploadIds: [csv.id, json.id] },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({
      assets: confirmed.json().assets,
      replayed: true,
    });

    const after = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    expect(after.json().collections[0]).toMatchObject({
      fileCount: 2,
      unifiedRecordCount: 2,
    });
    const attribution = await db.query(
      `SELECT source_type, license_status FROM source_attribution_revision sar
       JOIN data_asset da ON da.id = sar.asset_id
       WHERE da.project_id = $1`,
      [projectId],
    );
    expect(attribution.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: "owner_confirmed_nonproduction",
          license_status: "environment_confirmed",
        }),
      ]),
    );
  });

  it("cancels an unconfirmed file without making it visible", async () => {
    const pending = await start("cancel.csv", "question\nNever visible\n");
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/pending-upload-batches`,
      headers: mutationHeaders(),
      payload: { pendingUploadIds: [pending.id] },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(204);
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    expect(collections.json().collections[0].fileCount).toBe(2);
  });

  it("keeps one exact original file per project while allowing another project", async () => {
    const payload = "question,answer\nDuplicate?,Only once\n";
    const original = await start("original.csv", payload);
    const preview = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${original.id}/preview`,
      headers: mutationHeaders(),
      payload: { mapping: { question: "/question", expectedOutput: "/answer", metadata: [] } },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { collectionId, pendingUploadIds: [original.id] },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: { ...mutationHeaders(), "content-type": "text/csv", "x-file-name": "copy.csv" },
      payload,
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json()).toEqual({
      error: {
        code: "duplicate_upload",
        existingFileName: "original.csv",
        existingCollectionName: "未整理",
      },
    });

    const secondProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: mutationHeaders(),
      payload: { name: `Duplicate target ${randomUUID()}` },
    });
    otherProjectId = secondProject.json().project.id;
    const allowed = await app.inject({
      method: "POST",
      url: `/api/projects/${otherProjectId}/pending-uploads`,
      headers: { ...mutationHeaders(), "content-type": "text/csv", "x-file-name": "copy.csv" },
      payload,
    });
    expect(allowed.statusCode, allowed.body).toBe(201);

    const sameBatch = await app.inject({
      method: "POST",
      url: `/api/projects/${otherProjectId}/pending-uploads`,
      headers: { ...mutationHeaders(), "content-type": "text/csv", "x-file-name": "renamed.csv" },
      payload,
    });
    expect(sameBatch.statusCode, sameBatch.body).toBe(409);
  });

  it("does not expose the legacy direct upload route or accept governance fields", async () => {
    const legacy = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/assets`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(legacy.statusCode).toBe(404);

    const governanceField = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": "text/csv",
        "x-file-name": "invalid.csv",
        "x-source-name": "must not be public",
      },
      payload: "question\nnope\n",
    });
    expect(governanceField.statusCode).toBe(422);
  });

  it("rejects exactly 50,000,001 bytes before creating a visible file", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    const oversized = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": "text/csv",
        "x-file-name": "too-large.csv",
      },
      payload: Buffer.alloc(50_000_001, 0x61),
    });
    expect(oversized.statusCode, oversized.body).toBe(413);
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    expect(collections.json().collections[0].fileCount).toBe(
      before.json().collections[0].fileCount,
    );
  });

  async function start(fileName: string, payload: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": fileName.endsWith(".csv")
          ? "text/csv"
          : "application/octet-stream",
        "x-file-name": fileName,
        "idempotency-key": randomUUID(),
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().pendingUpload as { id: string };
  }

  function mutationHeaders() {
    return {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
  }
});
