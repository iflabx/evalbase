import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 20 project workspace", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  const projectName = `Ticket 20 ${randomUUID()}`;
  const secondProjectName = `Ticket 20 second ${randomUUID()}`;
  let projectId: string;
  let secondProjectId: string;

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
    expect(session.statusCode).toBe(200);
    cookie = `${session.cookies[0]?.name}=${session.cookies[0]?.value}`;
    csrf = session.json().csrfToken;
  });

  afterAll(async () => {
    if (projectId) {
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM project_member WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM project WHERE id = $1", [projectId]);
    }
    if (secondProjectId) {
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        secondProjectId,
      ]);
      await db.query("DELETE FROM project_member WHERE project_id = $1", [
        secondProjectId,
      ]);
      await db.query("DELETE FROM project WHERE id = $1", [secondProjectId]);
    }
    await db.end();
    await app.close();
  });

  it("creates a project with exactly one fixed Unfiled dataset", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { name: projectName, description: "Synthetic Ticket 20" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      project: expect.objectContaining({
        id: expect.any(String),
        name: projectName,
        description: "Synthetic Ticket 20",
        datasetCount: 1,
        testSetCount: 0,
        updatedAt: expect.any(String),
      }),
    });
    expect(created.json().project).not.toHaveProperty("members");
    expect(created.json().project).not.toHaveProperty("role");
    projectId = created.json().project.id;

    const datasets = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers: { cookie },
    });
    expect(datasets.statusCode).toBe(200);
    expect(datasets.json().collections).toHaveLength(1);
    expect(datasets.json().collections[0]).toMatchObject({
      name: "未整理",
      isUnfiled: true,
      fileCount: 0,
    });
  });

  it("persists project datasets across project switching and retires old actions", async () => {
    const collection = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collections`,
      headers: mutationHeaders(),
      payload: { name: "Synthetic collection", description: "" },
    });
    expect(collection.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: mutationHeaders(),
      payload: { name: secondProjectName },
    });
    expect(created.statusCode).toBe(201);
    secondProjectId = created.json().project.id;

    const listed = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: projectId, datasetCount: 2 }),
        expect.objectContaining({ id: secondProjectId, datasetCount: 1 }),
      ]),
    );

    const oldAction = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/collections/${collection.json().collection.id}`,
      headers: mutationHeaders(),
      payload: { name: "not allowed" },
    });
    expect(oldAction.statusCode).toBe(404);

    for (const path of [
      `/api/projects/${projectId}/collections/${collection.json().collection.id}`,
      `/api/projects/${projectId}/audit`,
      `/api/projects/${projectId}/audit/summary`,
    ]) {
      const retired = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie },
      });
      expect(retired.statusCode).toBe(404);
    }
  });

  function mutationHeaders() {
    return {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
  }
});
