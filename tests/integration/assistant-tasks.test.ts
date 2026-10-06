import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as taskModule from "../../src/assistant/tasks.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const origin = "http://127.0.0.1:4217";
const rootUrl = loadConfig().databaseUrl;
const databaseName = `assistant_tasks_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = rootUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("assistant continuous task public contract", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let projectId: string;
  let draftId: string;
  let sessionId: string;
  let runId: string;
  let independentAsset: string;
  const requests: any[] = [];
  afterEach(() => {
    extraAfterSubmit = false;
    preferBaseline = false;
    wrongEventRunId = undefined;
    repeatWrongEventRun = false;
    finishRetryRead = false;
  });
  let mode:
      | "clean"
      | "retry"
      | "held"
      | "held_explain"
      | "explain"
      | "planned"
      | "planned_read"
      | "planned_refine"
      | "planned_clarify"
      | "planned_ignore"
      | "planned_retry_text"
      | "proposal" = "clean",
    failReply = false,
    failRefinement = false;
  let repairPattern: "recover" | "partial" | null = null;
  let repairCalls = 0;
  let augmentationPattern = false;
  let preferBaseline = false;
  let extraAfterSubmit = false;
  let wrongEventRunId: string | undefined;
  let repeatWrongEventRun = false;
  let finishRetryRead = false;
  let release = () => {},
    entered = () => {};
  const appConfig = () => ({
    databaseUrl,
    appOrigin: origin,
    soloOwnerMode: false,
    allowTestIdentity: false,
    modelEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
  });
  const model = createServer(async (request, response) => {
    let text = "";
    for await (const part of request) text += part;
    const body = JSON.parse(text);
    requests.push(body);
    const requestMode = mode;
    const last = body.messages.at(-1);
    if (requestMode === "held" || requestMode === "held_explain") {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (requestMode === "retry" && last?.role === "tool" && failReply) {
      failReply = false;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "synthetic retry failure" } }),
      );
      return;
    }
    let processingInput;
    if (!body.tools) {
      try {
        processingInput = JSON.parse(last.content);
      } catch {
        /* A bounded assistant summary is not a processing payload. */
      }
    }
    if (processingInput?.operation && Array.isArray(processingInput.records)) {
      if (failRefinement) {
        failRefinement = false;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "synthetic refinement failure" },
          }),
        );
        return;
      }
      const input = processingInput;
      const generated = repairPattern
        ? repairCalls++ === 0
          ? Array.from({ length: 11 }, (_, i) => ({
              sourceId: input.records[i % input.records.length].id,
              question: `新增问题 ${i + 1}`,
              expectedOutput: i < 5 ? "指数分析" : "指数对比",
              metadata: [],
            }))
          : repairPattern === "recover"
            ? [
                {
                  sourceId: input.records[0].id,
                  question: "新增问题 12",
                  expectedOutput: "指数分析",
                  metadata: [],
                },
              ]
            : []
        : augmentationPattern
          ? Array.from({ length: input.outputCount }, (_, i) => ({
              sourceId: input.records[i % input.records.length].id,
              question: `新场景 ${(input.augmentationBatch?.offset ?? 0) + i + 1}`,
              expectedOutput: "应针对该场景安全作答",
              metadata: [],
            }))
          : input.records.map((row: any) => ({
              sourceId: preferBaseline ? (row.baseline?.id ?? row.id) : row.id,
              question: row.question + "（自然表达）",
              expectedOutput: "不应采用的模型答案",
              metadata: row.metadata,
            }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "refinement-model",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  records: generated,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        }),
      );
      return;
    }
    let message: any = { role: "assistant", content: "已按真实结果更新任务。" };
    let finish = "stop";
    if (requestMode.startsWith("planned")) {
      const lastTool = body.messages
        .findLast((item: any) => item.tool_calls?.length)
        ?.tool_calls.at(-1).function.name;
      const name =
        requestMode === "planned_retry_text"
          ? null
          : last?.role !== "tool"
            ? "plan_task"
            : requestMode !== "planned_ignore" &&
                body.tool_choice === "required"
              ? requestMode === "planned_read" && lastTool === "plan_task"
                ? "read_records"
                : requestMode === "planned_refine"
                  ? "refine_candidates"
                  : "submit_processing"
              : null;
      if (name) {
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `plan_call_${requests.length}`,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === "plan_task"
                    ? {
                        title: "整理问题验收",
                        target: { kind: "draft", id: draftId },
                        requirements: [
                          "清洗全部25条问题，保留期望输出和Metadata",
                        ],
                        targetCount: 25,
                        ...(requestMode === "planned"
                          ? {}
                          : requestMode === "planned_clarify"
                            ? {
                                nextAction: "none",
                                question: "请问需要处理哪些记录？",
                              }
                            : { nextAction: "submit_processing" }),
                      }
                    : name === "read_records"
                      ? { source: { kind: "draft", id: draftId } }
                      : name === "refine_candidates"
                        ? {
                            runId,
                            allSelected: true,
                            instructions: "以请问开头，其他字段保留",
                            allowedFields: ["question"],
                          }
                        : {
                            source: { kind: "draft", id: draftId },
                            allRecords: true,
                            operation: "clean",
                            instructions: "",
                            allowedFields: ["question"],
                          },
                ),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else
        message.content =
          requestMode === "planned_clarify"
            ? "请问需要处理哪些记录？"
            : "接下来我会提交后台任务，并在完成后核对候选。";
    }
    if (
      last?.role !== "tool" &&
      !requestMode.startsWith("planned") &&
      requestMode !== "explain" &&
      requestMode !== "held_explain"
    ) {
      const automatic = body.messages.some((item: any) =>
        String(item.content).startsWith("[processing_completed]"),
      );
      const automaticConfirmed = body.messages.some((item: any) =>
        String(item.content).startsWith("[confirmed]"),
      );
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `task_call_${requests.length}`,
            type: "function",
            function: {
              name:
                requestMode === "proposal"
                  ? automaticConfirmed
                    ? "read_processing"
                    : "request_processing_apply"
                  : requestMode === "retry" || requestMode === "held"
                    ? "create_draft"
                    : automatic
                      ? "plan_task"
                      : "submit_processing",
              arguments: JSON.stringify(
                requestMode === "proposal"
                  ? automaticConfirmed
                    ? { runId }
                    : { runId, allValid: true, target: { kind: "asset" } }
                  : requestMode === "retry" || requestMode === "held"
                    ? {
                        name:
                          requestMode === "held"
                            ? "停止后禁止创建"
                            : "失败恢复草稿",
                        purpose: "合成测试",
                      }
                    : automatic
                      ? {
                          title: "清洗结果核对",
                          requirements: ["读取当前处理结果并核对候选"],
                          nextAction: "read_processing",
                        }
                      : {
                          source: { kind: "draft", id: draftId },
                          allRecords: true,
                          operation: "clean",
                          instructions: "",
                          allowedFields: ["question"],
                        },
              ),
            },
          },
        ],
      };
      finish = "tool_calls";
    }
    if (
      requestMode === "clean" &&
      body.tool_choice?.function?.name === "read_processing"
    ) {
      const inspectedRunId = wrongEventRunId ?? runId;
      if (!repeatWrongEventRun) wrongEventRunId = undefined;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `forced_read_${requests.length}`,
            type: "function",
            function: {
              name: "read_processing",
              arguments: JSON.stringify({ runId: inspectedRunId }),
            },
          },
        ],
      };
      finish = "tool_calls";
    }
    if (
      requestMode === "clean" &&
      finishRetryRead &&
      body.tool_choice === "required"
    ) {
      finishRetryRead = false;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `retry_read_${requests.length}`,
            type: "function",
            function: {
              name: "read_records",
              arguments: JSON.stringify({
                source: { kind: "draft", id: draftId },
              }),
            },
          },
        ],
      };
      finish = "tool_calls";
    }
    if (
      extraAfterSubmit &&
      message.tool_calls?.[0]?.function.name === "submit_processing"
    )
      message.tool_calls.push({
        id: `extra_plan_${requests.length}`,
        type: "function",
        function: {
          name: "plan_task",
          arguments: JSON.stringify({
            title: "不应覆盖处理状态",
            requirements: ["错误地继续规划"],
            nextAction: "read_records",
          }),
        },
      });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "task-model",
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      }),
    );
  });
  const base = () => `/api/projects/${projectId}/assistant`;
  const read = async () =>
    (
      await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}`,
        headers,
      })
    ).json();

  beforeAll(async () => {
    const root = createPool(rootUrl);
    try {
      await root.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
    const account = {
      email: "tasks@example.test",
      password: "Assistant123",
      confirmPassword: "Assistant123",
      displayName: "任务管理员",
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
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "持续任务测试" },
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
            endpoint: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
            model: "synthetic",
            apiKey: "synthetic-test-key",
            enabled: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    draftId = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "持续清洗草稿" },
      })
    ).json().draft.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
          headers,
          payload: {
            question: "  如何查看账单？  ",
            expectedOutput: "查看账单",
            metadata: [{ key: "topic", value: "账务" }],
          },
        })
      ).statusCode,
    ).toBe(201);
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
  });
  afterAll(async () => {
    mode = "explain";
    release();
    await app?.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    const root = createPool(rootUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });

  it("continues beyond 50 turns and preserves history while rejecting turn 101", async () => {
    mode = "explain";
    const longSession = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const db = createPool(databaseUrl);
    const readLong = async () =>
      (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${longSession}`,
          headers,
        })
      ).json();
    const seed = async (start: number, end: number) =>
      db.query(
        `INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at,created_at)
       SELECT 'history_'||$1||'_'||n,$1,'history_'||n,'fixture','历史输入 '||n,'succeeded',now()+interval '1 day',now()-interval '1 day'+n*interval '1 second'
       FROM generate_series($2::int,$3::int) n`,
        [longSession, start, end],
      );
    try {
      await seed(1, 50);
      const submitted = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${longSession}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "继续同一任务" },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      await expect
        .poll(async () => (await readLong()).turns.at(-1)?.status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      expect((await readLong()).turns).toHaveLength(51);
      expect((await readLong()).turns[0].userText).toBe("历史输入 1");
      await taskModule.queueContinuation(
        db,
        longSession,
        "confirmed",
        "fixture-51",
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
            [longSession],
          )
        ).rows[0].n,
      ).toBe(52);
      // Settle this arranged automatic turn before checking the public upper bound.
      await db.query(
        "UPDATE assistant_turn SET status='succeeded',execution_token=NULL WHERE session_id=$1 AND status IN('queued','running')",
        [longSession],
      );
      await seed(53, 100);
      expect((await readLong()).turns).toHaveLength(100);
      const full = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${longSession}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "不能再增加" },
      });
      expect(full.statusCode).toBe(422);
      expect(full.json().error.code).toBe("assistant_session_full");
      await taskModule.queueContinuation(
        db,
        longSession,
        "confirmed",
        "fixture-101",
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
            [longSession],
          )
        ).rows[0].n,
      ).toBe(100);
    } finally {
      await db.end();
    }
  });

  it("continues to check candidates after background processing without another user message", async () => {
    mode = "clean";
    const initialModelCalls = requests.filter(
      (request) => request.tools,
    ).length;
    extraAfterSubmit = true;
    const submitted = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${sessionId}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        message:
          "清洗当前草稿的问题空白，保留期望输出和Metadata，完成后核对候选供我审核。",
        context: { kind: "draft", id: draftId },
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    await expect
      .poll(
        async () =>
          (await read()).turns.find(
            (turn: any) => turn.id === submitted.json().turnId,
          )?.status,
        { timeout: 15000 },
      )
      .toBe("succeeded");
    extraAfterSubmit = false;
    expect(requests.filter((request) => request.tools).length).toBe(
      initialModelCalls + 1,
    );
    expect((await read()).task.stage).toBe("processing");
    expect((await read()).task.title).not.toBe("不应覆盖处理状态");
    expect((await read()).turns[0].tools.map((tool: any) => tool.name)).toEqual(
      ["submit_processing"],
    );
    runId = (await read()).turns[0].tools.find(
      (tool: any) => tool.name === "submit_processing",
    ).result.runId;
    mode = "explain";
    const supplement = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${sessionId}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "期望输出和Metadata一定要保持原样" },
    });
    expect(supplement.statusCode, supplement.body).toBe(202);
    await expect
      .poll(async () => (await read()).turns.at(-1).status, { timeout: 15000 })
      .toBe("succeeded");
    expect((await read()).task.stage).toBe("processing");
    mode = "clean";
    await app.close();
    const db = createPool(databaseUrl);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='assistant-task-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const config = { ...loadConfig(), databaseUrl };
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id, result],
      );
      app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
      const competitor = await buildApp(appConfig(), {
        disableLegacyTestBootstrap: true,
      });
      try {
        await expect
          .poll(
            async () =>
              (await read()).turns.filter(
                (turn: any) =>
                  turn.event === "processing_completed" &&
                  turn.status === "succeeded",
              ).length,
            { timeout: 6000 },
          )
          .toBe(1);
        const state = await read();
        expect(state.task).toMatchObject({
          stage: "awaiting_review",
          runId,
          goal: "清洗当前草稿的问题空白，保留期望输出和Metadata，完成后核对候选供我审核。",
        });
        expect(
          state.turns.filter((turn: any) => turn.event === "user"),
        ).toHaveLength(2);
        expect(
          state.turns
            .at(-1)
            .tools.find((tool: any) => tool.name === "read_processing").result
            .records[0],
        ).toMatchObject({
          question: "如何查看账单？",
          expectedOutput: "查看账单",
        });
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
              headers,
            })
          ).json().records[0].question,
        ).toBe("  如何查看账单？  ");
        expect(
          requests.filter((body) =>
            String(body.messages.at(-1)?.content).startsWith(
              "[processing_completed]",
            ),
          ).length,
        ).toBe(1);
        const eventRequest = requests.find((body) =>
          String(body.messages.at(-1)?.content).startsWith(
            "[processing_completed]",
          ),
        );
        expect(eventRequest.tool_choice).toEqual({
          type: "function",
          function: { name: "read_processing" },
        });
        expect(eventRequest.messages.at(-1).role).toBe("user");
        expect(eventRequest.messages.at(-1).content).toContain(
          "不构成新的用户授权",
        );
        expect(
          requests.some(
            (body) => body.tool_choice?.function?.name === "read_processing",
          ),
        ).toBe(true);
        expect(
          eventRequest.tools.find(
            (item: any) => item.function.name === "submit_processing",
          ).function.parameters.required,
        ).toContain("allowedFields");
      } finally {
        await competitor.close();
      }
    } finally {
      await db.end();
    }
  });
  it("binds automatic inspection to the current run and preserves a retry follow-up", async () => {
    mode = "clean";
    const other = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/processing-runs`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: {
          kind: "draft",
          id: draftId,
          recordIds: (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
              headers,
            })
          )
            .json()
            .records.map((row: any) => row.id),
        },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    });
    expect(other.statusCode, other.body).toBe(201);
    wrongEventRunId = other.json().run.id;
    const event = (await read()).turns.find(
      (turn: any) => turn.event === "processing_completed",
    );
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed' WHERE id=$1",
        [event.id],
      );
      await db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"failed","nextAction":"read_records"}\'::jsonb WHERE id=$1',
        [sessionId],
      );
      const start = requests.length;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/retry`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (await read()).turns.find((turn: any) => turn.id === event.id)
              .status,
          { timeout: 15000 },
        )
        .toBe("failed");
      const failed = await read();
      expect(failed.task).toMatchObject({
        runId,
        nextAction: "read_records",
        review: { runId },
      });
      expect(
        failed.turns.find((turn: any) => turn.id === event.id).errorCode,
      ).toBe("assistant_task_not_executed");
      expect(
        failed.turns.find((turn: any) => turn.id === event.id).tools,
      ).toContainEqual(
        expect.objectContaining({
          name: "read_processing",
          status: "failed",
          error: { code: "assistant_processing_context_changed" },
        }),
      );
      expect(requests[start].tool_choice.function.name).toBe("read_processing");
      wrongEventRunId = undefined;
      finishRetryRead = true;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/retry`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (await read()).turns.find((turn: any) => turn.id === event.id)
              .status,
          { timeout: 15000 },
        )
        .toBe("succeeded");
      expect((await read()).task).toMatchObject({
        runId,
        stage: "awaiting_review",
        nextAction: null,
        review: { runId },
      });
      expect(
        (await read()).turns.find((turn: any) => turn.id === event.id).tools,
      ).toContainEqual(
        expect.objectContaining({ name: "read_records", status: "succeeded" }),
      );
      for (const responseMode of ["clean", "explain"] as const) {
        mode = responseMode;
        wrongEventRunId = other.json().run.id;
        repeatWrongEventRun = true;
        await db.query(
          "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed' WHERE id=$1",
          [event.id],
        );
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base()}/sessions/${sessionId}/retry`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
        await expect
          .poll(
            async () =>
              (await read()).turns.find((turn: any) => turn.id === event.id)
                .status,
            { timeout: 15000 },
          )
          .toBe("failed");
        expect(
          (await read()).turns.find((turn: any) => turn.id === event.id)
            .errorCode,
        ).toBe("assistant_task_not_executed");
        expect((await read()).task).toMatchObject({
          runId,
          nextAction: null,
          review: { runId },
        });
      }
      repeatWrongEventRun = false;
      wrongEventRunId = undefined;
      mode = "clean";
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/retry`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (await read()).turns.find((turn: any) => turn.id === event.id)
              .status,
          { timeout: 15000 },
        )
        .toBe("succeeded");
    } finally {
      await db.end();
    }
  });
  it("maps a selected-candidate processing plan to actual refinement and replays its receipt", async () => {
    mode = "planned_refine";
    const response = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${sessionId}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        message: "仅改我勾选的候选问题",
        candidates: { runId, resultIds: ["0:0"] },
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    const id = response.json().turnId;
    await expect
      .poll(
        async () =>
          (await read()).turns.find((turn: any) => turn.id === id).status,
        { timeout: 15000 },
      )
      .toBe("succeeded");
    const state = await read();
    const receipt = state.turns
      .find((turn: any) => turn.id === id)
      .tools.find((tool: any) => tool.name === "refine_candidates");
    expect(state.task).toMatchObject({
      runId: receipt.result.runId,
      stage: "processing",
      nextAction: null,
    });
    expect(receipt.result).toMatchObject({ refinedCount: 1 });
    const db = createPool(databaseUrl);
    try {
      mode = "explain";
      const beforeRetryRequests = requests.length;
      for (const nextAction of ["submit_processing", "any"]) {
        await db.query(
          "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed' WHERE id=$1",
          [id],
        );
        await db.query(
          "UPDATE assistant_session SET task=task||jsonb_build_object('stage','failed','nextAction',$2::text) WHERE id=$1",
          [sessionId, nextAction],
        );
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base()}/sessions/${sessionId}/retry`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
        await expect
          .poll(
            async () =>
              (await read()).turns.find((turn: any) => turn.id === id).status,
            { timeout: 15000 },
          )
          .toBe("succeeded");
        expect((await read()).task).toMatchObject({
          runId: receipt.result.runId,
          stage: "processing",
          nextAction: null,
        });
        expect(requests).toHaveLength(beforeRetryRequests);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/stop`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await db.end();
    }
  });
  it("reviews all pages and refines only selected candidates while retaining original draft conflict checks", async () => {
    for (let i = 1; i < 25; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
            headers,
            payload: {
              question: `问题 ${i}`,
              expectedOutput: i % 2 ? "账务" : "其他",
              metadata: [],
            },
          })
        ).statusCode,
      ).toBe(201);
    const draft = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${draftId}?limit=100`,
        headers,
      })
    ).json();
    const path = `/api/projects/${projectId}/processing-runs`;
    async function execute(id: string) {
      const db = createPool(databaseUrl);
      try {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='refinement-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
        };
        let result;
        try {
          result = await runProcessing(
            db,
            new ArtifactRepository(config.minio),
            config,
            job,
          );
        } catch (error) {
          await db.query(
            "UPDATE job SET status='failed',error_code='processing_batch_failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
            [job.id],
          );
          throw error;
        }
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [job.id, result],
        );
      } finally {
        await db.end();
      }
    }
    const created = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: {
          kind: "draft",
          id: draftId,
          recordIds: draft.records.map((row: any) => row.id),
        },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const parent = created.json().run.id;
    await execute(parent);
    const before = (
      await app.inject({
        method: "GET",
        url: `${path}/${parent}?limit=100`,
        headers,
      })
    ).json();
    const review = await app.inject({
      method: "GET",
      url: `${path}/${parent}/review`,
      headers,
    });
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().review).toMatchObject({
      total: 25,
      expectedCount: 25,
      countSatisfied: true,
      emptyQuestions: 0,
      protectedFieldChanges: 0,
    });
    const chosen = [before.records[0].id, before.records[24].id];
    const key = randomUUID(),
      payload = {
        resultIds: chosen,
        instructions: "问题写得更自然",
        allowedFields: ["question"],
      };
    const refined = await app.inject({
      method: "POST",
      url: `${path}/${parent}/refinements`,
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
    expect(refined.statusCode, refined.body).toBe(201);
    const child = refined.json().run.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/${parent}/refinements`,
          headers: { ...headers, "idempotency-key": key },
          payload,
        })
      ).json().run.id,
    ).toBe(child);
    preferBaseline = true;
    await execute(child);
    preferBaseline = false;
    const after = (
      await app.inject({
        method: "GET",
        url: `${path}/${child}?limit=100`,
        headers,
      })
    ).json();
    expect(after.total).toBe(25);
    for (let i = 0; i < 25; i++) {
      expect(after.records[i].result.question).toBe(
        before.records[i].result.question +
          (i === 0 || i === 24 ? "（自然表达）" : ""),
      );
      expect(after.records[i].result.expectedOutput).toBe(
        before.records[i].result.expectedOutput,
      );
      expect(after.records[i].result.metadata).toEqual(
        before.records[i].result.metadata,
      );
    }
    expect(
      requests
        .filter((body) => !body.tools)
        .flatMap(
          (body) => JSON.parse(body.messages.at(-1).content).records ?? [],
        ),
    ).toHaveLength(2);
    expect(
      requests
        .filter((body) => !body.tools)
        .every((body) => body.temperature === 0.2),
    ).toBe(true);
    const failedRun = await app.inject({
      method: "POST",
      url: `${path}/${child}/refinements`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        resultIds: [after.records[0].id],
        instructions: "再次调整问题",
        allowedFields: ["question"],
      },
    });
    expect(failedRun.statusCode, failedRun.body).toBe(201);
    const failedId = failedRun.json().run.id;
    const legacyDb = createPool(databaseUrl);
    try {
      await legacyDb.query(
        "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}',$2::jsonb) WHERE id=$1",
        [failedId, JSON.stringify("processing-v2")],
      );
    } finally {
      await legacyDb.end();
    }
    const legacyStart = requests.length;
    failRefinement = true;
    await expect(execute(failedId)).rejects.toThrow("processing_batch_failed");
    expect(
      requests
        .slice(legacyStart)
        .filter((body) => !body.tools)
        .some((body) =>
          JSON.parse(body.messages.at(-1).content).records.some(
            (row: any) => row.baseline,
          ),
        ),
    ).toBe(true);
    expect(
      requests
        .slice(legacyStart)
        .filter((body) => !body.tools)
        .every((body) => body.temperature === undefined),
    ).toBe(true);
    const partial = (
      await app.inject({
        method: "GET",
        url: `${path}/${failedId}?limit=100`,
        headers,
      })
    ).json();
    expect(partial.total).toBe(24);
    expect(partial.allIds).toEqual(partial.records.map((row: any) => row.id));
    expect(partial.records.map((r: any) => r.result.question)).toEqual(
      after.records.slice(1).map((r: any) => r.result.question),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/${failedId}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await execute(failedId);
    const recovered = (
      await app.inject({
        method: "GET",
        url: `${path}/${failedId}?limit=100`,
        headers,
      })
    ).json();
    expect(recovered.total).toBe(25);
    for (const row of partial.records) {
      expect(
        recovered.records.find((current: any) => current.id === row.id)?.result,
      ).toEqual(row.result);
    }
    expect(
      recovered.records.slice(1).map((r: any) => r.result.question),
    ).toEqual(after.records.slice(1).map((r: any) => r.result.question));
    const second = await app.inject({
      method: "POST",
      url: `${path}/${child}/refinements`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        resultIds: [after.records[0].id],
        instructions: "再次调整问题",
        allowedFields: ["question"],
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    const grandchild = second.json().run.id;
    await execute(grandchild);
    const latest = (
      await app.inject({
        method: "GET",
        url: `${path}/${grandchild}?limit=100`,
        headers,
      })
    ).json();
    const field = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records/${draft.records[0].id}`,
      headers,
      payload: {
        field: "question",
        value: "其他成员新修改",
        expectedFieldRevision: draft.records[0].questionRevision,
      },
    });
    expect(field.statusCode, field.body).toBe(200);
    const accept = await app.inject({
      method: "POST",
      url: `${path}/${grandchild}/accept`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        resultIds: latest.allIds,
        target: {
          kind: "draft",
          id: draftId,
          expectedRevision: draft.draft.revision,
        },
      },
    });
    expect(accept.statusCode, accept.body).toBe(409);
    expect(accept.json().error.code).toBe("draft_field_conflict");
    const adopt = await app.inject({
      method: "POST",
      url: `${path}/${grandchild}/accept`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        resultIds: latest.allIds.slice(1),
        target: {
          kind: "draft",
          id: draftId,
          expectedRevision: draft.draft.revision,
        },
      },
    });
    expect(adopt.statusCode, adopt.body).toBe(201);
    const adopted = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${draftId}?limit=100`,
        headers,
      })
    ).json();
    expect(adopted.total).toBe(25);
    expect(adopted.records[0].question).toBe("其他成员新修改");
    expect(adopted.records[24].question).toBe(
      before.records[24].result.question + "（自然表达）",
    );
  });

  it("retries the same unfinished turn without creating another draft, and fences a stopped model response", async () => {
    mode = "retry";
    failReply = true;
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const submit = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${id}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "创建失败恢复草稿" },
    });
    expect(submit.statusCode).toBe(202);
    const state = async () =>
      (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${id}`,
          headers,
        })
      ).json();
    await expect
      .poll(async () => (await state()).turns[0].status, { timeout: 15000 })
      .toBe("failed");
    const original = (await state()).turns[0];
    expect(
      original.tools.find((tool: any) => tool.name === "create_draft").status,
    ).toBe("succeeded");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${id}/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await expect
      .poll(async () => (await state()).turns[0].status, { timeout: 15000 })
      .toBe("succeeded");
    expect((await state()).turns).toHaveLength(1);
    const drafts = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
      })
    ).json().drafts;
    expect(
      drafts.filter((draft: any) => draft.name === "失败恢复草稿"),
    ).toHaveLength(1);
    mode = "held";
    const stopped = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${stopped}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "暂缓创建" },
        })
      ).statusCode,
    ).toBe(202);
    await waiting;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${stopped}/stop`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    mode = "explain";
    release();
    await expect
      .poll(
        async () =>
          (
            await app.inject({
              method: "GET",
              url: `${base()}/sessions/${stopped}`,
              headers,
            })
          ).json().task.stage,
      )
      .toBe("stopped");
    await app.close();
    app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
        })
      )
        .json()
        .drafts.some((draft: any) => draft.name === "停止后禁止创建"),
    ).toBe(false);
  });
  it("permits a direct explanation and keeps original requirements beyond the conversation history window", async () => {
    mode = "explain";
    const goal = "目标数量25条，保留答案和Metadata";
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    for (let i = 0; i < 8; i++) {
      const submitted = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${id}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: i === 0 ? goal : `补充要求 ${i}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await app.inject({
                method: "GET",
                url: `${base()}/sessions/${id}`,
                headers,
              })
            )
              .json()
              .turns.at(-1).status,
          { timeout: 15000 },
        )
        .toBe("succeeded");
    }
    const state = (
      await app.inject({
        method: "GET",
        url: `${base()}/sessions/${id}`,
        headers,
      })
    ).json();
    expect(state.task.goal).toBe(goal);
    expect(state.task.supplements).toHaveLength(7);
    expect(state.turns.every((turn: any) => turn.tools.length === 0)).toBe(
      true,
    );
    expect(requests.at(-1).tool_choice).not.toBe("required");
    expect(
      requests
        .at(-1)
        .messages.some((item: any) => String(item.content).includes(goal)),
    ).toBe(true);
  });

  it("invalidates old confirmation on changed requirements and resumes once after a confirmed receipt", async () => {
    mode = "proposal";
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const state = async () =>
      (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${id}`,
          headers,
        })
      ).json();
    const send = async (message: string) => {
      const result = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${id}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message },
      });
      expect(result.statusCode, result.body).toBe(202);
      await expect
        .poll(async () => (await state()).turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("succeeded");
    };
    await send("采用已核对候选，确认后读取实际结果");
    const old = (await state()).proposals.find(
      (p: any) => p.status === "pending",
    );
    expect(old).toBeTruthy();
    await send("仅保存派生原始数据，不写入草稿");
    const cancelled = await app.inject({
      method: "POST",
      url: `${base()}/proposals/${old.id}/confirm`,
      headers,
      payload: {},
    });
    expect(cancelled.statusCode, cancelled.body).toBe(409);
    const fresh = (await state()).proposals.find(
      (p: any) => p.status === "pending",
    );
    const first = await app.inject({
      method: "POST",
      url: `${base()}/proposals/${fresh.id}/confirm`,
      headers,
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/proposals/${fresh.id}/confirm`,
          headers,
          payload: {},
        })
      ).json().receipt,
    ).toEqual(first.json().receipt);
    await expect
      .poll(
        async () =>
          (await state()).turns.filter(
            (t: any) => t.event === "confirmed" && t.status === "succeeded",
          ).length,
        { timeout: 6000 },
      )
      .toBe(1);
    const receipt = first.json().receipt.receipt;
    expect(receipt.assetId).toBeTruthy();
    independentAsset = receipt.assetId;
    expect((await state()).task.goal).toBe(
      "采用已核对候选，确认后读取实际结果",
    );
  });

  it("links a processing receipt before post-commit reporting, and durably stops its queued job", async () => {
    mode = "clean";
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const spy = vi
      .spyOn(taskModule, "updateTask")
      .mockRejectedValueOnce(new Error("synthetic post-commit report failure"));
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${id}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              message: "清洗当前草稿",
              context: { kind: "draft", id: draftId },
            },
          })
        ).statusCode,
      ).toBe(202);
      const state = async () =>
        (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions/${id}`,
            headers,
          })
        ).json();
      await expect
        .poll(async () => (await state()).turns.at(-1)?.status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      expect(spy).toHaveBeenCalled();
      // Detail reading reconciles the committed domain receipt after reporting failed.
      expect(
        (await state()).turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "submit_processing").result
          .recovered,
      ).toBe(true);
      const linked = (await state()).task.runId;
      expect(linked).toBeTruthy();
      const db = createPool(databaseUrl);
      try {
        const completedTurn = (await state()).turns.at(-1);
        await db.query(
          "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed',assistant_text='' WHERE id=$1",
          [completedTurn.id],
        );
        await db.query(
          'UPDATE assistant_session SET task=task||\'{"stage":"failed"}\'::jsonb WHERE id=$1',
          [id],
        );
        const resumeCalls = requests.filter((request) => request.tools).length;
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base()}/sessions/${id}/retry`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
        await expect
          .poll(async () => (await state()).turns.at(-1)?.status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        expect((await state()).turns.at(-1).id).toBe(completedTurn.id);
        expect((await state()).task).toMatchObject({
          runId: linked,
          stage: "processing",
        });
        expect(requests.filter((request) => request.tools).length).toBe(
          resumeCalls,
        );
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/processing-runs/${linked}`,
              headers,
            })
          ).json().run.status,
        ).toBe("queued");
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base()}/sessions/${id}/stop`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
        await app.close();
        app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
        expect((await state()).task.stage).toBe("stopped");
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/processing-runs/${linked}`,
              headers,
            })
          ).json().run.status,
        ).toBe("cancel_requested");
      } finally {
        await db.end();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("isolates unavailable confirmed history and resumes a bounded automatic budget", async () => {
    mode = "explain";
    const send = async (id: string) => {
      const response = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${id}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "解释如何生成候选" },
      });
      expect(response.statusCode, response.body).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await app.inject({
                method: "GET",
                url: `${base()}/sessions/${id}`,
                headers,
              })
            )
              .json()
              .turns.at(-1).status,
          { timeout: 15000 },
        )
        .toBe("succeeded");
    };
    const bad = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    await send(bad);
    await app.close();
    const db = createPool(databaseUrl);
    try {
      // Persist the crash boundary: confirmation committed; its continuation has not been queued.
      const proposal = (
        await db.query(
          "SELECT * FROM assistant_proposal WHERE status='succeeded' LIMIT 1",
        )
      ).rows[0];
      const turn = (
        await db.query(
          "SELECT * FROM assistant_turn WHERE session_id=$1 LIMIT 1",
          [bad],
        )
      ).rows[0];
      await db.query("UPDATE assistant_turn SET dependencies=$2 WHERE id=$1", [
        turn.id,
        JSON.stringify([{ kind: "draft", id: "recycled-source" }]),
      ]);
      await db.query(
        "UPDATE assistant_proposal SET session_id=$2,turn_id=$3,task_revision=(SELECT task_revision FROM assistant_session WHERE id=$2) WHERE id=$1",
        [proposal.id, bad, turn.id],
      );
      await db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"awaiting_confirmation"}\'::jsonb WHERE id=$1',
        [bad],
      );
      app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
      const healthy = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      await send(healthy);
      const capturedRevision = (
        await db.query(
          "SELECT task_revision FROM assistant_session WHERE id=$1",
          [healthy],
        )
      ).rows[0].task_revision;
      await send(healthy);
      await taskModule.queueContinuation(
        db,
        healthy,
        "processing_completed",
        "stale-result-event",
        capturedRevision,
      );
      expect(
        (
          await db.query(
            "SELECT task->>'stage' AS stage FROM assistant_session WHERE id=$1",
            [healthy],
          )
        ).rows[0].stage,
      ).toBe("waiting_input");
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions/${healthy}`,
            headers,
          })
        )
          .json()
          .turns.every((turn: any) => turn.event === "user"),
      ).toBe(true);
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT task->>'stage' AS stage FROM assistant_session WHERE id=$1",
                [bad],
              )
            ).rows[0].stage,
          { timeout: 6000 },
        )
        .toBe("failed");
      const list = (
        await app.inject({ method: "GET", url: `${base()}/sessions`, headers })
      ).json().sessions;
      expect(list.some((s: any) => s.id === bad)).toBe(false);
      expect(list.some((s: any) => s.id === healthy)).toBe(true);
      await app.close();
      const budgetTurn = (
        await db.query(
          "SELECT id FROM assistant_turn WHERE session_id=$1 LIMIT 1",
          [healthy],
        )
      ).rows[0].id;
      await db.query(
        "UPDATE assistant_proposal SET session_id=$2,turn_id=$3,task_revision=(SELECT task_revision FROM assistant_session WHERE id=$2) WHERE id=$1",
        [proposal.id, healthy, budgetTurn],
      );
      await db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"awaiting_confirmation","autoCount":12}\'::jsonb WHERE id=$1',
        [healthy],
      );
      app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT task->>'error' AS error FROM assistant_session WHERE id=$1",
                [healthy],
              )
            ).rows[0].error,
          { timeout: 6000 },
        )
        .toBe("assistant_task_limit");
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${healthy}/retry`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (
              await app.inject({
                method: "GET",
                url: `${base()}/sessions/${healthy}`,
                headers,
              })
            ).json().task.stage,
          { timeout: 15000 },
        )
        .toBe("waiting_input");
      expect(
        (
          await db.query(
            "SELECT (task->>'autoCount')::int AS count FROM assistant_session WHERE id=$1",
            [healthy],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("waits for all linked batches before consuming an automatic inspection", async () => {
    mode = "explain";
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const posted = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${id}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "说明多批处理流程" },
    });
    expect(posted.statusCode).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await app.inject({
              method: "GET",
              url: `${base()}/sessions/${id}`,
              headers,
            })
          )
            .json()
            .turns.at(-1).status,
        { timeout: 15000 },
      )
      .toBe("succeeded");
    const recordIds = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
        headers,
      })
    )
      .json()
      .records.map((row: any) => row.id);
    const runs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const created = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: draftId, recordIds },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      runs.push(created.json().run.id);
    }
    await app.close();
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE job SET status='succeeded' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [runs[0]],
      );
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            stage: "processing",
            runIds: runs,
            runId: runs[1],
            autoCount: 0,
          }),
        ],
      );
      const automatic = async () =>
        (
          await db.query(
            "SELECT id FROM assistant_turn WHERE session_id=$1 AND event='processing_completed'",
            [id],
          )
        ).rowCount;
      // An old completed run cannot turn a queued/running new batch into a completion event.
      await taskModule.collectProcessingEvents(db);
      expect(await automatic()).toBe(0);
      await db.query(
        "UPDATE job SET status='running',updated_at=now() WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [runs[1]],
      );
      await taskModule.collectProcessingEvents(db);
      expect(await automatic()).toBe(0);
      expect(
        (
          await db.query(
            "SELECT task->>'stage' AS stage,task->>'autoCount' AS count FROM assistant_session WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({ stage: "processing", count: "0" });
      // Terminal failure still warrants one honest aggregate inspection; repeated polls do not add turns.
      await db.query(
        "UPDATE job SET status='failed',updated_at=now() WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [runs[1]],
      );
      await taskModule.collectProcessingEvents(db);
      await taskModule.collectProcessingEvents(db);
      expect(await automatic()).toBe(1);
    } finally {
      await db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"stopped"}\'::jsonb WHERE id=$1',
        [id],
      );
      await db.query(
        "UPDATE assistant_turn SET status='interrupted' WHERE session_id=$1 AND status IN('queued','running')",
        [id],
      );
      await db.end();
      app = await buildApp(appConfig(), { disableLegacyTestBootstrap: true });
    }
  });

  it("checks a linked job that finishes while the user supplement is still receiving its model reply", async () => {
    mode = "clean";
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const state = async () =>
      (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${id}`,
          headers,
        })
      ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${id}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            message: "清洗当前草稿后核对候选",
            context: { kind: "draft", id: draftId },
          },
        })
      ).statusCode,
    ).toBe(202);
    await expect
      .poll(async () => (await state()).turns.at(-1).status, { timeout: 15000 })
      .toBe("succeeded");
    const linked = (await state()).task.runId;
    mode = "held_explain";
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${id}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "保持期望输出和Metadata原样" },
        })
      ).statusCode,
    ).toBe(202);
    await received;
    const db = createPool(databaseUrl);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='supplement-race',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [linked],
        )
      ).rows[0];
      const config = { ...loadConfig(), databaseUrl };
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [job.id, result],
      );
      release();
      await expect
        .poll(async () => (await state()).turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      expect((await state()).task).toMatchObject({
        stage: "awaiting_review",
        runId: linked,
        checkedStatus: "succeeded",
        review: { total: 25 },
      });
    } finally {
      release();
      mode = "explain";
      await db.end();
    }
  });

  it("executes the planned operation instead of ending with a future-tense promise and waiting for input", async () => {
    mode = "planned";
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const state = async () =>
      (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${id}`,
          headers,
        })
      ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${id}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            message: "请清洗当前草稿的全部25条问题",
            context: { kind: "draft", id: draftId },
          },
        })
      ).statusCode,
    ).toBe(202);
    await expect
      .poll(async () => (await state()).turns.at(-1).status, { timeout: 15000 })
      .toBe("succeeded");
    const current = await state();
    expect(current.task.stage).toBe("processing");
    expect(current.task.runId).toBeTruthy();
    expect(
      current.turns
        .at(-1)
        .tools.filter(
          (tool: any) =>
            tool.name === "submit_processing" && tool.status === "succeeded",
        ),
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${id}/stop`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    mode = "explain";
  });

  it.each([
    { modelMode: "planned_read", stage: "processing" },
    { modelMode: "planned_clarify", stage: "waiting_input" },
    { modelMode: "planned_ignore", stage: "failed" },
  ] as const)(
    "handles a plan with $modelMode without false waiting",
    async ({ modelMode, stage }) => {
      mode = modelMode;
      const id = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const state = async () =>
        (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions/${id}`,
            headers,
          })
        ).json();
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${id}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              message: "请清洗问题并核对候选",
              context: { kind: "draft", id: draftId },
            },
          })
        ).statusCode,
      ).toBe(202);
      await expect
        .poll(async () => (await state()).turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe(stage === "failed" ? "failed" : "succeeded");
      const current = await state();
      expect(current.task.stage).toBe(stage);
      if (stage === "processing") {
        expect(current.task.runId).toBeTruthy();
        const run = (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-runs/${current.task.runId}`,
            headers,
          })
        ).json().run;
        expect(run.source).toMatchObject({ kind: "draft", id: draftId });
        expect(run.status).toBe("queued");
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base()}/sessions/${id}/stop`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
      } else {
        expect(current.task.runId).toBeUndefined();
        if (stage === "failed")
          expect(current.turns.at(-1).errorCode).toBe(
            "assistant_task_not_executed",
          );
        else
          expect(current.turns.at(-1).assistantText).toContain(
            "需要处理哪些记录",
          );
        if (stage === "failed") {
          mode = "planned_retry_text";
          const beforeRequests = requests.length;
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${base()}/sessions/${id}/retry`,
                headers,
                payload: {},
              })
            ).statusCode,
          ).toBe(200);
          await expect
            .poll(() => requests.length, { timeout: 15000 })
            .toBeGreaterThan(beforeRequests);
          await expect
            .poll(async () => (await state()).turns.at(-1).status, {
              timeout: 15000,
            })
            .not.toMatch(/queued|running/);
          const retried = await state();
          expect(retried.turns.at(-1).id).toBe(current.turns.at(-1).id);
          expect(retried.turns.at(-1).status).toBe("failed");
          expect(retried.turns.at(-1).errorCode).toBe(
            "assistant_task_not_executed",
          );
          expect(retried.task.runId).toBeUndefined();
        }
      }
      mode = "explain";
    },
  );

  it("purges task goals and chained candidate bodies when their draft is deleted", async () => {
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
      headers,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const session = await read();
    expect(session.task).toEqual({});
    expect(session.title).toBe("");
    expect(
      session.turns.every(
        (turn: any) =>
          !turn.userText && !turn.assistantText && turn.tools.length === 0,
      ),
    ).toBe(true);
    const runs = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-runs`,
        headers,
      })
    ).json().runs;
    expect(
      runs.some(
        (run: any) => run.source.kind === "draft" && run.source.id === draftId,
      ),
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${runId}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const assets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collections`,
        headers,
      })
    ).json();
    expect(assets.collections.length).toBeGreaterThan(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/assets/${independentAsset}/download?view=raw`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("uses small distinct ranges for large new augmentations and preserves v4 retries", async () => {
    mode = "explain";
    augmentationPattern = true;
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "分批扩充" },
      })
    ).json().draft.id;
    const record = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
        headers,
        payload: {
          question: "给社区志愿者写一段招募介绍",
          expectedOutput: "安全且完整",
          metadata: [],
        },
      })
    ).json().record.id;
    const path = `/api/projects/${projectId}/processing-runs`;
    const db = createPool(databaseUrl);
    try {
      for (const legacy of [false, true]) {
        const created = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "draft", id: draft, recordIds: [record] },
            options: {
              operation: "augment",
              instructions: "新增21个不同场景",
              outputCount: 21,
              allowedFields: ["question", "expectedOutput"],
            },
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        const id = created.json().run.id;
        if (legacy)
          await db.query(
            "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}', $2::jsonb) WHERE id=$1",
            [id, JSON.stringify("processing-v4")],
          );
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='range-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        const start = requests.length;
        const config = { ...loadConfig(), ...appConfig() };
        const result = await runProcessing(
          db,
          new ArtifactRepository(config.minio),
          config,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [job.id, result],
        );
        const sent = requests.slice(start).filter((body) => !body.tools);
        const prompts = sent.map((body) =>
          JSON.parse(body.messages.at(-1).content),
        );
        expect(prompts.map((p) => p.outputCount)).toEqual(
          legacy ? [20, 1] : [10, 10, 1],
        );
        expect(prompts.map((p) => p.augmentationBatch)).toEqual(
          legacy
            ? [undefined, undefined]
            : [
                { offset: 0, count: 10, total: 21 },
                { offset: 10, count: 10, total: 21 },
                { offset: 20, count: 1, total: 21 },
              ],
        );
        expect(sent.every((body) => body.temperature === 0.2)).toBe(true);
        const data = (
          await app.inject({
            method: "GET",
            url: `${path}/${id}?limit=100`,
            headers,
          })
        ).json();
        expect(data.total).toBe(21);
        if (!legacy)
          expect(
            new Set(data.records.map((r: any) => r.result.question)).size,
          ).toBe(21);
      }
    } finally {
      augmentationPattern = false;
      await db.end();
    }
  });
  it("allows a near-budget final augmentation batch using its actual count", async () => {
    mode = "explain";
    augmentationPattern = true;
    const draftPath = `/api/projects/${projectId}/collaborative-drafts`;
    const draft = (
      await app.inject({
        method: "POST",
        url: draftPath,
        headers,
        payload: { name: "末批预算" },
      })
    ).json().draft.id;
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const row = await app.inject({
        method: "POST",
        url: `${draftPath}/${draft}/records`,
        headers,
        payload: { question: `Q${i}`, expectedOutput: "safe", metadata: [] },
      });
      expect(row.statusCode, row.body).toBe(201);
      ids.push(row.json().record.id);
    }
    const db = createPool(databaseUrl);
    try {
      const execute = async () => {
        const run = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/processing-runs`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "draft", id: draft, recordIds: ids },
            options: {
              operation: "augment",
              instructions: "21个不同场景",
              outputCount: 21,
              allowedFields: ["question"],
            },
          },
        });
        expect(run.statusCode, run.body).toBe(201);
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='last-range-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [run.json().run.id],
          )
        ).rows[0];
        const config = { ...loadConfig(), ...appConfig() };
        const start = requests.length;
        const result = await runProcessing(
          db,
          new ArtifactRepository(config.minio),
          config,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [job.id, result],
        );
        return requests.slice(start).filter((body) => !body.tools);
      };
      const probe = (await execute()).at(-1);
      const prompt = JSON.parse(probe.messages.at(-1).content);
      prompt.records = [prompt.records[0]];
      expect(prompt.records[0].id).toBe(ids[20]);
      prompt.records[0].question = "";
      const size = Buffer.byteLength(
        probe.messages[0].content + JSON.stringify(prompt),
      );
      const patched = await app.inject({
        method: "PATCH",
        url: `${draftPath}/${draft}/records/${ids[20]}`,
        headers,
        payload: {
          field: "question",
          expectedFieldRevision: 0,
          value: "Q".repeat(39999 - size),
        },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      const actual = (await execute()).at(-1);
      expect(
        Buffer.byteLength(actual.messages.map((m: any) => m.content).join("")),
      ).toBe(39999);
      expect(
        JSON.parse(actual.messages.at(-1).content).augmentationBatch,
      ).toEqual({ offset: 20, count: 1, total: 21 });
    } finally {
      augmentationPattern = false;
      await db.end();
    }
  });
  it("fills only missing augmentation rows within a bounded batch and keeps honest partial results", async () => {
    mode = "explain";
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "补齐数量" },
      })
    ).json().draft.id;
    const record = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
        headers,
        payload: {
          question: "原始问题",
          expectedOutput: "指数分析",
          metadata: [{ key: "来源", value: "保留" }],
        },
      })
    ).json().record.id;
    const path = `/api/projects/${projectId}/processing-runs`,
      db = createPool(databaseUrl);
    try {
      for (const pattern of ["recover", "partial"] as const) {
        repairPattern = pattern;
        repairCalls = 0;
        const created = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "draft", id: draft, recordIds: [record] },
            options: {
              operation: "augment",
              instructions: "新增12条，指数分析与指数对比各6条",
              outputCount: 12,
              allowedFields: ["question", "expectedOutput"],
            },
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        const id = created.json().run.id;
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='repair-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
        };
        let result;
        try {
          result = await runProcessing(
            db,
            new ArtifactRepository(config.minio),
            config,
            job,
          );
        } catch (error) {
          if (pattern !== "partial") throw error;
          expect((error as Error).message).toBe("processing_batch_failed");
        }
        // Keep a legacy succeeded row to prove recovery still works for old persisted tasks.
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [job.id, result],
        );
        const data = (
          await app.inject({
            method: "GET",
            url: `${path}/${id}?limit=100`,
            headers,
          })
        ).json();
        expect(data.total).toBe(pattern === "recover" ? 12 : 11);
        expect(repairCalls).toBe(pattern === "recover" ? 2 : 3);
        expect(
          data.records.slice(0, 11).map((r: any) => r.result.question),
        ).toEqual(Array.from({ length: 11 }, (_, i) => `新增问题 ${i + 1}`));
        expect(
          data.records.every(
            (r: any) =>
              JSON.stringify(r.result.metadata) ===
              JSON.stringify([{ key: "来源", value: "保留" }]),
          ),
        ).toBe(true);
        const review = (
          await app.inject({
            method: "GET",
            url: `${path}/${id}/review`,
            headers,
          })
        ).json().review;
        if (pattern === "recover") {
          expect(review).toMatchObject({ complete: true });
          expect(review.labels).toEqual([
            { label: "指数分析", count: 6 },
            { label: "指数对比", count: 6 },
          ]);
        } else {
          expect(review.complete).toBe(false);
          const legacySession = (
            await app.inject({
              method: "POST",
              url: `${base()}/sessions`,
              headers,
              payload: {},
            })
          ).json().sessionId;
          await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
            legacySession,
            JSON.stringify({
              goal: "扩充12条",
              title: "补齐缺失",
              runId: id,
              stage: "awaiting_review",
              checkedStatus: "succeeded",
              review,
            }),
          ]);
          const retried = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${legacySession}/retry`,
            headers,
            payload: {},
          });
          expect(retried.statusCode, retried.body).toBe(200);
          expect(
            (
              await app.inject({
                method: "GET",
                url: `${path}/${id}/status`,
                headers,
              })
            ).json().run.status,
          ).toBe("queued");
          expect(
            (
              await app.inject({ method: "GET", url: `${path}/${id}`, headers })
            ).json().total,
          ).toBe(11);
        }
      }
    } finally {
      repairPattern = null;
      await db.end();
    }
  });
  it("refines raw-file augmentation without inventing draft revisions", async () => {
    mode = "explain";
    const collectionId = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collections`,
        headers,
      })
    ).json().collections[0].id;
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "text/csv",
        "x-file-name": "refinement.csv",
      },
      payload: "question,answer\nFirst,Index\nSecond,Compare\n",
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const saved = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        collectionId,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const assetId = saved.json().assets[0].id;
    const mappingUrl = `/api/projects/${projectId}/assets/${assetId}/mapping`;
    const raw = (
      await app.inject({ method: "GET", url: mappingUrl, headers })
    ).json();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: mappingUrl,
          headers,
          payload: {
            parsedViewId: raw.parsedViewId,
            expectedRevision: 0,
            mapping: {
              question: "/question",
              expectedOutput: "/answer",
              metadata: [],
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    const path = `/api/projects/${projectId}/processing-runs`;
    const preview = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-inputs`,
        headers,
        payload: { source: { kind: "assets", assetIds: [assetId] } },
      })
    ).json();
    const created = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: {
          kind: "assets",
          assetIds: [assetId],
          recordIds: preview.allIds,
        },
        options: {
          operation: "augment",
          instructions: "Two variants",
          allowedFields: ["question"],
          outputCount: 2,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const execute = async (id: string) => {
      const db = createPool(databaseUrl);
      try {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='raw-refinement-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        const config = { ...loadConfig(), ...appConfig() };
        const result = await runProcessing(
          db,
          new ArtifactRepository(config.minio),
          config,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
          [job.id, result],
        );
      } finally {
        await db.end();
      }
    };
    const parent = created.json().run.id;
    await execute(parent);
    const before = (
      await app.inject({
        method: "GET",
        url: `${path}/${parent}?limit=100`,
        headers,
      })
    ).json();
    expect(before.total).toBe(2);
    const key = randomUUID(),
      payload = {
        resultIds: [before.records[0].id],
        instructions: "Rephrase selected question",
        allowedFields: ["question"],
      };
    const refined = await app.inject({
      method: "POST",
      url: `${path}/${parent}/refinements`,
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
    expect(refined.statusCode, refined.body).toBe(201);
    const child = refined.json().run.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/${parent}/refinements`,
          headers: { ...headers, "idempotency-key": key },
          payload,
        })
      ).json().run.id,
    ).toBe(child);
    await execute(child);
    const after = (
      await app.inject({
        method: "GET",
        url: `${path}/${child}?limit=100`,
        headers,
      })
    ).json();
    expect(after.total).toBe(2);
    expect(after.records[0].result.question).toBe(
      before.records[0].result.question + "（自然表达）",
    );
    expect(after.records[1].result.question).toBe(
      before.records[1].result.question,
    );
    for (let i = 0; i < 2; i++) {
      expect(after.records[i].result.expectedOutput).toBe(
        before.records[i].result.expectedOutput,
      );
      expect(after.records[i].result.metadata).toEqual(
        before.records[i].result.metadata,
      );
      expect(after.records[i].original.baseline.id).toBe(
        before.records[i].result.sourceId,
      );
    }
  });
});
