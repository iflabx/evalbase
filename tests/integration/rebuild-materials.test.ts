import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import {
  MaterialsStore,
  materialRecordRows,
} from "../../src/materials/store.js";
import { materialsTools } from "../../src/assistant-rebuild/materials-tools.js";
import {
  SessionStore,
  type TurnProof,
} from "../../src/assistant-rebuild/session-store.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { processingSourceAvailable } from "../../src/processing/store.js";
const base = loadConfig(),
  origin = "http://127.0.0.1:4217";
const databaseName = "r05_materials_" + randomUUID().replaceAll("-", ""),
  databaseUrl = base.databaseUrl.replace(/\/[^/]+$/, "/" + databaseName);
const db = createPool(databaseUrl),
  identities = new Map<string, Record<string, string>>(),
  actors = new Map<string, string>();
const artifacts = new ArtifactRepository(base.minio),
  store = new MaterialsStore(db, artifacts),
  sessions = new SessionStore(db);
let app: AgentBenchApp,
  projectId: string,
  otherProject: string,
  collectionId: string,
  assetId: string;
const scope = (actor = "admin") => ({ projectId, actorId: actors.get(actor)! });
const path = (suffix: string, project = projectId) =>
  `/api/projects/${project}/${suffix}`;
async function api(
  method: any,
  url: string,
  payload?: unknown,
  actor = "admin",
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...identities.get(actor),
      "idempotency-key": randomUUID(),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
}
async function freshProof(actor = "admin"): Promise<TurnProof> {
  const made = await sessions.create(scope(actor));
  const accepted = await sessions.accept(scope(actor), made.session.id, {
    submissionId: "submission_" + randomUUID(),
    expectedRevision: made.session.revision,
    text: "整理这份资料",
  });
  return sessions.claim(scope(actor), made.session.id, accepted.turnId);
}
async function invoke(
  proof: TurnProof,
  name: string,
  args: unknown,
  canWrite = true,
) {
  const item = materialsTools(sessions, proof, canWrite, artifacts).tools.find(
    (t) => t.name === name,
  )!;
  return item.invoke(args);
}
async function upload(name: string, text: string, actor = "admin") {
  const response = await api("POST", path("pending-uploads"), text, actor, {
    "content-type": "application/octet-stream",
    "x-file-name": name,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().pendingUpload.id;
}
const mapping = {
  question: "/question",
  expectedOutput: "/answer",
  metadata: ["/type"],
};
const original =
  [
    { question: "  问题一  ", answer: "答案一", type: "一类" },
    { question: "问题二", answer: "答案二", type: "二类" },
    { question: "问题三", answer: "答案三", type: "一类" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";
describe("REBUILD-05 materials business and native bridge", () => {
  beforeAll(async () => {
    const root = createPool(base.databaseUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    app = await buildApp(
      {
        ...base,
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      {
        disableLegacyTestBootstrap: true,
        disableAssistantRuntimeDispatch: true,
      },
    );
    for (const who of ["admin", "editor", "viewer"]) {
      const payload = {
        email: who + "@r05.example.test",
        password: "Rebuild05Pass123",
        confirmPassword: "Rebuild05Pass123",
        ...(who === "admin" ? { displayName: who } : {}),
      };
      const created = await api(
        "POST",
        who === "admin" ? "/api/installation/administrator" : "/api/accounts",
        payload,
      );
      expect(created.statusCode, created.body).toBe(201);
      const logged = await api("POST", "/api/session", {
        email: payload.email,
        password: payload.password,
      });
      identities.set(who, {
        cookie: logged.cookies[0].name + "=" + logged.cookies[0].value,
        "x-csrf-token": logged.json().csrfToken,
      });
      actors.set(
        who,
        (
          await db.query("SELECT id FROM app_user WHERE email=$1", [
            payload.email,
          ])
        ).rows[0].id,
      );
    }
    projectId = (await api("POST", "/api/projects", { name: "R05材料" })).json()
      .project.id;
    otherProject = (
      await api("POST", "/api/projects", { name: "R05不可见" })
    ).json().project.id;
    for (const who of ["editor", "viewer"])
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,$3)",
        [projectId, actors.get(who), who],
      );
    collectionId = (await api("GET", path("collections"))).json().collections[0]
      .id;
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await db.end();
    const root = createPool(base.databaseUrl);
    try {
      await root.query("DROP DATABASE " + databaseName + " WITH (FORCE)");
    } finally {
      await root.end();
    }
  });
  it("native pending preview waits for fixed confirmation, replay creates one asset with unchanged bytes", async () => {
    const pending = await upload("r05-native.jsonl", original);
    expect(
      (await db.query("SELECT count(*)::int n FROM data_asset")).rows[0].n,
    ).toBe(0);
    const preview = await api(
      "PUT",
      path(`pending-uploads/${pending}/preview`),
      { mapping },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().preview[0].question).toBe("  问题一  ");
    const key = randomUUID();
    const body = { collectionId, pendingUploadIds: [pending], mode: "mapped" };
    const saved = await api(
      "POST",
      path("pending-upload-batches/confirm"),
      body,
      "admin",
      { "idempotency-key": key },
    );
    expect(saved.statusCode, saved.body).toBe(201);
    assetId = saved.json().assets[0].id;
    const retry = await api(
      "POST",
      path("pending-upload-batches/confirm"),
      body,
      "admin",
      { "idempotency-key": key },
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.json().assets[0].id).toBe(assetId);
    expect(
      (await db.query("SELECT count(*)::int n FROM data_asset")).rows[0].n,
    ).toBe(1);
    const raw = await api("GET", path(`assets/${assetId}/download?view=raw`));
    expect(raw.json().rawPreview.text).toBe(original);
    const after = await store.raw(scope(), assetId);
    expect(after.text).toBe(original);
    expect(after.truncated).toBe(false);
  });
  it("shared records preserve mapped values, filtering and processing-compatible real IDs", async () => {
    const result = await api(
      "GET",
      path(
        `collections/${collectionId}/records?search=${encodeURIComponent("一类")}&limit=1`,
      ),
    );
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().pagination.total).toBe(2);
    expect(result.json().records[0].recordId).toBe(assetId + ":1");
    const full = await materialRecordRows(
      db,
      projectId,
      collectionId,
      assetId,
      "一类",
    );
    expect(full.map((r) => r.ordinal)).toEqual([1, 3]);
    expect(full[0].question).toBe("  问题一  ");
    await expect(
      processingSourceAvailable(
        db,
        projectId,
        {
          kind: "assets",
          assetIds: [assetId],
          recordIds: full.map((r) => r.recordId),
        },
        true,
      ),
    ).resolves.toBeUndefined();
    const record = await store.record(scope(), assetId, 2);
    expect(record.record.question).toBe("问题二");
  });
  it("real tools create and move via shared service; repeated SDK invocation uses persisted unique receipt", async () => {
    const proof = await freshProof("editor");
    const collection: any = await invoke(proof, "create_collection", {
      name: "收纳集合",
    });
    const replay: any = await invoke(proof, "create_collection", {
      name: "收纳集合",
    });
    expect(replay.collection.id).toBe(collection.collection.id);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM raw_material_collection WHERE project_id=$1 AND name='收纳集合'",
          [projectId],
        )
      ).rows[0].n,
    ).toBe(1);
    const before = (
      await db.query(
        "SELECT blob_sha256,object_ref FROM data_asset WHERE id=$1",
        [assetId],
      )
    ).rows[0];
    const moved: any = await invoke(proof, "move_material_file", {
      assetId,
      collectionId: collection.collection.id,
    });
    expect(moved.collectionId).toBe(collection.collection.id);
    const web = await api("PATCH", path(`assets/${assetId}/collection`), {
      collectionId,
    });
    expect(web.statusCode, web.body).toBe(204);
    expect(
      (
        await db.query(
          "SELECT blob_sha256,object_ref FROM data_asset WHERE id=$1",
          [assetId],
        )
      ).rows[0],
    ).toEqual(before);
    expect(
      (await db.query("SELECT count(*)::int n FROM processing_run")).rows[0].n,
    ).toBe(0);
    const files: any = await invoke(proof, "list_material_files", {
      search: "r05-native",
      limit: 20,
      offset: 0,
    });
    expect(files.items[0].id).toBe(assetId);
    expect(
      materialsTools(sessions, proof, true, artifacts)
        .schemas.get("move_material_file")
        ?.safeParse({ assetId, collectionId, actorId: "fake" }).success,
    ).toBe(false);
  });
  it("viewer, removed member and cross-project objects fail at real server boundary", async () => {
    const proof = await freshProof("viewer");
    const tools = materialsTools(sessions, proof, false, artifacts);
    expect(tools.tools.some((t) => t.name === "create_collection")).toBe(false);
    const projects: any = await invoke(
      proof,
      "list_projects",
      { limit: 20, offset: 0 },
      false,
    );
    expect(projects.items.map((p: any) => p.id)).toEqual([projectId]);
    await expect(
      invoke(
        proof,
        "navigate_project",
        { projectId: otherProject, page: "datasets" },
        false,
      ),
    ).rejects.toMatchObject({ code: "project_not_found" });
    await expect(
      store.createCollection(scope("viewer"), { name: "forbidden" }),
    ).rejects.toMatchObject({ code: "project_not_found" });
    const foreign = (
      await api("POST", path("collections", otherProject), {
        name: "外项目集合",
      })
    ).json().collection.id;
    await expect(
      store.move(scope("editor"), assetId, foreign),
    ).rejects.toMatchObject({ code: "asset_or_collection_not_found" });
    await expect(
      store.createProject(actors.get("editor")!, { name: "forbidden" }),
    ).rejects.toMatchObject({ code: "administrator_required" });
    await db.query(
      "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
      [projectId, actors.get("viewer")],
    );
    await expect(
      invoke(proof, "list_collections", { offset: 0, limit: 20 }, false),
    ).rejects.toMatchObject({ code: "project_not_found" });
    await db.query(
      "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer')",
      [projectId, actors.get("viewer")],
    );
  });
  it("native bridges expose only validated actions; navigation does not rebind task project", async () => {
    const proof = await freshProof();
    const upload: any = await invoke(proof, "open_material_upload", {
      collectionId,
    });
    expect(upload).toEqual({ nativeAction: { kind: "upload", collectionId } });
    const mapping: any = await invoke(proof, "open_material_mapping", {
      assetId,
    });
    expect(mapping.nativeAction.assetId).toBe(assetId);
    const navigation: any = await invoke(proof, "navigate_project", {
      projectId: otherProject,
      page: "datasets",
    });
    expect(navigation.nativeAction.href).toBe(
      `/projects/${otherProject}/datasets`,
    );
    expect((await sessions.get(scope(), proof.sessionId)).project_id).toBe(
      projectId,
    );
  });
  it("pending cancellation/expiration/ownership never creates assets; raw initial mapping is confirmed once", async () => {
    const start = (await db.query("SELECT count(*)::int n FROM data_asset"))
      .rows[0].n;
    const pending = await upload("cancel.jsonl", '{"q":"cancel"}\n');
    const other = await api(
      "PUT",
      path(`pending-uploads/${pending}/preview`),
      { mapping: { question: "/q", metadata: [] } },
      "editor",
    );
    expect(other.statusCode).toBe(404);
    expect(
      (
        await api("DELETE", path("pending-upload-batches"), {
          pendingUploadIds: [pending],
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await api("POST", path("pending-upload-batches/confirm"), {
          collectionId,
          pendingUploadIds: [pending],
          mode: "raw",
        })
      ).statusCode,
    ).toBe(404);
    const expired = await upload("expired.jsonl", '{"q":"expired"}\n');
    await db.query(
      "UPDATE pending_upload SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired],
    );
    expect(
      (
        await api("POST", path("pending-upload-batches/confirm"), {
          collectionId,
          pendingUploadIds: [expired],
          mode: "raw",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await db.query("SELECT count(*)::int n FROM data_asset")).rows[0].n,
    ).toBe(start);
    const rawId = await upload("map.jsonl", '{"q":"initial","a":"expected"}\n');
    const saved = await api("POST", path("pending-upload-batches/confirm"), {
      collectionId,
      pendingUploadIds: [rawId],
      mode: "raw",
    });
    const id = saved.json().assets[0].id;
    const initial = (await api("GET", path(`assets/${id}/mapping`))).json();
    const body = {
      parsedViewId: initial.parsedViewId,
      mapping: { question: "/q", expectedOutput: "/a", metadata: [] },
    };
    expect(
      (await api("POST", path(`assets/${id}/mapping/preview`), body))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await db.query("SELECT mapping_ready FROM parsed_view WHERE id=$1", [
          initial.parsedViewId,
        ])
      ).rows[0].mapping_ready,
    ).toBe(false);
    const confirm = await api("PUT", path(`assets/${id}/mapping`), {
      ...body,
      expectedRevision: 0,
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    const stale = await api("PUT", path(`assets/${id}/mapping`), {
      ...body,
      expectedRevision: 0,
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().replayed).toBe(true);
    expect((await store.record(scope(), id, 1)).record.question).toBe(
      "initial",
    );
  });
  it("raw prefix truthfully reports truncation and rejects deletion/integrity locks", async () => {
    const text = JSON.stringify({ q: "长".repeat(5000) }) + "\n";
    const pending = await upload("long.jsonl", text);
    const saved = await api("POST", path("pending-upload-batches/confirm"), {
      collectionId,
      pendingUploadIds: [pending],
      mode: "raw",
    });
    const id = saved.json().assets[0].id;
    const raw = await store.raw(scope(), id);
    expect(raw.truncated).toBe(true);
    expect(Buffer.byteLength(raw.text)).toBeLessThanOrEqual(12000);
    expect(raw.text.includes("\ufffd")).toBe(false);
    await db.query(
      "UPDATE data_asset SET status='deletion_pending' WHERE id=$1",
      [id],
    );
    await expect(store.raw(scope(), id)).rejects.toMatchObject({
      code: "asset_not_found",
    });
  });
  it("HTTP input handoff fixes selected IDs, current matching range and source revision without widening", async () => {
    const endpoint = path("assistant-runtime/input-scope");
    const selected = await api("POST", endpoint, {
      collectionId,
      mode: "selected",
      records: [
        { assetId, ordinal: 1 },
        { assetId, ordinal: 3 },
      ],
    });
    expect(selected.statusCode, selected.body).toBe(200);
    const fixed = selected.json();
    expect(fixed.total).toBe(2);
    expect(fixed.source.recordIds).toEqual([assetId + ":1", assetId + ":3"]);
    expect(fixed.sourceRevision).toBeTruthy();
    const empty = await api("POST", endpoint, {
      collectionId,
      mode: "selected",
      records: [],
    });
    expect(empty.statusCode).toBe(422);
    const invalid = await api("POST", endpoint, {
      collectionId,
      mode: "selected",
      records: [{ assetId, ordinal: 999 }],
    });
    expect(invalid.statusCode).toBe(409);
    const foreign = await api("POST", endpoint, {
      collectionId,
      mode: "selected",
      records: [{ assetId: "other-project-asset", ordinal: 1 }],
    });
    expect(foreign.statusCode).toBe(409);
    const matching = await api("POST", endpoint, {
      collectionId,
      assetId,
      mode: "matching",
      search: "一类",
    });
    expect(matching.statusCode, matching.body).toBe(200);
    expect(matching.json().source.recordIds).toEqual(fixed.source.recordIds);
    const entire = await api("POST", endpoint, {
      collectionId,
      assetId,
      mode: "file",
    });
    expect(entire.statusCode, entire.body).toBe(200);
    expect(entire.json().total).toBe(3);
    expect(
      (await api("POST", endpoint, { collectionId, mode: "file" })).statusCode,
    ).toBe(422);
    const invisible = await api(
      "POST",
      path("assistant-runtime/input-scope", otherProject),
      { collectionId, mode: "selected", records: [{ assetId, ordinal: 1 }] },
      "viewer",
    );
    expect(invisible.statusCode).toBe(404);
    const viewer = await api(
      "POST",
      endpoint,
      { collectionId, mode: "selected", records: [{ assetId, ordinal: 1 }] },
      "viewer",
    );
    expect(viewer.statusCode, viewer.body).toBe(200);
    const conversation = await sessions.create(scope());
    const invalidRevision = await api(
      "POST",
      path(`assistant-runtime/sessions/${conversation.session.id}/messages`),
      {
        submissionId: "submission_" + randomUUID(),
        expectedRevision: conversation.session.revision,
        text: "仅查看选中的两条",
        context: fixed.source,
        contextRevision: "0".repeat(64),
      },
    );
    expect(invalidRevision.statusCode).toBe(409);
    await db.query(
      "UPDATE source_record SET parse_status='invalid' WHERE parsed_view_id=(SELECT id FROM parsed_view WHERE asset_id=$1 AND is_current) AND ordinal=3",
      [assetId],
    );
    try {
      const staleSelection = await api(
        "POST",
        path(`assistant-runtime/sessions/${conversation.session.id}/messages`),
        {
          submissionId: "submission_" + randomUUID(),
          expectedRevision: conversation.session.revision,
          text: "查看选中的两条",
          context: fixed.source,
          contextRevision: fixed.sourceRevision,
        },
      );
      expect(staleSelection.statusCode, staleSelection.body).toBe(409);
      expect(staleSelection.json().error.code).toBe("source_revision_conflict");
    } finally {
      await db.query(
        "UPDATE source_record SET parse_status='valid' WHERE parsed_view_id=(SELECT id FROM parsed_view WHERE asset_id=$1 AND is_current) AND ordinal=3",
        [assetId],
      );
    }

    await db.query(
      "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
      [projectId, actors.get("viewer")],
    );
    expect(
      (
        await api(
          "POST",
          endpoint,
          {
            collectionId,
            mode: "selected",
            records: [{ assetId, ordinal: 1 }],
          },
          "viewer",
        )
      ).statusCode,
    ).toBe(404);
    await db.query(
      "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer')",
      [projectId, actors.get("viewer")],
    );
  });
});
