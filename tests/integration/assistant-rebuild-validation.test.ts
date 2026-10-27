import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { StateSnapshot } from "@langchain/langgraph";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, afterAll, it, expect } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { saveModelConnection } from "../../src/model/connection.js";
import { createSharedDraft } from "../../src/drafts/create.js";
import {
  createProcessingRun,
  getProcessingRun,
  readProcessingRun,
  previewProcessingInput,
} from "../../src/processing/store.js";
import { processingRecovery } from "../../src/processing/recovery.js";
import { generationBudget } from "../../src/processing/generation.js";
import { processingReferences } from "../../src/processing/provenance.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { canonicalJson, sha256 } from "../../src/package/contract.js";
import {
  validationFetch,
  processingCost,
} from "../../src/assistant-rebuild/budget.js";
import { createHarness } from "../../src/assistant-rebuild/harness.js";
import { RebuildHost } from "../../src/assistant-rebuild/host.js";
import { fenceCheckpointer } from "../../src/assistant-rebuild/checkpointer.js";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "langchain";
import { z } from "zod";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const suffix = randomUUID().replaceAll("-", ""),
  databaseName = "rebuild_offline_" + suffix;
const base = loadConfig(),
  databaseUrl = base.databaseUrl.replace(/\/[^/]+$/, "/" + databaseName),
  origin = "http://127.0.0.1:4226";
const config = {
  ...base,
  databaseUrl,
  appOrigin: origin,
  soloOwnerMode: false,
  allowTestIdentity: false,
  modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
};
const db = createPool(databaseUrl),
  artifacts = new ArtifactRepository(base.minio);
let app: AgentBenchApp,
  headers: Record<string, string>,
  actorId: string,
  projectId: string,
  assetId: string,
  server: ReturnType<typeof createServer>,
  endpoint: string;
let child: ChildProcess | undefined, remoteUrl: string | undefined;
let onProviderRequest: undefined | (() => Promise<void>);
let outputs: any[] = [],
  requests: any[] = [],
  hold: Promise<void> | undefined,
  release: undefined | (() => void);
const call = (name: string, args: unknown) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: "call_" + randomUUID(),
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
  h = headers,
): Promise<any> {
  if (remoteUrl) {
    const response = await fetch(remoteUrl + url, {
      method,
      headers: {
        ...h,
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      body,
      json: () => JSON.parse(body),
      cookies: [],
    };
  }
  return app.inject({
    method,
    url,
    headers: {
      ...h,
      ...(payload !== undefined && typeof payload !== "string"
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(payload === undefined
      ? {}
      : {
          payload:
            typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
  });
}
async function restartChild() {
  child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/assistant-rebuild/offline-host.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        APP_ORIGIN: origin,
        MODEL_ENCRYPTION_KEY: config.modelEncryptionKey,
        SOLO_OWNER_MODE: "false",
        ALLOW_TEST_IDENTITY: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("host_restart_timeout")),
      15000,
    );
    child!.once("exit", (code) => {
      clearTimeout(timer);
      if (!remoteUrl) reject(Error("host_exited_" + code));
    });
    child!.stderr?.on("data", (part) => {
      buffer += part;
    });
    child!.stdout?.on("data", (part) => {
      buffer += part;
      for (const line of buffer.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.rebuildListening) {
            remoteUrl = value.rebuildListening;
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch {}
      }
    });
  });
}
async function stopChild() {
  if (!child) return;
  const exiting = new Promise<void>((resolve) =>
    child!.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  await exiting;
  child = undefined;
  remoteUrl = undefined;
}
const url = (id: string, tail = "") =>
  "/api/projects/" + projectId + "/assistant-validation/" + id + tail;
async function session() {
  const r = await api(
    "POST",
    "/api/projects/" + projectId + "/assistant-validation",
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json().session.id as string;
}
async function state(id: string) {
  const r = await api("GET", url(id));
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function wait(id: string, status: string[]) {
  for (let i = 0; i < 200; i++) {
    const value = await state(id);
    if (status.includes(value.session.status)) return value;
    await delay(25);
  }
  throw new Error("wait_timeout " + JSON.stringify(await state(id)));
}
async function send(id: string, text: string) {
  const r = await api("POST", url(id, "/messages"), { text });
  expect(r.statusCode, r.body).toBe(200);
}
async function running(id: string) {
  const token = randomUUID();
  const s = (
    await db.query(
      "UPDATE rebuild_session SET token=$2,status='running' WHERE id=$1 RETURNING *",
      [id, token],
    )
  ).rows[0];
  return {
    projectId,
    actorId,
    runtimeGuard: { sessionId: id, revision: s.revision, token },
  };
}
async function submit(id: string, operation = "clean", count = 3) {
  const scope = await running(id);
  const op = "offlineop_" + randomUUID();
  await db.query(
    "INSERT INTO rebuild_operation(id,session_id,revision,action,request_hash) VALUES($1,$2,$3,$4,$5)",
    [op, id, scope.runtimeGuard.revision, "processing", op],
  );
  const options =
    operation === "generate"
      ? {
          operation,
          instructions:
            "生成8条，预约操作和规则咨询各4条，Metadata中记录category。",
          allowedFields: ["question", "expectedOutput", "metadata"],
          outputCount: count,
          scenarios: [
            "新建预约",
            "修改时间",
            "取消预约",
            "查询预约",
            "时间范围",
            "时长规则",
            "预约数量",
            "迟到规则",
          ],
        }
      : {
          operation,
          instructions: operation === "rewrite" ? "保留原意换种说法" : "",
          allowedFields: ["question"],
        };
  return createProcessingRun(
    db,
    artifacts,
    { ...scope, runtimeGuard: { ...scope.runtimeGuard, operationId: op } },
    op,
    {
      source:
        operation === "generate"
          ? { kind: "background", id, recordIds: [] }
          : {
              kind: "assets",
              assetIds: [assetId],
              recordIds: Array.from(
                { length: count },
                (_, i) => assetId + ":" + (i + 1),
              ),
            },
      options,
    },
  );
}
async function complete(runId: string) {
  const run = await getProcessingRun(db, { projectId, actorId }, runId);
  const worker = "offline-worker";
  const job = (
    await db.query(
      "UPDATE job SET status='running',attempt=1,lease_owner=$2,lease_expires_at=now()+interval '2 minutes' WHERE id=$1 RETURNING *",
      [run.job_id, worker],
    )
  ).rows[0];
  const result = await runProcessing(db, artifacts, config, job);
  await db.query(
    "UPDATE job SET status='succeeded',progress=100,result=$2,counts=$3 WHERE id=$1",
    [job.id, JSON.stringify(result), JSON.stringify(result.counts)],
  );
  return result;
}
beforeAll(async () => {
  process.env.REBUILD_VALIDATION_ENABLED = "true";
  process.env.REBUILD_VALIDATION_CAMPAIGN_ID = "offline-" + suffix;
  const root = createPool(base.databaseUrl);
  await root.query("CREATE DATABASE " + databaseName);
  await root.end();
  await migrate(databaseUrl);
  await artifacts.initialize();
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    await onProviderRequest?.();
    if (hold) await hold;
    const next = outputs.shift() ?? {
      role: "assistant",
      content: "操作已完成。",
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "offline_" + randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "offline",
        choices: [
          {
            index: 0,
            message: next,
            finish_reason: next.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint =
    "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
  app = await buildApp(config, { disableLegacyTestBootstrap: true });
  const account = {
    email: "rebuild-admin@example.test",
    displayName: "验证管理员",
    password: "RebuildTest123!",
    confirmPassword: "RebuildTest123!",
  };
  expect(
    (await api("POST", "/api/installation/administrator", account, { origin }))
      .statusCode,
  ).toBe(201);
  const login = await api("POST", "/api/session", account, { origin });
  headers = {
    origin,
    cookie: login.cookies[0].name + "=" + login.cookies[0].value,
    "x-csrf-token": login.json().csrfToken,
  };
  actorId = login.json().actor.id;
  projectId = (
    await api("POST", "/api/projects", { name: "新运行时离线验证" })
  ).json().project.id;
  const collectionId = (
    await api("GET", "/api/projects/" + projectId + "/collections")
  ).json().collections[0].id;
  const content =
    Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        question: "  问题" + (i + 1) + "？  ",
        expectedOutput: "标签" + i,
        fixtureId: "r0" + (i + 1),
        channel: "网页",
        note: "",
      }),
    ).join("\n") + "\n";
  const upload = await api(
    "POST",
    "/api/projects/" + projectId + "/pending-uploads",
    content,
    {
      ...headers,
      "content-type": "application/octet-stream",
      "x-file-name": "offline.jsonl",
    },
  );
  expect(upload.statusCode, upload.body).toBe(201);
  const confirmed = await api(
    "POST",
    "/api/projects/" + projectId + "/pending-upload-batches/confirm",
    {
      collectionId,
      pendingUploadIds: [upload.json().pendingUpload.id],
      mode: "raw",
    },
    { ...headers, "idempotency-key": randomUUID() },
  );
  expect(confirmed.statusCode, confirmed.body).toBe(201);
  assetId = confirmed.json().assets[0].id;
  const murl = "/api/projects/" + projectId + "/assets/" + assetId + "/mapping";
  const mapping = await api("GET", murl);
  const mapped = await api("PUT", murl, {
    parsedViewId: mapping.json().parsedViewId,
    expectedRevision: 0,
    mapping: {
      question: "/question",
      expectedOutput: "/expectedOutput",
      metadata: ["/fixtureId", "/channel", "/note"],
    },
  });
  expect(mapped.statusCode, mapped.body).toBe(200);
  await saveModelConnection(db, config, actorId, {
    revision: 0,
    name: "离线协议夹具",
    endpoint,
    model: "offline",
    apiKey: "local-fixture-only",
    enabled: true,
  });
}, 30000);
afterAll(async () => {
  await stopChild();
  await app?.close();
  await db.end();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  delete process.env.REBUILD_VALIDATION_ENABLED;
  delete process.env.REBUILD_VALIDATION_CAMPAIGN_ID;
  delete process.env.REBUILD_VALIDATION_GRAPH_STEPS;
  console.log("Retained isolated fixture database:", databaseName);
});

it("F01: invalid type and unknown reference are corrected through the SDK and actual scoped business reads", async () => {
  const id = await session();
  requests = [];
  outputs = [
    call("read_records", { assetId, count: "错误类型" }),
    call("read_records", { assetId: "not-a-real-asset", count: 3 }),
    call("read_records", { assetId, count: 3 }),
    { role: "assistant", content: "已读取前三条。" },
  ];
  await send(id, "查看资料前三条");
  const finished = await wait(id, ["idle", "failed"]);
  expect(finished.session.status).toBe("idle");
  const results = (
    await db.query(
      "SELECT detail FROM rebuild_event WHERE session_id=$1 AND kind='tool_result' ORDER BY id",
      [id],
    )
  ).rows;
  expect(JSON.stringify(results)).toContain(assetId + ":3");
  expect(JSON.stringify(results)).not.toContain(assetId + ":4");
  expect(requests).toHaveLength(4);
  expect(
    Number(
      (await db.query("SELECT count(*) FROM assistant_session")).rows[0].count,
    ),
  ).toBe(0);
});
it("F02: rejects viewer/revoked identity, cross-project session and stale execution tokens at the shared commit", async () => {
  const id = await session(),
    scope = await running(id);
  const draft = await createSharedDraft(
    db,
    scope,
    { name: "权限保护" },
    "guard-" + id,
  );
  expect(draft.draft.id).toBeTruthy();
  await api("POST", url(id, "/stop"));
  await expect(
    createSharedDraft(db, scope, { name: "迟到写入" }, "late-" + id),
  ).rejects.toMatchObject({ code: "runtime_interrupted" });
  const other = (
    await api("POST", "/api/projects", { name: "另一隔离项目" })
  ).json().project.id;
  expect(
    (await api("GET", "/api/projects/" + other + "/assistant-validation/" + id))
      .statusCode,
  ).toBe(404);
  const account = {
    email: "viewer@example.test",
    password: "ViewerTest123!",
    confirmPassword: "ViewerTest123!",
  };
  expect(
    (await api("POST", "/api/accounts", account, { origin })).statusCode,
  ).toBe(201);
  const login = await api("POST", "/api/session", account, { origin });
  const viewer = login.json().actor.id;
  await db.query(
    "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer')",
    [projectId, viewer],
  );
  const vh = {
    origin,
    cookie: login.cookies[0].name + "=" + login.cookies[0].value,
    "x-csrf-token": login.json().csrfToken,
  };
  expect(
    (
      await api(
        "POST",
        "/api/projects/" + projectId + "/assistant-validation",
        undefined,
        vh,
      )
    ).statusCode,
  ).toBe(404);
  await db.query(
    "UPDATE project_member SET role='editor' WHERE project_id=$1 AND user_id=$2",
    [projectId, viewer],
  );
  const owned = await api(
    "POST",
    "/api/projects/" + projectId + "/assistant-validation",
    undefined,
    vh,
  );
  expect(owned.statusCode).toBe(200);
  await db.query(
    "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
    [projectId, viewer],
  );
  expect(
    (await api("GET", url(owned.json().session.id), "", vh)).statusCode,
  ).toBe(404);
});
it("F03: recovers the same committed receipt, rejects changed payloads, and does not duplicate drafts", async () => {
  const id = await session(),
    scope = await running(id),
    key = "lost-reply-" + id;
  const first = await createSharedDraft(db, scope, { name: "唯一草稿" }, key);
  const replay = await createSharedDraft(db, scope, { name: "唯一草稿" }, key);
  expect(replay.replayed).toBe(true);
  expect(replay.draft.id).toBe(first.draft.id);
  await expect(
    createSharedDraft(db, scope, { name: "换了内容" }, key),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(
    Number(
      (
        await db.query("SELECT count(*) FROM collaborative_draft WHERE id=$1", [
          first.draft.id,
        ])
      ).rows[0].count,
    ),
  ).toBe(1);
});
it("F04: survives host restart and lost terminal notification, then confirms actual processing results once", async () => {
  const id = await session();
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 3,
      name: "重启恢复草稿",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    call("submit_processing", {}),
  ];
  await send(id, "将前三条去掉首尾空格，保存草稿");
  const waiting = await wait(id, ["waiting", "failed"]);
  expect(waiting.session.status).toBe("waiting");
  const runId = waiting.session.waiting_run_id;
  await app.close();
  await complete(runId);
  outputs = [
    call("prepare_adoption", {}),
    { role: "assistant", content: "已保存。" },
  ];
  await restartChild();
  const ready = await wait(id, ["confirmation", "failed"]);
  expect(ready.session.status).toBe("confirmation");
  let confirmation = ready.confirmations.find(
    (c: any) => c.status === "pending",
  );
  const staleId = confirmation.id;
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 2,
      name: "修改后的恢复草稿",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    { role: "assistant", content: "已更新为两条。" },
    call("submit_processing", {}),
  ];
  await send(id, "改成前两条，保存为修改后的恢复草稿，现在执行。");
  const nextWait = await wait(id, ["waiting", "failed"]);
  expect(nextWait.session.status).toBe("waiting");
  expect(nextWait.session.requirements.count).toBe(2);
  expect(nextWait.session.waiting_run_id).not.toBe(runId);
  const stale = await api("POST", url(id, "/confirmations/" + staleId));
  expect(stale.statusCode, stale.body).toBe(409);
  outputs = [call("prepare_adoption", {})];
  await complete(nextWait.session.waiting_run_id);
  const renewed = await wait(id, ["confirmation", "failed"]);
  expect(renewed.session.status).toBe("confirmation");
  confirmation = renewed.confirmations.find(
    (c: any) =>
      c.status === "pending" && c.revision === renewed.session.revision,
  );
  expect(confirmation).toBeTruthy();
  const saved = await api("POST", url(id, "/confirmations/" + confirmation.id));
  expect(saved.statusCode, saved.body).toBe(200);
  const replay = await api(
    "POST",
    url(id, "/confirmations/" + confirmation.id),
  );
  expect(replay.statusCode, replay.body).toBe(200);
  await wait(id, ["idle", "failed"]);
  await db.query(
    "UPDATE rebuild_confirmation SET receipt=NULL,status='executing' WHERE id=$1",
    [confirmation.id],
  );
  const final = await state(id);
  expect(final.receipts[0].name).toBe("修改后的恢复草稿");
  expect(final.receipts[0].adopted).toBe(2);
  const rows = (
    await db.query(
      "SELECT question,metadata FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position",
      [final.receipts[0].draftId],
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0].question).toBe("问题1？");
  expect(rows[0].metadata).toEqual([
    { key: "fixtureId", value: "r01" },
    { key: "channel", value: "网页" },
    { key: "note", value: "" },
  ]);
  expect(
    Number(
      (
        await db.query("SELECT count(*) FROM processing_run WHERE id=$1", [
          runId,
        ])
      ).rows[0].count,
    ),
  ).toBe(1);
  await stopChild();
  app = await buildApp(config, { disableLegacyTestBootstrap: true });
});
it("F05: stop bypasses the active message mutex and fences a late model response", async () => {
  const id = await session();
  hold = new Promise<void>((r) => {
    release = r;
  });
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 2,
      name: "不能迟到写入",
      instructions: "",
      assetId,
      allowedFields: ["question"],
    }),
  ];
  await send(id, "清洗两条");
  await delay(80);
  const stop = await api("POST", url(id, "/stop"));
  expect(stop.statusCode, stop.body).toBe(200);
  expect(stop.json().session.status).toBe("paused");
  release?.();
  hold = undefined;
  await delay(80);
  const stopped = await state(id);
  expect(stopped.session.status).toBe("paused");
  expect(stopped.session).not.toHaveProperty("token");
  expect(stopped.session).not.toHaveProperty("source_snapshot");
  expect(stopped.session.requirements).toBeNull();
  expect(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM rebuild_operation WHERE session_id=$1",
          [id],
        )
      ).rows[0].count,
    ),
  ).toBe(0);
});
it("F06: preserves actual request accounting and stops before overspending after a new client/host", async () => {
  const cid = "offline-budget-" + suffix;
  await db.query(
    "INSERT INTO rebuild_campaign(id,max_requests,max_rows,max_generated,max_minutes) VALUES($1,1,1,1,180)",
    [cid],
  );
  const request = validationFetch(db, cid, { kind: "probe" });
  const opts = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "offline", messages: [] }),
  };
  await processingCost.run({ rows: 1, generated: 1 }, () =>
    request(endpoint + "/chat/completions", opts),
  );
  await expect(
    validationFetch(db, cid, { kind: "probe" })(
      endpoint + "/chat/completions",
      opts,
    ),
  ).rejects.toMatchObject({ code: "validation_budget_exhausted" });
  const c = (
    await db.query(
      "SELECT requests,rows,generated FROM rebuild_campaign WHERE id=$1",
      [cid],
    )
  ).rows[0];
  expect(c).toEqual({ requests: 1, rows: 1, generated: 1 });
});
it("F07: runs the real summarization middleware and retains explicit current requirements", async () => {
  const saver = new PostgresSaver(db, undefined, {
    schema: "assistant_rebuild_checkpoints",
  });
  const observations: string[] = [];
  const model = new ChatOpenAI({
    apiKey: "local-fixture-only",
    model: "offline",
    maxRetries: 0,
    configuration: { baseURL: endpoint },
  });
  const id = await session();
  for (const count of [5, 2]) {
    outputs = [
      call("set_requirements", {
        mode: "plan",
        operation: "clean",
        count,
        name: count === 5 ? "旧计划" : "精简版",
        instructions: "仅整理问题首尾空白",
        assetId,
        allowedFields: ["question"],
        scenarios: [],
      }),
      { role: "assistant", content: "方案已保存。" },
    ];
    await send(id, "改为" + count + "条的方案，暂不执行");
    expect((await wait(id, ["idle", "failed"])).session.status).toBe("idle");
  }
  const current = (await state(id)).session.requirements;
  expect(current.count).toBe(2);
  const read = tool(
    async () => ({
      currentRequirements: (
        await db.query("SELECT requirements FROM rebuild_session WHERE id=$1", [
          id,
        ])
      ).rows[0].requirements,
    }),
    {
      name: "read_current",
      description: "读取当前要求",
      schema: z.object({ count: z.number().int() }),
    },
  );
  requests = [];
  outputs = [
    { role: "assistant", content: "旧要求已改为2条，保存目标是精简版。" },
    call("read_current", { count: 2 }),
    { role: "assistant", content: "当前为2条。" },
  ];
  const agent = createHarness({
    model,
    tools: [read],
    systemPrompt: "当前服务端唯一要求：" + JSON.stringify(current),
    checkpointer: saver,
    summaryTokens: 100,
    observe: async (k) => {
      observations.push(k);
    },
  });
  const history = Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "历史方案5条旧名称。".repeat(15),
  }));
  const result = await agent.invoke(
    { messages: [...history, { role: "user", content: "按当前两条要求继续" }] },
    { configurable: { thread_id: "summary-" + suffix }, recursionLimit: 30 },
  );
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(requests)).toContain("精简版");
  expect(JSON.stringify(result)).toContain("2");
  expect(observations).toContain("tool_result");
  const checkpoint = (await agent.getState({
    configurable: { thread_id: "summary-" + suffix },
  })) as StateSnapshot;
  expect(JSON.stringify(checkpoint.values)).toContain("conversation_history");
});
it("F08: deduplicates across real Worker batches, replenishes only missing slots and retains semantic neighbours", async () => {
  const id = await session();
  const doc = await api("POST", url(id, "/documents"), {
    name: "预约背景.md",
    content: Buffer.from(
      "预约操作：新建、修改、取消、查询。规则咨询：时间、时长、数量、迟到。",
    ).toString("base64"),
  });
  expect(doc.statusCode, doc.body).toBe(200);
  const made = await submit(id, "generate", 8);
  const row = (n: number, q = "完整场景问题" + n + "？") => ({
    question: q,
    expectedOutput: n <= 4 ? "预约操作" : "规则咨询",
    metadata: [
      { key: "category", value: n <= 4 ? "预约操作" : "规则咨询" },
      { key: "context", value: String(n) },
    ],
  });
  const workerReply = (rows: any[]) => ({
    role: "assistant",
    content: JSON.stringify({ records: rows }),
  });
  outputs = [
    workerReply([
      row(1),
      row(2),
      row(3, "如何修改明天的预约？"),
      row(4, "如何修改后天的预约？"),
    ]),
    workerReply([
      row(9, "完整场景问题1？"),
      row(10, "  完整场景问题2？  "),
      row(5),
      row(6),
    ]),
    workerReply([row(7), row(8)]),
  ];
  await complete(made.run.id);
  const data = await readProcessingRun(
    db,
    artifacts,
    { projectId, actorId },
    made.run.id,
    { limit: "100" },
    true,
  );
  expect(data.total).toBe(8);
  expect(new Set(data.records.map((r) => r.result.question.trim())).size).toBe(
    8,
  );
  expect(
    data.records.filter((r) => r.result.question.includes("如何修改")),
  ).toHaveLength(2);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM processing_batch WHERE run_id=$1",
        [made.run.id],
      )
    ).rows[0].n,
  ).toBe(2);
  const before = requests.length;
  await complete(made.run.id);
  expect(requests).toHaveLength(before);
  expect(
    (
      await readProcessingRun(
        db,
        artifacts,
        { projectId, actorId },
        made.run.id,
        { limit: "100" },
        true,
      )
    ).total,
  ).toBe(8);
});

it("F02 scope: a changed draft cannot silently refresh the frozen processing input", async () => {
  const id = await session();
  const draft = await createSharedDraft(
    db,
    { projectId, actorId },
    { name: "并发输入草稿" },
    "frozen-source-" + id,
  );
  const recordUrl =
    "/api/projects/" +
    projectId +
    "/collaborative-drafts/" +
    draft.draft.id +
    "/records";
  const added = await api("POST", recordUrl, {
    question: "原始问题",
    expectedOutput: "保留标签",
    metadata: [],
  });
  expect(added.statusCode, added.body).toBe(201);
  const record = added.json().record;
  const source = { kind: "draft", id: draft.draft.id, recordIds: [record.id] };
  const before = await previewProcessingInput(
    db,
    { projectId, actorId },
    { source, limit: 1 },
  );
  const inputHash = sha256(
    canonicalJson({
      records: before.records,
      revision: before.revision ?? null,
    }),
  );
  const changed = await api("PATCH", recordUrl + "/" + record.id, {
    field: "question",
    value: "他人修改后的问题",
    expectedFieldRevision: record.questionRevision,
  });
  expect(changed.statusCode, changed.body).toBe(200);
  const scope = await running(id);
  await expect(
    createProcessingRun(
      db,
      artifacts,
      { ...scope, expectedInputHash: inputHash },
      "stale-source-" + id,
      {
        source,
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    ),
  ).rejects.toMatchObject({ code: "processing_scope_changed" });
});
it("F06 segments: automatically carries a progressing graph over at least three persisted execution segments", async () => {
  process.env.REBUILD_VALIDATION_GRAPH_STEPS = "6";
  const id = await session();
  outputs = [
    call("read_records", { assetId, count: 1 }),
    call("read_records", { assetId, count: 2 }),
    call("read_records", { assetId, count: 3 }),
    call("read_records", { assetId, count: 4 }),
    { role: "assistant", content: "查询完成。" },
  ];
  await send(id, "按顺序查看不同数量的记录");
  const done = await wait(id, ["idle", "failed"]);
  delete process.env.REBUILD_VALIDATION_GRAPH_STEPS;
  expect(done.session.status).toBe("idle");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM rebuild_event WHERE session_id=$1 AND kind='execution_segment'",
        [id],
      )
    ).rows[0].n,
  ).toBeGreaterThanOrEqual(2);
});
it("F06 timeout: a timed-out actual HTTP attempt stays charged with an unknown outcome", async () => {
  const cid = "offline-timeout-" + suffix;
  await db.query(
    "INSERT INTO rebuild_campaign(id,max_requests,max_rows,max_generated,max_minutes) VALUES($1,1,5,0,180)",
    [cid],
  );
  hold = new Promise<void>((r) => {
    release = r;
  });
  const request = validationFetch(db, cid, { kind: "probe" });
  const failed = request(endpoint + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "offline", messages: [] }),
    signal: AbortSignal.timeout(25),
  });
  await expect(failed).rejects.toThrow();
  release?.();
  hold = undefined;
  const budget = (
    await db.query("SELECT requests FROM rebuild_campaign WHERE id=$1", [cid])
  ).rows[0];
  expect(budget.requests).toBe(1);
  const last = (
    await db.query(
      "SELECT error_code,ended_at FROM rebuild_request WHERE campaign_id=$1",
      [cid],
    )
  ).rows[0];
  expect(last.error_code).toBeTruthy();
  expect(last.ended_at).toBeTruthy();
});
it("F06 no-progress: repeated successful reads stop without consuming the entire campaign", async () => {
  const id = await session();
  outputs = Array.from({ length: 8 }, () =>
    call("read_records", { assetId, count: 1 }),
  );
  const start = requests.length;
  await send(id, "查看当前记录");
  const stopped = await wait(id, ["idle", "failed"]);
  expect(stopped.session.status).toBe("failed");
  expect(requests.length - start).toBeLessThanOrEqual(3);
  const failure = (
    await db.query(
      "SELECT detail FROM rebuild_event WHERE session_id=$1 AND kind='execution_error' ORDER BY id DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  expect(failure.detail.message).toBe("no_progress");
  outputs = [];
});

it("F02 context: unavailable sources are rejected before persisted conversation or model context is returned", async () => {
  const id = await session();
  outputs = [
    call("read_records", { assetId, count: 1 }),
    { role: "assistant", content: "读到一条。" },
  ];
  await send(id, "查看第一条");
  expect((await wait(id, ["idle", "failed"])).session.status).toBe("idle");
  const before = requests.length;
  await db.query("UPDATE data_asset SET status='archived' WHERE id=$1", [
    assetId,
  ]);
  const blocked = await api("GET", url(id));
  expect(blocked.statusCode).toBe(404);
  expect(blocked.body).not.toContain("问题1");
  expect(
    (await api("POST", url(id, "/messages"), { text: "再显示刚才的问题" }))
      .statusCode,
  ).toBe(404);
  expect(requests).toHaveLength(before);
  await db.query("UPDATE data_asset SET status='stored' WHERE id=$1", [
    assetId,
  ]);
});

it("F01 injection: preserves provider arguments, mutates once before SDK parsing, and executes only the corrected read", async () => {
  const id = await session();
  await db.query(
    "INSERT INTO rebuild_fault(session_id,kind,tool_name) VALUES($1,'type','read_records')",
    [id],
  );
  outputs = [
    call("read_records", { assetId, count: 3 }),
    call("read_records", { assetId, count: 3 }),
    { role: "assistant", content: "读取完成。" },
  ];
  await send(id, "查看前三条");
  expect((await wait(id, ["idle", "failed"])).session.status).toBe("idle");
  const fault = (
    await db.query("SELECT * FROM rebuild_fault WHERE session_id=$1", [id])
  ).rows[0];
  expect(fault.trigger_count).toBe(1);
  expect(fault.origin).toBe("injected");
  expect(JSON.parse(fault.original_args).count).toBe(3);
  expect(typeof JSON.parse(fault.sdk_args).count).toBe("string");
  const request = (
    await db.query(
      "SELECT response,sdk_response FROM rebuild_request WHERE id=$1",
      [fault.request_id],
    )
  ).rows[0];
  expect(
    JSON.parse(
      request.response.choices[0].message.tool_calls[0].function.arguments,
    ).count,
  ).toBe(3);
  expect(
    typeof JSON.parse(
      request.sdk_response.choices[0].message.tool_calls[0].function.arguments,
    ).count,
  ).toBe("string");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM rebuild_event WHERE session_id=$1 AND kind='tool_result'",
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("F01 truncate: a truncated processing submission is corrected before one real job and one save", async () => {
  const id = await session();
  await db.query(
    "INSERT INTO rebuild_fault(session_id,kind,tool_name) VALUES($1,'truncate','submit_processing')",
    [id],
  );
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 3,
      name: "截断纠错草稿",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    call("submit_processing", {}),
    call("submit_processing", {}),
  ];
  await send(id, "清洗前三条，保留其他字段并保存为截断纠错草稿");
  const waiting = await wait(id, ["waiting", "failed"]);
  expect(waiting.session.status).toBe("waiting");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM rebuild_operation WHERE session_id=$1 AND run_id IS NOT NULL",
        [id],
      )
    ).rows[0].n,
  ).toBe(1);
  const fault = (
    await db.query("SELECT * FROM rebuild_fault WHERE session_id=$1", [id])
  ).rows[0];
  expect(fault.sdk_args).toBe("{");
  expect(fault.original_args).toBe("{}");
  outputs = [
    call("prepare_adoption", {}),
    { role: "assistant", content: "已保存。" },
  ];
  await complete(waiting.session.waiting_run_id);
  const ready = await wait(id, ["confirmation", "failed"]);
  expect(ready.session.status).toBe("confirmation");
  const c = ready.confirmations.find((item: any) => item.status === "pending");
  expect(
    (await api("POST", url(id, "/confirmations/" + c.id))).statusCode,
  ).toBe(200);
  await wait(id, ["idle", "failed"]);
  expect((await state(id)).receipts[0].adopted).toBe(3);
});

it("F05 checkpoint: a stopped execution cannot overwrite a real persistent checkpoint", async () => {
  const id = await session(),
    scope = await running(id);
  const checkpointPool = createPool(databaseUrl);
  const saver = fenceCheckpointer(
    new PostgresSaver(checkpointPool, undefined, {
      schema: "assistant_rebuild_checkpoints",
    }),
    db,
  );
  try {
    const model = new ChatOpenAI({
      apiKey: "local-fixture-only",
      model: "offline",
      maxRetries: 0,
      configuration: { baseURL: endpoint },
    });
    outputs = [{ role: "assistant", content: "持久状态" }];
    const agent = createHarness({
      model,
      tools: [],
      systemPrompt: "保存状态",
      checkpointer: saver,
    });
    const config = {
      configurable: {
        thread_id: id,
        execution_token: scope.runtimeGuard.token,
      },
    };
    await agent.invoke(
      { messages: [{ role: "user", content: "查询状态" }] },
      config,
    );
    const checkpoint = await saver.getTuple(config);
    expect(checkpoint).toBeTruthy();
    expect(JSON.stringify(requests)).not.toContain(scope.runtimeGuard.token);
    await api("POST", url(id, "/stop"));
    await expect(
      saver.put(config, checkpoint!.checkpoint, checkpoint!.metadata!, {}),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
    await expect(
      saver.putWrites(config, [], "late-task"),
    ).rejects.toMatchObject({ code: "runtime_interrupted" });
  } finally {
    await checkpointPool.end();
  }
});

it("F02 confirmation: changed candidate content invalidates the frozen card and needs a fresh confirmation", async () => {
  const id = await session();
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 1,
      name: "固定候选草稿",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    call("submit_processing", {}),
  ];
  await send(id, "整理第一条并保存草稿");
  const waiting = await wait(id, ["waiting", "failed"]);
  expect(waiting.session.status).toBe("waiting");
  outputs = [call("prepare_adoption", {})];
  await complete(waiting.session.waiting_run_id);
  const ready = await wait(id, ["confirmation", "failed"]);
  expect(ready.session.status).toBe("confirmation");
  const oldCard = ready.confirmations.find((c: any) => c.status === "pending");
  const batch = (
    await db.query(
      "SELECT ordinal,result_ref FROM processing_batch WHERE run_id=$1 ORDER BY ordinal LIMIT 1",
      [waiting.session.waiting_run_id],
    )
  ).rows[0];
  const body = JSON.parse(
    (await artifacts.readBytes(batch.result_ref, 1000000)).toString("utf8"),
  );
  body.records[0].question = "并发改变的候选";
  const changed = await artifacts.storeProcessing(
    Buffer.from(JSON.stringify(body)),
    waiting.session.waiting_run_id,
    "batch-" + batch.ordinal,
  );
  await db.query(
    "UPDATE processing_batch SET result_ref=$2 WHERE run_id=$1 AND ordinal=$3",
    [waiting.session.waiting_run_id, changed.objectRef, batch.ordinal],
  );
  const denied = await api("POST", url(id, "/confirmations/" + oldCard.id));
  expect(denied.statusCode, denied.body).toBe(409);
  expect(denied.json().error.code).toBe("confirmation_changed");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM processing_acceptance WHERE run_id=$1",
        [waiting.session.waiting_run_id],
      )
    ).rows[0].n,
  ).toBe(0);
  await db.query(
    "UPDATE processing_batch SET result_ref=$2 WHERE run_id=$1 AND ordinal=$3",
    [waiting.session.waiting_run_id, batch.result_ref, batch.ordinal],
  );
  await api("POST", url(id, "/continue"));
  const renewed = await wait(id, ["confirmation", "failed"]);
  expect(renewed.session.status).toBe("confirmation");
  const fresh = renewed.confirmations.find((c: any) => c.status === "pending");
  expect(fresh.id).not.toBe(oldCard.id);
  expect(
    (await api("POST", url(id, "/confirmations/" + fresh.id))).statusCode,
  ).toBe(200);
  expect((await wait(id, ["idle", "failed"])).receipts[0].adopted).toBe(1);
});

it("F05 dispatch: a stale terminal notification cannot undo a completed user stop", async () => {
  const id = await session();
  const { run } = await submit(id);
  await complete(run.id);
  await app.close();
  await db.query("UPDATE rebuild_session SET status='waiting' WHERE id=$1", [
    id,
  ]);
  let releaseSnapshot!: () => void;
  let observed!: () => void;
  const snapshotReady = new Promise<void>((r) => {
    observed = r;
  });
  const snapshotRelease = new Promise<void>((r) => {
    releaseSnapshot = r;
  });
  const query = db.query.bind(db);
  const gated = Object.assign(Object.create(db), {
    query: async (...args: any[]) => {
      const result = await (query as any)(...args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(
          "SELECT s.* FROM rebuild_session s JOIN processing_run",
        )
      ) {
        observed();
        await snapshotRelease;
      }
      return result;
    },
  }) as typeof db;
  const host = new RebuildHost(gated, artifacts, config, "offline-" + suffix);
  try {
    const campaign = (
      await db.query("SELECT campaign_id FROM rebuild_session WHERE id=$1", [
        id,
      ])
    ).rows[0].campaign_id;
    host.campaignId = campaign;
    const before = Number(
      (await db.query("SELECT count(*) FROM rebuild_request")).rows[0].count,
    );
    const dispatching = host.dispatch();
    await snapshotReady;
    await host.stop({ projectId, actorId }, id);
    releaseSnapshot();
    await dispatching;
    const final = await host.present({ projectId, actorId }, id);
    expect(final.session.status).toBe("paused");
    expect(
      Number(
        (await db.query("SELECT count(*) FROM rebuild_request")).rows[0].count,
      ),
    ).toBe(before);
    expect(
      (await getProcessingRun(db, { projectId, actorId }, run.id)).status,
    ).toBe("succeeded");
  } finally {
    releaseSnapshot?.();
    await host.close();
    app = await buildApp(config, { disableLegacyTestBootstrap: true });
  }
});

it("F05 pending replacement: stop wins over a late control-model completion", async () => {
  const id = await session();
  outputs = [
    call("set_requirements", {
      mode: "plan",
      operation: "clean",
      count: 3,
      name: "待修改",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    { role: "assistant", content: "方案已保存" },
  ];
  await send(id, "先计划前三条，不执行");
  await wait(id, ["idle"]);
  await api("POST", url(id, "/stop"));
  let unlock!: () => void, reached!: () => void;
  const barrier = new Promise<void>((r) => {
    unlock = r;
  });
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  let calls = 0;
  onProviderRequest = async () => {
    if (++calls === 2) {
      reached();
      await barrier;
    }
  };
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 2,
      name: "已修改",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    { role: "assistant", content: "修改已保存" },
  ];
  try {
    await send(id, "改成前两条，名字改为已修改，现在执行");
    await entered;
    const replacement = await state(id);
    expect(replacement.session.requirements.count).toBe(2);
    const count = requests.length;
    await api("POST", url(id, "/stop"));
    unlock();
    await delay(120);
    expect((await state(id)).session.status).toBe("paused");
    expect(requests).toHaveLength(count);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM rebuild_operation WHERE session_id=$1",
            [id],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
  } finally {
    unlock();
    onProviderRequest = undefined;
  }
});

it("F05 pending cancellation: stopping after replacement commit still finds the original job", async () => {
  const id = await session();
  const { run } = await submit(id);
  await app.close();
  const prior = (
    await db.query(
      "UPDATE rebuild_session SET status='waiting' WHERE id=$1 RETURNING *",
      [id],
    )
  ).rows[0];
  let releaseCommit!: () => void, committed!: () => void;
  const commitBarrier = new Promise<void>((r) => {
    releaseCommit = r;
  });
  const commitReady = new Promise<void>((r) => {
    committed = r;
  });
  let gatedOnce = false;
  const gatedDb = Object.assign(Object.create(db), {
    query: db.query.bind(db),
    connect: async () => {
      const client = await db.connect();
      return {
        query: async (...args: any[]) => {
          const result = await (client.query.bind(client) as any)(...args);
          if (args[0] === "COMMIT" && !gatedOnce) {
            gatedOnce = true;
            committed();
            await commitBarrier;
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  }) as typeof db;
  const host = new RebuildHost(gatedDb, artifacts, config, prior.campaign_id);
  try {
    const pending = (host as any).replacePending(
      prior,
      {
        mode: "plan",
        operation: "clean",
        count: 2,
        name: "取消前修改",
        instructions: "",
        assetId,
        allowedFields: ["question"],
        scenarios: [],
      },
      null,
    );
    const outcome = pending.catch((e: any) => e);
    await commitReady;
    expect(
      (
        await db.query(
          "SELECT waiting_run_id FROM rebuild_session WHERE id=$1",
          [id],
        )
      ).rows[0].waiting_run_id,
    ).toBe(run.id);
    await host.stop({ projectId, actorId }, id);
    releaseCommit();
    expect((await outcome).code).toBe("runtime_interrupted");
    expect(
      (await host.present({ projectId, actorId }, id)).session.status,
    ).toBe("paused");
    expect(
      (await getProcessingRun(db, { projectId, actorId }, run.id)).status,
    ).toBe("cancel_requested");
  } finally {
    releaseCommit?.();
    await host.close();
    app = await buildApp(config, { disableLegacyTestBootstrap: true });
  }
});

it("R1 paused Worker: SDK stop/query/resume retains attempts and completed work after the original deadline", async () => {
  const id = await session();
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "rewrite",
      count: 2,
      name: "暂停恢复",
      instructions: "保留原意，换种自然说法",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    call("submit_processing", {}),
  ];
  await send(id, "改写前两条并保存草稿");
  const waiting = await wait(id, ["waiting", "failed"]);
  expect(waiting.session.status).toBe("waiting");
  const runId = waiting.session.waiting_run_id;
  const run = await getProcessingRun(db, { projectId, actorId }, runId);
  let entered!: () => void, releaseWorker!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (releaseWorker = r));
  onProviderRequest = async () => {
    entered();
    await gate;
  };
  const rows = (
    await previewProcessingInput(
      db,
      { projectId, actorId },
      { source: { kind: "assets", assetIds: [assetId] }, limit: 2 },
    )
  ).records.map((r) => ({
    sourceId: r.id,
    question: "自然改写：" + r.question.trim(),
    expectedOutput: r.expectedOutput,
    metadata: r.metadata,
  }));
  outputs = [{ role: "assistant", content: JSON.stringify({ records: rows }) }];
  const interrupted = complete(runId).then(
    () => "unexpected_success",
    () => "cancelled",
  );
  try {
    await started;
    expect((await api("POST", url(id, "/stop"))).statusCode).toBe(200);
  } finally {
    onProviderRequest = undefined;
    releaseWorker();
  }
  expect(await interrupted).toBe("cancelled");
  await db.query(
    "UPDATE job SET status='cancelled',stage='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",
    [run.job_id],
  );
  // Persisted-clock fixture: the user waited longer than the original single-call deadline.
  await db.query(
    "UPDATE processing_batch SET model_started_at=now()-interval '2 minutes' WHERE run_id=$1",
    [runId],
  );
  const before = (
    await db.query(
      "SELECT model_attempts,model_started_at FROM processing_batch WHERE run_id=$1",
      [runId],
    )
  ).rows[0];
  expect(before.model_attempts).toBe(1);
  const paused = await readProcessingRun(
    db,
    artifacts,
    { projectId, actorId },
    runId,
    { limit: "100" },
  );
  expect(paused.recovery.canRetry).toBe(true);
  const workerCalls = (
    await db.query(
      "SELECT count(*)::int n FROM rebuild_request WHERE run_id=$1",
      [runId],
    )
  ).rows[0].n;
  outputs = [
    call("read_processing", {}),
    { role: "assistant", content: "任务暂停，尚未保存；继续后处理剩余内容。" },
  ];
  await send(id, "先别继续，现在做到哪了？");
  for (let i = 0; i < 100; i++) {
    if (
      (await state(id)).messages.some(
        (m: any) =>
          m.role === "assistant" && m.content.includes("任务暂停，尚未保存"),
      )
    )
      break;
    await delay(25);
  }
  expect(
    (await state(id)).messages.some((m: any) =>
      m.content.includes("任务暂停，尚未保存"),
    ),
  ).toBe(true);
  expect((await state(id)).session.status).toBe("paused");
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM rebuild_request WHERE run_id=$1",
        [runId],
      )
    ).rows[0].n,
  ).toBe(workerCalls);
  outputs = [call("submit_processing", {})];
  expect((await api("POST", url(id, "/continue"))).statusCode).toBe(200);
  expect((await wait(id, ["waiting", "failed"])).session.status).toBe(
    "waiting",
  );
  outputs = [
    { role: "assistant", content: JSON.stringify({ records: rows }) },
    call("prepare_adoption", {}),
  ];
  await complete(runId);
  const ready = await wait(id, ["confirmation", "failed"]);
  expect(ready.session.status).toBe("confirmation");
  const after = (
    await db.query(
      "SELECT model_attempts,model_started_at FROM processing_batch WHERE run_id=$1",
      [runId],
    )
  ).rows[0];
  expect(after.model_attempts).toBe(2);
  expect(after.model_started_at).toEqual(before.model_started_at);
  const card = ready.confirmations.find((c: any) => c.status === "pending");
  expect(
    (await api("POST", url(id, "/confirmations/" + card.id))).statusCode,
  ).toBe(200);
  const saved = await wait(id, ["idle", "failed"]);
  expect(saved.receipts).toHaveLength(1);
  expect(saved.receipts[0].adopted).toBe(2);
  await complete(runId);
  expect(
    (
      await db.query(
        "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
        [runId],
      )
    ).rows[0].model_attempts,
  ).toBe(2);
});

it("R2 provenance: generated output links to its owned validation session", async () => {
  const id = await session();
  expect(
    (
      await api("POST", url(id, "/documents"), {
        name: "预约背景.md",
        content: Buffer.from("预约可新建或取消。").toString("base64"),
      })
    ).statusCode,
  ).toBe(200);
  const made = await submit(id, "generate", 2);
  outputs = [
    {
      role: "assistant",
      content: JSON.stringify({
        records: [
          {
            question: "明天上午还有可以预约的时段吗？",
            expectedOutput: "查询可用时段",
            metadata: [],
          },
          {
            question: "我临时有事，怎么取消明天的预约？",
            expectedOutput: "说明取消方式",
            metadata: [],
          },
        ],
      }),
    },
  ];
  await complete(made.run.id);
  const source = await processingReferences(
    db,
    artifacts,
    { projectId, actorId },
    made.run.id,
  );
  expect(source?.steps.length).toBeGreaterThan(0);
  expect(
    source?.steps.every(
      (s) =>
        s.href ===
        "/projects/" + projectId + "/assistant-validation?session=" + id,
    ),
  ).toBe(true);
  expect((await api("GET", url(id))).statusCode).toBe(200);
  const oldCampaign = "closed-" + id;
  await db.query(
    "INSERT INTO rebuild_campaign(id,max_requests,max_rows,max_generated,max_minutes,closed_at) VALUES($1,1,1,1,1,now())",
    [oldCampaign],
  );
  await db.query("UPDATE rebuild_session SET campaign_id=$2 WHERE id=$1", [
    id,
    oldCampaign,
  ]);
  const old = await api("GET", url(id));
  expect(old.statusCode).toBe(200);
  expect(old.json().session.readonly).toBe(true);
  expect(old.json().documents[0].name).toBe("预约背景.md");
  for (const suffix of [
    "/continue",
    "/stop",
    "/messages",
    "/documents",
    "/confirmations/missing",
  ]) {
    expect(
      (
        await api(
          "POST",
          url(id, suffix),
          suffix === "/documents"
            ? {
                name: "新背景.md",
                content: Buffer.from("不应写入").toString("base64"),
              }
            : { text: "继续" },
        )
      ).statusCode,
    ).toBe(404);
  }
  expect(
    (
      await db.query("SELECT requests FROM rebuild_campaign WHERE id=$1", [
        oldCampaign,
      ])
    ).rows[0].requests,
  ).toBe(0);
});

it("R3 confirmation renewal: expired cards stay expired; unknown commits reconcile once and receipts are unique", async () => {
  const id = await session();
  outputs = [
    call("set_requirements", {
      mode: "execute",
      operation: "clean",
      count: 2,
      name: "唯一回执",
      instructions: "",
      assetId,
      allowedFields: ["question"],
      scenarios: [],
    }),
    call("submit_processing", {}),
  ];
  await send(id, "清洗前两条并保存为唯一回执");
  const waiting = await wait(id, ["waiting", "failed"]);
  outputs = [call("prepare_adoption", {})];
  await complete(waiting.session.waiting_run_id);
  const ready = await wait(id, ["confirmation", "failed"]);
  const oldCard = ready.confirmations.find((c: any) => c.status === "pending");
  await delay(250); // Let the confirmation checkpoint finish before the next control action.
  await api("POST", url(id, "/stop"));
  outputs = [call("prepare_adoption", {})];
  await api("POST", url(id, "/continue"));
  const renewed = await wait(id, ["confirmation", "failed"]);
  const fresh = renewed.confirmations.find((c: any) => c.status === "pending");
  expect(fresh.id).not.toBe(oldCard.id);
  expect(
    (await api("POST", url(id, "/confirmations/" + oldCard.id))).statusCode,
  ).toBe(409);
  expect(
    (await api("POST", url(id, "/confirmations/" + fresh.id))).statusCode,
  ).toBe(200);
  await wait(id, ["idle", "failed"]);
  await db.query(
    "UPDATE rebuild_confirmation SET receipt=NULL,status='executing' WHERE id=$1",
    [fresh.id],
  );
  const reconciled = await state(id);
  expect(
    reconciled.confirmations.find((c: any) => c.id === oldCard.id).status,
  ).toBe("expired");
  expect(
    reconciled.confirmations.find((c: any) => c.id === oldCard.id).receipt,
  ).toBeNull();
  expect(reconciled.receipts).toHaveLength(1);
  expect(reconciled.receipts[0].adopted).toBe(2);
  expect((await state(id)).receipts).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM processing_acceptance WHERE run_id=$1",
        [waiting.session.waiting_run_id],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("R4 timeout policy: exhausted attempts still block; historical deadlines and shared generation limits stay bounded", async () => {
  const id = await session();
  const made = await submit(id, "rewrite", 1);
  const scope = { projectId, actorId };
  await db.query("UPDATE job SET status='cancelled' WHERE id=$1", [
    made.run.jobId,
  ]);
  await db.query(
    "INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at) VALUES($1,0,1,now()-interval '2 minutes')",
    [made.run.id],
  );
  let run = await getProcessingRun(db, scope, made.run.id);
  expect((await processingRecovery(db, run)).canRetry).toBe(true);
  await db.query(
    "UPDATE processing_batch SET model_attempts=3 WHERE run_id=$1",
    [run.id],
  );
  expect((await processingRecovery(db, run)).canRetry).toBe(false);
  await db.query(
    "UPDATE processing_batch SET model_attempts=1 WHERE run_id=$1",
    [run.id],
  );
  await db.query(
    "UPDATE processing_run SET execution_config=execution_config-'timeoutScope' WHERE id=$1",
    [run.id],
  );
  run = await getProcessingRun(db, scope, run.id);
  expect((await processingRecovery(db, run)).canRetry).toBe(false);

  const genId = await session();
  await api("POST", url(genId, "/documents"), {
    name: "背景.md",
    content: Buffer.from("预约可查询和取消。").toString("base64"),
  });
  const gen = await submit(genId, "generate", 2);
  await db.query(
    "INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at) VALUES($1,0,1,now()-interval '2 minutes')",
    [gen.run.id],
  );
  const budget = await generationBudget(db, gen.run.id);
  expect(budget).toMatchObject({
    used: 1,
    remaining: 2,
    exhausted: false,
    deadline: null,
  });
  await db.query(
    "UPDATE processing_batch SET model_attempts=3 WHERE run_id=$1",
    [gen.run.id],
  );
  expect(await generationBudget(db, gen.run.id)).toMatchObject({
    used: 3,
    remaining: 0,
    exhausted: true,
  });
  await db.query(
    "UPDATE processing_batch SET model_attempts=1 WHERE run_id=$1",
    [gen.run.id],
  );
  await db.query(
    "UPDATE processing_run SET execution_config=execution_config-'timeoutScope' WHERE id=$1",
    [gen.run.id],
  );
  expect(await generationBudget(db, gen.run.id)).toMatchObject({
    used: 1,
    exhausted: true,
  });
});
