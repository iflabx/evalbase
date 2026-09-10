import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool, type Database } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/curation-recipe-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("S-HTTP Working Draft lease", () => {
  let app: AgentBenchApp;
  let db: Database;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
  });

  it("uses the frozen non-production lease defaults", () => {
    const config = loadConfig();
    expect({
      durationMs: config.draftLeaseDurationMs,
      renewIntervalMs: config.draftLeaseRenewIntervalMs,
      takeoverGraceMs: config.draftTakeoverGraceMs,
    }).toEqual(contract.lease);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  it("opens only one active Working Draft when concurrent requests target one Test Set", async () => {
    const testSetId = `testset_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Draft lease fixture', 'Synthetic test', 'user_owner')`,
      [testSetId],
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const open = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });

    const [first, second] = await Promise.all([open(), open()]);

    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(first.json().draft).toMatchObject({
      id: expect.stringMatching(/^draft_/),
      revision: 1,
      leaseToken: expect.any(String),
    });
    expect(second.json().draft).toMatchObject({ id: first.json().draft.id });
  });

  it("rejects a stale lease token before it can overwrite a saved recipe", async () => {
    const testSetId = `testset_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Revision fixture', 'Synthetic test', 'user_owner')`,
      [testSetId],
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const opened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    const draft = opened.json().draft;
    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: "stale-token",
        expectedRevision: draft.revision,
        proposalId: "schema_proposal_missing",
        filter: { field: "kind", operator: "eq", value: "fixture" },
        mapping: { input: { message: "question" }, expectedOutput: "answer" },
        unmappedFields: [],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: {
            type: "object",
            properties: { message: { type: "string" } },
          },
          expectedOutput: { type: "string" },
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "draft_lease_invalid", currentRevision: 1 },
    });
  });

  it("restores an auto-saved Recipe, freezes its revision, and abandons without creating a version", async () => {
    const testSetId = `testset_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Recipe fixture', 'Synthetic test', 'user_owner')`,
      [testSetId],
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const open = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
    const draft = (await open()).json().draft;
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Keep this synthetic fixture.",
        steps: [
          {
            kind: "filter",
            filter: { field: "/kind", operator: "eq", value: "fixture" },
          },
          { kind: "sample", mode: "count", value: 0, seed: "fixture" },
          { kind: "manual", include: [], exclude: [] },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft).toMatchObject({
      revision: 2,
      updatedBy: "user_owner",
    });
    const renewed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/lease/renew`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { leaseToken: draft.leaseToken, expectedRevision: 2 },
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().draft).toMatchObject({
      leaseToken: draft.leaseToken,
      revision: 2,
      leaseRenewIntervalMs: contract.lease.renewIntervalMs,
    });
    const restored = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie },
    });
    expect(restored.json().draft).toMatchObject({
      revision: 2,
      versionDescription: "Keep this synthetic fixture.",
      recipe: {
        steps: expect.arrayContaining([
          expect.objectContaining({ kind: "manual" }),
        ]),
      },
      leaseToken: draft.leaseToken,
    });
    const frozen = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/freeze`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { leaseToken: draft.leaseToken, expectedRevision: 2 },
    });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json()).toMatchObject({
      revision: { number: 2, hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const abandoned = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/abandon`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { leaseToken: draft.leaseToken, expectedRevision: 2 },
    });
    expect(abandoned.json().draft).toMatchObject({
      status: "abandoned",
      revision: 3,
    });
    expect((await open()).json().draft.id).not.toBe(draft.id);
  });

  it("requires confirmation for takeover and records the preserving handoff", async () => {
    const editorId = `user_${randomUUID().replaceAll("-", "")}`;
    const editorName = `editor_${randomUUID()}`;
    const testSetId = `testset_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      "INSERT INTO app_user (id, username, password_hash, role) VALUES ($1, $2, $3, 'editor')",
      [editorId, editorName, await hashPassword("editor-test-password")],
    );
    await db.query(
      "INSERT INTO project_member (project_id, user_id, role) VALUES ('project_demo', $1, 'editor')",
      [editorId],
    );
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Takeover fixture', 'Synthetic test', 'user_owner')`,
      [testSetId],
    );
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const ownerCookie = `${ownerLogin.cookies[0]?.name}=${ownerLogin.cookies[0]?.value}`;
    const ownerCsrf = ownerLogin.json().csrfToken;
    const opened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: ownerCookie,
        "x-csrf-token": ownerCsrf,
      },
    });
    const draft = opened.json().draft;
    const editorLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: editorName, password: "editor-test-password" },
    });
    const editorCookie = `${editorLogin.cookies[0]?.name}=${editorLogin.cookies[0]?.value}`;
    const editorCsrf = editorLogin.json().csrfToken;
    const withoutConfirmation = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/lease/takeover`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editorCookie,
        "x-csrf-token": editorCsrf,
        "content-type": "application/json",
      },
      payload: { expectedRevision: draft.revision },
    });
    expect(withoutConfirmation.statusCode).toBe(422);
    const takeover = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/lease/takeover`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editorCookie,
        "x-csrf-token": editorCsrf,
        "content-type": "application/json",
      },
      payload: { confirm: true, expectedRevision: draft.revision },
    });
    expect(takeover.json().draft).toMatchObject({ leaseHolderId: editorId });
    expect(takeover.json().draft.leaseToken).not.toBe(draft.leaseToken);
    const stolenWrite = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: ownerCookie,
        "x-csrf-token": ownerCsrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: takeover.json().draft.leaseToken,
        expectedRevision: draft.revision,
        steps: [],
      },
    });
    expect(stolenWrite.statusCode).toBe(409);
    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/audit`,
      headers: { cookie: ownerCookie },
    });
    expect(audit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "draft_lease_taken_over",
          actorId: editorId,
          details: { takeover: "confirmed" },
        }),
      ]),
    );
  });

  it("uses a controlled Clock for expiry plus grace takeover", async () => {
    let currentTime = new Date();
    const clockApp = await buildApp({}, { now: () => currentTime });
    const editorId = `user_${randomUUID().replaceAll("-", "")}`;
    const editorName = `editor_${randomUUID()}`;
    const testSetId = `testset_${randomUUID().replaceAll("-", "")}`;
    try {
      await db.query(
        "INSERT INTO app_user (id, username, password_hash, role) VALUES ($1, $2, $3, 'editor')",
        [editorId, editorName, await hashPassword("editor-test-password")],
      );
      await db.query(
        "INSERT INTO project_member (project_id, user_id, role) VALUES ('project_demo', $1, 'editor')",
        [editorId],
      );
      await db.query(
        `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
         VALUES ($1, 'project_demo', 'Clock fixture', 'Synthetic test', 'user_owner')`,
        [testSetId],
      );
      const ownerLogin = await clockApp.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: "owner", password: "owner-test-password" },
      });
      const ownerCookie = `${ownerLogin.cookies[0]?.name}=${ownerLogin.cookies[0]?.value}`;
      const opened = await clockApp.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: ownerCookie,
          "x-csrf-token": ownerLogin.json().csrfToken,
        },
      });

      currentTime = new Date(
        currentTime.getTime() +
          contract.lease.durationMs +
          contract.lease.takeoverGraceMs +
          1,
      );
      const editorLogin = await clockApp.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: editorName, password: "editor-test-password" },
      });
      const editorCookie = `${editorLogin.cookies[0]?.name}=${editorLogin.cookies[0]?.value}`;
      const takenOver = await clockApp.inject({
        method: "POST",
        url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: editorCookie,
          "x-csrf-token": editorLogin.json().csrfToken,
        },
      });
      expect(takenOver.statusCode).toBe(200);
      expect(takenOver.json()).toMatchObject({
        reopened: true,
        draft: {
          id: opened.json().draft.id,
          leaseHolderId: editorId,
          leaseToken: expect.any(String),
        },
      });
      const audit = await clockApp.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${opened.json().draft.id}/audit`,
        headers: { cookie: editorCookie },
      });
      expect(audit.json().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "draft_lease_taken_over",
            actorId: editorId,
            details: { takeover: "expired" },
          }),
        ]),
      );
    } finally {
      await clockApp.close();
    }
  });
});
