import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { revisePlan, planRequirementsKey } from "../../src/assistant/plan.js";
import { deliveryGoals } from "../../src/assistant/delivery-plan.js";
import { queueContinuation } from "../../src/assistant/tasks.js";

const origin = "http://127.0.0.1:4217";
const rootUrl = loadConfig().databaseUrl;
const databaseName = "assistant_intent_" + randomUUID().replaceAll("-", "");
const databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + databaseName);
type Call = {
  name: string;
  input: Record<string, unknown>;
  rawInput?: string;
  finishReason?: string;
};
let script: Call[] = [];
let observed: any[] = [];
let prose = "当前状态已核对，原有成果保留。";
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  observed.push(JSON.parse(raw));
  let call = script.shift();
  const body = observed.at(-1);
  if (
    !call &&
    (body.tool_choice === "required" ||
      body.tool_choice?.function?.name === "plan_task") &&
    prose === "当前状态已核对，原有成果保留。"
  )
    call = {
      name: "plan_task",
      input: { control: { mode: "query", explanation: prose } },
    };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: randomUUID(),
      object: "chat.completion",
      created: 1,
      model: "synthetic",
      choices: [
        {
          index: 0,
          finish_reason: call?.finishReason ?? (call ? "tool_calls" : "stop"),
          message: call
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: randomUUID(),
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: call.rawInput ?? JSON.stringify(call.input),
                    },
                  },
                ],
              }
            : { role: "assistant", content: prose },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    }),
  );
});

describe("OPT42 per-turn intent public boundary", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let projectId: string;
  const base = () => "/api/projects/" + projectId + "/assistant";
  beforeAll(async () => {
    const root = createPool(rootUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      },
      { disableLegacyTestBootstrap: true },
    );
    const account = {
      email: "intent@example.test",
      password: "IntentTest42",
      confirmPassword: "IntentTest42",
      displayName: "意图测试",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/installation/administrator",
          headers: { origin },
          payload: account,
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: account,
    });
    headers = {
      origin,
      cookie: login.cookies[0].name + "=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrfToken,
    };
    projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "OPT42隔离测试" },
      })
    ).json().project.id;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/model-connection",
          headers,
          payload: {
            revision: 0,
            name: "合成模型",
            endpoint:
              "http://127.0.0.1:" +
              (model.address() as { port: number }).port +
              "/v1",
            model: "synthetic",
            apiKey: "synthetic-test-key",
            enabled: true,
          },
        })
      ).statusCode,
    ).toBe(200);
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => model.close(() => r()));
    const root = createPool(rootUrl);
    try {
      await root.query(
        "DROP DATABASE IF EXISTS " + databaseName + " WITH (FORCE)",
      );
    } finally {
      await root.end();
    }
  });
  async function session(
    mode: "plan" | "execute" = "execute",
    paused = false,
    question?: string,
  ) {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const task: any = {
      goal: "建立两条用例的草稿",
      title: "意图夹具",
      requirements: ["保持原意"],
      targetCount: 2,
      stage: "inspecting",
      executionPaused: paused,
      autoCount: 0,
      autoEventLimit: 12,
      ...(question ? { question } : {}),
    };
    task.executionPlan = revisePlan(
      undefined,
      {
        executionMode: mode,
        steps: [
          {
            title: "建立草稿",
            action: "create_draft",
            input: { name: "执行边界草稿", purpose: "隔离测试" },
          },
        ],
      },
      0,
      undefined,
      planRequirementsKey(task),
    );
    const db = createPool(databaseUrl);
    try {
      await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
        id,
        task,
      ]);
    } finally {
      await db.end();
    }
    return id as string;
  }
  const read = async (id: string) =>
    (
      await app.inject({
        method: "GET",
        url: base() + "/sessions/" + id,
        headers,
      })
    ).json();
  async function send(
    id: string,
    message: string,
    calls: Call[] = [],
    extra: Record<string, unknown> = {},
  ) {
    script = [...calls];
    observed = [];
    const response = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message, ...extra },
    });
    expect(response.statusCode, response.body).toBe(202);
    await expect
      .poll(
        async () =>
          (await read(id)).turns.find(
            (t: any) => t.id === response.json().turnId,
          )?.status,
        { timeout: 15000 },
      )
      .toMatch(/succeeded|failed/);
    return read(id);
  }
  const decision = (mode: string, extra: object = {}) => ({
    name: "plan_task",
    input: { control: { mode, ...extra } },
  });
  const successes = (state: any, name: string) =>
    state.turns
      .at(-1)
      .tools.filter((r: any) => r.name === name && r.status === "succeeded");
  async function effects() {
    const db = createPool(databaseUrl);
    try {
      return (
        await db.query(
          "SELECT (SELECT count(*)::int FROM collaborative_draft) AS drafts,(SELECT count(*)::int FROM processing_run) AS runs",
        )
      ).rows[0];
    } finally {
      await db.end();
    }
  }
  it("viewer queries can record query control without write permission", async () => {
    const account = {
      email: "intent-viewer@example.test",
      password: "IntentViewer42",
      confirmPassword: "IntentViewer42",
    };
    const registered = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: account,
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: account,
    });
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) SELECT $1,id,'viewer' FROM app_user WHERE email=$2",
        [projectId, account.email],
      );
    } finally {
      await db.end();
    }
    const ownerHeaders = headers;
    headers = {
      origin,
      cookie: login.cookies[0].name + "=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrfToken,
    };
    try {
      const created = await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().sessionId;
      const before = await effects();
      const state = await send(id, "我可以查看什么？", [
        decision("query", { explanation: "你可以查看已发布的测试集。" }),
      ]);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.turns.at(-1).assistantText).toContain("已发布");
      expect(successes(state, "plan_task")).toHaveLength(1);
      expect(state.task.targetCount).toBeUndefined();
      expect(state.task.executionPlan).toBeUndefined();
      for (const operation of ["execute_plan", "resume"]) {
        const response = await app.inject({
          method: "POST",
          url: base() + "/sessions/" + id + "/turns",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "执行", operation, expectedTaskRevision: 1 },
        });
        expect(response.statusCode, response.body).toBe(404);
      }
      const mixed = await send(id, "只查看", [
        {
          name: "plan_task",
          input: { control: { mode: "query" }, targetCount: 1 },
        },
      ]);
      expect(mixed.task.targetCount).toBeUndefined();
      expect(mixed.task.executionPlan).toBeUndefined();
      expect(
        successes(mixed, "plan_task").every((r: any) =>
          Object.keys(r.input).every((key) => key === "control"),
        ),
      ).toBe(true);
      expect(await effects()).toEqual(before);
    } finally {
      headers = ownerHeaders;
    }
  });
  it.each([
    "为什么失败？",
    "解释执行流程",
    "我引用的是‘立即执行’，请解释这句话",
    "查看一下当前状态",
  ])("readonly %s cannot advance an old execute plan", async (text) => {
    const id = await session();
    const before = await effects();
    const state = await send(id, text);
    expect(await effects()).toEqual(before);
    expect(state.task.executionPaused).toBe(false);
    expect(state.task.requirements).toEqual(["保持原意"]);
    expect(state.task.executionPlan.needsReview).not.toBe(true);
  });
  it.each(["先给方案，别生成", "改成1条，先不执行"])(
    "plan only %s persists without effects",
    async (text) => {
      const id = await session();
      const before = await effects();
      const state = await send(id, text, [
        {
          name: "plan_task",
          input: {
            control: { mode: "plan", requiresUpdate: true },
            targetCount: 1,
          },
        },
      ]);
      expect(state.task.targetCount, JSON.stringify(state.turns.at(-1))).toBe(
        1,
      );
      expect(
        state.task.executionPaused || state.task.executionPlan.mode === "plan",
      ).toBeTruthy();
      expect(await effects()).toEqual(before);
    },
  );
  it("saves a changed count before executing with that revision", async () => {
    const id = await session();
    const before = await effects();
    const state = await send(id, "改成1条，然后继续", [
      {
        name: "plan_task",
        input: {
          control: { mode: "execute", requiresUpdate: true },
          targetCount: 1,
          executionMode: "execute",
        },
      },
    ]);
    expect(state.task.targetCount, JSON.stringify(state.turns.at(-1))).toBe(1);
    expect((await effects()).drafts).toBe(before.drafts + 1);
  });
  it("a failed change never submits old parameters", async () => {
    const id = await session();
    const before = await effects();
    const state = await send(id, "改成1条然后继续", [
      decision("execute", { requiresUpdate: true }),
      { name: "plan_task", input: { targetCount: 0 } },
      { name: "create_draft", input: { name: "不应创建" } },
    ]);
    expect(state.task.targetCount).toBe(2);
    expect(await effects()).toEqual(before);
  });
  it("a failed amendment cannot be bypassed by a later background event", async () => {
    const id = await session();
    const before = await effects();
    await send(id, "修改数量后继续", [
      decision("execute", { requiresUpdate: true }),
      { name: "plan_task", input: { targetCount: 0 } },
    ]);
    const db = createPool(databaseUrl);
    try {
      await queueContinuation(db, id, "processing_completed", "old-completion");
    } finally {
      await db.end();
    }
    expect((await read(id)).turns.length).toBe(1);
    expect(await effects()).toEqual(before);
  });
  it.each([false, true])(
    "pause survives later valid/invalid correction: %s",
    async (invalid) => {
      const id = await session();
      const before = await effects();
      const state = await send(id, "先暂停，再改为1条", [
        decision("pause", { requiresUpdate: true, pauseFirst: true }),
        { name: "plan_task", input: { targetCount: invalid ? 0 : 1 } },
      ]);
      expect(state.task.executionPaused).toBe(true);
      expect(state.task.targetCount).toBe(invalid ? 2 : 1);
      expect(await effects()).toEqual(before);
      const db = createPool(databaseUrl);
      try {
        await queueContinuation(db, id, "processing_completed", "old-event");
      } finally {
        await db.end();
      }
      expect((await read(id)).turns.length).toBe(1);
    },
  );
  it("explicit pause and explanation do not claim to cancel a worker", async () => {
    const id = await session();
    const state = await send(id, "不要继续生成，先解释", [decision("pause")]);
    expect(state.task.executionPaused).toBe(true);
    expect(observed).toHaveLength(1);
    expect(state.turns.at(-1).assistantText).toContain("不会取消");
    expect(
      state.turns.at(-1).tools.some((r: any) => r.name === "retry_processing"),
    ).toBe(false);
  });
  it("explanation is recorded before an explicitly requested execution", async () => {
    const id = await session();
    const before = await effects();
    const state = await send(id, "先解释方案，再开始执行", [
      {
        name: "plan_task",
        input: {
          control: {
            mode: "execute",
            explanation: "先建立草稿，然后等待人工检查。",
          },
          executionMode: "execute",
        },
      },
    ]);
    expect((await effects()).drafts).toBe(before.drafts + 1);
    expect(
      state.turns.at(-1).tools.some((r: any) => r.result?.control?.explanation),
    ).toBe(true);
  });
  it("ambiguous assent to plan-only asks one business question without execution", async () => {
    const id = await session("plan");
    const before = await effects();
    const state = await send(id, "好", [
      {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          question: "开始生成，还是继续调整方案？",
          nextAction: "none",
        },
      },
    ]);
    expect(state.task.question).toBe("开始生成，还是继续调整方案？");
    expect(await effects()).toEqual(before);
  });
  it.each(["execute_plan", "resume"])(
    "structured UI %s uses actual state and revision",
    async (operation) => {
      const id = await session("plan", operation === "resume");
      const before = await effects();
      const state = await send(id, "按钮显示文案可改变", [], {
        operation,
        expectedTaskRevision: 0,
      });
      expect((await effects()).drafts).toBe(before.drafts + 1);
      expect(state.task.executionPaused).toBe(false);
    },
  );
  it.each([
    { operation: "publish", expectedTaskRevision: 0 },
    { operation: "execute_plan" },
    { operation: "execute_plan", expectedTaskRevision: 99 },
    { operation: { mode: "execute" }, expectedTaskRevision: 0 },
  ])(
    "rejects an unknown, stale, or incomplete UI marker: %j",
    async (payload) => {
      const id = await session("plan");
      const before = await effects();
      const response = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + id + "/turns",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "按钮", ...payload },
      });
      expect([409, 422]).toContain(response.statusCode);
      expect(await effects()).toEqual(before);
      expect((await read(id)).turns.length).toBe(0);
    },
  );
  it("UI execution cannot answer an unresolved business question", async () => {
    const id = await session("plan", false, "请选择要修改的对象");
    const response = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        message: "执行",
        operation: "execute_plan",
        expectedTaskRevision: 0,
      },
    });
    expect(response.statusCode).toBe(409);
  });
  it("query-only classification cannot be escalated by a later repaired tool", async () => {
    const id = await session();
    const before = await effects();
    await send(id, "只解释原因", [
      decision("query"),
      {
        name: "plan_task",
        input: { control: { mode: "execute" }, executionMode: "execute" },
      },
      { name: "create_draft", input: { name: "不应创建" } },
    ]);
    expect(await effects()).toEqual(before);
  });
  it("unknown control cannot execute through a hidden tool", async () => {
    const id = await session();
    const before = await effects();
    await send(id, "先看看", [
      { name: "create_draft", input: { name: "不应创建" } },
    ]);
    expect(await effects()).toEqual(before);
  });
  it("legacy exact UI text still uses the same guarded path", async () => {
    const id = await session("plan");
    const before = await effects();
    await send(id, "按当前已保存方案执行");
    expect((await effects()).drafts).toBe(before.drafts + 1);
  });
  it("does not accept an old count as a receipt for an unsaved oral correction", async () => {
    const id = await session();
    prose = "已将数量修改为1条并保存要求。";
    try {
      const state = await send(id, "改为1条，先不执行");
      expect(state.task.targetCount).toBe(2);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("failed");
      expect([
        "assistant_requirements_not_saved",
        "assistant_intent_required",
      ]).toContain(state.turns.at(-1).errorCode);
    } finally {
      prose = "当前状态已核对，原有成果保留。";
    }
  });
  async function populated(id: string) {
    const state = await send(id, "执行建立草稿", [decision("execute")]);
    const draft = state.task.createdDraftId;
    expect(draft).toBeTruthy();
    const row = await app.inject({
      method: "POST",
      url:
        "/api/projects/" +
        projectId +
        "/collaborative-drafts/" +
        draft +
        "/records",
      headers,
      payload: {
        question: "如何查询包裹？",
        expectedOutput: "查询物流",
        metadata: [],
      },
    });
    expect(row.statusCode, row.body).toBe(201);
    return { draft, recordId: row.json().record.id };
  }
  it("query selection previews preserve the fixed scope and pending read step", async () => {
    const id = await session();
    const { draft, recordId } = await populated(id);
    const db = createPool(databaseUrl);
    const scope = {
      source: { kind: "draft", id: draft },
      recordIds: [recordId],
      hash: "retained-scope",
      configuration: { method: "all", conditions: [], seed: "scope-retained" },
    };
    try {
      const task = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      const executionPlan = revisePlan(
        undefined,
        {
          executionMode: "execute",
          steps: [
            {
              title: "读取固定输入",
              action: "read_records",
              scope: "all",
              input: { source: scope.source },
            },
          ],
        },
        1,
        undefined,
        planRequirementsKey(task),
      );
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [id, JSON.stringify({ executionPlan, processingScope: scope })],
      );
      const state = await send(id, "只预览一条，不要改输入范围", [
        {
          name: "read_records",
          input: {
            source: scope.source,
            selection: {
              method: "random",
              mode: "count",
              value: 1,
              conditions: [],
            },
          },
        },
      ]);
      const saved = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      expect(saved.processingScope).toEqual(scope);
      expect(saved.executionPlan.current).toBe(0);
      expect(saved.executionPlan.steps[0].status).toBe("pending");
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
    } finally {
      await db.end();
    }
  });
  it("query invalidation leaves a confirmation step resumable without publishing", async () => {
    const id = await session();
    const { draft } = await populated(id);
    const db = createPool(databaseUrl);
    try {
      const task = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      const executionPlan = revisePlan(
        undefined,
        {
          executionMode: "execute",
          steps: [
            {
              title: "准备发布确认",
              action: "request_publish",
              input: { draftId: draft },
            },
          ],
        },
        1,
        undefined,
        planRequirementsKey(task),
      );
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [id, JSON.stringify({ executionPlan })],
      );
      const first = await send(id, "准备发布", [decision("execute")]);
      expect(first.proposals.some((p: any) => p.status === "pending")).toBe(
        true,
      );
      const query = await send(id, "查看状态");
      expect(query.task.executionPlan.steps[0].status).toBe("pending");
      const resumed = await send(id, "继续准备发布确认", [
        decision("execute"),
        { name: "request_publish", input: { draftId: draft } },
      ]);
      expect(
        resumed.proposals.some((p: any) => p.status === "pending"),
        JSON.stringify(resumed.turns.at(-1)),
      ).toBe(true);
      expect(
        (await db.query("SELECT count(*)::int AS n FROM test_set_version"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await db.end();
    }
  });
  it("structured operations still require CSRF and replay the original receipt", async () => {
    const id = await session("plan");
    const before = await effects();
    const key = randomUUID();
    const payload = {
      message: "按钮",
      operation: "execute_plan",
      expectedTaskRevision: 0,
    };
    const unsafe = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { origin, cookie: headers.cookie, "idempotency-key": key },
      payload,
    });
    expect(unsafe.statusCode).toBe(403);
    script = [];
    const first = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
    expect(first.statusCode).toBe(202);
    await expect
      .poll(async () => (await read(id)).turns.at(-1)?.status)
      .toBe("succeeded");
    const replay = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().turnId).toBe(first.json().turnId);
    expect((await effects()).drafts).toBe(before.drafts + 1);
  });
  it("updates an existing document delivery using the current request rather than historical quantities", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const uploaded = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "物流说明.txt",
        contentBase64: Buffer.from(
          "使用完整中文问题，测试物流查询与修改收货地址；不包含真实个人信息。",
        ).toString("base64"),
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const recoveryDb = createPool(databaseUrl);
    try {
      await recoveryDb.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            goal: "按附件规划物流测试集",
            title: "规划恢复",
            requirements: [],
            autoCount: 0,
            stage: "failed",
            executionPaused: true,
            planningRecovery: {
              taskRevision: -2,
              documentsKey: "older-snapshot",
              evidenceKey: "older-evidence",
            },
          }),
        ],
      );
    } finally {
      await recoveryDb.end();
    }
    const first = await send(id, "按附件做2条，先给方案，不生成", [
      decision("plan"),
      {
        name: "read_background",
        input: { documentId: uploaded.json().document.id },
      },
      {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          executionMode: "plan",
          requirements: ["问题不包含真实个人信息", "覆盖两类业务各1条"],
          deliveries: [
            {
              name: "物流问答",
              count: 2,
              instructions: "按文档生成物流问答测试",
              scenarios: ["查询已发货包裹", "查询未揽收包裹", "修改未发货地址"],
              classifications: [],
            },
          ],
        },
      },
    ]);
    expect(
      first.turns.at(-1).tools.filter((r: any) => r.status === "failed"),
    ).toEqual([]);
    const wire = observed[0].tools.find(
      (tool: any) => tool.function.name === "plan_task",
    ).function.parameters;
    expect(wire.required).toContain("control");
    expect(wire.properties).not.toHaveProperty("targetDraftId");
    expect(wire.properties).not.toHaveProperty("overallTargetCount");
    expect(first.task.targetCount, JSON.stringify(first.turns.at(-1))).toBe(2);
    const db = createPool(databaseUrl);
    let goal: any;
    try {
      goal = deliveryGoals(
        (await db.query("SELECT task FROM assistant_session WHERE id=$1", [id]))
          .rows[0].task.executionPlan,
      )[0];
    } finally {
      await db.end();
    }
    const before = await effects();
    const changed = await send(id, "改成1条，先不执行", [
      decision("plan", { requiresUpdate: true }),
      {
        name: "plan_task",
        input: {
          control: { mode: "plan", requiresUpdate: true },
          deliveries: [{ id: goal.id, count: 1 }],
          requirements: ["问题不包含真实个人信息", "覆盖其中一类业务"],
        },
      },
    ]);
    expect(changed.task.targetCount, JSON.stringify(changed.turns.at(-1))).toBe(
      1,
    );
    expect(changed.task.requirements).toContain("问题不包含真实个人信息");
    expect(changed.task.requirements).toContain("覆盖其中一类业务");
    expect(changed.task.requirements).not.toContain("覆盖两类业务各1条");
    expect(changed.task.executionPlan.mode).toBe("plan");
    expect(changed.task.executionPaused).toBe(false);
    expect(await effects()).toEqual(before);
  });

  it("missing control returns to the bounded planner without inventing execution", async () => {
    const id = await session("plan");
    const before = await effects();
    const state = await send(id, "继续完善方案，先不执行", [
      {
        name: "plan_task",
        input: {
          executionMode: "plan",
          steps: [
            {
              title: "创建草稿",
              action: "create_draft",
              input: { name: "恢复草稿" },
            },
          ],
        },
      },
      {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          executionMode: "plan",
          steps: [
            {
              title: "创建草稿",
              action: "create_draft",
              input: { name: "恢复草稿" },
            },
          ],
        },
      },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.executionPlan.mode).toBe("plan");
    expect(state.task.executionPlan.steps[0].input.name).toBe("恢复草稿");
    expect(observed.length).toBeLessThanOrEqual(3);
    expect(await effects()).toEqual(before);
  });
  it("query answers are not replaced by an old clarification", async () => {
    const id = await session("plan", true, "是否分别保存两个草稿？");
    const state = await send(id, "为什么没生成？只解释", [
      decision("query", { explanation: "尚未执行生成，当前仍在规划阶段。" }),
    ]);
    expect(state.turns.at(-1).assistantText).toBe(
      "尚未执行生成，当前仍在规划阶段。",
    );
    expect(state.task.question).toBe("是否分别保存两个草稿？");
  });
  it("does not expose continue for an empty saved plan", async () => {
    const id = await session("plan", true);
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{executionPlan,steps}','[]') WHERE id=$1",
        [id],
      );
    } finally {
      await db.end();
    }
    expect((await read(id)).task.canContinueExecution).toBe(false);
  });
  it("query cannot claim a complete saved plan when no steps exist", async () => {
    const id = await session("plan", true);
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{executionPlan,steps}','[]') WHERE id=$1",
        [id],
      );
    } finally {
      await db.end();
    }
    const state = await send(id, "方案保存了吗？只查询", [
      decision("query", { explanation: "完整方案已保存。" }),
    ]);
    expect(state.turns.at(-1).assistantText).toBe(
      "当前还没有完整可执行方案，已有要求和文档保留。",
    );
  });
  it("failed execution does not display a claimed saved plan", async () => {
    const id = await session("plan");
    const state = await send(id, "修改方案后执行", [
      {
        name: "plan_task",
        input: {
          control: {
            mode: "execute",
            requiresUpdate: true,
            explanation: "完整方案已保存。",
          },
          target: { kind: "draft", id: "missing-draft" },
        },
      },
    ]);
    expect(state.turns.at(-1).assistantText ?? "").not.toContain(
      "完整方案已保存",
    );
  });
  it("never publishes an intent explanation as a successful plan receipt", async () => {
    const id = await session("plan");
    const state = await send(id, "先规划，不执行", [
      {
        name: "plan_task",
        input: {
          control: { mode: "plan", explanation: "完整方案已保存。" },
          target: { kind: "draft", id: "missing-draft" },
          executionMode: "plan",
        },
      },
    ]);
    expect(state.turns.at(-1).assistantText ?? "").not.toContain(
      "完整方案已保存",
    );
  });
  it("an oral pause without a control receipt cannot finish or authorize automatic work", async () => {
    const id = await session();
    const before = await effects();
    prose = "后续执行已暂停，已有成果保留。";
    try {
      const state = await send(id, "先暂停后续执行，再解释状态");
      expect(state.turns.at(-1).status).toBe("failed");
      expect(state.turns.at(-1).errorCode).toBe("assistant_intent_required");
      const db = createPool(databaseUrl);
      try {
        await queueContinuation(
          db,
          id,
          "processing_completed",
          "late-pause-event",
        );
      } finally {
        await db.end();
      }
      expect((await read(id)).turns.length).toBe(1);
      expect(await effects()).toEqual(before);
    } finally {
      prose = "当前状态已核对，原有成果保留。";
    }
  });
  it.each(["same", "different", "before_read"])(
    "repairs consecutive unnecessary planning questions (%s)",
    async (variant) => {
      const before = await effects();
      const id = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions",
          headers,
          payload: {},
        })
      ).json().sessionId;
      const uploaded = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + id + "/background-documents",
        headers,
        payload: {
          fileName: "物流说明.txt",
          contentBase64: Buffer.from(
            "使用完整中文问题，覆盖物流查询与修改收货地址；不包含真实个人信息。",
          ).toString("base64"),
        },
      });
      expect(uploaded.statusCode).toBe(201);
      const bad = {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          executionMode: "plan",
          question: "请确认是否按上述方案执行？",
          nextAction: "none",
        },
      };
      const state = await send(
        id,
        "按附件创建物流查询和修改地址两个测试集，每个2条。先给方案，不要执行。",
        [
          decision("plan"),
          {
            name: "read_background",
            input: { documentId: uploaded.json().document.id },
          },
          bad,
          variant === "different"
            ? {
                ...bad,
                input: {
                  ...bad.input,
                  question: "请确认是否使用物流查询这个名称？",
                },
              }
            : bad,
          {
            name: "plan_task",
            input: {
              executionMode: "plan",
              requirements: ["问题完整且不包含真实个人信息"],
              deliveries: [
                {
                  name: "物流查询",
                  count: 2,
                  instructions: "生成物流查询问题",
                  scenarios: ["运输进度", "预计到达", "当前位置"],
                  classifications: [],
                },
                {
                  name: "修改地址",
                  count: 2,
                  instructions: "生成修改收货地址问题",
                  scenarios: ["发货前改址", "运输中改址", "地址信息补充"],
                  classifications: [],
                },
              ],
            },
          },
        ],
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(script).toHaveLength(0);
      expect(observed).toHaveLength(5);
      if (variant === "before_read")
        expect(observed[1].tool_choice).toEqual({
          type: "function",
          function: { name: "read_background" },
        });
      for (const request of observed.slice(3)) {
        expect(request.tool_choice).toEqual({
          type: "function",
          function: { name: "plan_task" },
        });
        expect(request.tools.map((t: any) => t.function.name)).toEqual([
          "plan_task",
        ]);
        expect(JSON.stringify(request.messages)).toContain("纠正不必要的澄清");
        expect(JSON.stringify(request.messages)).toContain("每个2条");
      }
      expect(state.task.executionPlan.mode).toBe("plan");
      const planDb = createPool(databaseUrl);
      try {
        const saved = (
          await planDb.query("SELECT task FROM assistant_session WHERE id=$1", [
            id,
          ])
        ).rows[0].task;
        expect(
          deliveryGoals(saved.executionPlan).map((goal) => ({
            name: goal.name,
            count: goal.count,
          })),
        ).toEqual([
          { name: "物流查询", count: 2 },
          { name: "修改地址", count: 2 },
        ]);
      } finally {
        await planDb.end();
      }
      expect(state.task.question).toBeFalsy();
      expect(await effects()).toEqual(before);
    },
  );

  it("bounds repeated planning clarification failures and still permits genuine ambiguity", async () => {
    const before = await effects();
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const uploaded = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "说明.txt",
        contentBase64: Buffer.from("只使用完整中文问题。").toString("base64"),
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const bad = {
      name: "plan_task",
      input: {
        control: { mode: "plan" },
        executionMode: "plan",
        question: "请确认是否按上述方案执行？",
        nextAction: "none",
      },
    };
    const failed = await send(id, "按附件创建2条物流问题，先给方案，不执行。", [
      decision("plan"),
      {
        name: "read_background",
        input: { documentId: uploaded.json().document.id },
      },
      bad,
      bad,
      bad,
      bad,
    ]);
    expect(failed.turns.at(-1).status).toBe("failed");
    expect(failed.turns.at(-1).errorCode).toBe("assistant_no_progress");
    expect(failed.turns.at(-1).diagnostics.failure).toMatchObject({
      layer: "application",
      category: "workflow_stalled",
    });
    expect(failed.turns.at(-1).diagnostics.failure.reason).toContain(
      "仍未保存完整方案",
    );
    expect(observed).toHaveLength(5);
    expect(script).toHaveLength(1);
    expect(failed.task.executionPlan?.steps?.length ?? 0).toBe(0);
    expect(await effects()).toEqual(before);
    const clarified = await send(id, "按附件继续规划", [
      decision("plan"),
      {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          executionMode: "plan",
          question: "文档缺失物流业务范围，应该覆盖查询还是修改地址？",
          nextAction: "none",
        },
      },
    ]);
    expect(
      clarified.turns.at(-1).status,
      JSON.stringify(clarified.turns.at(-1)),
    ).toBe("succeeded");
    expect(clarified.task.question).toContain("文档缺失");
    expect(await effects()).toEqual(before);
  });
  it("saved requirements remain saved while a genuine clarification is pending", async () => {
    const id = await session("plan");
    const before = await effects();
    const state = await send(id, "查物流的，其他你安排", [
      {
        name: "plan_task",
        input: {
          control: { mode: "plan", requiresUpdate: true },
          requirements: ["覆盖查物流场景", "每条包含问题和期望回复"],
          question: "请提供背景文档。",
          nextAction: "none",
        },
      },
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(state.task.requirements).toContain("覆盖查物流场景");
    expect(state.task.turnControl.updateSaved).toBe(true);
    expect(state.task.question).toBe("请提供背景文档。");
    expect(await effects()).toEqual(before);
  });

  it("identical execute control survives server-required update promotion", async () => {
    const id = await session("plan");
    const before = await effects();
    const state = await send(id, "可以，开始吧", [
      {
        name: "plan_task",
        input: {
          control: { mode: "execute" },
          target: { kind: "draft", id: "missing-draft" },
        },
      },
      {
        name: "plan_task",
        input: {
          control: { mode: "execute" },
          target: null,
          executionMode: "execute",
        },
      },
    ]);
    expect(
      successes(state, "plan_task").length,
      JSON.stringify(state.turns.at(-1)),
    ).toBeGreaterThan(0);
    expect(
      state.turns
        .at(-1)
        .tools.find(
          (r: any) =>
            r.name === "plan_task" &&
            r.input?.target === null &&
            r.input?.executionMode === "execute",
        )?.status,
    ).toBe("succeeded");
    expect((await effects()).drafts).toBe(before.drafts + 1);
  });

  it("generation without background asks for material before execution", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const before = await effects();
    const state = await send(id, "做两个电商客服测试集，各2条，先给方案", [
      {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          allowedFields: ["question"],
          metadataKeys: ["业务场景"],
          targetCount: 2,
          overallTargetCount: 4,
          requirements: ["物流和改地址两个独立测试集，各2条"],
          nextAction: "generate_candidates",
        },
      },
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(state.task.question).toMatch(/背景文档/);
    expect(state.task.nextAction).toBeNull();
    expect(state.task.allowedFields).toEqual(["question"]);
    expect(state.task.metadataKeys).toEqual(["业务场景"]);
    expect(
      state.task.executionPaused || state.task.executionPlan.mode === "plan",
    ).toBeTruthy();
    expect(await effects()).toEqual(before);
  });

  it("contextual repair validates an invalid object field without changing authorization", async () => {
    const id = await session("plan");
    const before = await effects();
    const corrected = {
      name: "plan_task",
      input: {
        control: { mode: "plan", requiresUpdate: true },
        target: null,
        requirements: ["保持原意", "覆盖查物流场景"],
      },
    };
    const state = await send(id, "补充查物流场景，先别执行", [
      { name: "plan_task", input: { ...corrected.input, target: "当前草稿" } },
      corrected,
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.requirements).toContain("覆盖查物流场景");
    expect(state.task.turnControl.mode).toBe("plan");
    expect(
      state.turns
        .at(-1)
        .diagnostics.parameterRepairs.map((r: any) => r.outcome),
    ).toContain("repaired");
    expect(
      successes(state, "plan_task").some((r: any) => r.input.target === null),
    ).toBe(true);
    expect(state.turns.at(-1).diagnostics.repairRequestsUsed).toBe(1);
    expect(observed.length).toBeLessThanOrEqual(5);
    expect(await effects()).toEqual(before);
  });

  it("failed execution never displays an uncommitted started claim", async () => {
    const id = await session("plan");
    const state = await send(id, "开始执行", [
      {
        name: "plan_task",
        input: {
          control: {
            mode: "execute",
            explanation: "已按方案开始生成两个测试集。",
          },
          target: { kind: "draft", id: "missing-draft" },
        },
      },
    ]);
    expect(state.turns.at(-1).assistantText ?? "").not.toContain("开始生成");
  });

  it("document delivery amendments derive totals and replace the topic without reviving old requirements", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const definitions: Record<string, string> = {
      查物流: "1. 查物流：用户查询订单的运输位置、物流更新或预计送达时间。",
      改地址: "2. 改地址：用户请求修改订单的收货地址。",
      退款进度: "3. 退款进度：用户查询已申请退款的处理进度或到账时间。",
    };
    const uploaded = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "电商客服规范.txt",
        contentBase64: Buffer.from(
          Object.values(definitions).join("\n") +
            "\n问题是完整自然的用户问法，期望输出是逐题客服处理行为，不编造订单信息。",
        ).toString("base64"),
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const goal = (name: string, count = 2) => ({
      name,
      count,
      instructions: "生成" + name + "问题及逐题客服处理行为",
      scenarios: ["正常咨询", "信息不足", "进度异常"],
      classifications: [
        {
          field: "metadata",
          key: "业务场景",
          basis: "background",
          allowedValues: [name],
          definitions: [{ value: name, text: definitions[name] }],
          quotas: [{ value: name, count }],
        },
      ],
    });
    const before = await effects();
    const initial = await send(
      id,
      "按文档做物流和改地址两个测试集，各2条，先给方案",
      [
        decision("plan"),
        {
          name: "read_background",
          input: { documentId: uploaded.json().document.id },
        },
        {
          name: "plan_task",
          input: {
            control: { mode: "plan" },
            executionMode: "plan",
            requirements: ["自然完整的问题与逐题客服处理行为"],
            deliveries: [goal("查物流"), goal("改地址")],
          },
        },
      ],
    );
    expect(
      initial.turns.at(-1).status,
      JSON.stringify(initial.turns.at(-1)),
    ).toBe("succeeded");
    const goals = deliveryGoals(initial.task.executionPlan);
    const changed = await send(id, "查物流改成3条，先不执行", [
      decision("plan", { requiresUpdate: true }),
      {
        name: "plan_task",
        input: {
          control: { mode: "plan", requiresUpdate: true },
          deliveries: [{ id: goals[0].id, count: 3 }],
        },
      },
    ]);
    expect(changed.task.overallTargetCount).toBe(5);
    const revised = await send(id, "查物流还是2条，改地址只要1条", [
      decision("plan", { requiresUpdate: true }),
      {
        name: "plan_task",
        input: {
          control: { mode: "plan", requiresUpdate: true },
          deliveries: [
            { id: goals[0].id, count: 2 },
            { id: goals[1].id, count: 1 },
          ],
        },
      },
    ]);
    expect(revised.task.overallTargetCount).toBe(3);
    const replacement = {
      name: "plan_task",
      input: {
        control: { mode: "plan", requiresUpdate: true },
        deliveries: [{ ...goal("退款进度", 1), id: goals[1].id, count: 1 }],
      },
    };
    const rejected = await send(id, "改地址不要了，换成退款进度。", [
      decision("plan", { requiresUpdate: true }),
      {
        ...replacement,
        input: {
          ...replacement.input,
          deliveries: [{ ...goal("退款进度", 2), id: goals[1].id }],
        },
      },
    ]);
    expect(rejected.turns.at(-1).status).toBe("failed");
    expect(deliveryGoals(rejected.task.executionPlan)[1].name).toBe("改地址");
    const stopped = await send(id, "继续执行", [decision("execute")]);
    expect(stopped.turns.at(-1).status).toBe("failed");
    expect(deliveryGoals(stopped.task.executionPlan)[1].name).toBe("改地址");
    const replaced = await send(
      id,
      "把改地址换成退款进度，仍要1条，先保存方案",
      [
        decision("plan", { requiresUpdate: true }),
        {
          ...replacement,
          input: {
            ...replacement.input,
            control: { mode: "plan", requiresUpdate: true },
          },
        },
      ],
    );
    expect(
      replaced.turns.at(-1).status,
      JSON.stringify(replaced.turns.at(-1)),
    ).toBe("succeeded");
    expect(
      deliveryGoals(replaced.task.executionPlan).map((g: any) => [
        g.name,
        g.count,
      ]),
    ).toEqual([
      ["查物流", 2],
      ["退款进度", 1],
    ]);
    expect(replaced.task.overallTargetCount).toBe(3);
    expect(replaced.task.requirements).not.toContain(
      "本轮仅保存方案，不执行生成。",
    );
    expect(await effects()).toEqual(before);
    const started = await send(id, "按最后这个做。", [decision("execute")]);
    expect(
      started.task.executionPlan.mode,
      JSON.stringify(started.turns.at(-1)),
    ).toBe("execute");
    expect((await effects()).runs).toBe(before.runs + 1);
    expect(
      deliveryGoals(started.task.executionPlan).map((g: any) => [
        g.name,
        g.count,
      ]),
    ).toEqual([
      ["查物流", 2],
      ["退款进度", 1],
    ]);
  });

  it("context replanning cannot turn an invalid plan-only call into execution", async () => {
    const id = await session("plan");
    const before = await effects();
    const fixed = {
      name: "plan_task",
      input: {
        control: { mode: "plan" },
        target: null,
        requirements: ["保持原意"],
      },
    };
    const state = await send(id, "补全方案，先别执行", [
      { name: "plan_task", input: { ...fixed.input, target: "当前草稿" } },
      fixed,
      fixed,
      {
        name: "plan_task",
        input: { control: { mode: "execute" }, executionMode: "execute" },
      },
    ]);
    expect(state.turns.at(-1).status).toBe("failed");
    expect(state.task.turnControl.mode).toBe("plan");
    expect(
      state.turns.at(-1).diagnostics.repairRequestsUsed,
    ).toBeLessThanOrEqual(2);
    expect(successes(state, "create_draft")).toHaveLength(0);
    expect(await effects()).toEqual(before);
  });
  it.each(["normal", "query"])(
    "final %s reply cannot claim processing without a receipt",
    async (variant) => {
      const id = await session("plan");
      const db = createPool(databaseUrl);
      try {
        await db.query(
          "UPDATE assistant_session SET task=jsonb_set(task,'{executionPlan,steps}','[]') WHERE id=$1",
          [id],
        );
      } finally {
        await db.end();
      }
      const before = await effects();
      const previousProse = prose;
      try {
        prose = "已开始生成两个测试集。";
        const state = await send(
          id,
          variant === "query" ? "查看当前状态" : "开始吧",
          [
            decision(
              variant === "query" ? "query" : "execute",
              variant === "query" ? { explanation: prose } : {},
            ),
          ],
        );
        expect(state.turns.at(-1).assistantText ?? "").not.toContain(
          "已开始生成",
        );
        expect(state.turns.at(-1).assistantText).toContain("尚未提交");
        expect(await effects()).toEqual(before);
      } finally {
        prose = previousProse;
      }
    },
  );

  it("retry preserves the control recorded before an invalid SDK plan is repaired", async () => {
    const id = await session("plan");
    const before = await effects();
    const fixed = {
      name: "plan_task",
      input: {
        control: { mode: "plan" },
        target: null,
        requirements: ["保持原意"],
      },
    };
    const failed = await send(id, "补全方案，先别执行", [
      { name: "plan_task", input: { ...fixed.input, target: "当前草稿" } },
      fixed,
      fixed,
      {
        name: "plan_task",
        input: { control: { mode: "execute" }, executionMode: "execute" },
      },
    ]);
    expect(failed.task.turnControl.mode).toBe("plan");
    expect(failed.turns.at(-1).status).toBe("failed");
    script = [
      {
        name: "plan_task",
        input: { control: { mode: "execute" }, executionMode: "execute" },
      },
    ];
    observed = [];
    const retry = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/retry",
      headers,
      payload: {},
    });
    expect(retry.statusCode, retry.body).toBe(200);
    await expect
      .poll(async () => (await read(id)).turns.at(-1).status, {
        timeout: 15000,
      })
      .toMatch(/succeeded|failed/);
    expect((await read(id)).task.turnControl.mode).toBe("plan");
    expect(await effects()).toEqual(before);
  });
  it("a genuine document clarification ends successfully without a complete generation plan", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const upload = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "客服说明.txt",
        contentBase64: Buffer.from(
          "客服测试包含查物流和修改地址。问题应为完整用户问法。",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode).toBe(201);
    const before = await effects();
    const state = await send(id, "帮我做一份客服测试集", [
      decision("plan"),
      {
        name: "read_background",
        input: { documentId: upload.json().document.id },
      },
      {
        name: "plan_task",
        input: {
          control: { mode: "plan" },
          question: "需要多少条，覆盖哪些客服场景？",
        },
      },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(observed[0].tool_choice).toEqual({
      type: "function",
      function: { name: "plan_task" },
    });
    expect(state.turns.at(-1).assistantText).toBe(
      "需要多少条，覆盖哪些客服场景？",
    );
    expect(state.task.executionPlan.steps).toHaveLength(0);
    expect(observed).toHaveLength(3);
    expect(await effects()).toEqual(before);
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE assistant_turn SET status='failed',error_code='assistant_requirements_not_saved' WHERE id=$1",
        [state.turns.at(-1).id],
      );
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            stage: "failed",
            error: "assistant_requirements_not_saved",
          }),
        ],
      );
    } finally {
      await db.end();
    }
    script = [];
    observed = [];
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + id + "/retry",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await expect
      .poll(async () => (await read(id)).turns.at(-1).status, {
        timeout: 15000,
      })
      .toBe("succeeded");
    expect((await read(id)).turns.at(-1).assistantText).toBe(
      "需要多少条，覆盖哪些客服场景？",
    );
    expect(observed).toHaveLength(0);
  });
  it("accepts a cited definition while asking for the missing count", async () => {
    const { id, documentId } = await backgroundSession(
      "1. 查物流：用户查询订单运输位置。\n2. 改地址：用户请求修改收货地址。",
    );
    const readState = await send(id, "先读客服规范", [
      decision("plan"),
      {
        name: "read_background",
        input: { documentId, useForProcessing: false },
      },
      {
        name: "plan_task",
        input: { question: "这次需要多少条？", nextAction: "none" },
      },
    ]);
    const citation = readState.turns
      .at(-1)
      .tools.find((tool: any) => tool.name === "read_background")
      .result.definitions.find((item: any) => item.value === "查物流");
    const state = await send(id, "先列查物流方案，数量还要确认", [
      decision("plan", { requiresUpdate: true }),
      {
        name: "plan_task",
        input: {
          question: "这次需要多少条？",
          nextAction: "none",
          deliveries: [
            {
              name: "查物流客服测试集",
              count: 1,
              instructions: "按已读定义生成自然完整的问题",
              scenarios: ["查订单位置", "查物流更新", "查预计到达"],
              classifications: [
                {
                  field: "metadata",
                  key: "业务场景",
                  basis: "background",
                  allowedValues: ["查物流"],
                  definitions: [
                    {
                      value: "查物流",
                      text: citation.text,
                      reference: citation.reference,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.turns.at(-1).errorCode).toBeNull();
    expect(state.task.backgroundEvidence ?? []).toEqual([]);
    expect(state.task.executionPlan?.steps ?? []).toEqual([]);
  });

  async function backgroundSession(
    text = "问题使用完整中文，不含真实个人信息。",
  ) {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const upload = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "回归规范.txt",
        contentBase64: Buffer.from(text).toString("base64"),
      },
    });
    expect(upload.statusCode).toBe(201);
    return { id, documentId: upload.json().document.id };
  }
  const simpleDelivery = () => ({
    name: "客服测试集",
    count: 2,
    instructions: "完整用户问题和逐题处理行为",
    scenarios: ["正常咨询", "信息不足", "进度异常"],
    classifications: [],
  });
  it.each([false, true])(
    "recovers truncated native planning with a smaller control call, bounded=%s",
    async (repeated) => {
      const { id, documentId } = await backgroundSession();
      const before = await effects();
      const broken: Call = {
        name: "plan_task",
        input: {},
        rawInput: '{"control":{"mode":"plan"},"deliveries":[',
        finishReason: "length",
      };
      const state = await send(
        id,
        "按附件做2条客服用例，先给方案，不执行",
        repeated
          ? [broken, broken]
          : [
              broken,
              decision("plan"),
              { name: "read_background", input: { documentId } },
              {
                name: "plan_task",
                input: {
                  executionMode: "plan",
                  deliveries: [simpleDelivery()],
                },
              },
            ],
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe(repeated ? "failed" : "succeeded");
      expect(
        observed[1].tools.find((t: any) => t.function.name === "plan_task")
          .function.parameters.properties,
      ).toEqual({ control: expect.any(Object) });
      expect(JSON.stringify(observed[1].messages)).toContain("输出上限");
      expect(
        state.turns.at(-1).diagnostics.stepDiagnostics[0].finishReason,
      ).toBe("length");
      if (repeated) {
        expect(observed).toHaveLength(2);
        expect(state.turns.at(-1).diagnostics.failure.category).toBe(
          "output_truncated",
        );
      } else expect(state.task.targetCount).toBe(2);
      expect(await effects()).toEqual(before);
    },
  );
  it("corrects a repeated answered question without asking the user again", async () => {
    const { id, documentId } = await backgroundSession();
    const before = await effects();
    await send(id, "帮我做一份客服测试集", [
      decision("plan"),
      { name: "read_background", input: { documentId } },
      {
        name: "plan_task",
        input: { question: "需要哪种客服场景和多少条？", nextAction: "none" },
      },
    ]);
    const state = await send(id, "查物流，2条，先给方案", [
      decision("plan", { requiresUpdate: true }),
      {
        name: "plan_task",
        input: {
          requirements: ["查物流场景2条"],
          question: "需要哪种客服场景和多少条？",
          nextAction: "none",
        },
      },
      {
        name: "plan_task",
        input: {
          requirements: ["查物流场景2条"],
          deliveries: [simpleDelivery()],
          executionMode: "plan",
        },
      },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.question).toBeFalsy();
    expect(state.task.targetCount).toBe(2);
    expect(
      state.turns
        .at(-1)
        .tools.some(
          (t: any) =>
            t.error?.code === "assistant_plan_clarification_unnecessary",
        ),
    ).toBe(true);
    expect(await effects()).toEqual(before);
  });
  it("execute-mode clarification rereads background instead of asking for an available definition", async () => {
    const { id, documentId } = await backgroundSession(
      "1. 查物流：用户查询订单运输位置和预计到达时间。\n2. 改地址：用户请求修改订单收货地址。",
    );
    const before = await effects();
    const state = await send(id, "按附件做客服测试，开始吧", [
      decision("execute"),
      { name: "read_background", input: { documentId } },
      {
        name: "plan_task",
        input: { question: "查物流的定义是什么？", nextAction: "none" },
      },
      {
        name: "plan_task",
        input: { question: "你希望这次一共生成多少条？", nextAction: "none" },
      },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.question).toBe("你希望这次一共生成多少条？");
    expect(
      observed[2].tools.find((t: any) => t.function.name === "plan_task")
        .function.parameters.properties.control.properties.mode.enum,
    ).toEqual(["execute"]);
    expect(
      state.turns
        .at(-1)
        .tools.some(
          (t: any) =>
            t.error?.code === "assistant_plan_clarification_unnecessary",
        ),
    ).toBe(true);
    expect(await effects()).toEqual(before);
  });
  it("retains the legacy steps schema after a truncated call with control already saved", async () => {
    const id = await session("plan");
    const before = await effects();
    const state = await send(id, "继续调整方案，先不执行", [
      decision("plan"),
      {
        name: "plan_task",
        input: {},
        rawInput: '{"steps":[',
        finishReason: "length",
      },
      {
        name: "plan_task",
        input: {
          executionMode: "plan",
          requirements: ["保持原意"],
          steps: [
            {
              title: "建立草稿",
              action: "create_draft",
              input: { name: "执行边界草稿", purpose: "隔离测试" },
            },
          ],
        },
      },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    const schema = observed[2].tools.find(
      (t: any) => t.function.name === "plan_task",
    ).function.parameters;
    expect(
      schema.properties.steps.items.oneOf.flatMap(
        (variant: any) => variant.properties.action.enum ?? [],
      ),
    ).toContain("generate_candidates");
    expect(state.task.executionPlan.mode).toBe("plan");
    expect(await effects()).toEqual(before);
  });
});
