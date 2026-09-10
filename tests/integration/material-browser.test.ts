import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 22 material file and unified record browser", () => {
  let app!: AgentBenchApp;
  let db!: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  let projectId: string;
  let sourceCollectionId: string;
  let targetCollectionId: string;
  let assetId: string;
  let jsonAssetId: string;

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
      payload: { name: `Ticket 22 ${randomUUID()}` },
    });
    projectId = project.json().project.id;
    const initial = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    sourceCollectionId = initial.json().collections[0].id;
    const target = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collections`,
      headers: mutationHeaders(),
      payload: { name: "已整理", description: "" },
    });
    targetCollectionId = target.json().collection.id;
    assetId = await uploadCsv();
    jsonAssetId = await uploadJson();
  });

  afterAll(async () => {
    if (projectId && db) {
      await db.query(
        `DELETE FROM source_record sr USING parsed_view pv, data_asset da WHERE sr.parsed_view_id = pv.id AND pv.asset_id = da.id AND da.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM parsed_view pv USING data_asset da WHERE pv.asset_id = da.id AND da.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM source_attribution_revision sar USING data_asset da WHERE sar.asset_id = da.id AND da.project_id = $1`,
        [projectId],
      );
      await db.query("DELETE FROM data_asset WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM project_member WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM project WHERE id = $1", [projectId]);
    }
    await db?.end();
    await app?.close();
  });

  it("lists mapped file and unified record fields without governance DTOs", async () => {
    const files = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/assets?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(files.statusCode, files.body).toBe(200);
    expect(files.json()).toMatchObject({
      assets: expect.arrayContaining([
        expect.objectContaining({
          id: assetId,
          fileName: "browser.csv",
          format: "csv",
          recordCount: 11,
          status: "可浏览",
        }),
        expect.objectContaining({
          id: jsonAssetId,
          fileName: "browser.json",
          format: "json",
          recordCount: 1,
          status: "可浏览",
        }),
      ]),
      pagination: { total: 2, limit: 10, offset: 0 },
    });
    expect(files.json().assets[0]).not.toHaveProperty("hash");
    expect(files.json().assets[0]).not.toHaveProperty("mapping");

    const file = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/assets/${assetId}`,
      headers: { cookie },
    });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.json()).toEqual({
      asset: { fileName: "browser.csv", format: "csv", recordCount: 11 },
    });

    const records = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(records.statusCode, records.body).toBe(200);
    expect(records.json()).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          assetId,
          ordinal: 1,
          sourceFile: "browser.csv",
          question: "问题一",
          expectedOutput: "答案一",
          metadata: [
            { key: "tag", value: "tag1" },
            { key: "category", value: "常见问题" },
            { key: "source", value: "合成资料" },
          ],
        }),
      ]),
      pagination: { total: 12, limit: 10, offset: 0 },
    });

    const invalid = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/assets?format=csv`,
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(422);
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/assets/${assetId}/records/1`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toEqual({
      record: {
        assetId,
        ordinal: 1,
        sourceFile: "browser.csv",
        question: "问题一",
        expectedOutput: "答案一",
        metadata: [
          { key: "tag", value: "tag1" },
          { key: "category", value: "常见问题" },
          { key: "source", value: "合成资料" },
        ],
      },
    });
  });

  it("searches and pages files and unified records with stable results", async () => {
    const fileSearch = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/assets?name=browser.csv&limit=1&offset=0`,
      headers: { cookie },
    });
    expect(fileSearch.statusCode, fileSearch.body).toBe(200);
    expect(fileSearch.json()).toMatchObject({
      assets: [
        expect.objectContaining({ id: assetId, fileName: "browser.csv" }),
      ],
      pagination: { total: 1, limit: 1, offset: 0 },
    });

    const first = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/records?limit=2&offset=0`,
      headers: { cookie },
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/records?limit=2&offset=2`,
      headers: { cookie },
    });
    const firstAgain = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/records?limit=2&offset=0`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().records).toEqual(firstAgain.json().records);
    expect(second.json().records).not.toEqual(first.json().records);

    const recordSearch = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${sourceCollectionId}/records?search=%E9%97%AE%E9%A2%98%E5%8D%81%E4%B8%80&limit=10&offset=0`,
      headers: { cookie },
    });
    expect(recordSearch.statusCode, recordSearch.body).toBe(200);
    expect(recordSearch.json()).toMatchObject({
      records: [
        expect.objectContaining({
          question: "问题十一",
          expectedOutput: "答案十一",
          metadata: [
            { key: "tag", value: "tag11" },
            { key: "category", value: "常见问题" },
            { key: "source", value: "合成资料" },
          ],
        }),
      ],
      pagination: { total: 1, limit: 10, offset: 0 },
    });
  });

  it("moves only within the project without changing asset identity or parsed data", async () => {
    const before = await db.query(
      `SELECT da.id, da.blob_sha256, da.object_ref, pv.display_mapping
       FROM data_asset da JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
       WHERE da.id = $1`,
      [assetId],
    );
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/assets/${assetId}/collection`,
      headers: mutationHeaders(),
      payload: { collectionId: targetCollectionId },
    });
    expect(moved.statusCode, moved.body).toBe(204);
    const after = await db.query(
      `SELECT da.id, da.blob_sha256, da.object_ref, pv.display_mapping
       FROM data_asset da JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
       WHERE da.id = $1`,
      [assetId],
    );
    expect(after.rows).toEqual(before.rows);
    const target = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections/${targetCollectionId}/assets?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(target.json().assets).toEqual([
      expect.objectContaining({ id: assetId }),
    ]);

    const otherProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: mutationHeaders(),
      payload: { name: `Other ${randomUUID()}` },
    });
    const otherCollections = await app.inject({
      method: "GET",
      url: `/api/projects/${otherProject.json().project.id}/collections`,
      headers: { cookie },
    });
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/assets/${assetId}/collection`,
      headers: mutationHeaders(),
      payload: { collectionId: otherCollections.json().collections[0].id },
    });
    expect(rejected.statusCode).toBe(404);
    await db.query("DELETE FROM audit_event WHERE project_id = $1", [
      otherProject.json().project.id,
    ]);
    await db.query("DELETE FROM project_member WHERE project_id = $1", [
      otherProject.json().project.id,
    ]);
    await db.query("DELETE FROM project WHERE id = $1", [
      otherProject.json().project.id,
    ]);
  });

  it("returns only a bounded in-page raw preview for an accessible material file", async () => {
    const largeAssetId = await uploadLargeCsv();
    const raw = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/assets/${largeAssetId}/download?view=raw`,
      headers: { cookie },
    });
    expect(raw.statusCode, raw.body).toBe(200);
    expect(raw.json()).toMatchObject({
      rawPreview: {
        truncated: true,
        text: expect.stringContaining("question,answer,tag"),
      },
    });
    expect(
      Buffer.byteLength(raw.json().rawPreview.text, "utf8"),
    ).toBeLessThanOrEqual(1_000_000);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(raw.json().rawPreview.text, "utf8"),
      ),
    ).not.toThrow();
    const audit = await db.query(
      `SELECT action FROM audit_event WHERE project_id = $1 AND object_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [projectId, largeAssetId],
    );
    expect(audit.rows[0]?.action).toBe("asset_raw_previewed");

    const missingView = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/assets/${largeAssetId}/download`,
      headers: { cookie },
    });
    expect(missingView.statusCode).toBe(422);

    for (const url of [
      `/api/projects/${projectId}/assets`,
      `/api/projects/${projectId}/assets/${assetId}`,
      `/api/projects/${projectId}/assets/${assetId}/records`,
    ]) {
      const retired = await app.inject({
        method: "GET",
        url,
        headers: { cookie },
      });
      expect(retired.statusCode).toBe(404);
    }
  });

  async function uploadCsv() {
    const pending = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": "text/csv",
        "x-file-name": "browser.csv",
        "idempotency-key": randomUUID(),
      },
      payload: [
        "question,answer,tag,category,source",
        "问题一,答案一,tag1,常见问题,合成资料",
        "问题二,答案二,tag2,常见问题,合成资料",
        "问题三,答案三,tag3,常见问题,合成资料",
        "问题四,答案四,tag4,常见问题,合成资料",
        "问题五,答案五,tag5,常见问题,合成资料",
        "问题六,答案六,tag6,常见问题,合成资料",
        "问题七,答案七,tag7,常见问题,合成资料",
        "问题八,答案八,tag8,常见问题,合成资料",
        "问题九,答案九,tag9,常见问题,合成资料",
        "问题十,答案十,tag10,常见问题,合成资料",
        "问题十一,答案十一,tag11,常见问题,合成资料",
      ].join("\n"),
    });
    expect(pending.statusCode, pending.body).toBe(201);
    const invalidMapping = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${pending.json().pendingUpload.id}/preview`,
      headers: mutationHeaders(),
      payload: {
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/tag", "/Tag"],
        },
      },
    });
    expect(invalidMapping.statusCode).toBe(422);
    const preview = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${pending.json().pendingUpload.id}/preview`,
      headers: mutationHeaders(),
      payload: {
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/tag", "/category", "/source"],
        },
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().preview[0]).toMatchObject({
      metadata: [
        { key: "tag", value: "tag1" },
        { key: "category", value: "常见问题" },
        { key: "source", value: "合成资料" },
      ],
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        collectionId: sourceCollectionId,
        pendingUploadIds: [pending.json().pendingUpload.id],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    return confirmed.json().assets[0].id as string;
  }

  async function uploadJson() {
    const pending = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": "application/octet-stream",
        "x-file-name": "browser.json",
        "idempotency-key": randomUUID(),
      },
      payload: JSON.stringify([
        { prompt: "JSON 问题", expected: "JSON 答案", tag: "gamma" },
      ]),
    });
    expect(pending.statusCode, pending.body).toBe(201);
    const preview = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${pending.json().pendingUpload.id}/preview`,
      headers: mutationHeaders(),
      payload: {
        mapping: {
          question: "/prompt",
          expectedOutput: "/expected",
          metadata: ["/tag"],
        },
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        collectionId: sourceCollectionId,
        pendingUploadIds: [pending.json().pendingUpload.id],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    return confirmed.json().assets[0].id as string;
  }

  async function uploadLargeCsv() {
    const pending = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": "text/csv",
        "x-file-name": "large-preview.csv",
        "idempotency-key": randomUUID(),
      },
      payload: `question,answer,tag\n预览,答案,${"中".repeat(333_334)}`,
    });
    expect(pending.statusCode, pending.body).toBe(201);
    const preview = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${pending.json().pendingUpload.id}/preview`,
      headers: mutationHeaders(),
      payload: {
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/tag"],
        },
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        collectionId: sourceCollectionId,
        pendingUploadIds: [pending.json().pendingUpload.id],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    return confirmed.json().assets[0].id as string;
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
