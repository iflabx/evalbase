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
        name,
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
    app = await buildApp(config, { disableLegacyTestBootstrap: true });
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "response_" + randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message,
                finish_reason: message.tool_calls?.length
                  ? "tool_calls"
                  : "stop",
              },
            ],
            ...(omitUsage
              ? {}
              : {
                  usage: {
                    prompt_tokens: 3,
                    completion_tokens: 3,
                    total_tokens: 6,
                  },
                }),
          }),
        );
      } catch {
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
      "deepagents-v1",
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
    await host.store.change(proof, plan());
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
      "read_project",
      "list_sources",
      "read_records",
      "update_requirements",
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
    const first = await host.store.change(proof, plan());
    expect(await host.store.change(proof, plan())).toEqual(first);
    const noChange = await host.store.change(proof, {
      expectedRevision: 1,
      changes: { mode: "plan" },
    });
    expect(noChange.unchanged).toBe(true);
    expect(noChange.revision).toBe(1);
    await expect(
      host.store.change(proof, {
        expectedRevision: 0,
        changes: { objective: "不能覆盖" },
      }),
    ).rejects.toMatchObject({ code: "requirements_revision_conflict" });
    await host.store.finish(proof, "记录完成");
  });
  it.each(["wrong-type", "unknown-field"])(
    "corrects %s through the real SDK while binding the original invocation",
    async (kind) => {
      const id = await fresh(),
        valid = plan(50),
        broken = structuredClone(valid) as any;
      if (kind === "wrong-type")
        broken.changes.deliveries[0].patch.count = "50";
      else broken.steps = [];
      const state = await run(id, "两份方案", [
        call("update_requirements", broken, "original-call"),
        call("update_requirements", valid, "corrected-call"),
      ]);
      expect(state.session.requirements.deliveries[0].count).toBe(50);
      const feedback = (
        await db.query(
          "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='parameter_feedback'",
          [id],
        )
      ).rows;
      expect(feedback[0].detail.originalCallId).toBe("original-call");
      const attempts = (
        await db.query(
          "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='model_request'",
          [id],
        )
      ).rows;
      expect(
        attempts.some(
          (r) =>
            r.detail.purpose === "correction" &&
            r.detail.correctionOf === "original-call",
        ),
      ).toBe(true);
    },
  );
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
    ).rejects.toMatchObject({ code: "parameter_correction_incomplete" });
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
    expect(
      lastRequests.messages.some(
        (m: any) =>
          typeof m.content === "string" &&
          m.content.includes('"count":50') &&
          m.content.includes("当前服务端事实"),
      ),
    ).toBe(true);
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
      host.store.change({ ...proof, token: "forged" }, plan()),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    await host.store.finish(proof, "无需更改");
    await expect(host.store.change(proof, plan())).rejects.toMatchObject({
      code: "runtime_interrupted",
    });
    const second = await fresh();
    const multi = call("update_requirements", plan());
    multi.tool_calls.push(call("update_requirements", plan()).tool_calls[0]);
    await expect(run(second, "两份方案", [multi])).rejects.toMatchObject({
      code: "multiple_requirement_updates",
    });
    expect(
      (await host.store.get(scope(), second)).requirements.deliveries,
    ).toEqual([]);
  });

  it("does not drop an invalid quantity or replace an invalid object with a new intent", async () => {
    const id = await fresh(),
      bad = plan(50) as any,
      removed = plan(50) as any;
    bad.changes.deliveries[0].patch.count = "50";
    delete removed.changes.deliveries[0].patch.count;
    await expect(
      run(id, "50条方案", [
        call("update_requirements", bad),
        call("update_requirements", removed),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
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
        host.store.change(proof, {
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
    const receipt = await host.store.change(proof, {
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
    const cancelled = await host.store.change(proof, {
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
      await expect(host.store.change(proof, change)).rejects.toMatchObject({
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
    expect((await host.store.change(proof, change)).saved).toBe(true);
    await host.store.finish(proof, "合法父版本目标已核对");
  });
});
