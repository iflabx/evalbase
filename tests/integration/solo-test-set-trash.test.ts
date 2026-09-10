import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

describe("Ticket 26 solo test set trash", () => {
  let app!: AgentBenchApp;
  let db!: ReturnType<typeof createPool>;
  let artifacts!: ArtifactRepository;
  let cookie: string;
  let csrf: string;
  let projectId: string;

  beforeAll(async () => {
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    app = await buildApp({ soloOwnerMode: true }, { artifacts });
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
      payload: { name: `Ticket 26 ${randomUUID()}` },
    });
    projectId = project.json().project.id;
  });

  afterAll(async () => {
    if (projectId && db) {
      await db.query("DELETE FROM test_set_trash_entry WHERE project_id = $1", [
        projectId,
      ]);
      await db.query(
        "DELETE FROM version_member vm USING test_set_version v, test_set ts WHERE vm.version_id = v.id AND v.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM candidate_item ci USING candidate_snapshot cs, working_draft wd, test_set ts WHERE ci.candidate_id = cs.id AND cs.draft_id = wd.id AND wd.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "UPDATE candidate_snapshot cs SET base_version_id = NULL FROM working_draft wd, test_set ts WHERE cs.draft_id = wd.id AND wd.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "UPDATE working_draft wd SET base_version_id = NULL FROM test_set ts WHERE wd.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM test_set_version v USING test_set ts WHERE v.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM candidate_snapshot cs USING working_draft wd, test_set ts WHERE cs.draft_id = wd.id AND wd.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM case_revision cr USING test_case tc, test_set ts WHERE cr.case_id = tc.id AND tc.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM test_case tc USING test_set ts WHERE tc.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM formal_schema_revision fs USING test_set ts WHERE fs.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query(
        "DELETE FROM working_draft wd USING test_set ts WHERE wd.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query("DELETE FROM upload_idempotency WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM test_set WHERE project_id = $1", [projectId]);
      await db.query("DELETE FROM project_member WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM project WHERE id = $1", [projectId]);
    }
    await db?.end();
    await app?.close();
  });

  it("trashes and restores a leaf version without rewriting its identity or parent edge", async () => {
    const created = await createVersionChain();
    const trashed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(trashed.statusCode, trashed.body).toBe(201);
    expect(trashed.json()).toMatchObject({
      entry: { type: "version_branch", rootVersionId: created.v3 },
    });

    const hidden = await getVersion(created.testSetId, created.v3);
    expect(hidden.statusCode).toBe(404);
    const trash = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-set-trash?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(trash.statusCode, trash.body).toBe(200);
    const entry = trash.json().entries[0];
    expect(entry).toMatchObject({
      type: "version_branch",
      rootVersionLabel: "v3",
    });

    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entry.id}/restore`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const reopened = await getVersion(created.testSetId, created.v3);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().version).toMatchObject({
      id: created.v3,
      label: "v3",
      parentVersionId: created.v2,
    });
  });

  it("requires a complete branch for an intermediate version and preserves a tombstone relationship", async () => {
    const created = await createVersionChain();
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toEqual({
      error: { code: "version_branch_required" },
    });

    const branch = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/trash`,
      headers: mutationHeaders(),
      payload: { includeDescendants: true },
    });
    expect(branch.statusCode, branch.body).toBe(201);
    expect((await getVersion(created.testSetId, created.v3)).statusCode).toBe(
      404,
    );
    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${branch.json().entry.id}/restore`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const wrongConfirmation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v3" },
    });
    expect(wrongConfirmation.statusCode).toBe(422);
    expect(wrongConfirmation.json()).toEqual({
      error: { code: "tombstone_confirmation_required" },
    });

    const tombstoned = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v2" },
    });
    expect(tombstoned.statusCode, tombstoned.body).toBe(200);
    const blocked = await getVersion(created.testSetId, created.v2);
    expect(blocked.statusCode).toBe(404);
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/data.csv`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(404);
    const derive = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        selections: [],
        records: [
          { question: "cannot derive", expectedOutput: "", metadata: [] },
        ],
      },
    });
    expect(derive.statusCode).toBe(404);

    const descendant = await getVersion(created.testSetId, created.v3);
    expect(descendant.statusCode, descendant.body).toBe(200);
    expect(descendant.json().graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.v2,
          label: "v2",
          parentVersionId: created.v1,
          tombstoned: true,
          tombstonedAt: expect.any(String),
        }),
        expect.objectContaining({
          id: created.v3,
          label: "v3",
          parentVersionId: created.v2,
        }),
      ]),
    );
  });

  it("keeps failed tombstone cleanup pending and retries it idempotently", async () => {
    const created = await createVersionChain();
    const remove = artifacts.remove.bind(artifacts);
    artifacts.remove = async () => {
      throw new Error("synthetic minio failure");
    };
    try {
      const failed = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
        headers: mutationHeaders(),
        payload: { confirmation: "v2" },
      });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json()).toEqual({
        error: { code: "tombstone_cleanup_pending" },
      });
      const pending = await db.query(
        "SELECT tombstoned_at, cleanup_pending, cleanup_object_refs FROM test_set_version WHERE id = $1",
        [created.v2],
      );
      expect(pending.rows[0]).toMatchObject({ cleanup_pending: true });
      expect(pending.rows[0].tombstoned_at).toBeTruthy();
      expect(pending.rows[0].cleanup_object_refs).not.toEqual([]);
    } finally {
      artifacts.remove = remove;
    }
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v2" },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    const cleaned = await db.query(
      "SELECT cleanup_pending, cleanup_object_refs FROM test_set_version WHERE id = $1",
      [created.v2],
    );
    expect(cleaned.rows[0]).toEqual({
      cleanup_pending: false,
      cleanup_object_refs: [],
    });
  });

  it("permanently deletes only a trashed branch after a second confirmation", async () => {
    const created = await createVersionChain();
    const trashed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    const entryId = trashed.json().entry.id as string;
    const premature = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entryId}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: "no" },
    });
    expect(premature.statusCode).toBe(422);
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entryId}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: "v3" },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await getVersion(created.testSetId, created.v3)).statusCode).toBe(
      404,
    );
    const remaining = await getVersion(created.testSetId, created.v2);
    expect(remaining.statusCode, remaining.body).toBe(200);
  });

  it("requires the locked root version label instead of a historic fixed deletion string", async () => {
    const created = await createVersionChain();
    const trashed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    const entryId = trashed.json().entry.id as string;
    const historic = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entryId}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: "permanent_delete" },
    });
    expect(historic.statusCode).toBe(422);
    expect(historic.json()).toEqual({
      error: { code: "permanent_delete_confirmation_required" },
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entryId}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: "v3" },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
  });

  it("keeps an immutable object when another published version still references it", async () => {
    const created = await createVersionChain();
    const shared = await db.query(
      "SELECT manifest_object_ref FROM test_set_version WHERE id = $1",
      [created.v2],
    );
    const objectRef = shared.rows[0].manifest_object_ref as string;
    await db.query(
      "UPDATE test_set_version SET manifest_object_ref = $2 WHERE id = $1",
      [created.v3, objectRef],
    );
    const trashed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(trashed.statusCode, trashed.body).toBe(201);
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${trashed.json().entry.id}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: "v3" },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await expect(artifacts.size(objectRef)).resolves.toBeGreaterThan(0);
  });

  it("hides and restores a whole test set without changing its versions", async () => {
    const created = await createVersionChain();
    const trashed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(trashed.statusCode, trashed.body).toBe(201);
    const normal = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets?limit=100&offset=0`,
      headers: { cookie },
    });
    expect(
      normal.json().testSets.map((item: { id: string }) => item.id),
    ).not.toContain(created.testSetId);
    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${trashed.json().entry.id}/restore`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const reopened = await getVersion(created.testSetId, created.v3);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().version).toMatchObject({
      id: created.v3,
      parentVersionId: created.v2,
    });
  });

  it("absorbs a trashed branch into a Test Set and restores every recoverable version", async () => {
    const created = await createVersionChain();
    const branch = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/trash`,
      headers: mutationHeaders(),
      payload: { includeDescendants: true },
    });
    expect(branch.statusCode, branch.body).toBe(201);
    const testSet = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(testSet.statusCode, testSet.body).toBe(201);
    const beforeRestore = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-set-trash?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(
      beforeRestore
        .json()
        .entries.filter(
          (entry: { testSetId: string }) =>
            entry.testSetId === created.testSetId,
        ),
    ).toEqual([
      expect.objectContaining({
        id: testSet.json().entry.id,
        type: "test_set",
      }),
    ]);
    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${testSet.json().entry.id}/restore`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await getVersion(created.testSetId, created.v1)).statusCode).toBe(
      200,
    );
    expect((await getVersion(created.testSetId, created.v2)).statusCode).toBe(
      200,
    );
    expect((await getVersion(created.testSetId, created.v3)).statusCode).toBe(
      200,
    );
    const afterRestore = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-set-trash?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(
      afterRestore
        .json()
        .entries.filter(
          (entry: { testSetId: string }) =>
            entry.testSetId === created.testSetId,
        ),
    ).toEqual([]);
  });

  it("permanently deletes a Test Set's already-trashed branch as part of its closure", async () => {
    const created = await createVersionChain();
    const branch = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(branch.statusCode, branch.body).toBe(201);
    const testSet = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(testSet.statusCode, testSet.body).toBe(201);
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${testSet.json().entry.id}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: created.name },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${branch.json().entry.id}/restore`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(restored.statusCode).toBe(404);
    const members = await db.query(
      "SELECT count(*)::integer AS count FROM version_member WHERE version_id = $1",
      [created.v3],
    );
    expect(members.rows[0].count).toBe(0);
  });

  it("requires the locked Test Set name for permanent deletion", async () => {
    const created = await createVersionChain();
    const trashed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    const entryId = trashed.json().entry.id as string;
    const wrong = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entryId}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: "错误名称" },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toEqual({
      error: { code: "permanent_delete_confirmation_required" },
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${entryId}/permanent-delete`,
      headers: mutationHeaders(),
      payload: { confirmation: created.name },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
  });

  it("does not expose the retired controlled-deletion route", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/deletions/preview`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "route_not_found" } });
  });

  async function createVersionChain() {
    const name = `删除回归 ${randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name,
        purpose: "Ticket 26",
        selections: [],
        records: [
          {
            question: "v1",
            expectedOutput: "answer",
            metadata: [{ key: "Metadata", value: "synthetic" }],
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const testSetId = created.json().testSet.id as string;
    const v1 = created.json().version.id as string;
    const records = [
      {
        question: "v1",
        expectedOutput: "answer",
        metadata: [{ key: "Metadata", value: "synthetic" }],
      },
    ];
    const v2 = await derive(testSetId, v1, records);
    const v3 = await derive(testSetId, v2, records);
    return { testSetId, name, v1, v2, v3 };
  }

  async function derive(
    testSetId: string,
    parentVersionId: string,
    records: unknown[],
  ) {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${parentVersionId}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { selections: [], records },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().version.id as string;
  }

  function getVersion(testSetId: string, versionId: string) {
    return app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${versionId}`,
      headers: { cookie },
    });
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
