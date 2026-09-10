import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 19 raw material collections", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  const collectionName = `Ticket 19 ${randomUUID()}`;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(login.statusCode).toBe(200);
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    csrf = login.json().csrfToken;
  });

  afterAll(async () => {
    await db.query(
      "DELETE FROM raw_material_collection WHERE name = ANY($1::text[])",
      [[collectionName]],
    );
    await db.end();
    await app.close();
  });

  const mutationHeaders = () => ({
    origin: "http://127.0.0.1:3000",
    cookie,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  });

  it("creates and lists a shallow collection beside Unfiled", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/collections",
      headers: mutationHeaders(),
      payload: { name: collectionName, description: "Synthetic Ticket 19" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      collection: {
        name: collectionName,
        description: "Synthetic Ticket 19",
        isUnfiled: false,
        fileCount: 0,
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/collections",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.collections.filter((item: any) => item.isUnfiled)).toHaveLength(
      1,
    );
    expect(body.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "未整理", isUnfiled: true }),
        expect.objectContaining({ name: collectionName, isUnfiled: false }),
      ]),
    );
  });

  it("retires rename and rejects cross-project collection access", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/projects/project_demo/collections",
      headers: { cookie },
    });
    const unfiled = listed
      .json()
      .collections.find((item: any) => item.isUnfiled);
    expect(unfiled).toBeDefined();

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/projects/project_demo/collections/${unfiled.id}`,
      headers: mutationHeaders(),
      payload: { name: "不可修改" },
    });
    expect(rename.statusCode).toBe(404);
    expect(rename.json()).toMatchObject({ error: { code: "route_not_found" } });

    const otherProjectId = `project_ticket19_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      "INSERT INTO project (id, name, owner_id) VALUES ($1, 'Ticket 19 isolated', 'user_owner')",
      [otherProjectId],
    );
    try {
      const otherCollection = await db.query(
        "SELECT id FROM raw_material_collection WHERE project_id = $1 AND is_unfiled",
        [otherProjectId],
      );
      expect(otherCollection.rowCount).toBe(1);
      const other = await app.inject({
        method: "GET",
        url: `/api/projects/${otherProjectId}/collections`,
        headers: { cookie },
      });
      expect(other.statusCode).toBe(404);

      const leaked = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/collections/${otherCollection.rows[0].id}`,
        headers: { cookie },
      });
      expect(leaked.statusCode).toBe(404);
    } finally {
      await db.query(
        "DELETE FROM raw_material_collection WHERE project_id = $1",
        [otherProjectId],
      );
      await db.query("DELETE FROM project WHERE id = $1", [otherProjectId]);
    }
  });
});
