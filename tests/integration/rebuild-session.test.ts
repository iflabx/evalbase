import { SessionDispatcher } from "../../src/assistant-rebuild/session-dispatcher.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { WorkspaceStore } from "../../src/assistant-rebuild/workspace-store.js";
import { sendFormalCompletion } from "../support/formal-completion.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import {
  FormalSessionHost,
  type ModelAttempt,
  type ModelOutcome,
} from "../../src/assistant-rebuild/session-host.js";
import { sessionTools } from "../../src/assistant-rebuild/session-tools.js";
import { rebuildSchema } from "../../src/assistant-rebuild/schema.js";
vi.mock("../../src/assistant/agent.js", () => ({
  executeAssistantTurn: () => {
    throw Error("legacy_dispatch_disabled");
  },
}));
const origin = "http://127.0.0.1:4217",
  base = loadConfig(),
  databaseName = "formal_session_" + randomUUID().replaceAll("-", ""),
  databaseUrl = base.databaseUrl.replace(/\/[^/]+$/, "/" + databaseName);
const config = {
  ...base,
  databaseUrl,
  appOrigin: origin,
  soloOwnerMode: false,
  allowTestIdentity: false,
  modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
};
const db = createPool(databaseUrl),
  identities = new Map<string, Record<string, string>>(),
  actors = new Map<string, string>();
let app: AgentBenchApp,
  host: FormalSessionHost,
  projectId: string,
  otherProject: string,
  assetId: string,
  provider: Server;
let outputs: any[] = [],
  omitUsage = false;
const requests: any[] = [];
const route = (id?: string) =>
  "/api/projects/" +
  projectId +
  "/assistant-runtime/sessions" +
  (id ? "/" + id : "");
const scope = (actor = "admin") => ({ projectId, actorId: actors.get(actor)! });
const call = (name: string, args: unknown, id = "call_" + randomUUID()) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id,
      type: "function",
      function: {
        name:
          name === "update_requirements" &&
          args &&
          typeof args === "object" &&
          (args as any).expectedRevision === 0 &&
          (args as any).changes?.deliveries?.some((d: any) => !d.deliveryId)
            ? "create_requirements"
            : name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    },
  ],
});
async function api(
  method: any,
  url: string,
  payload?: unknown,
  actor = "admin",
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...identities.get(actor),
      "idempotency-key": randomUUID(),
    },
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
}
async function fresh(actor = "admin") {
  const response = await api("POST", route(), {}, actor);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().session.id as string;
}
async function submit(
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
  actor = "admin",
) {
  const state = await host.store.get(scope(actor), id);
  return api(
    "POST",
    route(id) + "/messages",
    {
      submissionId: "submission_" + randomUUID(),
      expectedRevision: state.revision,
      text,
      ...extra,
    },
    actor,
  );
}
async function run(
  id: string,
  text: string,
  replies: any[],
  options: {
    summaryTokens?: number;
    hooks?: {
      beforeRequest: (a: ModelAttempt) => Promise<void>;
      afterResponse: (o: ModelOutcome) => Promise<void>;
    };
  } = {},
) {
  outputs = [...replies];
  const accepted = await submit(id, text);
  expect(accepted.statusCode, accepted.body).toBe(202);
  return host.runPending(scope(), id, accepted.json().turnId, options);
}
const wireText = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part: any) => part.text ?? "").join("");
const plan = (count = 400) => ({
  expectedRevision: 0,
  changes: {
    mode: "plan",
    objective: "两份测试集方案",
    deliveries: [
      { patch: { name: "第一份", operation: "generate", count } },
      { patch: { name: "第二份", operation: "generate", count: 2 } },
    ],
  },
});

// Compatibility for pre-v2 trusted fixtures; new identity tests exercise explicit model commands.
const changeRequirements = (proof: any, input: any) =>
  host.store.change(
    proof,
    input,
    input.changes?.deliveries?.some((d: any) => !d.deliveryId)
      ? "create"
      : "update",
  );
async function effects() {
  return (
    await db.query(
      "SELECT (SELECT count(*) FROM collaborative_draft WHERE project_id=$1)::int AS drafts,(SELECT count(*) FROM processing_run WHERE project_id=$1)::int AS runs",
      [projectId],
    )
  ).rows[0];
}

describe("REBUILD-02 formal session and Deep Agents host", () => {
  beforeAll(async () => {
    const root = createPool(base.databaseUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    app = await buildApp(config, {
      disableLegacyTestBootstrap: true,
      disableAssistantRuntimeDispatch: true,
    });
    host = new FormalSessionHost(db, config);
    for (const who of ["admin", "editor", "viewer"]) {
      const payload = {
        email: who + "@r02.example.test",
        password: "Rebuild02Pass123",
        confirmPassword: "Rebuild02Pass123",
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
      identities.set(who, {
        cookie: login.cookies[0].name + "=" + login.cookies[0].value,
        "x-csrf-token": login.json().csrfToken,
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
    projectId = (
      await api("POST", "/api/projects", { name: "R02 synthetic" })
    ).json().project.id;
    otherProject = (
      await api("POST", "/api/projects", { name: "R02 other" })
    ).json().project.id;
    for (const who of ["editor", "viewer"])
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,$3)",
        [projectId, actors.get(who), who],
      );
    const collectionId = (
      await api("GET", "/api/projects/" + projectId + "/collections")
    ).json().collections[0].id;
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/pending-uploads",
      headers: {
        origin,
        ...identities.get("admin"),
        "content-type": "application/octet-stream",
        "x-file-name": "r02-source.jsonl",
      },
      payload:
        [1, 2, 3]
          .map((n) =>
            JSON.stringify({ question: " 问题" + n + " ", answer: "答案" + n }),
          )
          .join("\n") + "\n",
    });
    const confirmed = await api(
      "POST",
      "/api/projects/" + projectId + "/pending-upload-batches/confirm",
      {
        collectionId,
        pendingUploadIds: [uploaded.json().pendingUpload.id],
        mode: "raw",
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    assetId = confirmed.json().assets[0].id;
    const mapping = (
      await api(
        "GET",
        "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
      )
    ).json();
    expect(
      (
        await api(
          "PUT",
          "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
          {
            parsedViewId: mapping.parsedViewId,
            expectedRevision: 0,
            mapping: {
              question: "/question",
              expectedOutput: "/answer",
              metadata: [],
            },
          },
        )
      ).statusCode,
    ).toBe(200);
    provider = createServer(async (req, res) => {
      try {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        requests.push(body);
        const summary = !body.tools?.length;
        let message = summary
          ? {
              role: "assistant",
              content: "历史摘要：旧名称，数量2；以服务端当前要求为准。",
            }
          : (outputs.shift() ?? {
              role: "assistant",
              content: "已根据工具结果说明当前要求，未执行生成或业务保存。",
            });
        if (typeof message === "function") message = await message(body);
        if (message.httpStatus) {
          res.writeHead(message.httpStatus, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({
              error: { message: "synthetic provider unavailable" },
            }),
          );
          return;
        }
        await sendFormalCompletion(res, body, message, omitUsage);
      } catch (error) {
        console.error(error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid_test_request" } }));
      }
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    expect(
      (
        await api("PUT", "/api/settings/model-connection", {
          revision: 0,
          name: "R02 controlled model",
          endpoint:
            "http://127.0.0.1:" +
            (provider.address() as { port: number }).port +
            "/v1",
          model: "synthetic",
          apiKey: "synthetic-private-key",
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);
    await db.query(rebuildSchema);
    await db.query(
      "INSERT INTO rebuild_campaign(id,max_requests,max_rows,max_generated,max_minutes,requests,rows,generated,closed_at) VALUES('old-r02-sentinel',9,9,9,9,7,6,5,'2026-10-01T00:00:00Z')",
    );
  });
  afterAll(async () => {
    await host?.close();
    await app?.close();
    if (provider)
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    await db.end();
    const root = createPool(base.databaseUrl);
    try {
      await root.query(
        "DROP DATABASE IF EXISTS " + databaseName + " WITH(FORCE)",
      );
    } finally {
      await root.end();
    }
  });
  it("automatically dispatches current HTTP turns once while preserving legacy and paused work", async () => {
    const old = await fresh(),
      paused = await fresh(),
      current = await fresh();
    const oldTurn = await submit(old, "legacy must remain pending");
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='deepagents-v2' WHERE id=$1",
      [old],
    );
    const pausedTurn = await submit(paused, "do not resume without consent");
    await host.stop(scope(), paused);
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='deepagents-v1' WHERE id=$1",
      [paused],
    );
    const legacyWaiting = await fresh(),
      legacyConfirmation = await fresh();
    for (const [id, status] of [
      [legacyWaiting, "waiting"],
      [legacyConfirmation, "confirmation"],
    ]) {
      const accepted = await submit(id, "legacy recovery sentinel");
      await host.execution.claim(scope(), id, accepted.json().turnId);
      await db.query(
        "UPDATE assistant_runtime_execution SET status=$2,lease_until=now()-interval '1 second' WHERE session_id=$1",
        [id, status],
      );
      if (status === "confirmation")
        await db.query(
          "INSERT INTO assistant_runtime_confirmation(id,session_id,actor_id,action,payload,requirements_revision,status,expires_at) VALUES($1,$2,$3,'save','{}',0,'executing',now()+interval '1 hour')",
          ["legacy-card-" + id, id, scope().actorId],
        );
      await db.query(
        "UPDATE assistant_runtime_session SET runtime_version='deepagents-v2' WHERE id=$1",
        [id],
      );
    }
    const legacyIds = [old, paused, legacyWaiting, legacyConfirmation];
    const legacySnapshot = async () => ({
      execution: (
        await db.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=ANY($1::text[]) ORDER BY session_id",
          [legacyIds],
        )
      ).rows,
      cards: (
        await db.query(
          "SELECT * FROM assistant_runtime_confirmation WHERE session_id=ANY($1::text[]) ORDER BY id",
          [legacyIds],
        )
      ).rows,
    });
    const legacyBefore = await legacySnapshot();
    const before = (
      await db.query(
        "SELECT * FROM assistant_runtime_turn WHERE id=ANY($1::text[])",
        [[oldTurn.json().turnId, pausedTurn.json().turnId]],
      )
    ).rows;
    const budget = (
      await db.query(
        "SELECT * FROM rebuild_campaign WHERE id='old-r02-sentinel'",
      )
    ).rows;
    requests.length = 0;
    outputs = [
      async () => {
        await hostDispatch.dispatch();
        return call("read_project", {});
      },
      call("create_collection", {
        name: "R03 automatic " + current,
        description: "公开入口真实写入",
      }),
      { role: "assistant", content: "项目已读取，集合已创建" },
    ];
    const accepted = await submit(
      current,
      "查看当前项目并创建一个验收资料集合",
    );
    expect(accepted.statusCode).toBe(202);
    const worker = await buildApp(config, { disableLegacyTestBootstrap: true });
    const recoveryDispatch = new SessionDispatcher(
      host.execution,
      host.runPending.bind(host),
    );
    const hostDispatch = new SessionDispatcher(
      host.execution,
      host.runPending.bind(host),
    );
    try {
      await worker.ready();
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT status FROM assistant_runtime_turn WHERE id=$1",
                [accepted.json().turnId],
              )
            ).rows[0].status,
          { timeout: 10000 },
        )
        .toBe("succeeded");
      await hostDispatch.dispatch();
      expect(requests).toHaveLength(3);
      const receipts = (
        await db.query(
          "SELECT turn_id,operation_key,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='material_receipt'",
          [current],
        )
      ).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].turn_id).toBe(accepted.json().turnId);
      expect(receipts[0].operation_key).toBeTruthy();
      expect(receipts[0].detail.name).toBe("create_collection");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM raw_material_collection WHERE project_id=$1 AND name=$2",
            [projectId, "R03 automatic " + current],
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await host.present(scope(), current)).workspace).toBeDefined();
      await worker.close();

      const recovery = await fresh(),
        retry = await submit(recovery, "查看当前项目");
      await host.execution.claim(scope(), recovery, retry.json().turnId);
      await db.query(
        "UPDATE assistant_runtime_execution SET lease_until=now()-interval '1 second' WHERE session_id=$1",
        [recovery],
      );
      recoveryDispatch.start();
      outputs = [
        call("read_project", {}),
        { role: "assistant", content: "恢复后已读取" },
      ];
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT status FROM assistant_runtime_turn WHERE id=$1",
                [retry.json().turnId],
              )
            ).rows[0].status,
          { timeout: 10000 },
        )
        .toBe("succeeded");
      expect(requests).toHaveLength(5);
      await recoveryDispatch.close();
      expect(await legacySnapshot()).toEqual(legacyBefore);
      expect(
        (
          await db.query(
            "SELECT * FROM assistant_runtime_turn WHERE id=ANY($1::text[]) ORDER BY id",
            [[oldTurn.json().turnId, pausedTurn.json().turnId]],
          )
        ).rows,
      ).toEqual([...before].sort((a, b) => a.id.localeCompare(b.id)));
      expect(
        (
          await db.query(
            "SELECT * FROM rebuild_campaign WHERE id='old-r02-sentinel'",
          )
        ).rows,
      ).toEqual(budget);
    } finally {
      await recoveryDispatch.close();
      await hostDispatch.close();
      await worker.close();
    }
  });
  it("migrates additively without campaigns and preserves old budgets on repeat", async () => {
    const before = (
      await db.query(
        "SELECT * FROM rebuild_campaign WHERE id='old-r02-sentinel'",
      )
    ).rows[0];
    await migrate(databaseUrl);
    expect(
      (
        await db.query(
          "SELECT * FROM rebuild_campaign WHERE id='old-r02-sentinel'",
        )
      ).rows[0],
    ).toEqual(before);
    expect(
      (await db.query("SELECT count(*)::int AS n FROM rebuild_session")).rows[0]
        .n,
    ).toBe(0);
    const id = await fresh();
    expect((await api("GET", route(id))).json().session.runtime_version).toBe(
      "deepagents-v3",
    );
    expect(process.env.REBUILD_VALIDATION_CAMPAIGN_ID).toBeUndefined();
  });
  it("atomically accepts messages and replays before busy or advanced-revision checks", async () => {
    const id = await fresh(),
      payload = {
        submissionId: "submission_" + randomUUID(),
        expectedRevision: 1,
        text: "读取项目名称",
      };
    const first = await api("POST", route(id) + "/messages", payload);
    expect(first.statusCode).toBe(202);
    expect(
      (await api("POST", route(id) + "/messages", payload)).json(),
    ).toMatchObject({ ...first.json(), replayed: true });
    expect(
      (
        await api("POST", route(id) + "/messages", {
          ...payload,
          text: "不同内容",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await api("POST", route(id) + "/messages", {
          ...payload,
          submissionId: "submission_" + randomUUID(),
        })
      ).json().error.code,
    ).toBe("conversation_busy");
    const proof = await host.store.claim(scope(), id, first.json().turnId);
    await changeRequirements(proof, plan());
    await host.store.finish(proof, "已记录");
    const replay = await api("POST", route(id) + "/messages", payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().turnId).toBe(first.json().turnId);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM assistant_runtime_message WHERE session_id=$1 AND role='user'",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("serializes two-tab acceptance and does not deduplicate a later explicit same-text request", async () => {
    const id = await fresh(),
      payload = { expectedRevision: 1, text: "同样的问题" };
    const results = await Promise.all(
      [1, 2].map(() =>
        api("POST", route(id) + "/messages", {
          ...payload,
          submissionId: "submission_" + randomUUID(),
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const accepted = results.find((r) => r.statusCode === 202)!;
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM assistant_runtime_turn WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    const proof = await host.store.claim(scope(), id, accepted.json().turnId);
    await host.store.finish(proof, "回答");
    expect((await submit(id, payload.text)).statusCode).toBe(202);
  });
  it("rolls back submission, message and busy state together on precommit failure", async () => {
    const id = await fresh(),
      payload = {
        submissionId: "submission_" + randomUUID(),
        expectedRevision: 1,
        text: "故障后重试",
      };
    await db.query(
      "CREATE FUNCTION fail_r02_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fault'; END $$; CREATE TRIGGER fail_r02_message BEFORE INSERT ON assistant_runtime_message FOR EACH ROW EXECUTE FUNCTION fail_r02_message()",
    );
    try {
      expect(
        (await api("POST", route(id) + "/messages", payload)).statusCode,
      ).toBe(500);
    } finally {
      await db.query(
        "DROP TRIGGER fail_r02_message ON assistant_runtime_message; DROP FUNCTION fail_r02_message()",
      );
    }
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM assistant_runtime_turn WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await host.store.get(scope(), id)).toMatchObject({
      status: "idle",
      revision: 1,
    });
    expect(
      (await api("POST", route(id) + "/messages", payload)).statusCode,
    ).toBe(202);
  });
  it("keeps an accepted pending turn recoverable before dispatch and claims it once", async () => {
    const id = await fresh(),
      accepted = await submit(id, "稍后读取");
    expect(accepted.statusCode).toBe(202);
    const turnId = accepted.json().turnId;
    const replacement = new FormalSessionHost(db, config);
    try {
      const outcomes = await Promise.allSettled([
        replacement.store.claim(scope(), id, turnId),
        host.store.claim(scope(), id, turnId),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const proof = (
        outcomes.find(
          (r) => r.status === "fulfilled",
        ) as PromiseFulfilledResult<any>
      ).value;
      await replacement.store.finish(proof, "完成");
    } finally {
      await replacement.close();
    }
  });
  it("binds private sessions and submission identities to their real actor and project", async () => {
    const id = await fresh("editor");
    expect((await api("GET", route(id), undefined, "admin")).statusCode).toBe(
      404,
    );
    expect(
      (
        await api(
          "GET",
          route(id).replace(projectId, otherProject),
          undefined,
          "editor",
        )
      ).statusCode,
    ).toBe(404);
    const submissionId = "submission_" + randomUUID();
    expect(
      (await submit(id, "原消息", { submissionId }, "editor")).statusCode,
    ).toBe(202);
    const other = await fresh("editor");
    expect(
      (await submit(other, "原消息", { submissionId }, "editor")).statusCode,
    ).toBe(409);
    await db.query(
      "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
      [projectId, actors.get("editor")],
    );
    expect((await api("GET", route(id), undefined, "editor")).statusCode).toBe(
      404,
    );
    await db.query(
      "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'editor')",
      [projectId, actors.get("editor")],
    );
  });
  it("runs an ordinary real SDK query without creating a plan or calling legacy execution", async () => {
    const id = await fresh(),
      before = await effects(),
      start = requests.length;
    const state = await run(id, "当前项目叫什么？", [call("read_project", {})]);
    expect(state.session.requirements.deliveries).toEqual([]);
    expect(await effects()).toEqual(before);
    const observed = requests.slice(start);
    expect(
      observed.some((r) =>
        r.messages.some(
          (m: any) => m.role === "tool" && m.content.includes("R02 synthetic"),
        ),
      ),
    ).toBe(true);
    const allowed = [
      "create_collection",
      "create_project",
      "list_attachments",
      "list_collections",
      "list_material_files",
      "list_pending_uploads",
      "list_projects",
      "move_material_file",
      "navigate_project",
      "open_material_mapping",
      "open_material_upload",
      "read_material_raw",
      "read_material_record",
      "read_material_records",
      "read_project_access",
      "create_requirements",
      "read_project",
      "list_sources",
      "read_records",
      "update_requirements",
      "read_attachment",
      "submit_processing",
      "prepare_adoption",
      "wait_processing",
      "wait_confirmation",
      "read_task_progress",
      "continue_task",
    ];
    for (const req of observed)
      expect(req.tools.map((t: any) => t.function.name).sort()).toEqual(
        [...allowed].sort(),
      );
  });
  it("persists multiple stable delivery identities, partial edits and cancellation without creating business assets", async () => {
    const id = await fresh(),
      before = await effects();
    let state = await run(id, "两份各400和2条，先给方案，不执行", [
      call("update_requirements", plan()),
    ]);
    const [a, b] = state.session.requirements.deliveries;
    expect(a.count).toBe(400);
    expect(a.id).not.toBe(b.id);
    state = await run(id, "第一份改成3条并改名，第二份不要了", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            { deliveryId: a.id, patch: { count: 3, name: "新版" } },
            { deliveryId: b.id, patch: { status: "cancelled" } },
          ],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries).toEqual([
      expect.objectContaining({
        id: a.id,
        count: 3,
        name: "新版",
        operation: "generate",
      }),
      expect.objectContaining({ id: b.id, count: 2, status: "cancelled" }),
    ]);
    expect((await api("GET", route(id))).json().session.requirements).toEqual(
      state.session.requirements,
    );
    expect(await effects()).toEqual(before);
    const old = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='requirements_saved' ORDER BY id",
        [id],
      )
    ).rows[0].detail;
    expect(old.receipt.requirements.deliveries[0].count).toBe(400);
  });
  it("R02-9 preserves a fixed source, classification and save target during field-only amendment", async () => {
    const id = await fresh(),
      source = { kind: "assets", assetIds: [assetId] };
    const initial = {
      expectedRevision: 0,
      changes: {
        mode: "plan",
        deliveries: [
          {
            patch: {
              name: "清洗",
              operation: "clean",
              source,
              count: 3,
              allowedFields: ["question"],
              instructions: "整理空白",
              classifications: [],
              saveTarget: { kind: "newDraft", name: "整理版" },
            },
          },
        ],
      },
    };
    let state = await run(id, "清洗全部三条，先给方案", [
      call("update_requirements", initial),
    ]);
    const old = state.session.requirements.deliveries[0];
    expect(old.source!.recordIds).toHaveLength(3);
    state = await run(id, "只去问题首尾空白，期望输出和Metadata不变", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            {
              deliveryId: old.id,
              patch: {
                allowedFields: ["question"],
                instructions: "仅整理问题首尾空白",
              },
            },
          ],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries[0]).toEqual({
      ...old,
      instructions: "仅整理问题首尾空白",
    });
    expect(await effects()).toEqual({ drafts: 0, runs: 0 });
  });
  it("does not increment requirements revision for an unchanged amendment and replays its receipt", async () => {
    const id = await fresh(),
      accepted = await submit(id, "方案");
    const proof = await host.store.claim(scope(), id, accepted.json().turnId);
    const first = await changeRequirements(proof, plan());
    expect(await changeRequirements(proof, plan())).toEqual(first);
    const noChange = await changeRequirements(proof, {
      expectedRevision: 1,
      changes: { mode: "plan" },
    });
    expect(noChange.unchanged).toBe(true);
    expect(noChange.revision).toBe(1);
    await expect(
      changeRequirements(proof, {
        expectedRevision: 0,
        changes: { objective: "不能覆盖" },
      }),
    ).rejects.toMatchObject({ code: "requirements_revision_conflict" });
    await host.store.finish(proof, "记录完成");
  });
  it.each(["wrong-type", "unknown-field"])(
    "normalizes or corrects %s through the actual SDK",
    async (kind) => {
      const id = await fresh(),
        valid = plan(50),
        broken = structuredClone(valid) as any;
      if (kind === "wrong-type")
        broken.changes.deliveries[0].patch.count = "50";
      else broken.steps = [];
      const state = await run(id, "两份方案", [
        call("update_requirements", broken, "original-call"),
        ...(kind === "unknown-field"
          ? [call("update_requirements", valid, "corrected-call")]
          : []),
      ]);
      expect(state.session.requirements.deliveries[0].count).toBe(50);
      const events = (
        await db.query(
          "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
          [id],
        )
      ).rows;
      if (kind === "wrong-type") {
        expect(events.some((e) => e.kind === "parameter_normalized")).toBe(
          true,
        );
        expect(
          events.filter((e) => e.kind === "parameter_feedback"),
        ).toHaveLength(0);
      } else {
        expect(
          events.find((e) => e.kind === "parameter_feedback").detail
            .originalCallId,
        ).toBe("original-call");
        expect(
          events.some(
            (e) =>
              e.kind === "model_request" && e.detail.purpose === "correction",
          ),
        ).toBe(true);
      }
    },
  );

  it.each([false, true])(
    "NESTED root closure and omitted valid fields through SDK (%s)",
    async (correction) => {
      const id = await fresh(),
        fixed = await host.store.freezeSource(scope(), {
          kind: "assets",
          assetIds: [assetId],
        });
      const changes = {
        mode: "plan",
        objective: "问法自然，答案和标签保持",
        deliveries: [
          {
            patch: {
              name: "自然问法",
              operation: "rewrite",
              count: 3,
              source: fixed.source,
              allowedFields: ["question"],
              instructions: "保持原意，问法自然",
              saveTarget: { kind: "newDraft", name: "自然问法" },
            },
          },
        ],
      };
      const first = {
        expectedRevision: 0,
        changes: JSON.stringify(changes).slice(0, -1),
        ...(correction ? { steps: [] } : {}),
      };
      const state = await run(id, "先给前三条改写方案，不执行", [
        { ...call("create_requirements", first), toolArgumentChunkSize: 1 },
        ...(correction
          ? [
              call("create_requirements", {
                expectedRevision: 0,
                changes: { mode: "plan", deliveries: changes.deliveries },
              }),
            ]
          : []),
      ]);
      expect(state.session.requirements.objective).toBe(changes.objective);
      expect(state.session.requirements.deliveries).toHaveLength(1);
      expect(state.session.requirements.deliveries[0].source).toEqual(
        fixed.source,
      );
      expect(state.session.requirements.deliveries[0].count).toBe(3);
      expect(await effects()).toEqual({ drafts: 0, runs: 0 });
    },
  );
  it("NESTED unrecoverable structures stop without a correction request", async () => {
    const id = await fresh();
    await expect(
      run(id, "先给方案", [
        call("create_requirements", {
          expectedRevision: 0,
          changes: '{"mode":"pla',
        }),
      ]),
    ).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    const rows = (
      await db.query(
        "SELECT count(*)::int n FROM assistant_runtime_request WHERE session_id=$1 AND purpose='correction'",
        [id],
      )
    ).rows;
    expect(rows[0].n).toBe(0);
    expect(await effects()).toEqual({ drafts: 0, runs: 0 });
  });
  it("C01 captured wrapper and encoded source normalize before the SDK tool executes", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      });
    const state = await run(id, "先给前三条清洗方案，不执行", [
      {
        ...call(
          "update_requirements",
          {
            expectedRevision: 0,
            changes: {
              mode: "plan",
              objective: "前三条清洗，仅方案",
              deliveries: [
                {
                  name: "  三条整理版  ",
                  count: "3",
                  operation: "clean",
                  source: JSON.stringify(fixed.source),
                  allowedFields: ["question"],
                  instructions: "",
                  saveTarget: { kind: "newDraft", name: "三条整理版" },
                },
              ],
            },
          },
          "flat-c01",
        ),
        toolArgumentChunkSize: 2,
      },
    ]);
    expect(state.session.requirements.objective).toBe("前三条清洗，仅方案");
    const d = state.session.requirements.deliveries[0];
    expect(d.count).toBe(3);
    expect(d.name).toBe("三条整理版");
    expect(d.source).toEqual(fixed.source);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_event WHERE session_id=$1 AND kind='parameter_feedback'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await effects()).toEqual({ drafts: 0, runs: 0 });
  });
  it("C02 actual SDK repair retains omitted goal and unchanged fields from the first canonical invocation", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      });
    const first = {
      expectedRevision: 0,
      steps: [],
      changes: {
        mode: "plan",
        objective: "改写前三条，标签和Metadata不变",
        deliveries: [
          {
            operation: "rewrite",
            count: 3,
            source: fixed.source,
            allowedFields: ["question"],
            instructions: "保持原意，问法自然",
            saveTarget: { kind: "newDraft", name: "自然问法" },
          },
        ],
      },
    };
    const state = await run(id, "先保存改写要求", [
      call("update_requirements", first, "flat-c02"),
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "create_requirements",
        ]);
        expect(wireText(body.messages[0])).toContain("workingArguments");
        return {
          ...call(
            "update_requirements",
            {
              expectedRevision: 0,
              changes: { deliveries: [{ patch: { count: 3 } }] },
            },
            "partial-c02",
          ),
          toolArgumentChunkSize: 1,
        };
      },
    ]);
    expect(state.session.requirements.objective).toBe(first.changes.objective);
    const d = state.session.requirements.deliveries[0];
    expect(d.source).toEqual(fixed.source);
    expect(d.instructions).toBe(first.changes.deliveries[0].instructions);
    expect(d.saveTarget).toMatchObject({ kind: "newDraft", name: "自然问法" });
    expect(d.allowedFields).toEqual(["question"]);
    expect(
      (
        await db.query(
          "SELECT feedback FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0].feedback,
    ).toBeNull();
  });
  it("classifies a business quota conflict without spending a second SDK correction request", async () => {
    const id = await fresh(),
      start = requests.length;
    await expect(
      run(id, "三条方案", [
        call("update_requirements", {
          expectedRevision: 0,
          changes: {
            deliveries: [
              {
                patch: {
                  name: "配额",
                  count: 3,
                  classifications: [
                    {
                      field: "expectedOutput",
                      allowedValues: ["a", "b"],
                      quotas: [
                        { value: "a", count: 2 },
                        { value: "b", count: 2 },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: "assistant_plan_count_conflict" });
    expect(requests.length - start).toBe(1);
    const state = await host.present(scope(), id);
    expect(state.messages.at(-1).content).toContain("配额合计4");
    expect(state.session.requirements.deliveries).toEqual([]);
  });

  it("rejects duplicate invocation IDs from the real SDK with zero requirement writes", async () => {
    const id = await fresh(),
      batch = call("update_requirements", plan(), "duplicate");
    batch.tool_calls.push(
      call("update_requirements", plan(51), "duplicate").tool_calls[0],
    );
    await expect(run(id, "先给方案", [batch])).rejects.toMatchObject({
      code: "tool_call_identity_conflict",
    });
    expect((await host.store.get(scope(), id)).requirements.deliveries).toEqual(
      [],
    );
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_event WHERE session_id=$1 AND kind='tool_call'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("repairs a mixed batch with an unknown field before any SDK mutation", async () => {
    const id = await fresh(),
      broken = { ...plan(3), steps: [] },
      batch = call("update_requirements", broken, "batch-first");
    batch.tool_calls.push(
      call("read_project", {}, "batch-second").tool_calls[0],
    );
    const state = await run(id, "先给方案", [
      batch,
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "create_requirements",
        ]);
        return call("update_requirements", plan(3));
      },
    ]);
    expect(state.session.requirements.deliveries).toHaveLength(2);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "requirements_saved")).toHaveLength(
      1,
    );
    expect(
      events.some(
        (e) => e.kind === "tool_call" && e.detail.name === "read_project",
      ),
    ).toBe(false);
  });

  it("recovers a truncated read-only progress call through the actual SDK", async () => {
    const id = await fresh();
    await run(id, "看看进度", [
      call("read_task_progress", "{", "truncated-progress"),
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "read_task_progress",
        ]);
        expect(body.tool_choice.function.name).toBe("read_task_progress");
        return call("read_task_progress", {});
      },
    ]);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(
      events.filter((e) => e.kind === "tool_call").map((e) => e.detail.name),
    ).toEqual(["read_task_progress"]);
    expect(await effects()).toEqual({ drafts: 0, runs: 0 });
  });

  it("normalizes JSON object strings through SDK without a correction request or changed scope", async () => {
    const id = await fresh(),
      start = requests.length;
    await run(id, "读取前三条", [
      {
        ...call(
          "read_records",
          {
            source: JSON.stringify({ kind: "assets", assetIds: [assetId] }),
            offset: 0,
            limit: 3,
          },
          "encoded-source",
        ),
        toolArgumentChunkSize: 3,
      },
      { role: "assistant", content: "已读取三条，未处理或保存。" },
    ]);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "parameter_feedback")).toHaveLength(
      0,
    );
    expect(
      events.find((e) => e.kind === "parameter_normalized")?.detail.paths,
    ).toEqual([["source"]]);
    expect(events.find((e) => e.kind === "tool_call")?.detail.args).toEqual({
      source: { kind: "assets", assetIds: [assetId] },
      offset: 0,
      limit: 3,
    });
    expect(requests.slice(start)).toHaveLength(2);
    expect(await effects()).toEqual({ drafts: 0, runs: 0 });
  });
  it("binds SDK correction to its original tool, schema and invalid fields, then restores tools", async () => {
    const id = await fresh();
    await run(id, "读取前三条", [
      call(
        "read_records",
        {
          source: JSON.stringify({ kind: "assets", assetIds: [assetId] }),
          offset: 0,
          limit: 3,
          extra: true,
        },
        "locked-read",
      ),
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "read_records",
        ]);
        expect(body.tool_choice).toEqual({
          type: "function",
          function: { name: "read_records" },
        });
        expect(wireText(body.messages[0])).toContain(
          '"originalCallId":"locked-read"',
        );
        expect(wireText(body.messages[0])).toContain(
          '"invalidPaths":[["extra"]]',
        );
        return {
          ...call(
            "read_records",
            {
              source: { kind: "assets", assetIds: [assetId] },
              offset: 0,
              limit: 3,
            },
            "fixed-read",
          ),
          toolArgumentChunkSize: 1,
        };
      },
      (body: any) => {
        expect(body.tools.length).toBeGreaterThan(1);
        expect(body.tool_choice).not.toEqual({
          type: "function",
          function: { name: "read_records" },
        });
        return { role: "assistant", content: "已读取，未处理。" };
      },
    ]);
    expect(await effects()).toEqual({ drafts: 0, runs: 0 });
  });
  it("retains truncated invocation identity in the actual SDK correction request", async () => {
    const id = await fresh();
    await run(id, "先看项目", [
      {
        ...call("read_project", "{", "truncated-project"),
        toolArgumentChunkSize: 1,
      },
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "read_project",
        ]);
        expect(body.tool_choice).toEqual({
          type: "function",
          function: { name: "read_project" },
        });
        expect(wireText(body.messages[0])).toContain('"name":"read_project"');
        expect(
          body.messages.some(
            (m: any) =>
              m.role === "user" && wireText(m).includes("read_project"),
          ),
        ).toBe(true);
        return call("read_project", {}, "fixed-project");
      },
      { role: "assistant", content: "项目已读取。" },
    ]);
    const pending = (
      await db.query(
        "SELECT feedback FROM assistant_runtime_execution WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    expect(pending.feedback).toBeNull();
  });

  it("does not invent a missing original source during SDK correction", async () => {
    const id = await fresh();
    await expect(
      run(id, "读资料", [
        call(
          "read_records",
          { source: { kind: "assets" }, offset: 0, limit: 1 },
          "missing-source",
        ),
        call(
          "read_records",
          {
            source: { kind: "assets", assetIds: [assetId] },
            offset: 0,
            limit: 1,
          },
          "guessed-source",
        ),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1",
        [id],
      )
    ).rows;
    expect(events.some((e) => e.kind === "source_read")).toBe(false);
    expect(
      events.find((e) => e.kind === "correction_rejected").detail.changedPaths,
    ).toContainEqual(["source", "assetIds"]);
  });
  it("preserves the original semantic snapshot if an SDK correction is itself truncated", async () => {
    const id = await fresh(),
      valid = plan(50),
      broken = structuredClone(valid) as any;
    broken.changes.deliveries[0].patch.count = "50";
    broken.steps = [];
    await run(id, "两份方案", [
      call("update_requirements", broken, "first-readable"),
      {
        ...call(
          "create_requirements",
          '{"expectedRevision":0,"changes":',
          "truncated-correction",
        ),
        toolArgumentChunkSize: 2,
      },
      (body: any) => {
        const context = wireText(body.messages[0]);
        expect(context).toContain('"originalCallId":"first-readable"');
        expect(context).toContain('"count":50');
        expect(context).toContain('"unparsed":false');
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "create_requirements",
        ]);
        return call("update_requirements", valid, "second-correction");
      },
    ]).catch(async (error) => {
      console.error(
        JSON.stringify(
          (
            await db.query(
              "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind IN ('parameter_feedback','correction_rejected') ORDER BY id",
              [id],
            )
          ).rows,
        ),
      );
      throw error;
    });
    expect(
      (await host.store.get(scope(), id)).requirements.deliveries[0].count,
    ).toBe(50);
    const events = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='parameter_feedback' ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.map((e) => e.detail.originalCallId)).toEqual([
      "first-readable",
      "first-readable",
    ]);
  });

  it("rejects semantic source/count/save-target changes disguised as correction", async () => {
    const id = await fresh(),
      bad = plan(50) as any;
    bad.steps = [];
    const changed = plan(51);
    await expect(
      run(id, "两份方案", [
        call("update_requirements", bad),
        call("update_requirements", changed),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    expect((await host.store.get(scope(), id)).requirements.deliveries).toEqual(
      [],
    );
  });
  it("bounds repeated invalid parameters and refuses an oral-success substitute", async () => {
    const id = await fresh();
    const invalid = { ...plan(), expectedRevision: "wrong" };
    await expect(
      run(id, "先给方案", [
        call("update_requirements", invalid),
        call("update_requirements", invalid),
        call("update_requirements", invalid),
      ]),
    ).rejects.toMatchObject({ code: "parameter_correction_exhausted" });
    expect((await host.store.get(scope(), id)).status).toBe("idle");
    const second = await fresh();
    await expect(
      run(second, "先给方案", [
        call("update_requirements", invalid),
        { role: "assistant", content: "保存成功" },
      ]),
    ).rejects.toMatchObject({ code: "parameter_correction_incomplete" });
    expect(
      (await host.store.get(scope(), second)).requirements.deliveries,
    ).toEqual([]);
  });
  it("repairs truncated read-only JSON but fails closed for unparseable mutations", async () => {
    const id = await fresh();
    await run(id, "读取项目", [
      call("read_project", "{"),
      call("read_project", {}),
    ]);
    const second = await fresh();
    await expect(
      run(second, "给方案", [
        call("update_requirements", '{"expectedRevision":0,"changes":'),
        call("update_requirements", plan()),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    expect(
      (await host.store.get(scope(), second)).requirements.deliveries,
    ).toEqual([]);
  });
  it("rejects unavailable tools and forged delivery IDs without invoking a wider runtime", async () => {
    const id = await fresh();
    await expect(
      run(id, "执行命令", [call("execute", { command: "touch never" })]),
    ).rejects.toMatchObject({ code: "tool_not_allowed" });
    const second = await fresh();
    await expect(
      run(second, "改第二份", [
        call("update_requirements", {
          expectedRevision: 0,
          changes: {
            deliveries: [{ deliveryId: "forged", patch: { name: "恶意" } }],
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: "delivery_not_found" });
    expect(
      (await host.store.get(scope(), second)).requirements.deliveries,
    ).toEqual([]);
  });
  it("meters actual summary/correction/ordinary HTTP attempts and marks unknown usage", async () => {
    const id = await fresh(),
      attempts: ModelAttempt[] = [],
      outcomes: ModelOutcome[] = [];
    const hooks = {
      beforeRequest: async (a: ModelAttempt) => {
        attempts.push(a);
      },
      afterResponse: async (o: ModelOutcome) => {
        outcomes.push(o);
      },
    };
    await run(
      id,
      "先记录400条方案。" + "合成历史。".repeat(700),
      [call("update_requirements", plan())],
      { summaryTokens: 100, hooks },
    );
    const state = await run(
      id,
      "改为50条，新名称。" + "当前要求。".repeat(700),
      [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId: (await host.store.get(scope(), id)).requirements
                  .deliveries[0].id,
                patch: { count: 50, name: "新名称" },
              },
            ],
          },
        }),
      ],
      { summaryTokens: 100, hooks },
    );
    expect(attempts.some((a) => a.purpose === "summary")).toBe(true);
    expect(outcomes).toHaveLength(attempts.length);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      count: 50,
      name: "新名称",
    });
    const known = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='model_request'",
        [id],
      )
    ).rows;
    expect(known).toHaveLength(attempts.length);
    const lastRequests = requests.filter((r) => r.tools?.length).at(-1);
    expect(lastRequests.messages[0].role).toBe("system");
    const currentSystem = lastRequests.messages[0].content;
    const systemText =
      typeof currentSystem === "string"
        ? currentSystem
        : currentSystem
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join("\n");
    expect(systemText).toContain('"count":50');
    expect(systemText).toContain("当前服务端事实");
    expect(
      lastRequests.messages.slice(1).some((m: any) => m.role === "system"),
    ).toBe(false);
    omitUsage = true;
    try {
      await run(id, "只解释当前状态", [], { hooks });
    } finally {
      omitUsage = false;
    }
    expect(outcomes.at(-1)?.usage).toBeNull();
    expect(JSON.stringify((await api("GET", route(id))).json())).not.toContain(
      "synthetic-private-key",
    );
  });
  it("rejects caller authority, invalid selected records and text-changing submission replay", async () => {
    const id = await fresh();
    expect((await submit(id, "读项目", { token: "forged" })).statusCode).toBe(
      422,
    );
    expect(
      (
        await submit(id, "读选中的记录", {
          context: {
            kind: "assets",
            assetIds: [assetId],
            recordIds: [assetId + ":999"],
          },
        })
      ).statusCode,
    ).toBe(422);
    const payload = {
      submissionId: "submission_" + randomUUID(),
      expectedRevision: 1,
      text: "  原始文字  ",
    };
    expect(
      (await api("POST", route(id) + "/messages", payload)).statusCode,
    ).toBe(202);
    expect(
      (
        await api("POST", route(id) + "/messages", {
          ...payload,
          text: payload.text.trim(),
        })
      ).statusCode,
    ).toBe(409);
  });
  it("returns actual directory/record data and enforces viewer-only tool permissions", async () => {
    const id = await fresh();
    const start = requests.length;
    await run(id, "列出资料，再看第一条", [
      call("list_sources", { kind: "assets" }),
      call("read_records", {
        source: {
          kind: "assets",
          assetIds: [assetId],
          recordIds: [assetId + ":1"],
        },
        limit: 1,
      }),
    ]);
    expect(
      requests
        .slice(start)
        .some((r) =>
          r.messages.some(
            (m: any) => m.role === "tool" && m.content.includes("问题1"),
          ),
        ),
    ).toBe(true);
    const viewer = await fresh("viewer"),
      accepted = await submit(viewer, "项目名", {}, "viewer");
    outputs = [call("read_project", {})];
    const viewerStart = requests.length;
    await host.runPending(scope("viewer"), viewer, accepted.json().turnId);
    expect(
      requests
        .slice(viewerStart)
        .every(
          (r) =>
            !r.tools?.some(
              (t: any) => t.function.name === "update_requirements",
            ),
        ),
    ).toBe(true);
    expect(
      (await api("GET", route(viewer), undefined, "viewer")).json()
        .capabilities,
    ).not.toContain("update_requirements");
  });
  it("rejects changing an invalid numeric representation to a different quantity during correction", async () => {
    const id = await fresh(),
      bad = plan(50) as any;
    bad.changes.deliveries[0].patch.count = "50";
    bad.steps = [];
    await expect(
      run(id, "第一份50条", [
        call("update_requirements", bad),
        call("update_requirements", plan(51)),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    expect((await host.store.get(scope(), id)).requirements.deliveries).toEqual(
      [],
    );
  });
  it("revocation during a provider request prevents late requirement writes and terminates the turn", async () => {
    const id = await fresh("editor"),
      accepted = await submit(id, "给我方案", {}, "editor");
    outputs = [
      async () => {
        await db.query(
          "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
          [projectId, actors.get("editor")],
        );
        return call("update_requirements", plan());
      },
    ];
    try {
      await expect(
        host.runPending(scope("editor"), id, accepted.json().turnId),
      ).rejects.toBeDefined();
      const row = (
        await db.query(
          "SELECT status,error_code FROM assistant_runtime_turn WHERE id=$1",
          [accepted.json().turnId],
        )
      ).rows[0];
      expect(row.status).toBe("failed");
      expect(
        (
          await db.query(
            "SELECT requirements FROM assistant_runtime_session WHERE id=$1",
            [id],
          )
        ).rows[0].requirements.deliveries,
      ).toEqual([]);
    } finally {
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'editor') ON CONFLICT DO NOTHING",
        [projectId, actors.get("editor")],
      );
    }
  });
  it("rejects stale runner/checkpoint identities and multiple simultaneous requirement mutations", async () => {
    const id = await fresh(),
      accepted = await submit(id, "一份方案"),
      proof = await host.store.claim(scope(), id, accepted.json().turnId);
    await expect(
      changeRequirements({ ...proof, token: "forged" }, plan()),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    await host.store.finish(proof, "无需更改");
    await expect(changeRequirements(proof, plan())).rejects.toMatchObject({
      code: "runtime_interrupted",
    });
    const second = await fresh();
    const multi = call("update_requirements", plan());
    multi.tool_calls.push(call("update_requirements", plan()).tool_calls[0]);
    await run(second, "两份方案", [
      multi,
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).toEqual([
          "create_requirements",
        ]);
        return call("update_requirements", plan());
      },
    ]);
    expect(
      (await host.store.get(scope(), second)).requirements.deliveries,
    ).toHaveLength(2);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_event WHERE session_id=$1 AND kind='requirements_saved'",
          [second],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("retains omitted known quantities without accepting an invalid original object", async () => {
    const id = await fresh(),
      bad = { ...plan(50), steps: [] },
      removed = plan(50) as any;
    delete removed.changes.deliveries[0].patch.count;
    const result = await run(id, "50条方案", [
      call("update_requirements", bad),
      call("update_requirements", removed),
    ]);
    expect(result.session.requirements.deliveries[0].count).toBe(50);
    expect(result.session.requirements.deliveries).toHaveLength(2);
    const second = await fresh();
    await expect(
      run(second, "方案", [
        call("update_requirements", ["invalid-object"]),
        call("update_requirements", plan()),
      ]),
    ).rejects.toBeDefined();
    expect(
      (await host.store.get(scope(), second)).requirements.deliveries,
    ).toEqual([]);
  });
  it.each(["read_file", "write_file", "task"])(
    "does not expose or execute ambient tool %s",
    async (name) => {
      const id = await fresh(),
        before = await effects();
      await expect(
        run(id, "仅使用当前业务能力", [
          call(name, {
            file_path: "/not-authorized",
            description: "do not delegate",
          }),
        ]),
      ).rejects.toBeDefined();
      expect(await effects()).toEqual(before);
      expect(
        (await host.store.get(scope(), id)).requirements.deliveries,
      ).toEqual([]);
    },
  );
  it.each(["source", "classifications", "saveTarget"])(
    "rejects changing %s under unknown-field correction",
    async (field) => {
      const id = await fresh(),
        bad = plan(50) as any;
      const original = {
        source: {
          kind: "assets",
          assetIds: [assetId],
          recordIds: [assetId + ":1"],
        },
        classifications: [
          { field: "expectedOutput", allowedValues: ["原分类"] },
        ],
        saveTarget: { kind: "newDraft", name: "原目标" },
      };
      Object.assign(bad.changes.deliveries[0].patch, original);
      bad.steps = [];
      const repaired = structuredClone(bad);
      delete repaired.steps;
      if (field === "source")
        repaired.changes.deliveries[0].patch.source.recordIds = [
          assetId + ":2",
        ];
      if (field === "classifications")
        repaired.changes.deliveries[0].patch.classifications[0].allowedValues =
          ["别的分类"];
      if (field === "saveTarget")
        repaired.changes.deliveries[0].patch.saveTarget.name = "别的目标";
      await expect(
        run(id, "保持当前范围", [
          call("update_requirements", bad),
          call("update_requirements", repaired),
        ]),
      ).rejects.toMatchObject({ code: "correction_intent_changed" });
      expect(
        (await host.store.get(scope(), id)).requirements.deliveries,
      ).toEqual([]);
    },
  );
  it("records a rejected HTTP attempt once and preserves current requirements", async () => {
    const id = await fresh();
    await run(id, "只给方案", [call("update_requirements", plan())]);
    const before = (await host.store.get(scope(), id)).requirements,
      start = requests.length;
    await expect(
      run(id, "读取当前状态", [{ httpStatus: 503 }]),
    ).rejects.toBeDefined();
    expect(requests.length - start).toBe(1);
    expect((await host.store.get(scope(), id)).requirements).toEqual(before);
    const last = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='model_response' ORDER BY id DESC LIMIT 1",
        [id],
      )
    ).rows[0].detail;
    expect(last).toMatchObject({
      status: 503,
      usage: null,
      error: "provider_rejected",
    });
  });

  it("marks model prose as explanation instead of a business receipt", async () => {
    const id = await fresh();
    const state = await run(id, "先看看能做什么", [
      { role: "assistant", content: "保存成功（合成的未核对口头断言）" },
    ]);
    expect(state.messages.at(-1)).toMatchObject({
      kind: "model_explanation",
      isBusinessReceipt: false,
    });
    expect(state.session.requirements.deliveries).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM assistant_runtime_event WHERE session_id=$1 AND kind='requirements_saved'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("does not execute a session owned by an unsupported runtime version", async () => {
    const id = await fresh();
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='different-owner' WHERE id=$1",
      [id],
    );
    expect((await api("GET", route(id))).json().error.code).toBe(
      "runtime_version_not_supported",
    );
    expect(
      await submit(id, "不应受理").catch((e) => ({ code: e.code })),
    ).toMatchObject({ code: "runtime_version_not_supported" });
  });
  it("validates existing draft save targets in the requirements commit", async () => {
    const createDraft = async (project: string) =>
      (
        await api(
          "POST",
          "/api/projects/" + project + "/collaborative-drafts",
          {},
        )
      ).json().draft.id as string;
    const valid = await createDraft(projectId),
      other = await createDraft(otherProject),
      discarded = await createDraft(projectId),
      locked = await createDraft(projectId);
    await db.query(
      "UPDATE collaborative_draft SET status='discarded' WHERE id=$1",
      [discarded],
    );
    const eventId = "r02-lock-" + randomUUID();
    await db.query(
      "INSERT INTO deletion_event(id,project_id,target_type,target_id,status,preview_hash,closure,initiated_by) VALUES($1,$2,'test_set',$3,'running','synthetic','{}',$4)",
      [eventId, projectId, locked, actors.get("admin")],
    );
    await db.query(
      "INSERT INTO deletion_lock(event_id,project_id,object_type,object_id) VALUES($1,$2,'collaborative_draft',$3)",
      [eventId, projectId, locked],
    );
    const id = await fresh(),
      accepted = await submit(id, "保存到已有草稿的方案"),
      proof = await host.store.claim(scope(), id, accepted.json().turnId);
    for (const target of ["not-a-real-draft", other, discarded, locked]) {
      await expect(
        changeRequirements(proof, {
          expectedRevision: 0,
          changes: {
            deliveries: [
              {
                patch: {
                  name: "待处理",
                  saveTarget: { kind: "draft", id: target },
                },
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: "save_target_unavailable" });
      expect((await host.store.get(scope(), id)).requirements_revision).toBe(0);
    }
    const before = await effects();
    const receipt = await changeRequirements(proof, {
      expectedRevision: 0,
      changes: {
        deliveries: [
          {
            patch: { name: "待处理", saveTarget: { kind: "draft", id: valid } },
          },
        ],
      },
    });
    expect(receipt.requirements.deliveries[0].saveTarget).toEqual({
      kind: "draft",
      id: valid,
    });
    expect(await effects()).toEqual(before);
    await db.query(
      "UPDATE collaborative_draft SET status='discarded' WHERE id=$1",
      [valid],
    );
    const cancelled = await changeRequirements(proof, {
      expectedRevision: 1,
      changes: {
        deliveries: [
          {
            deliveryId: receipt.requirements.deliveries[0].id,
            patch: { status: "cancelled" },
          },
        ],
      },
    });
    expect(cancelled.requirements.deliveries[0]).toMatchObject({
      status: "cancelled",
      saveTarget: { kind: "draft", id: valid },
    });
    await host.store.finish(proof, "保存目标已核对");
  });
  it("applies shared parent availability to draft save targets and directory", async () => {
    const target = (
      await api(
        "POST",
        "/api/projects/" + projectId + "/collaborative-drafts",
        {},
      )
    ).json().draft.id;
    const prefix = "r02-parent-" + randomUUID(),
      owner = actors.get("admin");
    await db.query(
      "INSERT INTO test_set(id,project_id,name,purpose,owner_id) VALUES($1,$2,'synthetic parent','regression',$3)",
      [prefix, projectId, owner],
    );
    await db.query(
      "INSERT INTO formal_schema_revision(id,test_set_id,mode,input_schema,expected_output_schema) VALUES($1,$2,'input_only','{}','{}')",
      [prefix + "-schema", prefix],
    );
    await db.query(
      "INSERT INTO working_draft(id,test_set_id,status,updated_by) VALUES($1,$2,'editing',$3)",
      [prefix + "-working", prefix, owner],
    );
    await db.query(
      "INSERT INTO candidate_snapshot(id,draft_id,status) VALUES($1,$2,'published_as_version')",
      [prefix + "-candidate", prefix + "-working"],
    );
    await db.query(
      "INSERT INTO test_set_version(id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,published_at) VALUES($1,$2,1,$3,$4,'synthetic','synthetic','synthetic','synthetic/parent',0,$5,now())",
      [
        prefix + "-version",
        prefix,
        prefix + "-candidate",
        prefix + "-schema",
        owner,
      ],
    );
    await db.query(
      "UPDATE collaborative_draft SET test_set_id=$1,parent_version_id=$2 WHERE id=$3",
      [prefix, prefix + "-version", target],
    );
    const id = await fresh(),
      accepted = await submit(id, "保存到基于版本的草稿"),
      proof = await host.store.claim(scope(), id, accepted.json().turnId);
    const change = {
      expectedRevision: 0,
      changes: {
        deliveries: [
          {
            patch: {
              name: "待处理",
              saveTarget: { kind: "draft", id: target },
            },
          },
        ],
      },
    };
    const directory = sessionTools(host.store, proof, true).tools.find(
      (t) => t.name === "list_sources",
    )!;
    const assertUnavailable = async () => {
      await expect(changeRequirements(proof, change)).rejects.toMatchObject({
        code: "save_target_unavailable",
      });
      expect((await host.store.get(scope(), id)).requirements_revision).toBe(0);
      const listed = await directory.invoke({ kind: "drafts", offset: 0 });
      expect(listed.items.map((v: { id: string }) => v.id)).not.toContain(
        target,
      );
    };
    await db.query(
      "UPDATE test_set SET status='unavailable_by_deletion' WHERE id=$1",
      [prefix],
    );
    await assertUnavailable();
    await db.query("UPDATE test_set SET status='available' WHERE id=$1", [
      prefix,
    ]);
    await db.query(
      "UPDATE test_set_version SET status='archived' WHERE id=$1",
      [prefix + "-version"],
    );
    await assertUnavailable();
    await db.query(
      "UPDATE test_set_version SET status='published' WHERE id=$1",
      [prefix + "-version"],
    );
    const eventId = prefix + "-deletion";
    await db.query(
      "INSERT INTO deletion_event(id,project_id,target_type,target_id,status,preview_hash,closure,initiated_by) VALUES($1,$2,'test_set',$3,'running','synthetic','{}',$4)",
      [eventId, projectId, prefix, owner],
    );
    for (const [type, objectId] of [
      ["test_set", prefix],
      ["test_set_version", prefix + "-version"],
    ]) {
      await db.query(
        "INSERT INTO deletion_lock(event_id,project_id,object_type,object_id) VALUES($1,$2,$3,$4)",
        [eventId, projectId, type, objectId],
      );
      await assertUnavailable();
      await db.query(
        "DELETE FROM deletion_lock WHERE event_id=$1 AND object_id=$2",
        [eventId, objectId],
      );
    }
    const listed = await directory.invoke({ kind: "drafts", offset: 0 });
    expect(listed.items.map((v: { id: string }) => v.id)).toContain(target);
    expect((await changeRequirements(proof, change)).saved).toBe(true);
    await host.store.finish(proof, "合法父版本目标已核对");
  });
  it("R04 sends exactly one leading System message through the real SDK while retaining current authority and tool chronology", async () => {
    const id = await fresh(),
      start = requests.length;
    await run(id, "查看当前项目", [
      call("read_project", {}),
      { role: "assistant", content: "项目已读取。" },
    ]);
    const observed = requests.slice(start);
    expect(observed).toHaveLength(2);
    for (const request of observed) {
      expect(request.messages[0].role).toBe("system");
      expect(
        request.messages.slice(1).every((m: any) => m.role !== "system"),
      ).toBe(true);
      expect(JSON.stringify(request.messages[0].content)).toContain(
        "当前服务端事实",
      );
      expect(JSON.stringify(request.messages[0].content)).toContain(id);
    }
    const final = observed[1].messages;
    expect(final.findIndex((m: any) => m.role === "tool")).toBeGreaterThan(
      final.findIndex((m: any) => m.role === "assistant"),
    );
    expect((await host.present(scope(), id)).receipts).toEqual([]);
  });
  it("refreshes dependent rules after a partial 5-to-3 amendment through the real SDK", async () => {
    const id = await fresh(),
      before = await effects();
    let state = await run(id, "先规划5条", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "plan",
          deliveries: [
            {
              patch: {
                name: "整理",
                operation: "clean",
                count: 5,
                instructions: "清洗前5条：去除首尾空白，保留原意。",
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "整理版" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    const amend = {
      expectedRevision: 1,
      changes: {
        mode: "plan",
        deliveries: [{ deliveryId, patch: { count: 3 } }],
      },
    };
    let forced = false;
    state = await run(id, "改成3条，其他规则不变", [
      call("update_requirements", amend),
      (request: any) => {
        forced = request.tool_choice?.function?.name === "update_requirements";
        return call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: { instructions: "去除首尾空白，保留原意。" },
              },
            ],
          },
        });
      },
    ]);
    expect(forced).toBe(true);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      count: 3,
      instructions: "去除首尾空白，保留原意。",
    });
    expect(state.session.requirements_revision).toBe(2);
    const wire = wireText(requests.at(-1).messages[0]);
    const facts = JSON.parse(
      wire.match(/当前服务端事实（历史或摘要不能覆盖）：(.*)\n执行控制：/)![1],
    );
    expect(facts.requirementsRevision).toBe(2);
    expect(facts.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      count: 3,
      instructions: "去除首尾空白，保留原意。",
    });
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(
      events.filter((e) => e.kind === "requirements_feedback"),
    ).toHaveLength(1);
    expect(events.filter((e) => e.kind === "requirements_saved")).toHaveLength(
      2,
    );
    expect(await effects()).toEqual(before);
  });

  it("does not grant a changed count during semantic instruction repair", async () => {
    const id = await fresh();
    let state = await run(id, "规划", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            {
              patch: {
                name: "整理",
                operation: "clean",
                count: 5,
                instructions: "只清洗前5条，保留标签。",
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    await expect(
      run(id, "改成3条", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: { deliveries: [{ deliveryId, patch: { count: 3 } }] },
        }),
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: { count: 4, instructions: "保留标签，整理空白。" },
              },
            ],
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    state = await host.present(scope(), id);
    expect(state.session.requirements.deliveries[0].count).toBe(5);
    expect(state.session.requirements_revision).toBe(1);
    expect(state.turns[0].error_code).toBe("correction_intent_changed");
  });

  it("bounds repeated stale instructions and preserves the original revision", async () => {
    const id = await fresh(),
      before = await effects();
    let state = await run(id, "规划", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            { patch: { name: "整理", count: 5, instructions: "清洗前5条" } },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    const broken = {
      expectedRevision: 1,
      changes: {
        deliveries: [
          { deliveryId, patch: { count: 3, instructions: "清洗前5条" } },
        ],
      },
    };
    state = await run(id, "改成3条", [
      call("update_requirements", broken),
      call("update_requirements", broken),
      call("update_requirements", broken),
    ]);
    expect(state.session.requirements_revision).toBe(1);
    expect(state.session.requirements.deliveries[0].count).toBe(5);
    expect(state.execution.reason).toBe("no_progress");
    expect(await effects()).toEqual(before);
  });
  it("retains the semantic repair context across a truncated correction", async () => {
    const id = await fresh();
    let state = await run(id, "规划5条", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            {
              patch: {
                name: "清洗",
                count: 5,
                instructions: "清洗前5条，保留原意。",
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    state = await run(id, "改成3条", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: { deliveries: [{ deliveryId, patch: { count: 3 } }] },
      }),
      call("update_requirements", "{"),
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            { deliveryId, patch: { instructions: "整理空白，保留原意。" } },
          ],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      count: 3,
      instructions: "整理空白，保留原意。",
    });
    expect(state.session.requirements_revision).toBe(2);
    const events = (
      await db.query(
        "SELECT kind FROM assistant_runtime_event WHERE session_id=$1",
        [id],
      )
    ).rows;
    expect(
      events.filter((e) => e.kind === "requirements_feedback"),
    ).toHaveLength(1);
    expect(events.filter((e) => e.kind === "parameter_feedback")).toHaveLength(
      1,
    );
  });
  it("amends the unique delivery when the captured C01 amendment omits its identity and operation", async () => {
    const id = await fresh();
    let state = await run(id, "前5条先规划", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "plan",
          deliveries: [
            {
              patch: {
                name: "前5条",
                operation: "clean",
                count: 5,
                instructions: "",
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "旧版" },
              },
            },
          ],
        },
      }),
    ]);
    const originalId = state.session.requirements.deliveries[0].id;
    state = await run(id, "改成前3条，保存成三条整理版，现在执行", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "三条整理版",
                count: 3,
                source: { kind: "assets", assetIds: [assetId] },
                saveTarget: { kind: "newDraft", name: "三条整理版" },
              },
            },
          ],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      id: originalId,
      count: 3,
      operation: "clean",
    });
    expect(state.executionReadiness.ready).toBe(true);
    expect(await effects()).toMatchObject({ runs: 0 });
  });
  it("does not save executable creation with an omitted operation", async () => {
    const id = await fresh();
    await run(id, "创建三条清洗任务", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "三条",
                count: 3,
                source: { kind: "assets", assetIds: [assetId] },
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "三条" },
              },
            },
          ],
        },
      }),
    ]).catch(() => undefined);
    expect((await host.store.get(scope(), id)).requirements_revision).toBe(0);
  });
  it("does not reinterpret a targetless update on an empty session as creation", async () => {
    const id = await fresh(),
      message = call("update_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [{ patch: { name: "不能偷偷新增", count: 3 } }],
        },
      });
    message.tool_calls[0]!.function.name = "update_requirements";
    await expect(run(id, "修改已有方案", [message])).rejects.toMatchObject({
      code: "delivery_target_required",
    });
    expect((await host.store.get(scope(), id)).requirements.deliveries).toEqual(
      [],
    );
  });
  it("retains explicit additional planning and rejects unsupported executable additions atomically", async () => {
    const id = await fresh();
    let state = await run(id, "规划第一份", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "plan",
          deliveries: [{ patch: { name: "第一份", count: 3 } }],
        },
      }),
    ]);
    const firstId = state.session.requirements.deliveries[0].id;
    state = await run(id, "另加一份方案", [
      call("create_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "plan",
          deliveries: [{ patch: { name: "第二份", count: 2 } }],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries.map((d) => d.id)).toContain(
      firstId,
    );
    expect(state.session.requirements.deliveries).toHaveLength(2);
    await expect(
      run(id, "现在执行", [
        call("update_requirements", {
          expectedRevision: 2,
          changes: { mode: "execute" },
        }),
      ]),
    ).rejects.toMatchObject({ code: "single_delivery_required" });
    const after = await host.store.get(scope(), id);
    expect(after.requirements.mode).toBe("plan");
    expect(after.requirements_revision).toBe(2);
  });
  it("rejects duplicate mutations of the same bound delivery in one command", async () => {
    const id = await fresh();
    let state = await run(id, "规划", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { name: "第一份", count: 3 } }] },
      }),
    ]);
    const target = state.session.requirements.deliveries[0].id;
    await expect(
      run(id, "修改并取消", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              { deliveryId: target, patch: { name: "新版" } },
              { deliveryId: target, patch: { status: "cancelled" } },
            ],
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: "delivery_change_conflict" });
    state = await host.present(scope(), id);
    expect(state.session.requirements_revision).toBe(1);
    expect(state.session.requirements.deliveries[0].name).toBe("第一份");
  });
  it("repairs a missing new execution operation with the real SDK without changing its scope", async () => {
    const id = await fresh();
    const state = await run(id, "清洗前三条，现在执行", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "清洗",
                count: 3,
                source: { kind: "assets", assetIds: [assetId] },
                allowedFields: ["question"],
                instructions: "",
                saveTarget: { kind: "newDraft", name: "整理" },
              },
            },
          ],
        },
      }),
      call("create_requirements", {
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { operation: "clean" } }] },
      }),
    ]);
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements_revision).toBe(1);
    expect(state.executionReadiness.ready).toBe(true);
  });
  it("keeps v1 history readable without reinterpreting its checkpoint as a v2 command", async () => {
    const id = await fresh();
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='deepagents-v1' WHERE id=$1",
      [id],
    );
    const read = await api("GET", route(id));
    expect(read.statusCode).toBe(200);
    const before = read.json().session.revision;
    const submission = await submit(id, "继续");
    expect(submission.statusCode).toBe(409);
    expect(submission.json().code ?? submission.json().error?.code).toBe(
      "runtime_contract_changed",
    );
    expect((await host.store.get(scope(), id)).revision).toBe(before);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM assistant_runtime_turn WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("keeps the bound delivery identity when semantic correction supplies its previously omitted ID", async () => {
    const id = await fresh();
    let state = await run(id, "先规划5条", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            {
              patch: {
                name: "清洗",
                count: 5,
                instructions: "只清洗前5条，其他不变。",
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    state = await run(id, "改成3条", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: { deliveries: [{ patch: { count: 3 } }] },
      }),
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            { deliveryId, patch: { instructions: "整理所选记录，其他不变。" } },
          ],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      count: 3,
      instructions: "整理所选记录，其他不变。",
    });
    expect(state.session.requirements_revision).toBe(2);
  });
  it("replays a committed partial correction receipt without another mutation and rejects changed protected fields", async () => {
    const id = await fresh(),
      accepted = await submit(id, "先规划"),
      proof = await host.store.claim(scope(), id, accepted.json().turnId);
    const created = await host.store.change(
      proof,
      {
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { name: "清洗", count: 5 } }] },
      },
      "create",
    );
    const deliveryId = created.requirements.deliveries[0].id;
    const request = {
      expectedRevision: 1,
      changes: { deliveries: [{ patch: { count: 3, name: "三条整理版" } }] },
    };
    const saved = await host.store.change(proof, request, "update");
    const replay = await host.store.change(
      proof,
      {
        expectedRevision: 1,
        changes: {
          deliveries: [{ deliveryId, patch: { name: "三条整理版" } }],
        },
      },
      "update",
    );
    expect(replay).toEqual(saved);
    await expect(
      host.store.change(
        proof,
        {
          expectedRevision: 1,
          changes: { deliveries: [{ deliveryId, patch: { count: 4 } }] },
        },
        "update",
      ),
    ).rejects.toMatchObject({ code: "requirements_revision_conflict" });
    expect((await host.store.get(scope(), id)).requirements_revision).toBe(2);
    expect(
      (
        await db.query(
          "SELECT id FROM assistant_runtime_event WHERE session_id=$1 AND kind='requirements_saved'",
          [id],
        )
      ).rows,
    ).toHaveLength(2);
    await host.store.finish(proof, "已保存");
  });
  it("binds a missing operation correction to the already existing target even when its first amendment omitted ID", async () => {
    const id = await fresh();
    let s = await run(id, "先规划三条", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            {
              patch: {
                name: "清洗",
                count: 3,
                source: { kind: "assets", assetIds: [assetId] },
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "整理" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = s.session.requirements.deliveries[0].id;
    s = await run(id, "现在执行", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "execute",
          deliveries: [{ patch: { name: "整理版" } }],
        },
      }),
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [{ deliveryId, patch: { operation: "clean" } }],
        },
      }),
    ]);
    expect(s.session.requirements.deliveries).toHaveLength(1);
    expect(s.session.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      count: 3,
      operation: "clean",
      name: "整理版",
    });
    expect(s.executionReadiness.ready).toBe(true);
  });
  it("saves cancellation of the sole executable delivery as non-executing without another write", async () => {
    const id = await fresh();
    let s = await run(id, "准备清洗三条", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "清洗",
                operation: "clean",
                count: 3,
                source: { kind: "assets", assetIds: [assetId] },
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "整理" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = s.session.requirements.deliveries[0].id;
    s = await run(id, "这份不要了", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: { deliveries: [{ patch: { status: "cancelled" } }] },
      }),
    ]);
    expect(s.session.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      status: "cancelled",
    });
    expect(s.session.requirements.mode).toBe("plan");
    expect(s.executionReadiness.ready).toBe(false);
    expect(await effects()).toMatchObject({ runs: 0 });
  });

  it.each([
    "same-status",
    "same-inherited-fields",
    "changed-status",
    "changed-inherited-field",
  ])(
    "compares captured correction against effective inherited values: %s",
    async (kind) => {
      const id = await fresh();
      let state = await run(id, "先规划5条", [
        call("create_requirements", {
          expectedRevision: 0,
          changes: {
            deliveries: [
              {
                patch: {
                  name: "前五条",
                  operation: "clean",
                  count: 5,
                  instructions: "整理前5条空白，保留原意。",
                  allowedFields: ["question"],
                  metadataKeys: ["标签"],
                  saveTarget: { kind: "newDraft", name: "旧版" },
                },
              },
            ],
          },
        }),
      ]);
      const deliveryId = state.session.requirements.deliveries[0].id;
      const correctedPatch: any = {
        instructions: "对当前所选记录整理空白并保留原意。",
        status: kind === "changed-status" ? "cancelled" : "active",
      };
      if (kind.includes("inherited"))
        Object.assign(correctedPatch, {
          name: kind === "changed-inherited-field" ? "另外一份" : "前五条",
          operation: "clean",
          allowedFields: ["question"],
          metadataKeys: ["标签"],
        });
      const attempt = run(id, "改成三条，其他不变", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                patch: {
                  count: 3,
                  saveTarget: { kind: "newDraft", name: "三条整理版" },
                },
              },
            ],
          },
        }),
        call("update_requirements", {
          expectedRevision: 1,
          changes: { deliveries: [{ deliveryId, patch: correctedPatch }] },
        }),
      ]);
      if (kind.startsWith("changed")) {
        await expect(attempt).rejects.toMatchObject({
          code: "correction_intent_changed",
        });
        state = await host.present(scope(), id);
        expect(state.session.requirements_revision).toBe(1);
      } else {
        state = await attempt;
        expect(state.session.requirements_revision).toBe(2);
        expect(state.session.requirements.deliveries).toHaveLength(1);
        expect(state.session.requirements.deliveries[0]).toMatchObject({
          id: deliveryId,
          status: "active",
          count: 3,
          operation: "clean",
          name: "前五条",
          saveTarget: { kind: "newDraft", name: "三条整理版" },
        });
      }
    },
  );

  it("retains the semantic repair obligation when captured correction adds active status but omits instructions", async () => {
    const id = await fresh();
    let state = await run(id, "先规划5条", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            {
              patch: {
                name: "前五条",
                operation: "clean",
                count: 5,
                instructions: "整理前5条空白，保留原意。",
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "旧版" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    state = await run(id, "改成三条", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            {
              patch: {
                count: 3,
                saveTarget: { kind: "newDraft", name: "三条整理版" },
              },
            },
          ],
        },
      }),
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            {
              patch: {
                count: 3,
                status: "active",
                saveTarget: { kind: "newDraft", name: "三条整理版" },
              },
            },
          ],
        },
      }),
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            {
              deliveryId,
              patch: { instructions: "整理当前记录的空白，保留原意。" },
            },
          ],
        },
      }),
    ]);
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      count: 3,
      instructions: "整理当前记录的空白，保留原意。",
    });
    const events = (
      await db.query(
        "SELECT kind FROM assistant_runtime_event WHERE session_id=$1",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "correction_rejected")).toHaveLength(
      0,
    );
    expect(
      events.filter((e) => e.kind === "requirements_feedback"),
    ).toHaveLength(2);
  });

  it.each(["subset", "reordered"])(
    "aligns effective inherited fields by identity during multi-delivery semantic repair: %s",
    async (kind) => {
      const id = await fresh();
      let state = await run(id, "规划两份", [
        call("create_requirements", {
          expectedRevision: 0,
          changes: {
            deliveries: [
              {
                patch: {
                  name: "第一份",
                  operation: "clean",
                  count: 5,
                  instructions: "整理前5条空白。",
                },
              },
              {
                patch: {
                  name: "第二份",
                  operation: "rewrite",
                  count: 4,
                  instructions: "改写前4条表达。",
                },
              },
            ],
          },
        }),
      ]);
      const [a, b] = state.session.requirements.deliveries;
      const fixA = {
          deliveryId: a.id,
          patch: { instructions: "只整理当前首份记录。", status: "active" },
        },
        fixB = {
          deliveryId: b.id,
          patch: { instructions: "只改写当前第二份记录。", status: "active" },
        };
      const outputs = [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              { deliveryId: a.id, patch: { count: 3 } },
              { deliveryId: b.id, patch: { count: 2 } },
            ],
          },
        }),
        call("update_requirements", {
          expectedRevision: 1,
          changes: { deliveries: kind === "subset" ? [fixB] : [fixB, fixA] },
        }),
        ...(kind === "subset"
          ? [
              call("update_requirements", {
                expectedRevision: 1,
                changes: { deliveries: [fixA] },
              }),
            ]
          : []),
      ];
      state = await run(id, "分别改为3条和2条", outputs);
      expect(state.session.requirements_revision).toBe(2);
      expect(
        state.session.requirements.deliveries.map((d) => [
          d.id,
          d.name,
          d.count,
          d.operation,
        ]),
      ).toEqual([
        [a.id, "第一份", 3, "clean"],
        [b.id, "第二份", 2, "rewrite"],
      ]);
    },
  );
  it.each([false, true])(
    "locks a repaired operation when the next business check requires instructions: changed=%s",
    async (changeOperation) => {
      const id = await fresh();
      let state = await run(id, "先规划", [
        call("create_requirements", {
          expectedRevision: 0,
          changes: {
            deliveries: [
              {
                patch: {
                  name: "清洗",
                  count: 3,
                  source: { kind: "assets", assetIds: [assetId] },
                  allowedFields: ["question"],
                  instructions: "整理空白。",
                  saveTarget: { kind: "newDraft", name: "整理版" },
                },
              },
            ],
          },
        }),
      ]);
      const deliveryId = state.session.requirements.deliveries[0].id;
      const attempt = run(id, "现在执行清洗", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            mode: "execute",
            deliveries: [{ patch: { name: "清洗" } }],
          },
        }),
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [{ deliveryId, patch: { operation: "clean" } }],
          },
        }),
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: {
                  operation: changeOperation ? "rewrite" : "clean",
                  instructions: "只整理当前所选记录的空白。",
                },
              },
            ],
          },
        }),
      ]);
      if (changeOperation) {
        await expect(attempt).rejects.toMatchObject({
          code: "correction_intent_changed",
        });
        expect((await host.store.get(scope(), id)).requirements_revision).toBe(
          1,
        );
      } else {
        state = await attempt;
        expect(state.executionReadiness.ready).toBe(true);
        expect(state.session.requirements.deliveries[0].operation).toBe(
          "clean",
        );
      }
    },
  );
  it.each([true, false])(
    "keeps applicable rules unchanged across five to three: explicit=%s",
    async (explicit) => {
      const id = await fresh();
      const rule = "问法自然，保持原意；答案和标签不变，控制在5个字以内。";
      let state = await run(id, "先给5条方案，不执行", [
        call("create_requirements", {
          expectedRevision: 0,
          changes: {
            deliveries: [
              {
                patch: {
                  name: "前五条",
                  operation: "rewrite",
                  count: 5,
                  instructions: rule,
                  allowedFields: ["question"],
                },
              },
            ],
          },
        }),
      ]);
      const deliveryId = state.session.requirements.deliveries[0].id;
      state = await run(id, "改成3条，保存名三条自然问法", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: {
                  count: 3,
                  name: "三条自然问法",
                  saveTarget: { kind: "newDraft", name: "三条自然问法" },
                  ...(explicit ? { instructions: rule } : {}),
                },
              },
            ],
          },
        }),
      ]);
      expect(state.session.requirements_revision).toBe(2);
      expect(state.session.requirements.deliveries).toHaveLength(1);
      expect(state.session.requirements.deliveries[0]).toMatchObject({
        id: deliveryId,
        count: 3,
        instructions: rule,
      });
      const events = (
        await db.query(
          "SELECT kind FROM assistant_runtime_event WHERE session_id=$1",
          [id],
        )
      ).rows;
      expect(events.some((e) => e.kind === "requirements_feedback")).toBe(
        false,
      );
    },
  );

  it("keeps a generic rule through a fixed-source amendment and executable mode in SDK", async () => {
    const id = await fresh();
    const rule = "保持原意，问法自然，答案和标签不变。";
    let state = await run(id, "先规划前三条", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "plan",
          deliveries: [
            {
              patch: {
                name: "三条",
                operation: "rewrite",
                count: 3,
                source: {
                  kind: "assets",
                  assetIds: [assetId],
                  recordIds: [1, 2, 3].map((i) => assetId + ":" + i),
                },
                allowedFields: ["question"],
                instructions: rule,
                saveTarget: { kind: "newDraft", name: "三条" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    state = await run(id, "改前两条并执行", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "execute",
          deliveries: [
            {
              deliveryId,
              patch: {
                name: "两条自然问法",
                count: 2,
                source: {
                  kind: "assets",
                  assetIds: [assetId],
                  recordIds: [1, 2].map((i) => assetId + ":" + i),
                },
                instructions: rule,
                saveTarget: { kind: "newDraft", name: "两条自然问法" },
              },
            },
          ],
        },
      }),
    ]);
    expect(state.session.requirements_revision).toBe(2);
    expect(state.session.requirements.mode).toBe("execute");
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements.deliveries[0]).toMatchObject({
      id: deliveryId,
      count: 2,
      instructions: rule,
      allowedFields: ["question"],
    });
  });
  it("repairs a creation scope conflict without binding a nonexistent delivery", async () => {
    const id = await fresh();
    const args = {
      expectedRevision: 0,
      changes: {
        objective: "三条问题",
        deliveries: [
          {
            patch: {
              name: "三条",
              operation: "rewrite",
              count: 3,
              instructions: "只改写前5条。",
            },
          },
        ],
      },
    };
    const good = structuredClone(args);
    good.changes.deliveries[0].patch.instructions = "保持原意，问法自然。";
    const state = await run(id, "规划三条", [
      call("create_requirements", args),
      call("create_requirements", good),
    ]);
    expect(state.session.requirements_revision).toBe(1);
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements.objective).toBe("三条问题");
  });
  async function r05Source(name: string) {
    const cid = (
      await api("GET", "/api/projects/" + projectId + "/collections")
    ).json().collections[0].id;
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/pending-uploads",
      headers: {
        origin,
        ...identities.get("admin"),
        "content-type": "application/octet-stream",
        "x-file-name": name,
      },
      payload:
        JSON.stringify({
          question: "B文件唯一问题 " + randomUUID(),
          answer: "B答案",
        }) + "\n",
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const confirm = await api(
      "POST",
      "/api/projects/" + projectId + "/pending-upload-batches/confirm",
      {
        collectionId: cid,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    );
    const bid = confirm.json().assets[0].id;
    const m = (
      await api(
        "GET",
        "/api/projects/" + projectId + "/assets/" + bid + "/mapping",
      )
    ).json();
    const mapped = await api(
      "PUT",
      "/api/projects/" + projectId + "/assets/" + bid + "/mapping",
      {
        parsedViewId: m.parsedViewId,
        expectedRevision: 0,
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: [],
        },
      },
    );
    expect(mapped.statusCode, mapped.body).toBe(200);
    return { cid, bid };
  }
  it("R05 SDK explicit new filename supersedes page A and create/move use real business results", async () => {
    const id = await fresh(),
      { cid, bid } = await r05Source("r05-explicit-b.jsonl");
    outputs = [
      call("open_material_upload", { collectionId: cid }),
      call("list_material_files", { collectionId: cid }),
      call("read_records", {
        source: { kind: "assets", assetIds: [bid] },
        limit: 1,
      }),
      call("create_collection", {
        name: "SDK R05 " + id,
        description: "真实材料集合",
      }),
      async () => {
        const target = (
          await db.query(
            "SELECT id FROM raw_material_collection WHERE project_id=$1 AND name=$2",
            [projectId, "SDK R05 " + id],
          )
        ).rows[0].id;
        return call("move_material_file", {
          assetId: bid,
          collectionId: target,
        });
      },
      {
        role: "assistant",
        content: "已读取B文件并移动到新资料集合，未处理或生成。",
      },
    ];
    const accepted = await submit(
      id,
      "当前页面是A，但请读取 r05-explicit-b.jsonl，建一个资料集合并移进去。",
      {
        context: {
          kind: "assets",
          assetIds: [assetId],
          recordIds: [assetId + ":1"],
        },
      },
    );
    expect(accepted.statusCode, accepted.body).toBe(202);
    const done = await host.runPending(scope(), id, accepted.json().turnId);
    expect(done.execution.status).toBe("completed");
    expect(done.results).toEqual([]);
    expect(done.workspace.nativeActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "upload", collectionId: cid }),
      ]),
    );
    const read = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='source_read' ORDER BY id DESC LIMIT 1",
        [id],
      )
    ).rows[0].detail;
    expect(read.source.assetIds).toEqual([bid]);
    const receipts = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='material_receipt' ORDER BY id",
        [id],
      )
    ).rows;
    expect(receipts.map((x) => x.detail.name)).toEqual([
      "create_collection",
      "move_material_file",
    ]);
  });
  it("R05 SDK discovery failure and ordinary continue do not pin a stale candidate over a later explicit file", async () => {
    const id = await fresh(),
      { cid, bid } = await r05Source("r05-after-failure-b.jsonl");
    await expect(
      run(id, "看看不存在的集合", [
        call("list_material_files", { collectionId: "not-visible" }),
      ]),
    ).rejects.toBeDefined();
    await run(id, "继续", [
      call("list_collections", {}),
      { role: "assistant", content: "目录已核对，请说明文件。" },
    ]);
    const done = await run(
      id,
      "读取 r05-after-failure-b.jsonl 即可，不用旧候选。",
      [
        call("list_material_files", { collectionId: cid }),
        call("read_records", {
          source: { kind: "assets", assetIds: [bid] },
          limit: 1,
        }),
        { role: "assistant", content: "已按真实引用读取B文件。" },
      ],
    );
    expect(done.execution.status).toBe("completed");
    expect(done.results).toEqual([]);
    const refs = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='source_read'",
        [id],
      )
    ).rows;
    expect(refs.at(-1).detail.source.assetIds).toEqual([bid]);
  });
  it("R05 keeps v2 history read-only and denies a viewer background upload", async () => {
    const old = await fresh();
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='deepagents-v2' WHERE id=$1",
      [old],
    );
    const snap = await host.present(scope(), old);
    expect(snap.currentRuntime).toBe("deepagents-v3");
    expect(snap.canWrite).toBe(false);
    expect((await submit(old, "继续")).statusCode).toBe(409);
    for (const action of ["stop", "continue"]) {
      expect(
        (await api("POST", route(old) + "/control", { action })).statusCode,
      ).toBe(409);
    }
    expect(
      (await api("POST", route(old) + "/budget-offer", {})).statusCode,
    ).toBe(409);
    const viewer = await fresh("viewer");
    const attach = await api(
      "POST",
      route(viewer) + "/attachments",
      {
        fileName: "rules.md",
        contentBase64: Buffer.from("private background").toString("base64"),
      },
      "viewer",
    );
    expect(attach.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      (
        await db.query(
          "SELECT id FROM assistant_runtime_attachment WHERE session_id=$1",
          [viewer],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("R05 rejects an editor downgrade before the background transaction commits", async () => {
    const id = await fresh("editor");
    const artifacts = new ArtifactRepository(config.minio);
    const guarded = Object.create(artifacts);
    guarded.storeImmutable = async (bytes: Buffer) => {
      const result = await artifacts.storeImmutable(bytes);
      await db.query(
        "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [projectId, actors.get("editor")],
      );
      return result;
    };
    try {
      await expect(
        new WorkspaceStore(host.store, guarded).attach(
          scope("editor"),
          id,
          "rules.md",
          Buffer.from("example rules"),
        ),
      ).rejects.toBeDefined();
      expect(
        (
          await db.query(
            "SELECT id FROM assistant_runtime_attachment WHERE session_id=$1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query(
        "UPDATE project_member SET role='editor' WHERE project_id=$1 AND user_id=$2",
        [projectId, actors.get("editor")],
      );
    }
  });
  it("R02-A aborts a mixed-revision context before sending it to the provider", async () => {
    const id = await fresh(),
      start = requests.length;
    const projection = host.execution.projection.bind(host.execution);
    const spy = vi
      .spyOn(host.execution, "projection")
      .mockImplementationOnce(async (...args) => {
        await db.query(
          "UPDATE assistant_runtime_session SET requirements_revision=requirements_revision+1 WHERE id=$1",
          [id],
        );
        return projection(...args);
      });
    try {
      await expect(
        run(id, "查看当前项目", [{ role: "assistant", content: "完成" }]),
      ).rejects.toMatchObject({ code: "context_revision_conflict" });
      expect(requests.length).toBe(start);
    } finally {
      spy.mockRestore();
    }
  });
});
