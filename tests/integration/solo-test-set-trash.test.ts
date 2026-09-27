import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { publishSparseVersion } from "../../src/version/publish-sparse.js";
import { materializePeriodicCheckpoint } from "../../src/version/checkpoint.js";

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
        "DELETE FROM version_export_cache WHERE version_id IN (SELECT v.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1)",
        [projectId],
      );
      await db.query(
        "DELETE FROM version_provenance_cut_fact WHERE version_id IN (SELECT v.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1)",
        [projectId],
      );
      await db.query(
        "DELETE FROM version_provenance_cut_state WHERE version_id IN (SELECT v.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1)",
        [projectId],
      );
      await db.query(
        "DELETE FROM version_checkpoint WHERE version_id IN (SELECT v.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1)",
        [projectId],
      );
      await db.query(
        "DELETE FROM version_change WHERE version_id IN (SELECT v.id FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1)",
        [projectId],
      );
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
        "DELETE FROM draft_case_operation op USING working_draft wd,test_set ts WHERE op.draft_id=wd.id AND wd.test_set_id=ts.id AND ts.project_id=$1",
        [projectId],
      );
      await db.query(
        "DELETE FROM draft_revision dr USING working_draft wd,test_set ts WHERE dr.draft_id=wd.id AND wd.test_set_id=ts.id AND ts.project_id=$1",
        [projectId],
      );
      await db.query(
        "DELETE FROM working_draft wd USING test_set ts WHERE wd.test_set_id = ts.id AND ts.project_id = $1",
        [projectId],
      );
      await db.query("DELETE FROM upload_idempotency WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM job WHERE project_id = $1", [projectId]);
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM test_set WHERE project_id = $1", [projectId]);
      await db.query("DELETE FROM data_asset WHERE project_id = $1", [
        projectId,
      ]);
      await db.query(
        "DELETE FROM raw_material_collection WHERE project_id = $1",
        [projectId],
      );
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
    const stored = await db.query(
      `SELECT cs.object_ref,cs.evidence_object_ref,cs.recipe,cs.validation_report,
              (SELECT count(*)::int FROM candidate_item ci WHERE ci.candidate_id=cs.id) AS candidate_items,
              (SELECT count(*)::int FROM version_member vm WHERE vm.version_id=v.id) AS members
         FROM test_set_version v JOIN candidate_snapshot cs ON cs.id=v.candidate_id
        WHERE v.id=$1`,
      [created.v2],
    );
    expect(stored.rows[0]).toMatchObject({
      object_ref: null,
      evidence_object_ref: null,
      recipe: null,
      validation_report: null,
      candidate_items: 0,
      members: 0,
    });
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
        operations: [
          {
            operation: "add",
            after: {
              question: "cannot derive",
              expectedOutput: "",
              metadata: [],
            },
          },
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

  it("keeps the target blocked and intact when a boundary checkpoint fails, then retries", async () => {
    const created = await createVersionChain();
    const child = await db.query(
      "SELECT payload_hash FROM test_set_version WHERE id=$1",
      [created.v3],
    );
    const original = String(child.rows[0].payload_hash);
    const target = await db.query(
      "SELECT manifest_object_ref FROM test_set_version WHERE id=$1",
      [created.v2],
    );
    await db.query(
      "UPDATE test_set_version SET payload_hash=repeat('0',64) WHERE id=$1",
      [created.v3],
    );
    const failed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v2" },
    });
    expect(failed.statusCode, failed.body).toBe(503);
    const pending = await db.query(
      "SELECT status,cleanup_pending,manifest_object_ref,item_count FROM test_set_version WHERE id=$1",
      [created.v2],
    );
    expect(pending.rows[0]).toMatchObject({
      status: "tombstoned",
      cleanup_pending: true,
      manifest_object_ref: target.rows[0].manifest_object_ref,
      item_count: 1,
    });
    expect((await getVersion(created.testSetId, created.v2)).statusCode).toBe(
      404,
    );
    const cut = await db.query(
      "SELECT 1 FROM version_checkpoint WHERE version_id=$1",
      [created.v3],
    );
    expect(cut.rowCount).toBe(0);
    expect((await getVersion(created.testSetId, created.v3)).statusCode).toBe(
      200,
    );
    const pendingProvenance = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/provenance?status=all`,
      headers: { cookie },
    });
    expect(pendingProvenance.statusCode, pendingProvenance.body).toBe(200);
    expect(pendingProvenance.json().summary.counts).toMatchObject({
      unchanged: 1,
      added: 0,
    });
    expect(pendingProvenance.json().changes[0].previous).toBeNull();
    await db.query("UPDATE test_set_version SET payload_hash=$2 WHERE id=$1", [
      created.v3,
      original,
    ]);
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v2" },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await getVersion(created.testSetId, created.v3)).statusCode).toBe(
      200,
    );
  });

  it("does not serve a deleted version or stale descendant CSV during object cleanup", async () => {
    const created = await createVersionChain();
    const url = (id: string) =>
      `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${id}/data.csv`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: url(created.v3),
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    let entered!: () => void;
    let release!: () => void;
    const reachedRemoval = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumeRemoval = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = artifacts.remove.bind(artifacts);
    artifacts.remove = async (ref) => {
      entered();
      await resumeRemoval;
      return remove(ref);
    };
    try {
      const deleting = app
        .inject({
          method: "POST",
          url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v2}/tombstone`,
          headers: mutationHeaders(),
          payload: { confirmation: "v2" },
        })
        .then((response) => response);
      await reachedRemoval;
      expect(
        (
          await app.inject({
            method: "GET",
            url: url(created.v2),
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: url(created.v3),
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(200);
      release();
      expect((await deleting).statusCode).toBe(200);
    } finally {
      release();
      artifacts.remove = remove;
    }
  });

  it("preserves a surviving boundary beyond an earlier tombstone", async () => {
    const created = await createVersionChain();
    for (const [id, label] of [
      [created.v2, "v2"],
      [created.v1, "v1"],
    ]) {
      const deleted = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${id}/tombstone`,
        headers: mutationHeaders(),
        payload: { confirmation: label },
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
    }
    expect((await getVersion(created.testSetId, created.v3)).statusCode).toBe(
      200,
    );
    const checkpoint = await db.query(
      "SELECT retention_class FROM version_checkpoint WHERE version_id=$1",
      [created.v3],
    );
    expect(checkpoint.rows[0].retention_class).toBe("required_dependency");
  });

  it("retries a pending Delta tombstone after its ancestor is deleted", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: `嵌套删除 ${randomUUID()}`,
        purpose: "Ticket 37",
        selections: [],
        operations: addOperations(
          Array.from({ length: 10 }, (_, index) => ({
            question: `base ${index + 1}`,
            expectedOutput: "answer",
            metadata: [],
          })),
        ),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const testSetId = created.json().testSet.id as string;
    const baseId = created.json().version.id as string;
    const firstMember = await db.query(
      `SELECT cr.case_id,cr.id FROM resolve_version_members($1) vm
       JOIN case_revision cr ON cr.id=vm.case_revision_id
       WHERE vm.version_id=$1 AND vm.ordinal=1`,
      [baseId],
    );
    const actor = await db.query("SELECT owner_id FROM project WHERE id=$1", [
      projectId,
    ]);
    const publish = (
      parentVersionId: string,
      beforeRevisionId: string,
      question: string,
    ) =>
      publishSparseVersion(db, artifacts, {
        projectId,
        testSetId,
        parentVersionId,
        actorId: String(actor.rows[0].owner_id),
        idempotencyKey: randomUUID(),
        operations: [
          {
            operation: "update",
            caseId: String(firstMember.rows[0].case_id),
            beforeRevisionId,
            after: { question, expectedOutput: "answer", metadata: [] },
          },
        ],
      });
    const middle = await publish(
      baseId,
      String(firstMember.rows[0].id),
      "secret pending",
    );
    const middleMember = await db.query(
      "SELECT case_revision_id FROM resolve_version_members($1) WHERE case_id=$2",
      [middle.id, firstMember.rows[0].case_id],
    );
    const child = await publish(
      middle.id,
      String(middleMember.rows[0].case_revision_id),
      "survivor",
    );
    const originalHash = await db.query(
      "SELECT payload_hash FROM test_set_version WHERE id=$1",
      [child.id],
    );
    await db.query(
      "UPDATE test_set_version SET payload_hash=repeat('0',64) WHERE id=$1",
      [child.id],
    );
    const firstAttempt = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${middle.id}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: middle.label },
    });
    expect(firstAttempt.statusCode).toBe(503);
    await db.query("UPDATE test_set_version SET payload_hash=$2 WHERE id=$1", [
      child.id,
      originalHash.rows[0].payload_hash,
    ]);
    const ancestor = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${baseId}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v1" },
    });
    expect(ancestor.statusCode, ancestor.body).toBe(200);
    const pendingCsv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${child.id}/provenance.csv`,
      headers: { cookie },
    });
    expect(pendingCsv.statusCode, pendingCsv.body).toBe(200);
    expect(pendingCsv.body).toContain("modified");
    expect(pendingCsv.body).not.toContain("secret pending");
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${middle.id}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: middle.label },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await getVersion(testSetId, child.id)).statusCode).toBe(200);
    const pending = await db.query(
      "SELECT cleanup_pending FROM test_set_version WHERE id=$1",
      [middle.id],
    );
    expect(pending.rows[0].cleanup_pending).toBe(false);
  });

  it("retains removed-case facts when the surviving Delta is empty", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: `空后代 ${randomUUID()}`,
        purpose: "Ticket 37",
        selections: [],
        operations: addOperations([
          {
            question: "deleted secret",
            expectedOutput: "answer",
            metadata: [],
          },
        ]),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const testSetId = created.json().testSet.id as string;
    const baseId = created.json().version.id as string;
    const member = await db.query(
      `SELECT cr.case_id,cr.id FROM resolve_version_members($1) vm
       JOIN case_revision cr ON cr.id=vm.case_revision_id
       WHERE vm.version_id=$1`,
      [baseId],
    );
    const actor = await db.query("SELECT owner_id FROM project WHERE id=$1", [
      projectId,
    ]);
    const empty = await publishSparseVersion(db, artifacts, {
      projectId,
      testSetId,
      parentVersionId: baseId,
      actorId: String(actor.rows[0].owner_id),
      idempotencyKey: randomUUID(),
      operations: [
        {
          operation: "delete",
          caseId: String(member.rows[0].case_id),
          beforeRevisionId: String(member.rows[0].id),
        },
      ],
    });
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${baseId}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: "v1" },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const provenance = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${empty.id}/provenance?status=all`,
      headers: { cookie },
    });
    expect(provenance.statusCode, provenance.body).toBe(200);
    expect(provenance.json().summary.counts.removed).toBe(1);
    expect(provenance.json().changes[0].previous).toBeNull();
    const csv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${empty.id}/provenance.csv`,
      headers: { cookie },
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain("removed");
    expect(csv.body).not.toContain("deleted secret");
  });

  it("cuts both Delta descendants before deleting an exclusive middle revision", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: `Delta 删除 ${randomUUID()}`,
        purpose: "Ticket 37",
        selections: [],
        operations: addOperations(
          Array.from({ length: 10 }, (_, index) => ({
            question: `base ${index + 1}`,
            expectedOutput: "answer",
            metadata: [],
          })),
        ),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const testSetId = created.json().testSet.id as string;
    const baseId = created.json().version.id as string;
    const baseMember = await db.query(
      `SELECT cr.case_id,cr.id FROM resolve_version_members($1) vm
       JOIN case_revision cr ON cr.id=vm.case_revision_id
       WHERE vm.version_id=$1 AND vm.ordinal=1`,
      [baseId],
    );
    const caseId = String(baseMember.rows[0].case_id);
    const actor = await db.query("SELECT owner_id FROM project WHERE id=$1", [
      projectId,
    ]);
    const publish = (
      parentVersionId: string,
      beforeRevisionId: string,
      question: string,
    ) =>
      publishSparseVersion(db, artifacts, {
        projectId,
        testSetId,
        parentVersionId,
        actorId: String(actor.rows[0].owner_id),
        idempotencyKey: randomUUID(),
        operations: [
          {
            operation: "update",
            caseId,
            beforeRevisionId,
            after: { question, expectedOutput: "answer", metadata: [] },
          },
        ],
      });
    const middle = await publish(
      baseId,
      String(baseMember.rows[0].id),
      "secret middle",
    );
    const middleMember = await db.query(
      "SELECT case_revision_id FROM resolve_version_members($1) WHERE case_id=$2",
      [middle.id, caseId],
    );
    const middleRevisionId = String(middleMember.rows[0].case_revision_id);
    const middleManifest = await db.query(
      "SELECT manifest_object_ref FROM test_set_version WHERE id=$1",
      [middle.id],
    );
    const first = await publish(middle.id, middleRevisionId, "first survivor");
    const second = await publish(
      middle.id,
      middleRevisionId,
      "second survivor",
    );
    const candidates = await db.query(
      `SELECT v.id,cs.id AS candidate_id,cs.draft_id
         FROM test_set_version v JOIN candidate_snapshot cs ON cs.id=v.candidate_id
        WHERE v.id=ANY($1::text[])`,
      [[middle.id, first.id]],
    );
    const middleCandidate = candidates.rows.find((row) => row.id === middle.id);
    const firstCandidate = candidates.rows.find((row) => row.id === first.id);
    const draftRevisionId = `draftrev_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO draft_case_operation
         (id,draft_id,operation,case_id,previous_content,diff,created_by)
       VALUES ($1,$2,'update',$3,$4::jsonb,$5::jsonb,$6)`,
      [
        `caseop_${randomUUID().replaceAll("-", "")}`,
        middleCandidate.draft_id,
        caseId,
        JSON.stringify({ question: "secret middle" }),
        JSON.stringify({ before: "secret middle" }),
        actor.rows[0].owner_id,
      ],
    );
    await db.query(
      `INSERT INTO draft_revision
         (id,draft_id,revision,operations,created_by,revision_hash)
       VALUES ($1,$2,2,$3::jsonb,$4,$5)`,
      [
        draftRevisionId,
        middleCandidate.draft_id,
        JSON.stringify([
          {
            previous_content: { question: "secret middle" },
            diff: { before: "secret middle" },
          },
        ]),
        actor.rows[0].owner_id,
        "fixture",
      ],
    );
    await db.query(
      "UPDATE candidate_snapshot SET draft_revision_id=$2 WHERE id=$1",
      [middleCandidate.candidate_id, draftRevisionId],
    );
    await db.query("UPDATE candidate_snapshot SET draft_id=$2 WHERE id=$1", [
      firstCandidate.candidate_id,
      middleCandidate.draft_id,
    ]);
    for (const id of [first.id, second.id]) {
      const csv = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${id}/provenance.csv`,
        headers: { cookie },
      });
      expect(csv.statusCode, csv.body).toBe(200);
      const hit = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${id}/provenance.csv`,
        headers: { cookie },
      });
      expect(hit.body).toBe(csv.body);
      const entries = await db.query(
        "SELECT count(*)::int AS count FROM version_export_cache WHERE version_id=$1",
        [id],
      );
      expect(entries.rows[0].count).toBe(1);
    }
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${middle.id}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: middle.label },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await getVersion(testSetId, middle.id)).statusCode).toBe(404);
    for (const [id, question] of [
      [first.id, "first survivor"],
      [second.id, "second survivor"],
    ]) {
      const page = await getVersion(testSetId, id);
      expect(page.statusCode, page.body).toBe(200);
      const csv = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${id}/provenance.csv`,
        headers: { cookie },
      });
      expect(csv.statusCode, csv.body).toBe(200);
      expect(csv.body).toContain(question);
      expect(csv.body).not.toContain("secret middle");
      const checkpoint = await db.query(
        "SELECT retention_class FROM version_checkpoint WHERE version_id=$1",
        [id],
      );
      expect(checkpoint.rows[0].retention_class).toBe("required_dependency");
      const edge = await db.query(
        "SELECT parent_version_id FROM test_set_version WHERE id=$1",
        [id],
      );
      expect(edge.rows[0].parent_version_id).toBe(middle.id);
    }
    const exclusive = await db.query(
      "SELECT 1 FROM case_revision WHERE id=$1",
      [middleRevisionId],
    );
    expect(exclusive.rowCount).toBe(0);
    const staging = await db.query(
      `SELECT previous_content,diff FROM draft_case_operation WHERE draft_id=$1`,
      [middleCandidate.draft_id],
    );
    expect(staging.rows[0]).toEqual({ previous_content: null, diff: null });
    const frozen = await db.query(
      "SELECT operations FROM draft_revision WHERE id=$1",
      [draftRevisionId],
    );
    expect(JSON.stringify(frozen.rows[0].operations)).not.toContain(
      "secret middle",
    );
    await expect(
      artifacts.size(String(middleManifest.rows[0].manifest_object_ref)),
    ).rejects.toThrow();
    const stale = await db.query(
      "SELECT 1 FROM version_export_cache WHERE version_id=$1",
      [middle.id],
    );
    expect(stale.rowCount).toBe(0);
  });

  it("promotes a restorable periodic checkpoint and retains a shared revision", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: `共享修订 ${randomUUID()}`,
        purpose: "Ticket 37",
        selections: [],
        operations: addOperations(
          Array.from({ length: 10 }, (_, index) => ({
            question: `base ${index + 1}`,
            expectedOutput: "answer",
            metadata: [],
          })),
        ),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const testSetId = created.json().testSet.id as string;
    const baseId = created.json().version.id as string;
    const member = await db.query(
      `SELECT cr.case_id,cr.id FROM resolve_version_members($1) vm JOIN case_revision cr
       ON cr.id=vm.case_revision_id WHERE vm.version_id=$1 AND vm.ordinal=1`,
      [baseId],
    );
    const actor = await db.query("SELECT owner_id FROM project WHERE id=$1", [
      projectId,
    ]);
    const middle = await publishSparseVersion(db, artifacts, {
      projectId,
      testSetId,
      parentVersionId: baseId,
      actorId: String(actor.rows[0].owner_id),
      idempotencyKey: randomUUID(),
      operations: [
        {
          operation: "update",
          caseId: String(member.rows[0].case_id),
          beforeRevisionId: String(member.rows[0].id),
          after: {
            question: "shared content",
            expectedOutput: "answer",
            metadata: [],
          },
        },
      ],
    });
    const survivor = await publishSparseVersion(db, artifacts, {
      projectId,
      testSetId,
      parentVersionId: middle.id,
      actorId: String(actor.rows[0].owner_id),
      idempotencyKey: randomUUID(),
      operations: [],
    });
    expect(
      await materializePeriodicCheckpoint(db, survivor.id, projectId),
    ).toBe("created");
    const revision = await db.query(
      "SELECT case_revision_id FROM resolve_version_members($1) WHERE case_id=$2",
      [middle.id, member.rows[0].case_id],
    );
    const trash = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${survivor.id}/trash`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(trash.statusCode, trash.body).toBe(201);
    const deleted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${middle.id}/tombstone`,
      headers: mutationHeaders(),
      payload: { confirmation: middle.label },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const checkpoint = await db.query(
      "SELECT retention_class FROM version_checkpoint WHERE version_id=$1",
      [survivor.id],
    );
    expect(checkpoint.rows[0].retention_class).toBe("required_dependency");
    expect(
      (
        await db.query("SELECT 1 FROM case_revision WHERE id=$1", [
          revision.rows[0].case_revision_id,
        ])
      ).rowCount,
    ).toBe(1);
    const restored = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-set-trash/${trash.json().entry.id}/restore`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const csv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${survivor.id}/data.csv`,
      headers: { cookie },
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain("shared content");
  });

  it("invalidates cached exports when a source asset moves", async () => {
    const created = await createVersionChain();
    const csv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSetId}/versions/${created.v3}/data.csv`,
      headers: { cookie },
    });
    expect(csv.statusCode, csv.body).toBe(200);
    const prior = await db.query(
      "SELECT count(*)::int AS count FROM version_export_cache WHERE version_id=$1",
      [created.v3],
    );
    expect(prior.rows[0].count).toBe(1);
    const owner = await db.query("SELECT owner_id FROM project WHERE id=$1", [
      projectId,
    ]);
    const collectionId = `collection_${randomUUID().replaceAll("-", "")}`;
    const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      "INSERT INTO raw_material_collection (id,project_id,name) VALUES ($1,$2,$3)",
      [collectionId, projectId, `Moved ${randomUUID()}`],
    );
    await db.query(
      `INSERT INTO data_asset
       (id,project_id,blob_sha256,object_ref,size_bytes,mime_type,file_name,format,status,uploaded_by,collection_id)
       VALUES ($1,$2,repeat('a',64),'synthetic/no-object',1,'text/csv','synthetic.csv','csv','stored',$3,
         (SELECT id FROM raw_material_collection WHERE project_id=$2 AND is_unfiled))`,
      [assetId, projectId, owner.rows[0].owner_id],
    );
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/assets/${assetId}/collection`,
      headers: mutationHeaders(),
      payload: { collectionId },
    });
    expect(moved.statusCode, moved.body).toBe(204);
    const invalidated = await db.query(
      "SELECT 1 FROM version_export_cache WHERE version_id=$1",
      [created.v3],
    );
    expect(invalidated.rowCount).toBe(0);
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
        operations: addOperations([
          {
            question: "v1",
            expectedOutput: "answer",
            metadata: [{ key: "Metadata", value: "synthetic" }],
          },
        ]),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const testSetId = created.json().testSet.id as string;
    const v1 = created.json().version.id as string;
    const v2 = await derive(testSetId, v1);
    const v3 = await derive(testSetId, v2);
    return { testSetId, name, v1, v2, v3 };
  }

  async function derive(testSetId: string, parentVersionId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${parentVersionId}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { operations: [] },
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

  function addOperations(records: unknown[]) {
    return records.map((after) => ({ operation: "add", after }));
  }
});
