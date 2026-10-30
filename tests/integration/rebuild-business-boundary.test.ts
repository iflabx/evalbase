import * as operationBoundary from "../../src/operations/commit.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { runProcessing } from "../../src/processing/execute.js";
import { acceptProcessingResults } from "../../src/processing/accept.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { createSharedDraft } from "../../src/drafts/create.js";
import { withOperationScope } from "../../src/operations/commit.js";
import { runtimeOperationScope } from "../../src/assistant-rebuild/operation-scope.js";
import { legacyOperationScope } from "../../src/assistant/fence.js";
import { rebuildSchema } from "../../src/assistant-rebuild/schema.js";

// No legacy planning/dispatch may be needed by the manual business flows below.
vi.mock("../../src/assistant/agent.js", () => ({
  executeAssistantTurn: vi.fn(() => {
    throw Error("legacy_dispatch_disabled");
  }),
}));
const origin = "http://127.0.0.1:4217";
const baseUrl = loadConfig().databaseUrl;
const databaseName = "rebuild_boundary_" + randomUUID().replaceAll("-", "");
const databaseUrl = baseUrl.replace(/\/[^/]+$/, "/" + databaseName);
const db = createPool(databaseUrl);
let app: AgentBenchApp,
  projectId: string,
  otherProject: string,
  editorId: string;
const sessions = new Map<string, Record<string, string>>();
const baseScope = () => ({ projectId, actorId: editorId });
async function api(
  method: any,
  url: string,
  payload?: unknown,
  actor = "admin",
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: { origin, ...sessions.get(actor), ...extraHeaders },
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
}
async function runtimeScope() {
  const id = "rb_" + randomUUID(),
    token = randomUUID();
  await db.query(
    "INSERT INTO rebuild_session(id,project_id,actor_id,campaign_id,status,token) VALUES($1,$2,$3,'r01','running',$4)",
    [id, projectId, editorId, token],
  );
  return runtimeOperationScope({
    ...baseScope(),
    runtimeGuard: { sessionId: id, revision: 1, token },
  });
}
describe("REBUILD-01 shared business commit boundary", () => {
  beforeAll(async () => {
    const root = createPool(baseUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
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
    for (const who of ["admin", "editor", "viewer"]) {
      const payload = {
        email: who + "@r01.example.test",
        password: "Rebuild01Pass123",
        confirmPassword: "Rebuild01Pass123",
        ...(who === "admin" ? { displayName: who } : {}),
      };
      const created = await api(
        "POST",
        who === "admin" ? "/api/installation/administrator" : "/api/accounts",
        payload,
      );
      expect(created.statusCode, created.body).toBe(201);
      const login = await api("POST", "/api/session", {
        email: payload.email,
        password: payload.password,
      });
      expect(login.statusCode, login.body).toBe(200);
      sessions.set(who, {
        cookie: login.cookies[0].name + "=" + login.cookies[0].value,
        "x-csrf-token": login.json().csrfToken,
      });
    }
    projectId = (
      await api("POST", "/api/projects", { name: "R01 synthetic" })
    ).json().project.id;
    otherProject = (
      await api("POST", "/api/projects", { name: "R01 other" })
    ).json().project.id;
    for (const who of ["editor", "viewer"]) {
      const invitation = (
        await api("POST", "/api/projects/" + projectId + "/invitations", {
          email: who + "@r01.example.test",
          role: who,
        })
      ).json().invitation;
      expect(
        (
          await api(
            "POST",
            "/api/me/invitations/" + invitation.id + "/accept",
            undefined,
            who,
          )
        ).statusCode,
      ).toBe(200);
    }
    editorId = (
      await db.query(
        "SELECT id FROM app_user WHERE email='editor@r01.example.test'",
      )
    ).rows[0].id;
    await db.query(rebuildSchema);
    await db.query(
      "INSERT INTO rebuild_campaign(id,max_requests,max_rows,max_generated,max_minutes) VALUES('r01',0,0,0,1)",
    );
  });
  afterAll(async () => {
    await app?.close();
    await db.end();
    const root = createPool(baseUrl);
    try {
      await root.query(
        "DROP DATABASE IF EXISTS " + databaseName + " WITH (FORCE)",
      );
    } finally {
      await root.end();
    }
  });
  it("restricts the real trash read entry to administrators", async () => {
    expect(
      (await api("GET", "/api/projects/" + projectId + "/solo-test-set-trash"))
        .statusCode,
    ).toBe(200);
    for (const who of ["editor", "viewer"])
      expect(
        (
          await api(
            "GET",
            "/api/projects/" + projectId + "/solo-test-set-trash",
            undefined,
            who,
          )
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await api(
          "GET",
          "/api/projects/" + otherProject + "/solo-test-set-trash",
          undefined,
          "editor",
        )
      ).statusCode,
    ).toBe(404);
  });
  it("preserves existing operation receipts and parameter conflicts across callers", async () => {
    const runtime = await runtimeScope();
    const actualLegacy = legacyOperationScope({
      ...baseScope(),
      assistantGuard: { sessionId: "retired-fixture", revision: 0 },
    });
    await expect(
      createSharedDraft(
        db,
        actualLegacy,
        { name: "旧执行不得写入" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "assistant_runtime_retired" });
    for (const scope of [baseScope(), runtime]) {
      const key = randomUUID(),
        body = { name: "同一业务操作" };
      const first = await createSharedDraft(db, scope, body, key);
      const replay = await createSharedDraft(db, scope, body, key);
      expect(replay.draft.id).toBe(first.draft.id);
      expect(replay.replayed).toBe(true);
      await expect(
        createSharedDraft(db, scope, { name: "变参" }, key),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
  });
  it("does not downgrade an assistant write when a nested caller drops proof fields", async () => {
    const scope = await runtimeScope();
    await db.query(
      "UPDATE rebuild_session SET status='paused',token=NULL WHERE id=$1",
      [scope.runtimeGuard.sessionId],
    );
    await expect(
      withOperationScope(scope, () =>
        createSharedDraft(
          db,
          baseScope(),
          { name: "不能冒充人工" },
          randomUUID(),
        ),
      ),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    expect(
      (
        await db.query(
          "SELECT 1 FROM collaborative_draft WHERE name='不能冒充人工'",
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      createSharedDraft(
        db,
        { ...baseScope(), runtimeGuard: scope.runtimeGuard },
        { name: "不能伪造证明" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "operation_context_required" });
    await expect(
      createSharedDraft(
        db,
        {
          ...baseScope(),
          operation: JSON.parse(JSON.stringify(scope.operation)),
        },
        { name: "不能序列化证明" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "operation_context_invalid" });
  });
  it("rechecks runtime revision and current project membership at commit", async () => {
    const scope = await runtimeScope();
    await db.query(
      "UPDATE rebuild_session SET revision=revision+1 WHERE id=$1",
      [scope.runtimeGuard.sessionId],
    );
    await expect(
      createSharedDraft(db, scope, { name: "旧修订" }, randomUUID()),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    await db.query(
      "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [projectId, editorId],
    );
    try {
      for (const s of [baseScope(), await runtimeScope()])
        await expect(
          createSharedDraft(db, s, { name: "撤权" }, randomUUID()),
        ).rejects.toMatchObject({ code: "project_not_found" });
    } finally {
      await db.query(
        "UPDATE project_member SET role='editor' WHERE project_id=$1 AND user_id=$2",
        [projectId, editorId],
      );
    }
  });
  it("keeps issued proof immutable and limits paused control to cancellation", async () => {
    const scope = await runtimeScope(),
      token = randomUUID();
    await db.query(
      "UPDATE rebuild_session SET revision=2,token=$2 WHERE id=$1",
      [scope.runtimeGuard.sessionId, token],
    );
    scope.runtimeGuard.revision = 2;
    scope.runtimeGuard.token = token;
    await expect(
      createSharedDraft(db, scope, { name: "不能升级旧证明" }, randomUUID()),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    const paused = await runtimeScope();
    await db.query("UPDATE rebuild_session SET status='paused' WHERE id=$1", [
      paused.runtimeGuard.sessionId,
    ]);
    const control = runtimeOperationScope({
      ...paused,
      runtimeGuard: { ...paused.runtimeGuard, control: true },
    });
    await expect(
      createSharedDraft(
        db,
        control,
        { name: "取消权不是写入权" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    const other = await runtimeScope();
    await expect(
      withOperationScope(paused, () =>
        createSharedDraft(db, other, { name: "不能换会话" }, randomUUID()),
      ),
    ).rejects.toMatchObject({ code: "operation_context_invalid" });
    expect(
      (
        await db.query(
          "SELECT 1 FROM collaborative_draft WHERE name IN('不能升级旧证明','取消权不是写入权','不能换会话')",
        )
      ).rowCount,
    ).toBe(0);
  });
  it("keeps manual upload, selection, rule cleaning, adoption and publication independent of legacy dispatch", async () => {
    const base = "/api/projects/" + projectId;
    const collections = (await api("GET", base + "/collections")).json()
      .collections;
    const bytes =
      "question,answer,kind\n  手工问题一  ,标签甲,预约\n手工问题二,标签乙,查询\n";
    const uploaded = await api(
      "POST",
      base + "/pending-uploads",
      bytes,
      "admin",
      {
        "content-type": "text/csv",
        "x-file-name": "r01-original.csv",
        "idempotency-key": randomUUID(),
      },
    );
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const pendingId = uploaded.json().pendingUpload.id;
    const mapping = await api(
      "PUT",
      base + "/pending-uploads/" + pendingId + "/preview",
      {
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/kind"],
        },
      },
    );
    expect(mapping.statusCode, mapping.body).toBe(200);
    const confirmed = await api(
      "POST",
      base + "/pending-upload-batches/confirm",
      { collectionId: collections[0].id, pendingUploadIds: [pendingId] },
      "admin",
      { "idempotency-key": randomUUID() },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const assetId = confirmed.json().assets[0].id;
    const created = await api("POST", base + "/collaborative-drafts", {
      name: "人工入口仍独立",
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json().draft.id,
      draftPath = base + "/collaborative-drafts/" + draftId;
    const preview = await api("POST", draftPath + "/selection-previews", {
      assetIds: [assetId],
      conditions: [],
      method: "all",
    });
    expect(preview.statusCode, preview.body).toBe(201);
    const selection = preview.json().preview;
    const selectionInput = {
      selectedIds: selection.selectedIds,
      expectedRevision: 0,
    };
    expect(
      (
        await api(
          "POST",
          draftPath + "/selection-previews/" + selection.id + "/apply",
          selectionInput,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api(
          "POST",
          draftPath + "/selection-previews/" + selection.id + "/apply",
          selectionInput,
        )
      ).json().replayed,
    ).toBe(true);
    const source = (await api("GET", draftPath)).json();
    const submitted = await api(
      "POST",
      base + "/processing-runs",
      {
        source: {
          kind: "draft",
          id: draftId,
          recordIds: source.records.map((r: any) => r.id),
        },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
      "admin",
      { "idempotency-key": randomUUID() },
    );
    expect(submitted.statusCode, submitted.body).toBe(201);
    const run = submitted.json().run;
    const job = (
      await db.query(
        "UPDATE job SET status='running',attempt=attempt+1,lease_owner='r01-local',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
        [run.jobId],
      )
    ).rows[0];
    const config = { ...loadConfig(), databaseUrl };
    const result = await runProcessing(
      db,
      new ArtifactRepository(config.minio),
      config,
      job,
    );
    await db.query("UPDATE job SET status='succeeded',result=$2 WHERE id=$1", [
      job.id,
      result,
    ]);
    const processed = await api("GET", base + "/processing-runs/" + run.id);
    expect(processed.statusCode, processed.body).toBe(200);
    const input = {
      resultIds: processed.json().records.map((r: any) => r.id),
      target: {
        kind: "draft",
        id: draftId,
        expectedRevision: source.draft.revision,
      },
    };
    const key = randomUUID();
    const badProof = await runtimeScope();
    await expect(
      acceptProcessingResults(
        db,
        new ArtifactRepository(config.minio),
        badProof,
        run.id,
        randomUUID(),
        {
          resultIds: input.resultIds,
          target: { kind: "newDraft", name: "未批准不能采用", purpose: "" },
        },
      ),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(
      (
        await db.query(
          "SELECT 1 FROM collaborative_draft WHERE name='未批准不能采用'",
        )
      ).rowCount,
    ).toBe(0);
    const adopted = await api(
      "POST",
      base + "/processing-runs/" + run.id + "/accept",
      input,
      "admin",
      { "idempotency-key": key },
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    const replay = await api(
      "POST",
      base + "/processing-runs/" + run.id + "/accept",
      input,
      "admin",
      { "idempotency-key": key },
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const current = (await api("GET", draftPath)).json();
    expect(current.records[0].question).toBe("手工问题一");
    expect(current.records.map((r: any) => r.expectedOutput)).toEqual(
      source.records.map((r: any) => r.expectedOutput),
    );
    const rejectPublication = async (path: string, revision: number) => {
      const originalGuard = operationBoundary.guardOperationCommit;
      const spy = vi
        .spyOn(operationBoundary, "guardOperationCommit")
        .mockImplementation(async (...args) => {
          if (args[2] === "publish")
            throw new operationBoundary.OperationCommitError(
              "project_not_found",
              404,
            );
          return originalGuard(...args);
        });
      const before = Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM test_set_version v JOIN test_set s ON s.id=v.test_set_id WHERE s.project_id=$1",
            [projectId],
          )
        ).rows[0].n,
      );
      try {
        const denied = await api("POST", path + "/publish", { revision });
        expect(denied.statusCode, denied.body).toBe(404);
        expect(denied.json().error.code).toBe("project_not_found");
      } finally {
        spy.mockRestore();
      }
      expect((await api("GET", path)).json().draft.status).toBe("editing");
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM test_set_version v JOIN test_set s ON s.id=v.test_set_id WHERE s.project_id=$1",
              [projectId],
            )
          ).rows[0].n,
        ),
      ).toBe(before);
    };
    await rejectPublication(draftPath, current.draft.revision);
    const published = await api("POST", draftPath + "/publish", {
      revision: current.draft.revision,
    });
    expect(published.statusCode, published.body).toBe(201);
    const version = published.json();
    const exported = await api(
      "GET",
      base +
        "/solo-test-sets/" +
        version.testSet.id +
        "/versions/" +
        version.version.id +
        "/data.csv",
    );
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain("手工问题一");
    const derivedCreated = await api("POST", base + "/collaborative-drafts", {
      testSetId: version.testSet.id,
      parentVersionId: version.version.id,
    });
    expect(derivedCreated.statusCode, derivedCreated.body).toBe(201);
    const derivedPath =
      base + "/collaborative-drafts/" + derivedCreated.json().draft.id;
    const added = await api("POST", derivedPath + "/records", {
      question: "派生新增问题",
      expectedOutput: "新增标签",
      metadata: [],
    });
    expect(added.statusCode, added.body).toBe(201);
    const derived = (await api("GET", derivedPath)).json().draft;
    await rejectPublication(derivedPath, derived.revision);
    const next = await api("POST", derivedPath + "/publish", {
      revision: derived.revision,
    });
    expect(next.statusCode, next.body).toBe(201);
    const originalVersion = await api(
      "GET",
      base +
        "/solo-test-sets/" +
        version.testSet.id +
        "/versions/" +
        version.version.id +
        "/data.csv",
    );
    expect(originalVersion.body).toBe(exported.body);

    const original = await api(
      "GET",
      base + "/assets/" + assetId + "/download?view=raw",
    );
    expect(original.statusCode, original.body).toBe(200);
    expect(original.json().rawPreview).toEqual({
      text: bytes,
      truncated: false,
    });
    expect(
      (
        await db.query(
          "SELECT requests,rows,generated FROM rebuild_campaign WHERE id='r01'",
        )
      ).rows[0],
    ).toEqual({ requests: 0, rows: 0, generated: 0 });
  });
});
