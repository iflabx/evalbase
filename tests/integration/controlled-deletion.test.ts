import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { sha256 } from "../../src/package/contract.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

describe("Ticket 14 controlled deletion S-HTTP capability seam", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  const db = createPool(loadConfig().databaseUrl);

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
  });

  async function login(username: string, password: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username, password },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: `${response.cookies[0]?.name}=${response.cookies[0]?.value}`,
      csrf: response.json<{ csrfToken: string }>().csrfToken,
    };
  }

  async function waitForParsedAsset(
    assetId: string,
    cookie: string,
    projectId = "project_demo",
  ) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/assets/${assetId}/records`,
        headers: { cookie },
      });
      if (
        response.statusCode === 200 &&
        response.json().parsedView?.status === "ready"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for Ticket 14 parse fixture");
  }

  it("rejects a non-Owner preview at the service boundary", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "editor", password: "editor-test-password" },
    });
    expect(login.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: `${login.cookies[0]?.name}=${login.cookies[0]?.value}`,
        "x-csrf-token": login.json<{ csrfToken: string }>().csrfToken,
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: "asset_missing" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "controlled_deletion_owner_required" },
    });
  });

  it("locks and removes an uploaded asset without retaining content", async () => {
    const owner = await login("owner", "owner-test-password");
    const cookie = owner.cookie;
    const csrf = owner.csrf;
    const key = `${"a".repeat(32)}${randomUUID().replaceAll("-", "")}`;
    const bytes = Buffer.from(`question,answer\nsynthetic,${randomUUID()}\n`);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": key,
        "content-type": "text/csv",
        "x-file-name": "ticket14.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 synthetic",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    await waitForParsedAsset(assetId, cookie);

    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: assetId },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    const deletion = preview.json().deletion;
    expect(deletion.reasonCodes).toEqual(
      expect.arrayContaining([
        "owner_requested",
        "nonproduction_test",
        "nonproduction_validation",
        "data_correction",
        "retention_cleanup",
        "other",
      ]),
    );
    expect(deletion.closure.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assetId })]),
    );

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${deletion.id}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash: deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic fixture cleanup",
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(202);

    let outcome: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      outcome = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/deletions/${deletion.id}/outcome`,
        headers: { cookie },
      });
      if (outcome.json().deletion.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(outcome.json().deletion.status).toBe("completed");
    expect(outcome.json().deletion.tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: "data_asset",
          opaqueObjectId: assetId,
        }),
      ]),
    );
    const blobTombstone = outcome
      .json()
      .deletion.tombstones.find(
        (item: { objectType?: string }) => item.objectType === "data_blob",
      );
    expect(blobTombstone).toEqual(
      expect.objectContaining({ objectType: "data_blob" }),
    );
    expect(blobTombstone.opaqueObjectId).not.toBe(blobTombstone.priorHash);
    const tombstoneKeys = new Set([
      "deletionEventId",
      "objectType",
      "opaqueObjectId",
      "priorHash",
      "affectedVersionIds",
      "actorId",
      "reasonCode",
      "reasonNote",
      "initiatedAt",
      "confirmedAt",
      "completedAt",
      "resultStatus",
    ]);
    for (const tombstone of outcome.json().deletion.tombstones)
      expect(
        Object.keys(tombstone).every((key) => tombstoneKeys.has(key)),
      ).toBe(true);
    expect(JSON.stringify(outcome.json())).not.toContain("ticket14.csv");

    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(409);
    expect(download.json()).toEqual({ error: { code: "deletion_locked" } });
    const reupload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": `${key}-new-resource`,
        "content-type": "text/csv",
        "x-file-name": "ticket14.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 synthetic",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(reupload.statusCode).toBe(201);
    expect(reupload.json().asset.id).not.toBe(assetId);
    const replay = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": key,
        "content-type": "text/csv",
        "x-file-name": "ticket14.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 synthetic",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(replay.statusCode).toBe(410);
    expect(replay.json()).toMatchObject({
      error: { code: "idempotency_resource_gone" },
    });

    const blockedTransformation = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        schemaVersion: "1.0",
        operationType: "code_rule",
        lineageLevel: "record_level",
        purpose: "Synthetic deletion lock regression",
        tool: { name: "ticket14-test", version: "1.0.0", codeRef: "git:test" },
        parameters: {},
        inputs: [
          {
            objectType: "data_asset",
            id: assetId,
            sha256: uploaded.json().asset.sha256,
            scope: { entireAsset: true },
          },
        ],
        outputs: [
          {
            assetId,
            sha256: uploaded.json().asset.sha256,
            recordCount: 1,
          },
        ],
        recordEdges: [
          {
            outputOrdinal: 1,
            inputs: [
              {
                objectType: "source_record",
                parsedViewId: "deleted-view",
                ordinal: 1,
                recordHash: "0".repeat(64),
              },
            ],
          },
        ],
        executedBy: "user_owner",
        startedAt: "2026-08-22T02:10:00.000Z",
        finishedAt: "2026-08-22T02:14:00.000Z",
      },
    });
    expect(blockedTransformation.statusCode).toBe(409);
    expect(blockedTransformation.json()).toEqual({
      error: { code: "deletion_locked" },
    });
  });

  it("does not treat a future client key equal to a tombstone digest as gone", async () => {
    const owner = await login("owner", "owner-test-password");
    const originalKey = `ticket14-tombstone-source-${randomUUID()}`;
    const tombstoneKey = sha256(originalKey);
    const tombstoneStorageKey = `tombstone:legacy:${randomUUID()}`;
    await db.query(
      `INSERT INTO upload_idempotency
       (project_id, actor_id, operation, idempotency_key, idempotency_key_digest,
        status, operation_id, deleted_resource_id, result_kind, tombstoned_at)
       VALUES ('project_demo', 'user_owner', 'asset_upload', $1, $2, 'tombstoned', $3,
               'asset_deleted_fixture', 'idempotency_resource_gone', now())`,
      [tombstoneStorageKey, tombstoneKey, `ticket14-tombstone-${randomUUID()}`],
    );
    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
          "idempotency-key": tombstoneKey,
          "content-type": "text/csv",
          "x-file-name": "ticket14-digest-collision.csv",
          "x-source-type": "synthetic",
          "x-source-name": "Ticket 14 digest collision",
          "x-responsible-person": "Project Owner",
          "x-source-purpose": "Synthetic idempotency tombstone regression",
          "x-license-status": "not_applicable",
          "x-sensitivity": "non_sensitive",
        },
        payload: Buffer.from("question,answer\ndigest,collision\n"),
      });
      expect(upload.statusCode, upload.body).toBe(201);
    } finally {
      await db.query(
        `DELETE FROM upload_idempotency
         WHERE project_id = 'project_demo' AND actor_id = 'user_owner'
           AND operation = 'asset_upload'
           AND idempotency_key IN ($1, $2, $3)`,
        [tombstoneStorageKey, tombstoneKey, originalKey],
      );
    }
  });

  it("releases a receiving upload when confirmation wins the blob lock", async () => {
    const owner = await login("owner", "owner-test-password");
    const key = `${"b".repeat(32)}${randomUUID().replaceAll("-", "")}`;
    const bytes = Buffer.from(`question,answer\nlock-race,${randomUUID()}\n`);
    const blobHash = sha256(bytes);
    const eventId = `deletion_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO deletion_event
       (id, project_id, target_type, target_id, status, stage, preview_hash,
        closure, initiated_by)
       VALUES ($1, 'project_demo', 'data_asset', 'asset_fixture', 'confirmed',
               'fail_closed_lock', 'fixture', '{}'::jsonb, 'user_owner')`,
      [eventId],
    );
    await db.query(
      `INSERT INTO deletion_lock (event_id, project_id, object_type, object_id)
       VALUES ($1, 'project_demo', 'data_blob', $2)`,
      [eventId, blobHash],
    );
    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
          "idempotency-key": key,
          "content-type": "text/csv",
          "x-file-name": "ticket14-lock-race.csv",
          "x-source-type": "synthetic",
          "x-source-name": "Ticket 14 lock race",
          "x-responsible-person": "Project Owner",
          "x-source-purpose": "Synthetic lock race",
          "x-license-status": "not_applicable",
          "x-sensitivity": "non_sensitive",
        },
        payload: bytes,
      });
      expect(upload.statusCode, upload.body).toBe(409);
    } finally {
      await db.query("DELETE FROM deletion_lock WHERE event_id = $1", [
        eventId,
      ]);
      await db.query("DELETE FROM deletion_event WHERE id = $1", [eventId]);
    }
    const retry = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": key,
        "content-type": "text/csv",
        "x-file-name": "ticket14-lock-race.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 lock race",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic lock race",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(retry.statusCode, retry.body).toBe(201);
  });

  it("keeps preview/confirm authorization and event access project-scoped", async () => {
    const owner = await login("owner", "owner-test-password");
    const editor = await login("editor", "editor-test-password");
    const viewer = await login("viewer", "viewer-test-password");
    const bytes = Buffer.from("question,answer\nauth,fixture\n");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-auth-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "ticket14-auth.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 authorization",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion authorization fixture",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(201);
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        targetType: "data_asset",
        targetId: uploaded.json().asset.id,
      },
    });
    expect(preview.statusCode).toBe(201);
    const eventId = preview.json().deletion.id as string;
    const previewHash = preview.json().deletion.previewHash as string;

    const viewerPreview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: viewer.cookie,
        "x-csrf-token": viewer.csrf,
        "content-type": "application/json",
      },
      payload: {
        targetType: "data_asset",
        targetId: uploaded.json().asset.id,
      },
    });
    expect(viewerPreview.statusCode).toBe(403);
    expect(viewerPreview.json()).toEqual({
      error: { code: "controlled_deletion_owner_required" },
    });

    for (const actor of [editor, viewer]) {
      const confirm = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/deletions/${eventId}/confirm`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: actor.cookie,
          "x-csrf-token": actor.csrf,
          "content-type": "application/json",
        },
        payload: {
          previewHash,
          reasonCode: "nonproduction_test",
          reasonNote: "Not allowed",
        },
      });
      expect(confirm.statusCode).toBe(403);
      expect(confirm.json()).toEqual({
        error: { code: "controlled_deletion_owner_required" },
      });
    }

    const emptyReasonNote = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${eventId}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash,
        reasonCode: "owner_requested",
        reasonNote: "   ",
      },
    });
    expect(emptyReasonNote.statusCode).toBe(422);
    expect(emptyReasonNote.json()).toEqual({
      error: { code: "deletion_reason_invalid" },
    });
    const longReasonNote = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${eventId}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash,
        reasonCode: "owner_requested",
        reasonNote: "x".repeat(501),
      },
    });
    expect(longReasonNote.statusCode).toBe(422);

    const anonymousConfirm = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${eventId}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: {
        previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Anonymous authorization probe",
      },
    });
    expect(anonymousConfirm.statusCode).toBe(401);

    const memberOutcome = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deletions/${eventId}/outcome`,
      headers: { cookie: editor.cookie },
    });
    expect(memberOutcome.statusCode).toBe(200);
    const crossProject = await app.inject({
      method: "GET",
      url: `/api/projects/project_other/deletions/${eventId}/outcome`,
      headers: { cookie: editor.cookie },
    });
    expect(crossProject.statusCode).toBe(404);
    expect(crossProject.json()).toEqual({
      error: { code: "deletion_event_not_found" },
    });

    const otherProjectId = `project_ticket14_idor_${randomUUID().replaceAll(
      "-",
      "",
    )}`;
    await db.query(
      "INSERT INTO project (id, name, owner_id) VALUES ($1, $2, 'user_owner')",
      [otherProjectId, "Ticket 14 deletion IDOR fixture"],
    );
    await db.query(
      "INSERT INTO project_member (project_id, user_id, role) VALUES ($1, 'user_owner', 'owner')",
      [otherProjectId],
    );
    const crossProjectConfirm = await app.inject({
      method: "POST",
      url: `/api/projects/${otherProjectId}/deletions/${eventId}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Cross-project IDOR probe",
      },
    });
    expect(crossProjectConfirm.statusCode).toBe(404);
    expect(crossProjectConfirm.json()).toEqual({
      error: { code: "deletion_event_not_found" },
    });
    const crossProjectRetry = await app.inject({
      method: "POST",
      url: `/api/projects/${otherProjectId}/deletions/${eventId}/retry`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
      },
    });
    expect(crossProjectRetry.statusCode).toBe(404);
    expect(crossProjectRetry.json()).toEqual({
      error: { code: "deletion_event_not_found" },
    });

    const anonymousPreview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: "asset_missing" },
    });
    expect(anonymousPreview.statusCode).toBe(401);
  });

  it("requires the project owner to remain a project member", async () => {
    const owner = await login("owner", "owner-test-password");
    const projectId = `project_ticket14_owner_membership_${randomUUID().replaceAll(
      "-",
      "",
    )}`;
    await db.query(
      "INSERT INTO project (id, name, owner_id) VALUES ($1, $2, 'user_owner')",
      [projectId, "Ticket 14 owner membership fixture"],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/deletions/preview`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: "asset_missing" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "controlled_deletion_owner_required" },
    });
  });

  it("rejects confirmation after the frozen closure drifts", async () => {
    const owner = await login("owner", "owner-test-password");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-drift-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "drift.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 drift",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic preview drift",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from("question,answer\ndrift,fixture\n"),
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: assetId },
    });
    expect(preview.statusCode).toBe(201);
    const archived = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/archive`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
      },
    });
    expect(archived.statusCode).toBe(200);
    const confirm = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${preview.json().deletion.id}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash: preview.json().deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic stale preview",
      },
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json()).toMatchObject({
      error: { code: "deletion_preview_stale" },
    });
  });

  it("invalidates a preview when Source Attribution receives a new revision", async () => {
    const owner = await login("owner", "owner-test-password");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-attribution-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "ticket14-attribution.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 attribution drift",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic attribution drift",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from("question,answer\ndrift,fixture\n"),
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: assetId },
    });
    expect(preview.statusCode).toBe(201);
    const revised = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/assets/${assetId}/attribution`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        sourceType: "synthetic",
        sourceName: "Ticket 14 attribution drift revised",
        responsiblePerson: "Project Owner",
        purpose: "Synthetic attribution drift",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        deidentificationConfirmed: false,
      },
    });
    expect(revised.statusCode).toBe(200);
    const confirm = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${preview.json().deletion.id}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash: preview.json().deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic stale attribution preview",
      },
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json()).toMatchObject({
      error: { code: "deletion_preview_stale" },
    });
  });

  it("allows only one overlapping confirmation for the same closure", async () => {
    const owner = await login("owner", "owner-test-password");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-overlap-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "ticket14-overlap.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 overlapping confirmation",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic overlapping deletion confirmation",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from("question,answer\noverlap,fixture\n"),
    });
    expect(uploaded.statusCode).toBe(201);
    const targetId = uploaded.json().asset.id as string;
    await waitForParsedAsset(targetId, owner.cookie);
    const previewHeaders = {
      origin: "http://127.0.0.1:3000",
      cookie: owner.cookie,
      "x-csrf-token": owner.csrf,
      "content-type": "application/json",
    };
    const previews = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: "POST",
          url: "/api/projects/project_demo/deletions/preview",
          headers: previewHeaders,
          payload: { targetType: "data_asset", targetId },
        }),
      ),
    );
    expect(previews.every((response) => response.statusCode === 201)).toBe(
      true,
    );
    const confirms = await Promise.all(
      previews.map((preview) =>
        app.inject({
          method: "POST",
          url: `/api/projects/project_demo/deletions/${preview.json().deletion.id}/confirm`,
          headers: previewHeaders,
          payload: {
            previewHash: preview.json().deletion.previewHash,
            reasonCode: "nonproduction_test",
            reasonNote: "Synthetic overlap check",
          },
        }),
      ),
    );
    expect(
      confirms.filter((response) => response.statusCode === 202),
    ).toHaveLength(1);
    const rejected = confirms.find((response) => response.statusCode === 409);
    expect(rejected).toBeDefined();
    expect(["deletion_already_confirmed", "deletion_preview_stale"]).toContain(
      rejected?.json().error.code,
    );
  });

  it("invalidates a preview when draft recipe and frozen revision inputs drift", async () => {
    const owner = await login("owner", "owner-test-password");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-revision-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "ticket14-revision.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 revision drift",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic revision drift",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from("question,answer\nrevision,fixture\n"),
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    await waitForParsedAsset(assetId, owner.cookie);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 14 revision ${randomUUID()}`,
        purpose: "Synthetic revision drift",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        targetType: "test_set",
        targetId: created.json().testSet.id,
      },
    });
    expect(preview.statusCode).toBe(201);
    const frozenDraft = preview.json().deletion.closure.drafts[0];
    expect(frozenDraft).toEqual(
      expect.objectContaining({ revision: expect.any(Number) }),
    );
    await db.query(
      `UPDATE working_draft
       SET revision = revision + 1,
           recipe = COALESCE(recipe, '{}'::jsonb) || '{"drift":true}'::jsonb
       WHERE id = $1`,
      [frozenDraft.id ?? draft.id],
    );
    if (frozenDraft.mappingRevisionId)
      await db.query(
        `UPDATE mapping_revision
         SET mapping = mapping || '{"drift":true}'::jsonb
         WHERE id = $1`,
        [frozenDraft.mappingRevisionId],
      );
    if (frozenDraft.formalSchemaId)
      await db.query(
        `UPDATE formal_schema_revision
         SET input_schema = input_schema || '{"x-ticket14-drift":true}'::jsonb
         WHERE id = $1`,
        [frozenDraft.formalSchemaId],
      );
    if (frozenDraft.draftRevisionId)
      await db.query(
        `UPDATE draft_revision SET revision_hash = 'ticket14-drift'
         WHERE id = $1`,
        [frozenDraft.draftRevisionId],
      );
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${preview.json().deletion.id}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash: preview.json().deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic stale revision preview",
      },
    });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json()).toMatchObject({
      error: { code: "deletion_preview_stale" },
    });
  });

  it("preserves a shared blob referenced by another project", async () => {
    const owner = await login("owner", "owner-test-password");
    const bytes = Buffer.from(`question,answer\nshared,${randomUUID()}\n`);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-shared-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "ticket14-shared.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 shared blob",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion shared blob fixture",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    await waitForParsedAsset(assetId, owner.cookie);
    const otherProjectId = `project_ticket14_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      "INSERT INTO project (id, name, owner_id) VALUES ($1, $2, 'user_owner')",
      [otherProjectId, "Ticket 14 shared blob project"],
    );
    await db.query(
      "INSERT INTO project_member (project_id, user_id, role) VALUES ($1, 'user_owner', 'owner')",
      [otherProjectId],
    );
    const otherUpload = await app.inject({
      method: "POST",
      url: `/api/projects/${otherProjectId}/assets`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-shared-other-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "shared-copy.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 shared blob copy",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion shared blob fixture",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(otherUpload.statusCode).toBe(201);
    const otherAssetId = otherUpload.json().asset.id as string;
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: { targetType: "data_asset", targetId: assetId },
    });
    expect(preview.statusCode).toBe(201);
    expect(preview.json().deletion.closure.sharedBlobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deleteObject: false }),
      ]),
    );
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${preview.json().deletion.id}/confirm`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "content-type": "application/json",
      },
      payload: {
        previewHash: preview.json().deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic shared blob cleanup",
      },
    });
    expect(confirmed.statusCode).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const outcome = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/deletions/${preview.json().deletion.id}/outcome`,
        headers: { cookie: owner.cookie },
      });
      if (outcome.json().deletion.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const otherDownload = await app.inject({
      method: "GET",
      url: `/api/projects/${otherProjectId}/assets/${otherAssetId}/download`,
      headers: { cookie: owner.cookie },
    });
    expect(otherDownload.statusCode).toBe(200);
    expect(otherDownload.rawPayload).toEqual(bytes);
    const reuploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: owner.cookie,
        "x-csrf-token": owner.csrf,
        "idempotency-key": `ticket14-shared-reupload-${randomUUID()}`,
        "content-type": "text/csv",
        "x-file-name": "shared-reupload.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 14 shared blob reupload",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Controlled deletion shared blob fixture",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(reuploaded.statusCode).toBe(201);
  });

  it("reclaims a shared blob after both project references are deleted", async () => {
    const owner = await login("owner", "owner-test-password");
    const bytes = Buffer.from(`question,answer\nrace,${randomUUID()}\n`);
    const firstProjectId = `project_ticket14_blob_race_a_${randomUUID().replaceAll(
      "-",
      "",
    )}`;
    const secondProjectId = `project_ticket14_blob_race_b_${randomUUID().replaceAll(
      "-",
      "",
    )}`;
    for (const projectId of [firstProjectId, secondProjectId]) {
      await db.query(
        "INSERT INTO project (id, name, owner_id) VALUES ($1, $2, 'user_owner')",
        [projectId, `Ticket 14 shared blob race ${projectId}`],
      );
      await db.query(
        "INSERT INTO project_member (project_id, user_id, role) VALUES ($1, 'user_owner', 'owner')",
        [projectId],
      );
    }
    const upload = async (projectId: string, suffix: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/assets`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
          "idempotency-key": `ticket14-blob-race-${suffix}-${randomUUID()}`,
          "content-type": "text/csv",
          "x-file-name": `${suffix}.csv`,
          "x-source-type": "synthetic",
          "x-source-name": "Ticket 14 shared blob race",
          "x-responsible-person": "Project Owner",
          "x-source-purpose": "Synthetic shared blob race",
          "x-license-status": "not_applicable",
          "x-sensitivity": "non_sensitive",
        },
        payload: bytes,
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().asset.id as string;
    };
    const firstAssetId = await upload(firstProjectId, "race-a");
    const secondAssetId = await upload(secondProjectId, "race-b");
    await waitForParsedAsset(firstAssetId, owner.cookie, firstProjectId);
    await waitForParsedAsset(secondAssetId, owner.cookie, secondProjectId);

    const previewAndConfirm = async (projectId: string, assetId: string) => {
      const preview = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/deletions/preview`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
          "content-type": "application/json",
        },
        payload: { targetType: "data_asset", targetId: assetId },
      });
      expect(preview.statusCode, preview.body).toBe(201);
      const deletion = preview.json().deletion;
      const confirmed = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/deletions/${deletion.id}/confirm`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
          "content-type": "application/json",
        },
        payload: {
          previewHash: deletion.previewHash,
          reasonCode: "nonproduction_test",
          reasonNote: "Synthetic shared blob race",
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(202);
      return deletion.id as string;
    };

    const artifacts = new ArtifactRepository(loadConfig().minio);
    const objectRef = `blobs/sha256/${sha256(bytes)}`;
    expect(await artifacts.size(objectRef)).toBe(bytes.byteLength);
    process.kill(worker.pid!, "SIGSTOP");
    let firstEventId = "";
    let secondEventId = "";
    try {
      [firstEventId, secondEventId] = await Promise.all([
        previewAndConfirm(firstProjectId, firstAssetId),
        previewAndConfirm(secondProjectId, secondAssetId),
      ]);
    } finally {
      process.kill(worker.pid!, "SIGCONT");
    }

    const waitForCompletion = async (projectId: string, eventId: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/deletions/${eventId}/outcome`,
          headers: { cookie: owner.cookie },
        });
        if (response.json().deletion.status === "completed") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Timed out waiting for shared blob deletion race");
    };
    await Promise.all([
      waitForCompletion(firstProjectId, firstEventId),
      waitForCompletion(secondProjectId, secondEventId),
    ]);
    await expect(artifacts.size(objectRef)).rejects.toMatchObject({
      code: expect.stringMatching(/NoSuchKey|NotFound/),
    });
  });
});
