import { sha256 } from "../../src/package/contract.js";
import { updateTask, queueContinuation } from "../../src/assistant/tasks.js";
import { assistantContext } from "../../src/assistant/context.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const origin = "http://127.0.0.1:4217";
const rootUrl = loadConfig().databaseUrl;
const databaseName = "assistant_opt48_" + randomUUID().replaceAll("-", "");
const databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + databaseName);
type Call = {
  name: string;
  input: Record<string, unknown>;
  rawInput?: string;
  finishReason?: string;
  httpStatus?: number;
  text?: string;
};
let script: Call[] = [];
let observed: any[] = [];
const prose = "当前状态已核对，原有成果保留。";
const omitDiscovery = false;
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  observed.push(JSON.parse(raw));
  let call = script.shift();
  const body = observed.at(-1);
  if (call?.httpStatus) {
    response.writeHead(call.httpStatus, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "synthetic transport interruption" },
      }),
    );
    return;
  }
  if (
    !call &&
    !omitDiscovery &&
    body.tool_choice?.function?.name === "query_project"
  )
    call = { name: "query_project", input: { kind: "files" } };
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
          finish_reason:
            call?.finishReason ?? (call && !call.text ? "tool_calls" : "stop"),
          message:
            call && !call.text
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
              : { role: "assistant", content: call?.text ?? prose },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    }),
  );
});

describe("OPT48 task boundaries and complete request projection", () => {
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
      .tools.filter((t: any) => t.name === name && t.status === "succeeded");
  const newSession = async () =>
    (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId as string;
  async function dbQuery(sql: string, params: any[] = []) {
    const db = createPool(databaseUrl);
    try {
      return await db.query(sql, params);
    } finally {
      await db.end();
    }
  }
  async function effects() {
    return (
      await dbQuery(
        "SELECT (SELECT count(*)::int FROM collaborative_draft) AS drafts,(SELECT count(*)::int FROM processing_run) AS runs",
      )
    ).rows[0];
  }
  async function draft(name: string, rows = 2) {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/collaborative-drafts",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { name },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().draft.id;
    for (let i = 0; i < rows; i++) {
      const r = await app.inject({
        method: "POST",
        url:
          "/api/projects/" +
          projectId +
          "/collaborative-drafts/" +
          id +
          "/records",
        headers,
        payload: {
          question: "  问题" + i + "  ",
          expectedOutput: "  原标签  ",
          metadata: [
            { key: "intent", value: i ? "B" : " A " },
            { key: "other", value: " A " },
          ],
        },
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    return id as string;
  }
  it("isolates sequential goals, archives actual budgets and restores the original identity", async () => {
    const id = await newSession();
    await send(id, "先查看状态", [decision("query")]);
    const before = (
      await dbQuery(
        "SELECT task,task_revision FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0];
    const old = {
      ...before.task,
      title: "任务甲",
      goal: "创建原目标",
      requirements: ["仅退款"],
      stage: "complete",
      executionBudget: { ...before.task.executionBudget, modelSteps: 130 },
    };
    await dbQuery("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      id,
      old,
    ]);
    const next = await send(id, "另开一个任务，帮我查看当前资料", [
      decision("query"),
    ]);
    expect(next.task.taskId).not.toBe(old.taskId);
    expect(next.task.requirements).toEqual([]);
    const archived = (
      await dbQuery(
        "SELECT * FROM assistant_task_checkpoint WHERE session_id=$1 AND id=$2",
        [id, old.taskId],
      )
    ).rows[0];
    expect(archived.task.executionBudget.modelSteps).toBe(130);
    expect(archived.task.requirements).toEqual(["仅退款"]);
    const restored = await send(id, "恢复任务“任务甲”");
    expect(restored.task.taskId).toBe(old.taskId);
    expect(restored.task.requirements).toEqual(["仅退款"]);
    const actual = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    expect(actual.executionBudget.modelSteps).toBeGreaterThanOrEqual(130);
  });
  it("keeps failed amendments and continuations in the original task without resetting budget", async () => {
    const id = await newSession();
    await send(id, "先查询状态", [decision("query")]);
    const old = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
      id,
      {
        stage: "failed",
        executionBudget: {
          modelSteps: 130,
          toolCalls: 10,
          transportRetries: 0,
          activeMs: 5,
        },
      },
    ]);
    for (const text of [
      "继续",
      "改名为任务乙",
      "数量改成3+2",
      "先查询状态",
      "新开一个任务，继续刚才",
      "新开一个任务，请继续刚才",
      "新开一个任务，麻烦你接着原任务",
      "新开一个任务，生成内容；请按原任务执行",
    ]) {
      const requestsBefore = observed.length;
      const refused = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + id + "/turns",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: text },
      });
      if (refused.statusCode === 202)
        expect(refused.json().status).toBe("succeeded");
      else expect(refused.statusCode, refused.body).toBe(409);
      expect(observed.length).toBe(requestsBefore);
      const now = (
        await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      expect(now.taskId).toBe(old.taskId);
      expect(now.executionBudget.modelSteps).toBe(130);
    }
  });
  it("paginates 120 mixed turns across three tasks and accepts one new message", async () => {
    const id = await newSession();
    await send(id, "查看状态", [decision("query")]);
    const task = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    await dbQuery(
      `INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,assistant_text,status,expires_at,event,task_revision,task_id,created_at)
      SELECT 'history_'||$1||'_'||n,$1,'history_'||n,'synthetic','用户消息'||n,'历史答复'||n,'succeeded',now(),CASE WHEN n%2=0 THEN 'user' ELSE 'budget_yield' END,1,CASE WHEN n<=40 THEN 'synthetic-task-a' WHEN n<=80 THEN 'synthetic-task-b' ELSE $2 END,now()-interval '1 day'+n*interval '1 second' FROM generate_series(1,120) n`,
      [id, task.taskId],
    );
    const checkpoints = ["synthetic-task-a", "synthetic-task-b"].map(
      (taskId, i) => ({
        taskId,
        taskContractVersion: 2,
        title: "已归档任务" + i,
        executionBudget: {
          modelSteps: 70 + i,
          toolCalls: 3,
          activeMs: 25,
          transportRetries: 0,
        },
      }),
    );
    for (const archived of checkpoints)
      await dbQuery(
        "INSERT INTO assistant_task_checkpoint(session_id,id,task,revision,dependencies,requires_write) VALUES($1,$2,$3,1,'[]',false)",
        [id, archived.taskId, archived],
      );
    let before: string | undefined;
    const seen = new Set<string>();
    let counts: any;
    do {
      const page = (
        await app.inject({
          method: "GET",
          url:
            base() +
            "/sessions/" +
            id +
            "?view=messages&limit=17" +
            (before ? "&before=" + before : ""),
          headers,
        })
      ).json();
      expect(page.turns.length).toBeLessThanOrEqual(17);
      for (const turn of page.turns) {
        expect(seen.has(turn.id)).toBe(false);
        seen.add(turn.id);
      }
      before = page.pagination.nextBefore;
      counts = page.pagination;
    } while (before);
    expect(seen.size).toBe(121);
    expect(counts.userTurns).toBe(61);
    expect(counts.automaticTurns).toBe(60);
    const state = await send(id, "当前资料是什么", [decision("query")]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(
      (
        await dbQuery(
          "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(122);
    expect(JSON.stringify(observed)).not.toContain('历史答复1\\"');
    expect(
      (
        await dbQuery(
          "SELECT task FROM assistant_task_checkpoint WHERE session_id=$1 ORDER BY id",
          [id],
        )
      ).rows.map((x) => x.task),
    ).toEqual(checkpoints);
  });
  it("does not let stale dependencies block an independent goal or leak their history", async () => {
    const id = await newSession();
    await send(id, "查看状态", [decision("query")]);
    await dbQuery(
      `UPDATE assistant_turn SET dependencies='[{"kind":"asset","id":"asset_unavailable"}]',user_text='旧私密来源内容',assistant_text='旧私密答复' WHERE session_id=$1`,
      [id],
    );
    const continuation = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "继续" },
    });
    expect(continuation.statusCode).toBe(409);
    const state = await send(id, "另开一个任务，查询当前项目资料", [
      decision("query"),
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(JSON.stringify(state)).not.toContain("旧私密");
    expect(JSON.stringify(observed)).not.toContain("旧私密");
  });
  it("fences late replies and automatic events after switching unfinished work", async () => {
    const id = await newSession();
    await send(id, "查询资料", [decision("query")]);
    const row = (
      await dbQuery("SELECT * FROM assistant_session WHERE id=$1", [id])
    ).rows[0];
    const oldTurn = (
      await dbQuery(
        "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
      id,
      { title: "未完成甲", stage: "planning", executionPaused: true },
    ]);
    await dbQuery(
      "UPDATE assistant_turn SET status='running',execution_token='late-token',expires_at=now()+interval '1 minute' WHERE id=$1",
      [oldTurn.id],
    );
    const next = await send(id, "先暂停当前任务，切换到整理另一份资料", [
      decision("query"),
    ]);
    expect(next.task.taskId).not.toBe(row.task.taskId);
    const db = createPool(databaseUrl);
    try {
      await expect(
        updateTask(
          db,
          { ...oldTurn, execution_token: "late-token" },
          { requirements: ["迟到污染"] },
        ),
      ).rejects.toMatchObject({ code: "assistant_interrupted" });
      await queueContinuation(
        db,
        id,
        "processing_completed",
        "old-event",
        row.task_revision,
      );
    } finally {
      await db.end();
    }
    const now = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    expect(now.taskId).toBe(next.task.taskId);
    expect(now.requirements).not.toContain("迟到污染");
    const old = (
      await dbQuery(
        "SELECT * FROM assistant_task_checkpoint WHERE session_id=$1 AND id=$2",
        [id, row.task.taskId],
      )
    ).rows[0];
    expect(old.task.stage).toBe("planning");
    expect(old.task.turnBudget.attemptStartedAt).toBeNull();
    const snapshot = await app.inject({
      method: "GET",
      url: base() + "/sessions/" + id + "/tasks/" + row.task.taskId,
      headers,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().taskId).toBe(row.task.taskId);
    expect((await read(id)).task.taskId).toBe(next.task.taskId);
  });
  it("allows only one concurrent switch from the same observed revision", async () => {
    const id = await newSession();
    await send(id, "查询资料", [decision("query")]);
    const revision = (
      await dbQuery("SELECT task_revision FROM assistant_session WHERE id=$1", [
        id,
      ])
    ).rows[0].task_revision;
    script = [decision("query")];
    const results = await Promise.all(
      [1, 2].map((n) =>
        app.inject({
          method: "POST",
          url: base() + "/sessions/" + id + "/turns",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            message: "另开一个任务，查询第" + n + "份资料",
            expectedTaskRevision: revision,
          },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(1);
    await expect
      .poll(async () => (await read(id)).turns.at(-1)?.status, {
        timeout: 15000,
      })
      .toMatch(/succeeded|failed/);
    expect(
      (
        await dbQuery(
          "SELECT count(*)::int n FROM assistant_task_checkpoint WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("reads legacy state without identity writes, budget migration or history reruns", async () => {
    const id = await newSession();
    const task = {
      goal: "旧关闭任务",
      title: "旧关闭任务",
      stage: "complete",
      requirements: [],
      supplements: [],
      executionBudget: {
        modelSteps: 130,
        toolCalls: 100,
        transportRetries: 0,
        activeMs: 500,
      },
    };
    await dbQuery("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      id,
      task,
    ]);
    await dbQuery(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at) VALUES($1,$2,'legacy','legacy','旧用户消息','succeeded',now())",
      ["legacy_" + randomUUID(), id],
    );
    const before = (
      await dbQuery(
        "SELECT task,task_revision,xmin::text AS rev FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0];
    for (const suffix of ["", "?view=status", "?view=messages&limit=10"])
      expect(
        (
          await app.inject({
            method: "GET",
            url: base() + "/sessions/" + id + suffix,
            headers,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await dbQuery(
          "SELECT task,task_revision,xmin::text AS rev FROM assistant_session WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual(before);
    expect(
      (
        await dbQuery(
          "SELECT count(*)::int n FROM assistant_task_checkpoint WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it.each([9, 20])(
    "preserves all %i long requirements in actual normal and correction payloads",
    async (count) => {
      const id = await newSession();
      await send(id, "查询资料", [decision("query")]);
      const requirements = Array.from({ length: count }, (_, i) =>
        ("约束" + i + ":").padEnd(1000, "a"),
      );
      await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
        id,
        {
          requirements,
          goal: "撤销限制：旧约束不再生效",
          supplements: ["旧要求取消，不采用"],
          stage: "planning",
        },
      ]);
      const state = await send(id, "查看当前资料，先不要执行", [
        {
          name: "plan_task",
          input: {},
          rawInput: '{"control":',
          finishReason: "length",
        },
        decision("query"),
        { name: "query_project", input: { kind: "files" } },
      ]);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(observed.length).toBeGreaterThanOrEqual(2);
      for (const body of observed) {
        expect(
          Buffer.byteLength(JSON.stringify(body)) +
            Number(body.max_tokens ?? 4096) +
            1024,
        ).toBeLessThanOrEqual(131072);
        for (const rule of requirements)
          expect(JSON.stringify(body)).toContain(rule);
        expect(JSON.stringify(body)).not.toContain("旧约束不再生效");
      }
      expect(
        (await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id]))
          .rows[0].task.requirements,
      ).toEqual(requirements);
    },
  );
  it("preserves Metadata customerId and ID-shaped ordinary values through real aliases", async () => {
    const id = await newSession(),
      draftId = await draft("元信息别名测试", 0);
    const value = "asset_" + "a".repeat(32);
    expect(
      (
        await app.inject({
          method: "POST",
          url:
            "/api/projects/" +
            projectId +
            "/collaborative-drafts/" +
            draftId +
            "/records",
          headers,
          payload: {
            question: "用户普通问题",
            expectedOutput: "正常回答",
            metadata: [
              { key: "customerId", value },
              { key: "runId", value: "d:ordinary-user-value" },
            ],
          },
        })
      ).statusCode,
    ).toBe(201);
    const ref = "d:" + sha256(draftId).slice(0, 16);
    const state = await send(
      id,
      "查看当前草稿",
      [
        decision("query"),
        {
          name: "read_records",
          input: { source: { kind: "draft", id: ref }, limit: 2 },
        },
      ],
      { context: { kind: "draft", id: draftId } },
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    const record = successes(state, "read_records")[0].result.records[0];
    expect(record.metadata).toEqual([
      { key: "customerId", value },
      { key: "runId", value: "d:ordinary-user-value" },
    ]);
    const db = createPool(databaseUrl);
    try {
      const context = await assistantContext(
        db,
        {
          projectId,
          actorId: (
            await dbQuery(
              "SELECT actor_id FROM assistant_session WHERE id=$1",
              [id],
            )
          ).rows[0].actor_id,
        },
        id,
      );
      expect(
        context.decode(
          context.encode({
            metadata: { customerId: value, runId: "d:ordinary-user-value" },
          }),
        ),
      ).toEqual({
        metadata: { customerId: value, runId: "d:ordinary-user-value" },
      });
      expect(() => context.decode({ runId: "o:unknown" })).toThrow(
        "assistant_reference_invalid",
      );
    } finally {
      await db.end();
    }
  });
  it("accepts independent read goals after downgrade and redacts historical write content", async () => {
    const id = await newSession();
    await send(id, "查询资料", [decision("query")]);
    const actor = (
      await dbQuery("SELECT actor_id FROM assistant_session WHERE id=$1", [id])
    ).rows[0].actor_id;
    await dbQuery(
      "UPDATE assistant_turn SET requires_write=true,user_text='降权前私密写入' WHERE session_id=$1",
      [id],
    );
    await dbQuery("UPDATE app_user SET role='user' WHERE id=$1", [actor]);
    await dbQuery(
      "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(project_id,user_id) DO UPDATE SET role='viewer'",
      [projectId, actor],
    );
    try {
      const state = await send(id, "另开一个任务，查询可查看的资料", [
        decision("query"),
      ]);
      expect(state.turns.at(-1).status).toBe("succeeded");
      expect(JSON.stringify(state)).not.toContain("降权前私密写入");
      expect(JSON.stringify(observed)).not.toContain("降权前私密写入");
    } finally {
      await dbQuery("UPDATE app_user SET role='admin' WHERE id=$1", [actor]);
      await dbQuery(
        "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
        [projectId, actor],
      );
    }
  });
  it("permanently deleting an old source purges its task body without clearing the independent current goal or budget", async () => {
    const id = await newSession(),
      draftId = await draft("应清除的原文", 0);
    const first = await send(id, "查看当前草稿", [decision("query")], {
      context: { kind: "draft", id: draftId },
    });
    await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
      id,
      { requirements: ["旧任务私密正文"], title: "应清除的原文" },
    ]);
    const next = await send(id, "另开一个任务，查询公开资料", [
      decision("query"),
    ]);
    const before = (
      await dbQuery(
        "SELECT task,task_revision FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0];
    await dbQuery(
      "UPDATE collaborative_draft SET status='discarded' WHERE id=$1",
      [draftId],
    );
    const after = (
      await dbQuery(
        "SELECT task,task_revision FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(after).toEqual(before);
    expect(after.task.taskId).toBe(next.task.taskId);
    const archived = (
      await dbQuery(
        "SELECT task FROM assistant_task_checkpoint WHERE session_id=$1 AND id=$2",
        [id, first.task.taskId],
      )
    ).rows[0].task;
    expect(JSON.stringify(archived)).not.toContain("私密正文");
    expect(JSON.stringify(archived)).not.toContain("应清除的原文");
    expect(archived.executionBudget).toBeTruthy();
    expect(JSON.stringify(await read(id))).not.toContain("私密正文");
    expect(
      (
        await app.inject({
          method: "GET",
          url: base() + "/sessions/" + id + "/tasks/" + first.task.taskId,
          headers,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("reports an actual provider-boundary capacity rejection without an HTTP request or lost input", async () => {
    await app.close();
    app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        assistantContextWindowTokens: 8192,
      },
      { disableLegacyTestBootstrap: true },
    );
    try {
      const id = await newSession();
      const state = await send(id, "请保存我这次的完整需求，先不要生成");
      expect(state.turns.at(-1).status).toBe("failed");
      expect(state.turns.at(-1).errorCode).toBe("assistant_context_capacity");
      expect(observed).toHaveLength(0);
      expect(
        (await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id]))
          .rows[0].task.goal,
      ).toBe("请保存我这次的完整需求，先不要生成");
    } finally {
      await app.close();
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
    }
  });
  it("keeps draft creation idempotent and invalidates an old publication card across a task switch", async () => {
    const id = await newSession();
    const created = await send(id, "创建一个测试集草稿", [
      decision("execute"),
      {
        name: "create_draft",
        input: { name: "任务边界确认测试", purpose: "合成回归" },
      },
    ]);
    expect(
      created.turns.at(-1).status,
      JSON.stringify(created.turns.at(-1)),
    ).toBe("succeeded");
    const draftId = successes(created, "create_draft")[0].result.draftId;
    expect(
      (
        await app.inject({
          method: "POST",
          url:
            "/api/projects/" +
            projectId +
            "/collaborative-drafts/" +
            draftId +
            "/records",
          headers,
          payload: {
            question: "完整的合成问题？",
            expectedOutput: "正常回答",
            metadata: [],
          },
        })
      ).statusCode,
    ).toBe(201);
    const prepared = await send(id, "请发布这个草稿", [
      decision("execute"),
      { name: "request_publish", input: { draftId } },
    ]);
    const proposal = prepared.proposals.find(
      (p: any) => p.action === "publish",
    );
    expect(proposal.status).toBe("pending");
    const before = await effects();
    await send(id, "另开一个任务，查询其他资料", [decision("query")]);
    const rejected = await app.inject({
      method: "POST",
      url: base() + "/proposals/" + proposal.id + "/confirm",
      headers,
      payload: {},
    });
    expect(rejected.statusCode).toBe(409);
    expect(await effects()).toEqual(before);
    expect(
      (await dbQuery("SELECT count(*)::int n FROM test_set_version")).rows[0].n,
    ).toBe(0);
    const latest = (
      await dbQuery(
        "SELECT operation_key,user_text FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    const replay = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": latest.operation_key },
      payload: { message: latest.user_text },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(await effects()).toEqual(before);
  });
  it("uses existing structured intent to clarify an unfamiliar independent goal once", async () => {
    const id = await newSession();
    await send(id, "查询资料", [decision("query")]);
    const original = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task.taskId;
    const asked = await send(
      id,
      "咱们把手里的先放一放，我想做退款方面的另一套问题",
      [
        {
          name: "plan_task",
          input: { control: { mode: "plan", taskBoundary: "new" } },
        },
      ],
    );
    expect(asked.task.taskId).toBe(original);
    expect(asked.task.question).toContain("另开目标");
    const next = await send(id, "另开目标", [decision("query")]);
    expect(next.task.taskId).not.toBe(original);
  });
  it.each([9, 20])(
    "projects actual recovery requests with %i full requirements, pending amendment and original task identity",
    async (count) => {
      const id = await newSession();
      await send(id, "查询资料", [decision("query")]);
      const original = (
        await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      const requirements = Array.from({ length: count }, (_, i) =>
        ("恢复约束" + i + ":").padEnd(1000, "b"),
      );
      await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
        id,
        { requirements },
      ]);
      const failed = await send(id, "数量改为5条，先只保存要求，不执行", [
        decision("plan", { requiresUpdate: true }),
        ...Array.from({ length: 3 }, () => ({
          name: "plan_task",
          input: {},
          httpStatus: 503,
        })),
      ]);
      expect(failed.turns.at(-1).status).toBe("failed");
      const before = (
        await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      expect(before.planningRecovery).toBeTruthy();
      const resumed = await send(id, "继续规划", [
        decision("plan", { requiresUpdate: true }),
        {
          name: "plan_task",
          input: {
            targetCount: 5,
            countKind: "final",
            nextAction: "none",
          },
        },
      ]);
      expect(
        resumed.turns.at(-1).status,
        JSON.stringify(resumed.turns.at(-1)),
      ).toBe("succeeded");
      expect(resumed.task.taskId).toBe(original.taskId);
      expect(resumed.task.targetCount).toBe(5);
      expect(observed.length).toBeGreaterThan(0);
      for (const body of observed) {
        expect(
          Buffer.byteLength(JSON.stringify(body)) +
            Number(body.max_tokens ?? 4096) +
            1024,
        ).toBeLessThanOrEqual(131072);
        expect(JSON.stringify(body)).toContain("5条");
        for (const rule of requirements)
          expect(JSON.stringify(body)).toContain(rule);
      }
      const after = (
        await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
      ).rows[0].task;
      expect(after.requirements).toEqual(requirements);
      expect(after.executionBudget.modelSteps).toBeGreaterThanOrEqual(
        before.executionBudget.modelSteps,
      );
    },
  );
  it("asks a boundary question once and uses the actual reply without a fresh-budget loophole", async () => {
    const id = await newSession();
    await send(id, "查询资料", [decision("query")]);
    const old = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    const asked = await send(id, "另外，创建退款测试集");
    expect(asked.turns.at(-1).assistantText).toContain("另开目标");
    expect(observed).toHaveLength(0);
    const kept = await send(id, "继续当前任务", [decision("query")]);
    expect(kept.task.taskId).toBe(old.taskId);
    const switched = await send(id, "另开一个目标，创建新的退货问题集", [
      decision("query"),
    ]);
    expect(switched.task.taskId).not.toBe(old.taskId);
  });
  it("retains recent explanations as evidence for an ordinary referential follow-up", async () => {
    const id = await newSession();
    const explanation = "第一种逐条查看，第二种按标签浏览。";
    const first = await send(id, "怎么做比较合适", [
      decision("query"),
      { name: "query_project", input: { kind: "files" } },
      { name: "", input: {}, text: explanation },
    ]);
    expect(first.turns.at(-1).assistantText).toContain("第二种");
    const followed = await send(id, "按你刚才说的第二种，先不执行", [
      decision("query"),
    ]);
    expect(followed.turns.at(-1).status).toBe("succeeded");
    for (const body of observed) {
      expect(JSON.stringify(body)).toContain(explanation);
      expect(JSON.stringify(body)).toContain("只作指代证据");
      expect(JSON.stringify(body)).toContain("按你刚才说的第二种");
    }
  });
  it("uses the actual new page context instead of the inherited focus", async () => {
    const id = await newSession(),
      first = await draft("首个页面"),
      second = await draft("当前页面");
    await send(id, "查看草稿", [decision("query")], {
      context: { kind: "draft", id: first },
    });
    await send(id, "查看当前页面", [decision("query")], {
      context: { kind: "draft", id: second },
    });
    for (const body of observed) {
      const facts = body.messages.find(
        (m: any) =>
          typeof m.content === "string" &&
          m.content.startsWith("服务端本轮对象快照"),
      );
      const snapshot = JSON.parse(facts.content.split("当前业务上下文：\n")[1]);
      expect(snapshot.pageObject.ref).toBe("d:" + sha256(second).slice(0, 16));
    }
  });
  it.each([9, 20])(
    "rejects %i oversized derived requirements through the public execution entry without a submitted run",
    async (count) => {
      const id = await newSession(),
        draftId = await draft("派生指令容量" + count);
      await send(id, "查看草稿", [decision("query")], {
        context: { kind: "draft", id: draftId },
      });
      const requirements = Array.from({ length: count }, (_, i) =>
        ("执行约束" + i + ":").padEnd(1000, "c"),
      );
      await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
        id,
        { requirements },
      ]);
      const before = await effects();
      const state = await send(
        id,
        "对当前草稿的全部记录按已保存的完整要求改写",
        [
          decision("execute"),
          {
            name: "submit_processing",
            input: {
              operation: "rewrite",
              source: {
                kind: "draft",
                id: "d:" + sha256(draftId).slice(0, 16),
              },
              allRecords: true,
            },
          },
        ],
        { context: { kind: "draft", id: draftId } },
      );
      const errors = state.turns
        .at(-1)
        .tools.filter(
          (t: any) => t.name === "submit_processing" && t.status === "failed",
        );
      expect(errors.length, JSON.stringify(state.turns.at(-1))).toBeGreaterThan(
        0,
      );
      expect(errors[0].error.code).toBe("assistant_context_capacity");
      expect(errors[0].error.hint).toContain("8000");
      expect(
        (await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id]))
          .rows[0].task.requirements,
      ).toEqual(requirements);
      expect(await effects()).toEqual(before);
    },
  );
  it.each(["current", "legacy"])(
    "reuses older committed drafts independently of model history and isolates same names across tasks (%s)",
    async (format) => {
      const id = await newSession(),
        name = "相同显示名称";
      const created = await send(id, "创建退款业务的测试集", [
        decision("execute"),
        { name: "create_draft", input: { name, purpose: "退款业务" } },
      ]);
      const first = successes(created, "create_draft")[0].result.draftId,
        taskId = created.task.taskId;
      if (format === "legacy") {
        await dbQuery(
          "UPDATE assistant_session SET task=task-'taskId'-'taskContractVersion'-'budgetLedger' WHERE id=$1",
          [id],
        );
        await dbQuery(
          "UPDATE assistant_turn SET task_id=NULL WHERE session_id=$1",
          [id],
        );
      }
      for (let n = 0; n < 6; n++)
        await send(id, "查询当前状态", [decision("query")]);
      const before = await effects();
      const reused = await send(id, "继续使用已建立的草稿", [
        decision("execute"),
        { name: "create_draft", input: { name, purpose: "退款业务" } },
      ]);
      expect(successes(reused, "create_draft")[0].result).toMatchObject({
        draftId: first,
        reused: true,
      });
      expect(await effects()).toEqual(before);
      const independent = await send(
        id,
        "另开一个任务，创建退货业务的独立测试集",
        [
          decision("execute"),
          { name: "create_draft", input: { name, purpose: "退货业务" } },
        ],
      );
      expect(independent.task.taskId).not.toBe(taskId);
      expect(successes(independent, "create_draft")[0].result.draftId).not.toBe(
        first,
      );
      expect((await effects()).drafts).toBe(before.drafts + 1);
    },
  );
});
