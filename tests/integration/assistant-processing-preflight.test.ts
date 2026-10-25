import { revisePlan, planRequirementsKey } from "../../src/assistant/plan.js";
import { canonicalJson, sha256 } from "../../src/package/contract.js";
import { selectRecords } from "../../src/selection/index.js";
import { vi } from "vitest";
import * as processingStore from "../../src/processing/store.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { discoverSources } from "../../src/assistant/source-discovery.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const origin = "http://127.0.0.1:4217";
const rootUrl = loadConfig().databaseUrl;
const databaseName = "assistant_opt47_" + randomUUID().replaceAll("-", "");
const databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + databaseName);
type Call = {
  name: string;
  input: Record<string, unknown>;
  rawInput?: string;
  finishReason?: string;
  text?: string;
  beforeReply?: () => Promise<void>;
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
  if (call?.beforeReply) await call.beforeReply();
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

describe("OPT47 unified processing public boundary", () => {
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
  async function file(name: string, count = 2) {
    const collections = (
      await app.inject({
        method: "GET",
        url: "/api/projects/" + projectId + "/collections",
        headers,
      })
    ).json();
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/pending-uploads",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-agentbench-upload-encoding": "percent-utf8",
      },
      payload:
        '{"fixture":' +
        JSON.stringify(name) +
        ',"question":"  问题甲  ","answer":"  原标签  ","intent":" A "}\n{"question":"  问题乙  ","answer":"  原标签  ","intent":"B"}\n' +
        (count === 3
          ? '{"question":"  问题丙  ","answer":"  原标签  ","intent":"C"}\n'
          : ""),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const saved = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/pending-upload-batches/confirm",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        collectionId: collections.collections[0].id,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().assets[0].id;
    const url = "/api/projects/" + projectId + "/assets/" + id + "/mapping";
    const mapping = (await app.inject({ method: "GET", url, headers })).json();
    const mapped = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        parsedViewId: mapping.parsedViewId,
        expectedRevision: 0,
        mapping: {
          question: "/question",
          expectedOutput: "/answer",
          metadata: ["/intent"],
        },
      },
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    return id as string;
  }
  async function finishClean(runId: string) {
    const db = createPool(databaseUrl);
    const config = { ...loadConfig(), databaseUrl };
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt47-test',lease_expires_at=now()+interval '60 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
    } finally {
      await db.end();
    }
    const result = await app.inject({
      method: "GET",
      url:
        "/api/projects/" +
        projectId +
        "/processing-runs/" +
        runId +
        "?view=all&limit=20",
      headers,
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json();
  }

  it.each(["query", "plan", "execute"])(
    "OPT50 generic processing intent %s must discover real sources before asking",
    async (mode) => {
      await file("首轮资料甲" + randomUUID() + ".jsonl");
      await file("首轮资料乙" + randomUUID() + ".jsonl");
      const id = await newSession(),
        before = await effects();
      const state = await send(id, "帮我整理一下这些数据", [
        decision(mode),
        { name: "query_project", input: { kind: "files" } },
      ]);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.task.question).toContain("请选择要处理的资料");
      expect(state.task.sourceDiscovery.items.length).toBeGreaterThan(1);
      expect(state.task.sourceDiscovery.reads).toBeLessThanOrEqual(2);
      expect(observed).toHaveLength(2);
      expect(observed[1].tools.map((t: any) => t.function.name)).toEqual([
        "query_project",
      ]);
      expect(observed[1].tool_choice).toEqual({
        type: "function",
        function: { name: "query_project" },
      });
      expect(state.task.turnControl.mode).toBe(mode);
      expect(await effects()).toEqual(before);
    },
  );

  it.each([null, "files", [{ kind: "files" }]])(
    "OPT50 damaged root query %j uses context and persists bounded source clarification",
    async (broken) => {
      await file("根参数候选甲" + randomUUID() + ".jsonl");
      await file("根参数候选乙" + randomUUID() + ".jsonl");
      const id = await newSession(),
        before = await effects();
      const state = await send(id, "帮我整理一下这些数据", [
        decision("query"),
        { name: "query_project", input: {}, rawInput: JSON.stringify(broken) },
        { name: "query_project", input: { kind: "files" } },
      ]);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.task.stage).toBe("waiting_input");
      expect(state.task.question).toContain("请选择");
      expect(state.task.sourceDiscovery.reads).toBeLessThanOrEqual(2);
      expect(await effects()).toEqual(before);
      expect(observed).toHaveLength(3);
      const repair = JSON.parse(
        observed[2].messages.find(
          (m: any) =>
            typeof m.content === "string" &&
            m.content.includes('"operation":"repair_tool_arguments"'),
        ).content,
      );
      expect(repair.repairClass).toBe("context");
      expect(repair.context.request).toBe("帮我整理一下这些数据");
    },
  );

  it.each([false, true])(
    "OPT50 a filename reply binds the real source with requiresUpdate=%s",
    async (requiresUpdate) => {
      const target = await file("回答来源" + requiresUpdate + "测试.jsonl");
      await file("回答其他" + requiresUpdate + "资料.jsonl");
      const id = await newSession(),
        before = await effects();
      await send(id, "帮我整理一下这些数据", [
        decision("query"),
        { name: "query_project", input: { kind: "files" } },
      ]);
      const state = await send(id, "回答来源" + requiresUpdate + "测试.jsonl", [
        decision("plan", { requiresUpdate }),
        { name: "", input: {}, text: "已选定资料，请说明清洗要求。" },
      ]);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.task.target).toEqual({ kind: "assets", assetIds: [target] });
      expect(state.task.processingClarification).toBeNull();
      expect(state.task.question ?? "").not.toContain("请选择要处理的资料");
      expect(await effects()).toEqual(before);
    },
  );
  it.each([
    "same source",
    "combined field requirements",
    "different source",
    "changed count",
    "reduced scope",
    "only refund",
    "exclude refund",
  ])(
    "OPT50 multi-turn cleaning keeps source-bound authorization: %s",
    async (scenario) => {
      const assetId = await file(
        "多轮范围" + scenario + ".jsonl",
        scenario === "changed count" ? 3 : 2,
      );
      const other = await file("另份范围" + scenario + ".jsonl");
      const id = await newSession();
      await send(
        id,
        "清洗这份文件的全部2条记录，其他不改。",
        [
          decision("execute"),
          {
            name: "plan_task",
            input: {
              target: { kind: "assets", assetIds: [assetId] },
              question: "希望怎样清洗？",
              nextAction: "submit_processing",
            },
          },
        ],
        { context: { kind: "asset", id: assetId } },
      );
      await send(id, "只去掉问题前后的空白，期望输出和Metadata保持原样。", [
        decision("plan", { requiresUpdate: true }),
        {
          name: "plan_task",
          input: {
            nextAction: "submit_processing",
            allowedFields: ["question"],
            requirements: [
              "只去掉问题字段前后的空白",
              "期望输出保持原样",
              "Metadata保持原样",
            ],
          },
        },
      ]);
      const targetId = scenario === "different source" ? other : assetId;
      if (scenario === "different source")
        await send(
          id,
          "换成另份资料，先不要执行",
          [
            decision("plan", { requiresUpdate: true }),
            {
              name: "plan_task",
              input: { target: { kind: "assets", assetIds: [other] } },
            },
          ],
          { context: { kind: "asset", id: other } },
        );
      if (scenario === "reduced scope")
        await send(id, "改为只清洗1条，先不要执行", [
          decision("plan"),
          { name: "", input: {}, text: "已暂停，请指定要清洗的记录。" },
        ]);
      const before = await effects();
      const state = await send(
        id,
        scenario === "combined field requirements"
          ? "开始清洗，只去掉问题首尾的空格和换行，期望输出和Metadata保持不变。"
          : scenario === "only refund"
            ? "开始清洗，仅限退款类记录。"
            : scenario === "exclude refund"
              ? "开始清洗，排除退款类记录。"
              : "开始清洗。",
        [
          decision("execute", { requiresUpdate: true }),
          {
            name: "plan_task",
            input: {
              nextAction: "submit_processing",
              allowedFields: ["question"],
            },
          },
          {
            name: "submit_processing",
            input: {
              operation: "clean",
              outputCount: 2,
              ...(scenario === "combined field requirements"
                ? {
                    instructions:
                      "仅去除 question 字段首尾的空格和换行；不修改问题内部内容，不修改 expectedOutput 和 metadata。",
                  }
                : {}),
            },
          },
        ],
        { context: { kind: "asset", id: targetId } },
      );
      if (!["same source", "combined field requirements"].includes(scenario)) {
        expect(await effects()).toEqual(before);
        expect(
          state.task.question,
          JSON.stringify(state.turns.at(-1)),
        ).toBeTruthy();
        if (["only refund", "exclude refund"].includes(scenario)) {
          const continued = await send(id, "继续", [
            decision("execute"),
            { name: "submit_processing", input: { operation: "clean" } },
          ]);
          expect(await effects()).toEqual(before);
          expect(
            successes(continued, "submit_processing").at(-1)?.result,
          ).toMatchObject({
            unchanged: true,
            requiresClarification: true,
            clarification: { kind: "scope" },
          });
          expect(continued.task.question).toBeTruthy();
        }
      } else {
        const submitted = successes(state, "submit_processing").at(-1);
        expect(
          submitted?.result?.runId,
          JSON.stringify(state.turns.at(-1)),
        ).toBeTruthy();
        expect(submitted.result.inputCount).toBe(2);
        expect(submitted.input.outputCount).toBeUndefined();
        expect(submitted.input.instructions ?? "").toBe("");
        expect(await effects()).toEqual({ ...before, runs: before.runs + 1 });
      }
    },
  );

  it("OPT50 query correction dispatch carries latest business issues before ordinary discovery", async () => {
    await file("修复候选A.jsonl");
    await file("修复候选B.jsonl");
    const id = await newSession();
    const before = await effects();
    const state = await send(id, "帮我整理一下这些数据", [
      decision("query"),
      { name: "query_project", input: { kind: "files", search: " " } },
      { name: "query_project", input: { kind: "files" } },
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    const correction = observed[2].messages.find(
      (m: any) =>
        typeof m.content === "string" &&
        m.content.includes('"operation":"repair_tool_arguments"'),
    );
    expect(correction, JSON.stringify(observed[2])).toBeDefined();
    expect(
      JSON.parse(correction.content).error.some(
        (i: any) => i.path === "/search",
      ),
    ).toBe(true);
    expect(state.task.question).toContain("请选择");
    expect(observed).toHaveLength(3);
    expect(await effects()).toEqual(before);
  });

  it("OPT50 failed discovery followed by ordinary continue persists a source question and completes authorized cleaning", async () => {
    const target = await file("继续清洗测试.jsonl");
    await file("继续其他资料.jsonl");
    const id = await newSession();
    const failed = await send(id, "帮我整理一下这些数据", [
      decision("query"),
      { name: "query_project", input: { kind: "files", search: " " } },
      { name: "query_project", input: { kind: "files", search: " " } },
    ]);
    expect(failed.turns.at(-1).status).toBe("failed");
    expect(failed.task.sourceDiscovery).toBeFalsy();
    const taskId = failed.task.taskId;
    const budgetBefore = (
      await dbQuery(
        "SELECT task->'executionBudget' AS budget FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0].budget;
    expect(budgetBefore.requestAttempts).toBeGreaterThan(0);
    const repairBefore = (
      await dbQuery(
        "SELECT task->'parameterRepairLimits' AS limits FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0].limits.query_project;
    const before = await effects();
    const continued = await send(id, "继续", [
      decision("execute"),
      { name: "query_project", input: { kind: "files", search: " " } },
      { name: "query_project", input: { kind: "files" } },
    ]);
    expect(
      continued.turns.at(-1).status,
      JSON.stringify(continued.turns.at(-1)),
    ).toBe("succeeded");
    expect(continued.task.taskId).toBe(taskId);
    expect(continued.task.question).toContain("请选择");
    expect(continued.task.stage).toBe("waiting_input");
    expect(continued.task.sourceDiscovery.items.length).toBeLessThanOrEqual(5);
    expect(observed).toHaveLength(3);
    const repairAfter = (
      await dbQuery(
        "SELECT task->'parameterRepairLimits' AS limits FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0].limits.query_project;
    expect(repairBefore.used).toBe(1);
    expect(repairAfter).toMatchObject({
      identity: repairBefore.identity,
      used: 2,
    });
    expect(await effects()).toEqual(before);
    // A further invalid continue cannot reset correction allowance; the discovered choices remain available.
    const repeated = await send(id, "继续", [
      decision("execute"),
      { name: "query_project", input: { kind: "files", search: " " } },
      { name: "query_project", input: { kind: "files" } },
    ]);
    expect(repeated.turns.at(-1).status).toBe("failed");
    const repairRepeated = (
      await dbQuery(
        "SELECT task->'parameterRepairLimits' AS limits FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0].limits.query_project;
    expect(repairRepeated).toEqual(repairAfter);
    expect(repeated.task.sourceDiscovery.question).toBe(
      continued.task.question,
    );
    expect(repeated.task.taskId).toBe(taskId);
    expect(observed.length).toBeLessThanOrEqual(2);
    const clean = await send(id, "清洗继续清洗测试.jsonl的全部2条，其他不改", [
      decision("execute"),
      {
        name: "query_project",
        input: { kind: "files", search: "继续清洗测试.jsonl" },
      },
      {
        name: "submit_processing",
        input: { operation: "clean", allRecords: true },
      },
    ]);
    const submitted = successes(clean, "submit_processing").at(-1);
    expect(submitted, JSON.stringify(clean.turns.at(-1))).toBeDefined();
    const run = (
      await dbQuery("SELECT source FROM processing_run WHERE id=$1", [
        submitted.result.runId,
      ])
    ).rows[0];
    expect(run.source).toMatchObject({ kind: "assets", assetIds: [target] });
    expect(await effects()).toEqual({ ...before, runs: before.runs + 1 });
    await dbQuery(
      "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
      [id],
    );
    const result = await finishClean(submitted.result.runId);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.result.question).toBe(record.result.question.trim());
      expect(record.result.expectedOutput).toBe("  原标签  ");
    }
    const budgetAfter = (
      await dbQuery(
        "SELECT task->'executionBudget' AS budget FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0].budget;
    expect(budgetAfter.requestAttempts).toBeGreaterThan(
      budgetBefore.requestAttempts,
    );
    expect(budgetAfter.limits).toEqual(budgetBefore.limits);
  });

  it("OPT50 project query schema exposes kind restrictions and repairs the original invalid combination", async () => {
    const id = await newSession();
    const state = await send(id, "帮我整理一下这些数据", [
      decision("query"),
      {
        name: "query_project",
        input: { kind: "project", search: "数据", offset: 0 },
      },
      { name: "query_project", input: { kind: "files" } },
    ]);
    const declared = observed[1].tools.find(
      (t: any) => t.function.name === "query_project",
    ).function.parameters;
    const Ajv = (await import("ajv")).Ajv;
    const validate = new Ajv({ strict: false }).compile(declared);
    expect(validate({ kind: "project", search: "数据", offset: 0 })).toBe(
      false,
    );
    const planSchema = observed[0].tools.find(
      (t: any) => t.function.name === "plan_task",
    ).function.parameters;
    const queryStep = planSchema.properties.steps.items.oneOf.find((s: any) =>
      s.properties.action.enum.includes("query_project"),
    );
    const validateStepInput = new Ajv({ strict: false }).compile(
      queryStep.properties.input,
    );
    expect(validateStepInput({ kind: "project", search: "数据" })).toBe(false);
    expect(validateStepInput({ kind: "files", search: "客服" })).toBe(true);
    expect(validate({ kind: "project" })).toBe(true);
    expect(validate({ kind: "files", search: "客服", offset: 0 })).toBe(true);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.question).toContain("请选择");
    expect(observed.length).toBeLessThanOrEqual(4);
  });

  it("OPT50 continue after failed named discovery keeps the original requested filename", async () => {
    const target = await file("续接指定文件.jsonl");
    const id = await newSession();
    const failed = await send(id, "帮我整理续接指定文件.jsonl", [
      decision("query"),
      { name: "query_project", input: { kind: "files", search: " " } },
      { name: "query_project", input: { kind: "files", search: " " } },
    ]);
    expect(failed.turns.at(-1).status).toBe("failed");
    const before = await effects();
    const state = await send(id, "继续", [
      decision("query"),
      {
        name: "query_project",
        input: { kind: "files", search: "续接指定文件.jsonl" },
      },
      { name: "", input: {}, text: "已找到指定文件，可以继续确认处理要求。" },
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(state.task.sourceDiscovery.resolvedSource).toEqual({
      kind: "assets",
      assetIds: [target],
    });
    expect(await effects()).toEqual(before);
  });

  it("OPT47 bounded discovery persists real ambiguity and never requests a model summary", async () => {
    for (let i = 0; i < 6; i++) await draft("发现候选" + i, 1);
    const id = await newSession();
    const before = await effects();
    const state = await send(id, "帮我整理一下这些数据", [
      decision("execute"),
      { name: "query_project", input: { kind: "files", search: "数据" } },
    ]);
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.sourceDiscovery.items.length).toBeLessThanOrEqual(5);
    expect(state.task.sourceDiscovery.items.length).toBeGreaterThan(1);
    expect(state.task.sourceDiscovery.reads).toBeLessThanOrEqual(2);
    expect(state.task.question).toContain("请选择");
    expect(observed).toHaveLength(2);
    expect(await effects()).toEqual(before);
    const again = await send(id, "继续找这些数据", [
      decision("execute"),
      { name: "query_project", input: { kind: "drafts" } },
      { name: "query_project", input: { kind: "versions" } },
    ]);
    expect(again.task.sourceDiscovery.reads).toBe(
      state.task.sourceDiscovery.reads,
    );
    expect(again.task.sourceDiscovery.items.map((x: any) => x.id)).toEqual(
      state.task.sourceDiscovery.items.map((x: any) => x.id),
    );
    expect(observed).toHaveLength(2);
    expect(await effects()).toEqual(before);
  });
  it.each(["file references", "mixed task range", "unknown run"])(
    "OPT50 invalid apply result %s repairs into a confirmed independent draft",
    async (scenario) => {
      const assetId = await file("采用引用复测" + scenario + ".jsonl");
      const id = await newSession();
      const initial = await send(
        id,
        "清洗全部2条，其他不改",
        [
          decision("execute"),
          {
            name: "submit_processing",
            input: { operation: "clean", allRecords: true },
          },
        ],
        { context: { kind: "asset", id: assetId } },
      );
      const runId = successes(initial, "submit_processing").at(-1).result.runId;
      await dbQuery(
        "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
        [id],
      );
      const output = await finishClean(runId);
      await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
        id,
        {
          stage: "awaiting_review",
          executionPaused: false,
          checkedStatus: "succeeded",
        },
      ]);
      const before = await effects();
      const target = {
        kind: "newDraft",
        name: "客服清洗复测",
        purpose: "保留清洗结果",
      };
      const state = await send(id, "保存为新的测试集草稿，叫客服清洗复测", [
        decision("execute"),
        {
          name: "request_processing_apply",
          input: {
            runId:
              scenario === "unknown run"
                ? "processing_" + "f".repeat(32)
                : runId,
            target,
            ...(scenario === "mixed task range" ? { allTask: true } : {}),
            resultIds: ["f:280e7d0239e11abb", "f:70c9c0590844c22b"],
          },
        },
        ...(scenario === "unknown run"
          ? [
              {
                name: "request_processing_apply",
                input: {
                  runId,
                  target,
                  resultIds: ["f:280e7d0239e11abb", "f:70c9c0590844c22b"],
                },
              },
            ]
          : []),
        {
          name: "request_processing_apply",
          input: {
            runId,
            target,
            resultIds: output.records.map((r: any) => r.id),
          },
        },
      ]);
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      const failed = state.turns
        .at(-1)
        .tools.find((t: any) => t.status === "failed");
      expect(failed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: scenario === "unknown run" ? "/runId" : "/resultIds/0",
          }),
        ]),
      );
      if (scenario !== "unknown run")
        expect(JSON.stringify(observed.at(-1))).toContain("0:0");
      expect(successes(state, "request_processing_apply")).toHaveLength(1);
      expect(await effects()).toEqual(before);
      const proposal = (
        await dbQuery(
          "SELECT * FROM assistant_proposal WHERE session_id=$1 AND status='pending'",
          [id],
        )
      ).rows[0];
      expect(proposal).toBeDefined();
      expect(proposal.parameters.resultIds).toEqual(
        output.records.map((r: any) => r.id),
      );
      await dbQuery(
        "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
        [id],
      );
      const confirmed = await app.inject({
        method: "POST",
        url: base() + "/proposals/" + proposal.id + "/confirm",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(await effects()).toEqual({ ...before, drafts: before.drafts + 1 });
      const saved = (
        await dbQuery("SELECT name FROM collaborative_draft WHERE id=$1", [
          confirmed.json().receipt.receipt.draftId,
        ])
      ).rows[0];
      expect(saved.name).toBe(target.name);
    },
  );

  it("OPT47 selected two-row file cleans exactly once with default protection and real output", async () => {
    const assetId = await file("opt47-clean.jsonl");
    const id = await newSession();
    const before = await effects();
    const state = await send(
      id,
      "清洗这份文件全部2条数据",
      [
        decision("execute"),
        {
          name: "submit_processing",
          input: { operation: "clean", allRecords: true },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    const op = successes(state, "submit_processing").at(-1);
    expect(op, JSON.stringify(state.turns.at(-1))).toBeDefined();
    expect(op.result.inputCount).toBe(2);
    expect(await effects()).toEqual({ ...before, runs: before.runs + 1 });
    const row = (
      await dbQuery("SELECT options,source FROM processing_run WHERE id=$1", [
        op.result.runId,
      ])
    ).rows[0];
    expect(row.options).toMatchObject({
      operation: "clean",
      instructions: "",
      allowedFields: ["question"],
    });
    expect(row.source.recordIds).toHaveLength(2);
    // This worker-boundary fixture holds automatic review; generation/continuation is covered separately.
    await dbQuery(
      "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
      [id],
    );
    const output = await finishClean(op.result.runId);
    expect(output.records).toHaveLength(2);
    expect(output.records.map((r: any) => r.result.question)).toEqual([
      "问题甲",
      "问题乙",
    ]);
    expect(
      output.records.every(
        (r: any) => r.result.expectedOutput === "  原标签  ",
      ),
    ).toBe(true);
    expect(output.records[0].result.metadata).toEqual([
      { key: "intent", value: " A " },
    ]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
          headers,
        })
      ).statusCode,
    ).toBe(200);
    await dbQuery("UPDATE assistant_session SET task=task||$2 WHERE id=$1", [
      id,
      {
        stage: "awaiting_review",
        checkedStatus: "succeeded",
        executionPaused: false,
        review: { runId: op.result.runId, total: output.records.length },
      },
    ]);
    const selected = await send(id, "从刚才清洗的结果随机选1条并固定范围", [
      decision("execute"),
      {
        name: "select_candidates",
        input: {
          runId: op.result.runId,
          selection: {
            method: "random",
            mode: "count",
            value: 1,
            conditions: [],
          },
        },
      },
    ]);
    expect(
      successes(selected, "select_candidates").length,
      JSON.stringify(selected.turns.at(-1)),
    ).toBeGreaterThan(0);
    const fixed = (
      await dbQuery(
        "SELECT task->'candidateScope' AS scope FROM assistant_session WHERE id=$1",
        [id],
      )
    ).rows[0].scope;
    const repeated = await send(id, "沿用刚才固定的1条，不要重新抽取", [
      decision("execute"),
      {
        name: "select_candidates",
        input: {
          runId: op.result.runId,
          selection: {
            method: "random",
            mode: "count",
            value: 1,
            conditions: [],
          },
        },
      },
    ]);
    expect(
      successes(repeated, "select_candidates").length,
      JSON.stringify(repeated.turns.at(-1)),
    ).toBeGreaterThan(0);
    expect(
      (
        await dbQuery(
          "SELECT task->'candidateScope' AS scope FROM assistant_session WHERE id=$1",
          [id],
        )
      ).rows[0].scope,
    ).toEqual(fixed);
  });
  it("OPT47 combined clean configuration errors reach one shared correction then genuine range clarification", async () => {
    const assetId = await file("opt47-config.jsonl");
    const id = await newSession();
    const before = await effects();
    const state = await send(
      id,
      "清洗这份资料的Metadata",
      [
        decision("execute"),
        {
          name: "submit_processing",
          input: {
            operation: "clean",
            instructions: "",
            allowedFields: ["metadata"],
            outputCount: 2,
            metadataKeys: ["question"],
          },
        },
        {
          name: "submit_processing",
          input: {
            operation: "clean",
            instructions: "",
            allowedFields: ["metadata"],
            metadataKeys: ["intent"],
          },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    const failed = state.turns
      .at(-1)
      .tools.find(
        (t: any) => t.name === "submit_processing" && t.status === "failed",
      );
    expect(failed, JSON.stringify(state.turns.at(-1))).toBeDefined();
    expect(failed.error.issues.map((i: any) => i.path)).toEqual(
      expect.arrayContaining(["/outputCount", "/recordIds", "/metadataKeys/0"]),
    );
    expect(state.task.question).toContain("整份");
    expect(
      state.turns.at(-1).diagnostics.repairRequestsUsed,
    ).toBeLessThanOrEqual(2);
    expect(await effects()).toEqual(before);
    const resumed = await send(
      id,
      "处理这份资料全部记录",
      [
        decision("execute"),
        {
          name: "submit_processing",
          input: {
            operation: "clean",
            instructions: "",
            allowedFields: ["metadata"],
            metadataKeys: ["intent"],
            allRecords: true,
          },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(
      resumed.turns.at(-1).status,
      JSON.stringify(resumed.turns.at(-1)),
    ).toBe("succeeded");
    expect(
      successes(resumed, "submit_processing").at(-1),
      JSON.stringify({ task: resumed.task, turn: resumed.turns.at(-1) }),
    ).toBeDefined();
    expect(
      successes(resumed, "submit_processing").at(-1).result.inputCount,
    ).toBe(2);
    expect((await effects()).runs).toBe(before.runs + 1);
  });
  it("OPT47 a preview is not authorization for the entire file", async () => {
    const assetId = await file("opt47-preview.jsonl");
    const id = await newSession();
    const before = await effects();
    const state = await send(
      id,
      "先看看这几条，再清洗这些数据",
      [
        decision("execute"),
        {
          name: "read_records",
          input: { source: { kind: "assets", assetIds: [assetId] }, limit: 1 },
        },
        {
          name: "submit_processing",
          input: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
            allRecords: true,
          },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(state.task.question, JSON.stringify(state.turns.at(-1))).toContain(
      "整份",
    );
    expect((await effects()).runs).toBe(before.runs);
    const alternate = await newSession();
    const allSelection = await send(
      alternate,
      "先看看这几条，再清洗这些数据",
      [
        decision("execute"),
        {
          name: "read_records",
          input: { source: { kind: "assets", assetIds: [assetId] }, limit: 1 },
        },
        {
          name: "submit_processing",
          input: { operation: "clean", selection: { method: "all" } },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(
      allSelection.task.question,
      JSON.stringify(allSelection.turns.at(-1)),
    ).toContain("整份");
    expect((await effects()).runs).toBe(before.runs);
  });
  it("OPT47 validates create conditions before an existing-name reuse", async () => {
    const id = await newSession();
    const initial = await send(id, "建立草稿复用检查", [
      decision("execute"),
      { name: "create_draft", input: { name: "复用检查", purpose: "原用途" } },
    ]);
    expect(
      initial.turns.at(-1).status,
      JSON.stringify(initial.turns.at(-1)),
    ).toBe("succeeded");
    const before = await effects();
    const call = {
      name: "create_draft",
      input: { name: "复用检查", testSetId: "missing-parent" },
    };
    const bad = await send(id, "复用这个草稿", [
      decision("execute"),
      call,
      call,
      call,
    ]);
    expect(bad.turns.at(-1).status).toBe("failed");
    expect(await effects()).toEqual(before);
  });

  async function generationPlan() {
    const id = await newSession();
    const upload = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "客服背景.txt",
        contentBase64: Buffer.from(
          "电商客服测试覆盖物流查询和地址修改。问题自然完整，期望输出说明正常应答行为。",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const state = await send(
      id,
      "按文档生成2条物流测试问题，先保存方案，不执行",
      [
        decision("plan", { requiresUpdate: true }),
        {
          name: "read_background",
          input: { documentId: upload.json().document.id },
        },
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [
              {
                name: "物流" + id,
                count: 2,
                instructions: "生成完整自然的物流用户问题",
                scenarios: ["查询快递位置", "物流延迟咨询", "物流签收异常"],
                classifications: [],
              },
            ],
            allowedFields: ["question", "expectedOutput", "metadata"],
          },
        },
      ],
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    return { id, state };
  }
  it.each([
    "processing_configuration_invalid",
    "processing_background_changed",
    "processing_capacity_exceeded",
  ])(
    "OPT47 preserves target partial commit on %s and retries original identity",
    async (code) => {
      const { id } = await generationPlan();
      const before = await effects();
      const spy = vi
        .spyOn(processingStore, "createProcessingRun")
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error(code), { code, statusCode: 422 });
        });
      let state: any;
      try {
        state = await send(id, "执行方案", [
          decision("execute"),
          { name: "plan_task", input: { executionMode: "execute" } },
        ]);
      } finally {
        spy.mockRestore();
      }
      const failed = state.turns
        .at(-1)
        .tools.find(
          (t: any) => t.name === "generate_candidates" && t.status === "failed",
        );
      expect(failed, JSON.stringify(state.turns.at(-1))).toBeDefined();
      expect(failed.effect).toBe("partial");
      expect(failed.partialResult.draftId).toBeTruthy();
      expect(await effects()).toEqual({ ...before, drafts: before.drafts + 1 });
      const receipt = (
        await dbQuery(
          "SELECT * FROM draft_creation_receipt WHERE operation_key=$1",
          [failed.key + ":target"],
        )
      ).rows[0];
      expect(receipt).toBeDefined();
      // Recover old rows without the newer effect tag as well, without changing their inputs/budgets.
      await dbQuery(
        "UPDATE assistant_turn SET tool_results=(SELECT jsonb_agg(x-'effect'-'partialResult') FROM jsonb_array_elements(tool_results) x) WHERE id=$1",
        [state.turns.at(-1).id],
      );
      script = [{ name: "generate_candidates", input: failed.input }];
      observed = [];
      const retry = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + id + "/retry",
        headers,
        payload: {},
      });
      expect(retry.statusCode, retry.body).toBe(200);
      await expect
        .poll(async () => (await read(id)).turns.at(-1)?.status, {
          timeout: 15000,
        })
        .toMatch(/succeeded|failed/);
      state = await read(id);
      expect(state.task.runId, JSON.stringify(state.turns.at(-1))).toBeTruthy();
      const run = (
        await dbQuery(
          "SELECT idempotency_key,target_draft_id FROM processing_run WHERE id=$1",
          [state.task.runId],
        )
      ).rows[0];
      expect(run.idempotency_key).toBe(failed.key);
      expect(run.target_draft_id).toBe(failed.partialResult.draftId);
      expect(await effects()).toEqual({
        drafts: before.drafts + 1,
        runs: before.runs + 1,
      });
    },
  );
  it("OPT47 reconciles processing accepted before response loss without resubmitting", async () => {
    const { id } = await generationPlan();
    const before = await effects();
    const real = processingStore.createProcessingRun;
    let count = 0;
    const spy = vi
      .spyOn(processingStore, "createProcessingRun")
      .mockImplementationOnce(async (...args) => {
        count++;
        await real(...args);
        throw new Error("synthetic response lost after processing commit");
      });
    let state: any;
    try {
      state = await send(id, "执行方案", [
        decision("execute"),
        { name: "plan_task", input: { executionMode: "execute" } },
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(state.task.runId, JSON.stringify(state.turns.at(-1))).toBeTruthy();
    expect(count).toBe(1);
    expect(await effects()).toEqual({
      drafts: before.drafts + 1,
      runs: before.runs + 1,
    });
    expect(
      state.turns
        .at(-1)
        .tools.filter(
          (t: any) =>
            t.name === "generate_candidates" && t.status === "succeeded",
        ),
    ).toHaveLength(1);
  });
  it("OPT47 discovery prefers confirmed object, keeps ambiguity bounded, and rechecks live visibility", async () => {
    const id = await draft("同名资料", 1),
      second = await draft("同名资料", 1);
    const db = createPool(databaseUrl);
    const actorId = (
      await db.query("SELECT actor_id FROM assistant_session LIMIT 1")
    ).rows[0].actor_id;
    const scope = { projectId, actorId };
    try {
      const args = {
        task: { goal: "清洗资料" },
        request: "清洗同名资料",
        requestId: "r1",
        input: { kind: "files", search: "同名资料" },
      };
      const ambiguous = await discoverSources(db, scope, args);
      expect(ambiguous.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([id, second]),
      );
      expect(ambiguous.question).toContain("请选择");
      const missing = await discoverSources(db, scope, {
        task: { goal: "整理资料" },
        request: "整理不存在的资料",
        requestId: "missing",
        input: { kind: "files", search: "不存在的资料" },
      });
      expect(missing.logicalReads).toBe(2);
      expect(missing.question).toBeTruthy();
      const unique = await draft("独立资料B", 1);
      const changed = await discoverSources(db, scope, {
        task: {
          goal: "清洗资料",
          target: { kind: "draft", id },
          sourceDiscovery: ambiguous.state,
        },
        request: "清洗独立资料B",
        requestId: "changed",
        input: { kind: "files", search: "独立资料B" },
        preferred: { kind: "draft", id },
      });
      expect(changed.resolvedSource).toEqual({ kind: "draft", id: unique });
      expect(changed.logicalReads).toBe(2);
      const repeated = await discoverSources(db, scope, {
        task: {
          goal: "清洗资料",
          target: changed.resolvedSource,
          sourceDiscovery: changed.state,
        },
        request: "继续找",
        requestId: "again",
        input: { kind: "drafts" },
        preferred: changed.resolvedSource,
      });
      expect(repeated.logicalReads).toBe(2);
      expect(repeated.items).toEqual(changed.items);
      const selected = await discoverSources(db, scope, {
        ...args,
        preferred: { kind: "draft", id },
      });
      expect(selected.resolvedSource).toEqual({ kind: "draft", id });
      expect(selected.question).toBeUndefined();
      await db.query(
        "UPDATE collaborative_draft SET status='discarded' WHERE id=$1",
        [id],
      );
      const stale = await discoverSources(db, scope, {
        ...args,
        task: { ...args.task, sourceDiscovery: selected.state },
        preferred: { kind: "draft", id },
      });
      expect(stale.items).toEqual([]);
      expect(stale.question).toContain("不可用");
      expect(stale.resolvedSource).toBeUndefined();
      const page1 = await discoverSources(db, scope, {
        task: { goal: "整理资料" },
        request: "整理这些资料",
        requestId: "r2",
        input: { kind: "files" },
      });
      const repeat = await discoverSources(db, scope, {
        task: { goal: "整理资料", sourceDiscovery: page1.state },
        request: "继续找",
        requestId: "r3",
        input: { kind: "drafts" },
      });
      expect(repeat.state.offset).toBe(page1.state.offset);
      expect(repeat.logicalReads).toBe(page1.logicalReads);
      const page2 = await discoverSources(db, scope, {
        task: { goal: "整理资料", sourceDiscovery: repeat.state },
        request: "下一页",
        requestId: "r4",
        input: { kind: "versions" },
      });
      expect(page2.state.offset).toBe(5);
      expect(page2.logicalReads).toBeLessThanOrEqual(2);
    } finally {
      await db.end();
    }
  });

  it("OPT47 read, real random selection and submit share the persisted seed and exact IDs", async () => {
    const draftId = await draft("随机范围", 4),
      id = await newSession();
    const selection = {
      method: "random",
      mode: "count",
      value: 2,
      seed: "fixed-input-seed",
    };
    const state = await send(
      id,
      "随机选2条记录清洗，保留期望输出和Metadata",
      [
        decision("execute"),
        {
          name: "read_records",
          input: { source: { kind: "draft", id: draftId }, selection },
        },
        { name: "submit_processing", input: { operation: "clean", selection } },
      ],
      { context: { kind: "draft", id: draftId } },
    );
    const submitted = successes(state, "submit_processing").at(-1);
    expect(
      submitted?.result?.runId,
      JSON.stringify(state.turns.at(-1)),
    ).toBeTruthy();
    const run = (
      await dbQuery("SELECT source FROM processing_run WHERE id=$1", [
        submitted.result.runId,
      ])
    ).rows[0];
    const rawTask = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    expect([...run.source.recordIds].sort()).toEqual(
      [...rawTask.processingScope.recordIds].sort(),
    );
    expect(run.source.recordIds).toHaveLength(2);
    expect(state.task.processingScope.configuration).toMatchObject({
      ...selection,
      conditions: [],
    });
    expect(submitted.input.selection).toEqual(
      state.task.processingScope.configuration,
    );
  });
  it("OPT47 saved step dispatch shares the direct clean compiler and scope hash", async () => {
    const draftId = await draft("保存清洗步骤", 2),
      id = await newSession();
    await dbQuery(
      "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
      [
        id,
        JSON.stringify({
          executionPlan: { mode: "plan", current: 0, steps: [] },
        }),
      ],
    );
    const cfg = {
      operation: "clean",
      source: { kind: "draft", id: draftId },
      selection: { method: "random", mode: "count", value: 1 },
    };
    const planned = await send(
      id,
      "随机选1条，先保存清洗方案",
      [
        decision("plan", { requiresUpdate: true }),
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            steps: [
              {
                title: "清洗选中记录",
                action: "submit_processing",
                input: cfg,
              },
            ],
          },
        },
      ],
      { context: { kind: "draft", id: draftId } },
    );
    expect(
      planned.turns.at(-1).status,
      JSON.stringify(planned.turns.at(-1)),
    ).toBe("succeeded");
    const executed = await send(id, "执行方案", [
      decision("execute"),
      { name: "plan_task", input: { executionMode: "execute" } },
    ]);
    expect(
      executed.task.runId,
      JSON.stringify(executed.turns.at(-1)),
    ).toBeTruthy();
    const run = (
      await dbQuery("SELECT source,options FROM processing_run WHERE id=$1", [
        executed.task.runId,
      ])
    ).rows[0];
    expect(run.source.recordIds).toHaveLength(1);
    expect(run.options).toMatchObject({
      operation: "clean",
      instructions: "",
      allowedFields: ["question"],
    });
  });
  it("OPT47 reuse cannot silently ignore a new purpose", async () => {
    const id = await newSession();
    await send(id, "创建用途检查草稿", [
      decision("execute"),
      { name: "create_draft", input: { name: "用途检查", purpose: "原用途" } },
    ]);
    const before = await effects();
    const call = {
      name: "create_draft",
      input: { name: "用途检查", purpose: "另一个用途" },
    };
    const state = await send(id, "使用这个草稿，并将用途改为另一个用途", [
      decision("execute"),
      call,
      call,
      call,
    ]);
    expect(await effects()).toEqual(before);
    expect(
      state.turns
        .at(-1)
        .tools.some((t: any) =>
          t.error?.issues?.some((i: any) => i.path === "/purpose"),
        ),
    ).toBe(true);
  });

  it("OPT47 a viewer cannot discover drafts and cached results recheck revoked membership", async () => {
    const db = createPool(databaseUrl),
      actorId = "viewer_" + randomUUID();
    try {
      await db.query(
        "INSERT INTO app_user(id,username,password_hash,role) SELECT $1,$1,password_hash,'user' FROM app_user LIMIT 1",
        [actorId],
      );
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer')",
        [projectId, actorId],
      );
      const scope = { projectId, actorId },
        args = {
          task: { goal: "整理数据" },
          request: "整理数据",
          requestId: "v1",
          input: { kind: "files" },
        };
      const found = await discoverSources(db, scope, args);
      expect(found.items.every((i) => i.kind === "asset")).toBe(true);
      const hidden = await discoverSources(db, scope, {
        ...args,
        preferred: {
          kind: "draft",
          id: (
            await db.query(
              "SELECT id FROM collaborative_draft WHERE status='editing' LIMIT 1",
            )
          ).rows[0].id,
        },
      });
      expect(hidden.items).toEqual([]);
      await db.query(
        "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
        [projectId, actorId],
      );
      await expect(
        discoverSources(db, scope, {
          ...args,
          task: { ...args.task, sourceDiscovery: found.state },
        }),
      ).rejects.toThrow();
    } finally {
      await db.end();
    }
  });
  it("OPT47 explicit two-row authorization is not expanded when the source has three rows", async () => {
    const draftId = await draft("数量变化", 3),
      id = await newSession(),
      before = await effects();
    const state = await send(
      id,
      "清洗全部2条数据",
      [
        decision("execute"),
        {
          name: "submit_processing",
          input: { operation: "clean", allRecords: true },
        },
      ],
      { context: { kind: "draft", id: draftId } },
    );
    expect(state.task.question, JSON.stringify(state.turns.at(-1))).toContain(
      "来源数量",
    );
    expect(await effects()).toEqual(before);
    expect(observed).toHaveLength(2);
  });
  it.each(["stale revision", "implicit expansion"])(
    "OPT47 frozen selection blocks %s before any submission",
    async (scenario) => {
      const draftId = await draft("冻结边界" + scenario, 4),
        id = await newSession(),
        selection = {
          method: "random",
          mode: "count",
          value: 2,
          seed: "frozen-input",
        };
      await send(id, "查看项目概况", [
        decision("query"),
        { name: "query_project", input: { kind: "project" } },
      ]);
      // Persist an already authorized range fixture. Normal read→selection→submit is covered above.
      const db = createPool(databaseUrl);
      let old: any;
      try {
        const actorId = (
          await db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
            id,
          ])
        ).rows[0].actor_id;
        const source = { kind: "draft", id: draftId };
        const data = await processingStore.previewProcessingInput(
          db,
          { projectId, actorId },
          { source, limit: 10000 },
          "write",
          true,
        );
        const selected = new Set(
          selectRecords(
            data.records.map((r) => ({ ...r, assetId: r.id, ordinal: 0 })),
            { ...selection, conditions: [] },
          ).selected.map((r) => r.id),
        );
        const records = data.records.filter((r) => selected.has(r.id));
        old = {
          source,
          recordIds: records.map((r) => r.id),
          hash: sha256(
            canonicalJson({ records, revision: data.revision ?? null }),
          ),
          configuration: { ...selection, conditions: [] },
        };
        await db.query(
          "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
          [
            id,
            JSON.stringify({
              goal: "清洗固定选择",
              target: source,
              processingScope: old,
            }),
          ],
        );
      } finally {
        await db.end();
      }
      expect(old.recordIds).toHaveLength(2);
      const before = await effects();
      if (scenario === "stale revision")
        await dbQuery(
          "UPDATE collaborative_draft SET revision=revision+1 WHERE id=$1",
          [draftId],
        );
      const state = await send(
        id,
        scenario === "stale revision" ? "清洗刚才选中的2条" : "清洗这些",
        [
          decision("execute"),
          {
            name: "submit_processing",
            input: {
              operation: "clean",
              ...(scenario === "stale revision"
                ? { selection }
                : { allRecords: true }),
            },
          },
        ],
        { context: { kind: "draft", id: draftId } },
      );
      expect(await effects()).toEqual(before);
      expect(
        state.task.question,
        JSON.stringify(state.turns.at(-1)),
      ).toBeTruthy();
      expect(
        (
          await dbQuery(
            "SELECT task->'processingScope' AS scope FROM assistant_session WHERE id=$1",
            [id],
          )
        ).rows[0].scope,
      ).toEqual(old);
    },
  );
  it("OPT47 an explicit new filename overrides a different live page source within two reads", async () => {
    const originalId = await draft("当前资料A", 4),
      targetId = await draft("独立处理资料B", 2),
      id = await newSession(),
      before = await effects();
    const state = await send(
      id,
      "清洗独立处理资料B的全部2条数据",
      [
        decision("execute"),
        {
          name: "query_project",
          input: { kind: "files", search: "独立处理资料B" },
        },
        {
          name: "submit_processing",
          input: { operation: "clean", allRecords: true },
        },
      ],
      { context: { kind: "draft", id: originalId } },
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    const submitted = successes(state, "submit_processing").at(-1);
    expect(
      submitted?.result?.runId,
      JSON.stringify(state.turns.at(-1)),
    ).toBeTruthy();
    const run = (
      await dbQuery("SELECT source FROM processing_run WHERE id=$1", [
        submitted.result.runId,
      ])
    ).rows[0];
    expect(run.source).toMatchObject({ kind: "draft", id: targetId });
    expect(run.source.recordIds).toHaveLength(2);
    expect(state.task.sourceDiscovery.reads).toBeLessThanOrEqual(2);
    expect(await effects()).toEqual({ ...before, runs: before.runs + 1 });
  });

  it("OPT47 all-selection defaults are accepted without inventing a null random seed", async () => {
    const draftId = await draft("全量选择配置", 2),
      id = await newSession();
    const state = await send(
      id,
      "清洗全部2条数据",
      [
        decision("execute"),
        {
          name: "submit_processing",
          input: { operation: "clean", selection: { method: "all" } },
        },
      ],
      { context: { kind: "draft", id: draftId } },
    );
    const submitted = successes(state, "submit_processing").at(-1);
    expect(
      submitted?.result?.runId,
      JSON.stringify(state.turns.at(-1)),
    ).toBeTruthy();
    expect(submitted.result.inputCount).toBe(2);
    expect(submitted.input.selection).toEqual({
      method: "all",
      conditions: [],
    });
  });

  it.each([
    "全部2条整理问题首尾空白，期望输出和Metadata保持原样",
    "全部2条去掉问题前后空格，保留换行，其他不改",
  ])("CU10 SDK compiles explicit whitespace semantics: %s", async (message) => {
    const assetId = await file("CU10" + randomUUID() + ".jsonl"),
      id = await newSession();
    const state = await send(
      id,
      message,
      [
        decision("execute"),
        {
          name: "submit_processing",
          input: {
            source: { kind: "assets", assetIds: [assetId] },
            operation: "clean",
            allRecords: true,
            instructions:
              "清除前后空白，但不要修改语义、标点、换行，保留所有答案、分类和元数据",
          },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    const submitted = successes(state, "submit_processing").at(-1);
    expect(
      submitted?.result?.runId,
      JSON.stringify(state.turns.at(-1)),
    ).toBeTruthy();
    await dbQuery(
      "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
      [id],
    );
    const result = await finishClean(submitted.result.runId);
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.result.question).toBe(record.result.question.trim());
      expect(record.result.expectedOutput).toBe("  原标签  ");
    }
    expect(
      state.turns.at(-1).tools.filter((t: any) => t.status === "failed"),
    ).toHaveLength(0);
  });
  it("CU13 SDK carries selected rows and rejects a widened repair", async () => {
    const draftId = await draft("CU13", 4),
      id = await newSession();
    const preview = (
      await app.inject({
        method: "POST",
        url: "/api/projects/" + projectId + "/processing-inputs",
        headers,
        payload: { source: { kind: "draft", id: draftId }, limit: 100 },
      })
    ).json();
    expect(preview.records, JSON.stringify(preview)).toHaveLength(4);
    const recordIds = preview.records.slice(0, 2).map((r: any) => r.id);
    const state = await send(
      id,
      "这两条整理一下前后空格，其他别动",
      [
        decision("execute"),
        { name: "submit_processing", input: { operation: "clean" } },
      ],
      {
        context: {
          kind: "draft",
          id: draftId,
          inputSelection: {
            recordIds,
            sourceRevision: preview.sourceRevision,
            total: 4,
          },
        },
      },
    );
    const submitted = successes(state, "submit_processing").at(-1);
    expect(
      submitted?.result?.runId,
      JSON.stringify(state.turns.at(-1)),
    ).toBeTruthy();
    expect(submitted.result.inputCount).toBe(2);
    const stored = (
      await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0].task;
    expect(stored.uiInputScope.recordIds).toEqual(recordIds);
    const rebound = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        message: "现在怎么样了",
        context: {
          kind: "draft",
          id: draftId,
          inputSelection: {
            recordIds: preview.records.map((r: any) => r.id),
            sourceRevision: preview.sourceRevision,
          },
        },
      },
    });
    expect(rebound.statusCode, rebound.body).toBe(409);
    expect(
      (await dbQuery("SELECT task FROM assistant_session WHERE id=$1", [id]))
        .rows[0].task.uiInputScope.recordIds,
    ).toEqual(recordIds);
    await dbQuery(
      "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
      [id],
    );
    const result = await finishClean(submitted.result.runId);
    expect(result.records).toHaveLength(2);
    const invalid = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + (await newSession()) + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        message: "清洗",
        context: {
          kind: "draft",
          id: draftId,
          inputSelection: {
            recordIds: ["invented"],
            sourceRevision: preview.sourceRevision,
          },
        },
      },
    });
    expect(invalid.statusCode).toBe(409);
  });
  it("CU15 pause interrupts an in-flight SDK request, replays safely and fences its late response", async () => {
    const id = await newSession();
    const seeded: any = {
      goal: "建立两条用例的草稿",
      title: "暂停恢复",
      requirements: ["保持原意"],
      targetCount: 2,
      stage: "inspecting",
      executionPaused: false,
      autoCount: 0,
      autoEventLimit: 12,
    };
    seeded.executionPlan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          {
            title: "建立草稿",
            action: "create_draft",
            input: { name: "暂停恢复草稿", purpose: "隔离测试" },
          },
        ],
      },
      0,
      undefined,
      planRequirementsKey(seeded),
    );
    await dbQuery("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      id,
      seeded,
    ]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    script = [
      {
        ...decision("execute"),
        beforeReply: async () => {
          entered = true;
          await held;
        },
      },
    ];
    const start = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "执行方案" },
    });
    expect(start.statusCode, start.body).toBe(202);
    try {
      await expect.poll(() => entered, { timeout: 10000 }).toBe(true);
      const before = await read(id),
        key = randomUUID(),
        payload = { message: "先停一下。", expectedTaskId: before.task.taskId };
      const pause = () =>
        app.inject({
          method: "POST",
          url: base() + "/sessions/" + id + "/turns",
          headers: { ...headers, "idempotency-key": key },
          payload,
        });
      const stopped = await pause();
      expect(stopped.statusCode, stopped.body).toBe(200);
      const repeated = await pause();
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json().turnId).toBe(stopped.json().turnId);
      expect((await read(id)).task.executionPaused).toBe(true);
      expect(
        (await read(id)).turns.find((t: any) => t.id === start.json().turnId)
          .status,
      ).toBe("interrupted");
      release();
      const queried = await send(id, "现在怎么样了", [decision("query")]);
      expect(queried.task.executionPaused).toBe(true);
      expect(
        queried.turns.filter((t: any) => t.userText === "先停一下。"),
      ).toHaveLength(1);
      const stale = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + id + "/turns",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "先停一下", expectedTaskId: "wrong-task" },
      });
      expect(stale.statusCode).toBe(409);
      const beforeResume = await effects();
      const resumed = await send(id, "继续", [
        decision("execute"),
        { name: "plan_task", input: { executionMode: "execute" } },
      ]);
      expect(
        resumed.turns.at(-1).status,
        JSON.stringify(resumed.turns.at(-1)),
      ).toBe("succeeded");
      expect((await effects()).drafts).toBe(beforeResume.drafts + 1);
      expect(resumed.task.taskId).toBe(before.task.taskId);
      expect(resumed.task.executionPaused).toBe(false);
    } finally {
      release();
    }
  });

  it("CU10 SDK: action word matching a file name still asks which source", async () => {
    await file("客服清洗两条.jsonl");
    await file("客服范围四条.jsonl");
    const id = await newSession();
    const before = await effects();
    const state = await send(id, "帮我清洗一下这些数据。", [
      decision("execute"),
      {
        name: "query_project",
        input: { kind: "files", search: "清洗", offset: 0 },
      },
      ...Array.from({ length: 6 }, () => ({
        name: "query_project",
        input: { kind: "files", search: "清洗", offset: 0 },
      })),
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(state.task.processingClarification?.kind).toBe("source");
    expect(state.task.question).toContain("请选择要处理的资料");
    expect(state.task.target).toBeFalsy();
    expect(observed.length).toBeLessThanOrEqual(3);
    expect(await effects()).toEqual(before);
  });
  it("CU15 SDK: paused empty delivery plan can answer a progress query", async () => {
    const id = await newSession();
    const question = "期望回答由谁拟定？";
    const seeded = {
      goal: "新建两个客服测试集，先给方案",
      title: "两个客服测试集",
      stage: "waiting_input",
      question,
      requirements: ["两份测试集各2条，期望回答由助手拟定"],
      supplements: ["期望回答由你拟定，按这个方案开始生成。"],
      executionPlan: {
        mode: "plan",
        current: 0,
        steps: [],
        contractVersion: 1,
      },
      executionPaused: true,
      planningClarification: { question, askedTurnId: "original-turn" },
      turnControl: { mode: "pause", source: "ui" },
    };
    await dbQuery("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      id,
      seeded,
    ]);
    const state = await send(id, "现在做到哪了？", [
      {
        name: "plan_task",
        input: {
          control: {
            mode: "query",
            explanation: "任务已暂停。",
            querySubject: "task_progress",
          },
        },
      },
      { name: "", input: {}, text: "当前暂停，尚未生成数据。" },
    ]);
    expect(state.turns.at(-1).status).toBe("succeeded");
    expect(
      state.turns.at(-1).tools?.filter((r: any) => r.status === "failed") ?? [],
    ).toHaveLength(0);
    expect(state.task.executionPaused).toBe(true);
    expect(state.task.planningClarification?.answer).toBeUndefined();
  });

  it("CU15 SDK: interrupted answer survives pause and builds executable plan before model generation", async () => {
    const id = await newSession();
    const prompt =
      "新建两个客服测试集：查物流和修改收货地址，各2条自然完整问题及期望回答。先给方案。";
    const question = "期望回答由我拟定，还是你提供固定回答？";
    const planned = await send(id, prompt, [
      decision("plan"),
      {
        name: "plan_task",
        input: {
          title: "客服测试集",
          executionMode: "plan",
          question,
          nextAction: "none",
          targetCount: 2,
          overallTargetCount: 4,
          target: null,
          requirements: ["两份测试集各2条自然完整问题与期望回答"],
          allowedFields: ["question", "expectedOutput", "metadata"],
          classifications: [],
          metadataKeys: null,
        },
      },
    ]);
    expect(
      planned.turns.at(-1).status,
      JSON.stringify(planned.turns.at(-1)),
    ).toBe("succeeded");
    expect(planned.task.executionPlan.steps).toHaveLength(0);
    const upload = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/background-documents",
      headers,
      payload: {
        fileName: "客服说明.txt",
        contentBase64: Buffer.from(
          "客服测试覆盖物流查询和修改收货地址。提问应自然完整，期望回答说明应答行为，不编造订单数据。",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    script = [
      {
        ...decision("execute"),
        beforeReply: async () => {
          entered = true;
          await held;
        },
      },
    ];
    const start = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "期望回答由你拟定，按这个方案开始生成。" },
    });
    expect(start.statusCode, start.body).toBe(202);
    try {
      await expect.poll(() => entered, { timeout: 10000 }).toBe(true);
      const stop = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + id + "/turns",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "先停一下。", expectedTaskId: planned.task.taskId },
      });
      expect(stop.statusCode, stop.body).toBe(200);
      release();
      const progress = await send(id, "现在做到哪了？", [
        {
          name: "plan_task",
          input: {
            control: {
              mode: "query",
              querySubject: "task_progress",
              explanation: "任务已暂停。",
            },
          },
        },
        { name: "", input: {}, text: "任务已暂停。" },
      ]);
      expect(progress.turns.at(-1).status).toBe("succeeded");
      expect(progress.task.executionPaused).toBe(true);
      const continued = await send(id, "继续。", [
        decision("execute", { requiresUpdate: true }),
        {
          name: "read_background",
          input: { documentId: upload.json().document.id },
        },
        {
          name: "plan_task",
          input: {
            deliveries: [
              {
                name: "查物流",
                count: 2,
                instructions: "生成自然完整的客服物流查询及期望回答",
                scenarios: ["查询位置", "延迟咨询", "签收核对"],
                classifications: [],
              },
              {
                name: "修改收货地址",
                count: 2,
                instructions: "生成自然完整的客服改地址问题及期望回答",
                scenarios: ["发货前修改", "发货后咨询", "地址核对"],
                classifications: [],
              },
            ],
            requirements: ["期望回答由助手拟定", "两份测试集各2条自然完整问题"],
            allowedFields: ["question", "expectedOutput", "metadata"],
          },
        },
      ]);
      const last = continued.turns.at(-1);
      expect(last.tools?.[0]?.result?.control?.mode, JSON.stringify(last)).toBe(
        "execute",
      );
      expect(continued.task.supplements).toContain(
        "期望回答由你拟定，按这个方案开始生成。",
      );
      const savedPlan = last.tools?.find(
        (x: any) =>
          x.name === "plan_task" &&
          x.status === "succeeded" &&
          x.result?.task?.executionPlan?.steps?.length,
      );
      expect(savedPlan, JSON.stringify(last)).toBeTruthy();
      expect(savedPlan.result.task.executionPlan.steps.length).toBeGreaterThan(
        0,
      );
      expect(continued.task.interruptedTurnId).toBeNull();
      expect(
        last.tools?.some(
          (x: any) => x.error?.code === "assistant_operation_failed",
        ),
      ).toBe(false);
    } finally {
      release();
    }
  });
  it.each(["整份资料", "这2条"])(
    "CU10 saved destination survives clean, pause and fixed save: %s",
    async (range) => {
      const outputName = "客服清洗结果" + range;
      const assetId = await file("保存名称回归-" + range + ".jsonl"),
        id = await newSession();
      const target = { kind: "assets", assetIds: [assetId] };
      let state = await send(
        id,
        "清洗" +
          range +
          "，只去掉问题前后的空格，其他内容不变。保存为新测试集草稿，名字叫“" +
          outputName +
          "”。",
        [
          decision("execute", { requiresUpdate: true }),
          {
            name: "plan_task",
            input: {
              title: "清洗客服资料",
              target,
              requirements: [
                "只去掉问题首尾空格，其他字段不变",
                "保存为新的测试集草稿“" + outputName + "”",
              ],
              allowedFields: ["question"],
              executionMode: "execute",
              nextAction: "submit_processing",
            },
          },
          {
            name: "submit_processing",
            input: {
              source: target,
              operation: "clean",
              ...(range === "整份资料"
                ? { allRecords: true }
                : { outputCount: 2 }),
              instructions: "",
              allowedFields: ["question"],
            },
          },
        ],
        { context: { kind: "asset", id: assetId } },
      );
      expect(state.task.saveTarget, JSON.stringify(state.turns.at(-1))).toEqual(
        { kind: "newDraft", name: outputName },
      );
      expect(state.task.runId, JSON.stringify(state.turns.at(-1))).toBeTruthy();
      const clean = await finishClean(state.task.runId);
      expect(clean.records).toHaveLength(2);
      expect(clean.records.map((r: any) => r.result.question)).toEqual([
        "问题甲",
        "问题乙",
      ]);
      expect(clean.records.map((r: any) => r.result.expectedOutput)).toEqual([
        "  原标签  ",
        "  原标签  ",
      ]);
      await expect
        .poll(
          async () => {
            state = await read(id);
            return (
              state.task.stage === "awaiting_review" &&
              state.turns.every(
                (t: any) => !["queued", "running"].includes(t.status),
              )
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      await send(id, "先停一下", []);
      state = await send(id, "继续。", [
        decision("execute"),
        { name: "plan_task", input: { executionMode: "execute" } },
      ]);
      expect(state.task.saveTarget).toEqual({
        kind: "newDraft",
        name: outputName,
      });
      await expect
        .poll(
          async () => {
            state = await read(id);
            return state.turns.every(
              (t: any) => !["queued", "running"].includes(t.status),
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      const candidates = (
        await app.inject({
          method: "GET",
          url: base() + "/sessions/" + id + "/candidates",
          headers,
        })
      ).json();
      const picked = {
        scope: "task",
        reviewRevision: candidates.reviewRevision,
        resultIds: candidates.records.map((r: any) => r.id),
      };
      const saved = await send(id, "将勾选成果保存为新测试集草稿", [], {
        operation: "save_candidates_new",
        expectedTaskRevision: state.task.turnControl.taskRevision,
        candidates: picked,
      });
      expect(observed).toHaveLength(0);
      const proposal = saved.proposals.find((p: any) => p.status === "pending");
      expect(proposal?.summary.target, JSON.stringify(saved.turns.at(-1))).toBe(
        outputName,
      );
      const confirmed = await app.inject({
        method: "POST",
        url: base() + "/proposals/" + proposal.id + "/confirm",
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const drafts = (
        await dbQuery(
          "SELECT id,name FROM collaborative_draft WHERE project_id=$1",
          [projectId],
        )
      ).rows;
      const actual = drafts.find((d: any) => d.name === outputName);
      expect(actual).toBeTruthy();
      const records = (
        await dbQuery(
          "SELECT question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
          [actual.id],
        )
      ).rows;
      expect(records.map((r: any) => r.question)).toEqual(["问题甲", "问题乙"]);
      expect(
        records.every((r: any) => r.expected_output === "  原标签  "),
      ).toBe(true);
      expect(
        records.find((r: any) => r.question === "问题甲").metadata,
      ).toEqual([{ key: "intent", value: " A " }]);
      const receipt = (
        await dbQuery("SELECT receipt FROM assistant_proposal WHERE id=$1", [
          proposal.id,
        ])
      ).rows[0].receipt;
      expect(receipt.receipt.draftId).toBe(actual.id);
      const opened = await app.inject({
        method: "GET",
        url:
          "/api/projects/" + projectId + "/collaborative-drafts/" + actual.id,
        headers,
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.json().draft.name).toBe(outputName);
      const repeated = await app.inject({
        method: "POST",
        url: base() + "/proposals/" + proposal.id + "/confirm",
        headers,
        payload: {},
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(
        (
          await dbQuery(
            "SELECT count(*)::int AS n FROM collaborative_draft WHERE project_id=$1 AND name=$2",
            [projectId, outputName],
          )
        ).rows[0].n,
      ).toBe(1);
    },
  );
  it("CU10 SDK: an unquoted early destination must be repaired into executable state before cleaning", async () => {
    const assetId = await file("未加引号的保存目标.jsonl"),
      id = await newSession();
    const target = { kind: "assets", assetIds: [assetId] };
    const state = await send(
      id,
      "清洗整份资料后保存为新测试集草稿，名字叫客服清洗结果。",
      [
        decision("execute", { requiresUpdate: true }),
        {
          name: "plan_task",
          input: {
            target,
            requirements: ["清洗后保存为名叫客服清洗结果的新草稿"],
            allowedFields: ["question"],
            executionMode: "execute",
            nextAction: "submit_processing",
          },
        },
        {
          name: "plan_task",
          input: {
            target,
            saveTarget: { kind: "newDraft", name: "客服清洗结果" },
            requirements: ["清洗后保存"],
            allowedFields: ["question"],
            executionMode: "execute",
            nextAction: "submit_processing",
          },
        },
        {
          name: "submit_processing",
          input: {
            source: target,
            operation: "clean",
            allRecords: true,
            instructions: "",
            allowedFields: ["question"],
          },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.saveTarget).toEqual({
      kind: "newDraft",
      name: "客服清洗结果",
    });
    expect(state.task.runId).toBeTruthy();
    expect(
      state.turns
        .at(-1)
        .tools.some(
          (t: any) =>
            t.name === "plan_task" &&
            t.status === "failed" &&
            t.error?.issues?.some((i: any) => i.path === "/saveTarget"),
        ),
    ).toBe(true);
    expect(successes(state, "submit_processing")).toHaveLength(1);
  });
  it.each(["复制要求", "重复范围"])(
    "CU10 SDK: source-confirmed echo or scope questions are corrected without another user turn: %s",
    async (scenario) => {
      const assetId = await file("澄清守卫-" + scenario + ".jsonl"),
        id = await newSession();
      const target = { kind: "assets", assetIds: [assetId] };
      const request =
        "清洗这2条，去掉问题前后的空格，其他内容不变，保存为新草稿“客服清洗结果”。";
      const state = await send(
        id,
        request,
        [
          decision("execute", { requiresUpdate: true }),
          {
            name: "plan_task",
            input: {
              target,
              requirements: ["只去掉问题前后空格，其他内容不变"],
              question:
                scenario === "复制要求"
                  ? request
                  : "请说明要处理整份资料，还是其中指定的记录？",
              nextAction: "none",
              executionMode: "execute",
            },
          },
          {
            name: "plan_task",
            input: {
              target,
              saveTarget: { kind: "newDraft", name: "客服清洗结果" },
              requirements: ["只去掉问题前后空格，其他内容不变"],
              allowedFields: ["question"],
              nextAction: "submit_processing",
              executionMode: "execute",
            },
          },
          {
            name: "submit_processing",
            input: {
              source: target,
              operation: "clean",
              outputCount: 2,
              instructions: "",
              allowedFields: ["question"],
            },
          },
        ],
        { context: { kind: "asset", id: assetId } },
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.task.runId, JSON.stringify(state.turns.at(-1))).toBeTruthy();
      expect(state.task.question).toBeFalsy();
      expect(state.task.saveTarget).toEqual({
        kind: "newDraft",
        name: "客服清洗结果",
      });
      expect(
        state.turns
          .at(-1)
          .tools.some(
            (t: any) =>
              t.status === "failed" &&
              t.error?.code === "assistant_plan_clarification_unnecessary",
          ),
      ).toBe(true);
      expect(successes(state, "submit_processing")).toHaveLength(1);
    },
  );
  it("CU10 SDK: an execution-ready redundant confirmation is normalized without a repair request", async () => {
    const assetId = await file("确定性确认归一.jsonl"),
      id = await newSession();
    const target = { kind: "assets", assetIds: [assetId] };
    const state = await send(
      id,
      "清洗这2条，去掉问题前后的空格，其他不变，保存为新草稿“客服清洗结果”。",
      [
        decision("execute"),
        {
          name: "plan_task",
          input: {
            control: { mode: "execute", requiresUpdate: true },
            target,
            allowedFields: ["question"],
            nextAction: "submit_processing",
            question: "请确认是否继续清洗并保存为新草稿“客服清洗结果”。",
          },
        },
        {
          name: "submit_processing",
          input: {
            source: target,
            operation: "clean",
            outputCount: 2,
            instructions: "",
            allowedFields: ["question"],
          },
        },
      ],
      { context: { kind: "asset", id: assetId } },
    );
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    expect(state.task.runId).toBeTruthy();
    expect(state.task.saveTarget).toEqual({
      kind: "newDraft",
      name: "客服清洗结果",
    });
    expect(state.task.question).toBeFalsy();
    expect(
      state.turns.at(-1).tools.filter((t: any) => t.status === "failed"),
    ).toHaveLength(0);
    expect(observed).toHaveLength(3);
  });
});
