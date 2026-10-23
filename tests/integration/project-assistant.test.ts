import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { parse as parseCsv } from "csv-parse/sync";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as processingStoreModule from "../../src/processing/store.js";
import * as contextModule from "../../src/assistant/context.js";
import * as draftCreateModule from "../../src/drafts/create.js";
import * as taskModule from "../../src/assistant/tasks.js";
import * as fenceModule from "../../src/assistant/fence.js";
import * as refineModule from "../../src/processing/refine.js";
import * as presentationModule from "../../src/processing/presentation.js";
import * as reviewModule from "../../src/assistant/review.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { canonicalJson, sha256 } from "../../src/package/contract.js";
import { planRequirementsKey } from "../../src/assistant/plan.js";
import {
  selectRecords,
  type SelectionRecord,
} from "../../src/selection/index.js";

const origin = "http://127.0.0.1:4217",
  baseUrl = loadConfig().databaseUrl,
  name = `assistant_${randomUUID().replaceAll("-", "")}`,
  databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${name}`);
describe("project assistant public contract", () => {
  let app: AgentBenchApp,
    headers: Record<string, string>,
    projectId: string,
    draftId: string,
    sessionId: string,
    publishedVersionId: string,
    publishedTestSetId: string;
  const calls: Record<string, any>[] = [];
  let requestedTool:
    | { name: string; input: Record<string, unknown> }
    | undefined;
  let rawToolArguments: string[] = [];
  let toolSequence: { name: string; input: Record<string, unknown> }[] = [];
  let toolBatch: { name: string; input: Record<string, unknown> }[] | undefined;
  let backgroundCheckpoint:
    | Record<string, unknown>
    | Record<string, unknown>[]
    | undefined;
  let generationDuplicates = false;
  let generationResponse: ((prompt: any) => unknown[]) | undefined;
  let repeatRead: boolean | "progress" | "bounded" = false;
  let textualToolCall: string | undefined;
  let textualReplies: string[] = [];
  let finalReply: string | undefined;
  let toolReply: string | undefined;
  let textualToolCallAfterScopeError = false;
  let hold = false,
    release: () => void = () => undefined,
    entered: () => void = () => undefined;
  let providerFailure: number | "network" | "json" | "shape" | undefined;
  let providerFailureRemaining = 1;
  let providerFaults: (number | null)[] = [];
  let providerRetryAfter: string | undefined;
  let failAfterTool = false;
  let parameterRepairTextOnce = false;
  let parameterRepairReply:
    | ((
        input: any,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>)
    | undefined;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push(body);
    if (providerFaults.length) {
      providerFailure = providerFaults.shift() ?? undefined;
      providerFailureRemaining = 1;
    }
    if (
      providerFailure !== undefined &&
      (!failAfterTool || body.messages.at(-1)?.role === "tool")
    ) {
      const failure = providerFailure;
      if (--providerFailureRemaining <= 0) {
        providerFailure = undefined;
        failAfterTool = false;
        providerFailureRemaining = 1;
      }
      if (failure === "network") {
        req.socket.destroy();
        return;
      }
      res.writeHead(typeof failure === "number" ? failure : 200, {
        "content-type": "application/json",
        ...(providerRetryAfter ? { "retry-after": providerRetryAfter } : {}),
      });
      res.end(
        failure === "json"
          ? "{"
          : failure === "shape"
            ? "{}"
            : JSON.stringify({
                error: {
                  message: "private-provider-canary synthetic-test-key",
                },
              }),
      );
      return;
    }
    if (!body.tools) {
      let processing;
      try {
        processing = JSON.parse(body.messages.at(-1)?.content ?? "");
      } catch {
        /* Other protocol requests keep their existing fixture response. */
      }
      if (processing?.operation === "generate") {
        const offset = processing.augmentationBatch?.offset ?? 0;
        const prefix = processing.previousBatchExamples?.length
          ? "在新的场景中，"
          : "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "synthetic-generation",
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    records:
                      generationResponse?.(processing) ??
                      Array.from(
                        { length: processing.outputCount },
                        (_, i) => ({
                          question: `${prefix}如果我遇到第${generationDuplicates ? 1 : offset + i + 1}种具体情况，应当怎样核验信息来源？`,
                          expectedOutput: "说明核验方法，不编造事实",
                          metadata: [
                            {
                              key: "riskCategory",
                              value:
                                processing.background?.classifications?.[0]
                                  ?.allowedValues?.[0] ?? "A.1.a",
                            },
                          ],
                        }),
                      ),
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          }),
        );
        return;
      }
      if (processing?.operation && Array.isArray(processing.records)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "synthetic-processing",
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    records: processing.records
                      .slice(
                        0,
                        processing.outputCount ?? processing.records.length,
                      )
                      .map((row: any) => ({
                        sourceId: row.id,
                        question:
                          processing.instructions === "OPT-25 局部表述"
                            ? row.question.trim() + " 自然表述"
                            : processing.instructions ===
                                  "新增第二个具体问题" ||
                                row.question ===
                                  "另一个背景约束下的具体场景问题"
                              ? "另一个背景约束下的具体场景问题"
                              : "背景约束下的具体场景问题",
                        expectedOutput: row.expectedOutput,
                        metadata: processing.metadataKeys
                          ? [
                              { key: "subject", value: "伪造旧标签" },
                              ...processing.metadataKeys.map((key: string) => ({
                                key,
                                value: row.question.startsWith("甲")
                                  ? "A.1.a"
                                  : "A.2.a",
                              })),
                            ]
                          : processing.instructions === "补足缺少的丙类问题"
                            ? [
                                ...row.metadata,
                                { key: "riskCode", value: "A.3.a" },
                              ]
                            : row.metadata,
                      })),
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          }),
        );
        return;
      }
    }
    if (hold) {
      entered();
      await new Promise<void>((r) => (release = r));
      hold = false;
    }
    let repairRequest;
    try {
      repairRequest = JSON.parse(body.messages.at(-1)?.content ?? "");
    } catch {
      /* Normal assistant messages are not repair envelopes. */
    }
    if (repairRequest?.operation === "repair_tool_arguments") {
      if (parameterRepairTextOnce) {
        parameterRepairTextOnce = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "repair-protocol-failure",
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "未按工具协议返回参数" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const input =
        (await parameterRepairReply?.(repairRequest)) ?? repairRequest.original;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "parameter-repair",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "repaired-call",
                    type: "function",
                    function: {
                      name: repairRequest.toolName,
                      arguments: JSON.stringify(input),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        }),
      );
      return;
    }
    // Honor the actual protocol before consuming any scripted business call.
    const requiredControl =
      body.tool_choice?.function?.name === "plan_task" &&
      body.tools
        ?.find((entry: any) => entry.function.name === "plan_task")
        ?.function.parameters.required?.includes("control");
    if (requiredControl) {
      const scriptedControl =
        toolSequence[0]?.name === "plan_task" &&
        Object.hasOwn(toolSequence[0].input, "control")
          ? toolSequence.shift()
          : undefined;
      const prompt = String(
        body.messages.findLast((entry: any) => entry.role === "user")
          ?.content ?? "",
      );
      if (!toolSequence.length && !requestedTool && !scriptedControl) {
        const action = prompt.includes("读取版本")
          ? "read_records"
          : prompt.includes("发布")
            ? "request_publish"
            : prompt.includes("查询")
              ? "query_project"
              : "create_draft";
        requestedTool = {
          name: action,
          input:
            action === "read_records"
              ? { source: { kind: "version", id: publishedVersionId } }
              : action === "request_publish"
                ? { draftId }
                : action === "query_project"
                  ? { kind: "project" }
                  : { name: "助手创建的测试集", purpose: "合成测试" },
        };
      }
      const next = toolSequence[0] ?? requestedTool;
      const mode =
        next?.name === "plan_task" && next.input.executionMode === "plan"
          ? "plan"
          : [
                "query_project",
                "read_records",
                "read_background",
                "read_processing",
              ].includes(next?.name ?? "") || /查询|读取/u.test(prompt)
            ? "query"
            : "execute";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fixture-control",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "control_" + calls.length,
                    type: "function",
                    function: {
                      name: "plan_task",
                      arguments: JSON.stringify(
                        scriptedControl?.input ?? { control: { mode } },
                      ),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        }),
      );
      return;
    }
    if (
      textualToolCallAfterScopeError &&
      body.messages.at(-1)?.role === "tool" &&
      String(body.messages.at(-1)?.content).includes("processing_scope_invalid")
    ) {
      textualToolCallAfterScopeError = false;
      textualToolCall =
        '<tool_call><function=submit_processing><parameter=selection>{"method":"random","conditions":[],"mode":"count","value":2}</parameter></function></tool_call>';
    }
    if (textualReplies.length) textualToolCall = textualReplies.shift();
    if (textualToolCall !== undefined) {
      const content = textualToolCall;
      textualToolCall = undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "textual-tool-call",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
        }),
      );
      return;
    }
    let message: Record<string, unknown> = {
        role: "assistant",
        content: finalReply ?? "操作结果请查看下方真实回执。",
      },
      finish = "stop";
    const automatic =
      String(body.messages.at(-1)?.content ?? "").startsWith(
        "[processing_completed]",
      ) ||
      String(body.messages.at(-1)?.content ?? "").startsWith("[confirmed]");
    const inspectRun = body.tool_choice?.function?.name === "read_processing";
    const forcedDiscovery =
      body.tool_choice?.function?.name === "query_project";
    const checkpointRequested =
      backgroundCheckpoint && body.tool_choice?.function?.name === "plan_task";
    const scriptedTool = checkpointRequested
      ? {
          name: "plan_task",
          input: Array.isArray(backgroundCheckpoint)
            ? backgroundCheckpoint.shift()!
            : backgroundCheckpoint!,
        }
      : body.tool_choice === "none" || !body.tools?.length
        ? undefined
        : forcedDiscovery
          ? undefined
          : toolSequence.shift();
    if (checkpointRequested) {
      if (!Array.isArray(backgroundCheckpoint) || !backgroundCheckpoint.length)
        backgroundCheckpoint = undefined;
      toolSequence = [];
    }
    if (
      scriptedTool ||
      requestedTool ||
      forcedDiscovery ||
      inspectRun ||
      (repeatRead &&
        !(
          repeatRead === "bounded" &&
          (!body.tools?.length || body.tool_choice === "none")
        )) ||
      (body.messages.at(-1)?.role !== "tool" && !automatic)
    ) {
      const prompt = body.messages.findLast(
        (m: any) => m.role === "user",
      ).content;
      const action =
        (forcedDiscovery ? "query_project" : undefined) ??
        scriptedTool?.name ??
        (inspectRun
          ? "read_processing"
          : repeatRead
            ? "query_project"
            : requestedTool?.name) ??
        (prompt.includes("读取版本")
          ? "read_records"
          : prompt.includes("发布")
            ? "request_publish"
            : prompt.includes("查询")
              ? "query_project"
              : "create_draft");
      const args =
        (forcedDiscovery
          ? requestedTool?.name === "query_project"
            ? requestedTool.input
            : { kind: "project" }
          : undefined) ??
        scriptedTool?.input ??
        (inspectRun
          ? {
              runId: JSON.parse(
                body.messages
                  .findLast((m: any) =>
                    String(m.content).startsWith("当前持久事实："),
                  )
                  .content.split("：")
                  .slice(1)
                  .join("："),
              ).runId,
            }
          : repeatRead
            ? { kind: "project" }
            : requestedTool?.input) ??
        (action === "read_records"
          ? { source: { kind: "version", id: publishedVersionId } }
          : action === "request_publish"
            ? { draftId }
            : action === "query_project"
              ? { kind: "project" }
              : { name: "助手创建的测试集", purpose: "合成测试" });
      if (!forcedDiscovery || requestedTool?.name === "query_project")
        requestedTool = undefined;
      message = {
        role: "assistant",
        content:
          repeatRead === "progress"
            ? "继续统计，请稍候。"
            : (toolReply ?? null),
        tool_calls: [
          {
            id: `call_${calls.length}`,
            type: "function",
            function: {
              name: action,
              arguments: rawToolArguments.shift() ?? JSON.stringify(args),
            },
          },
        ],
      };
      finish = "tool_calls";
    }
    if (toolBatch && body.tool_choice !== "none") {
      message = {
        role: "assistant",
        content: null,
        tool_calls: toolBatch.map((item, index) => ({
          id: `batch_${calls.length}_${index}`,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.input) },
        })),
      };
      toolBatch = undefined;
      finish = "tool_calls";
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "synthetic",
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      }),
    );
  });
  beforeAll(async () => {
    const root = createPool(baseUrl);
    try {
      await root.query(`CREATE DATABASE ${name}`);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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
      email: "admin@example.test",
      password: "Assistant123",
      confirmPassword: "Assistant123",
      displayName: "管理员",
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
        payload: { name: "助手合同测试" },
      })
    ).json().project.id;
    const connection = await app.inject({
      method: "PUT",
      url: "/api/settings/model-connection",
      headers,
      payload: {
        revision: 0,
        name: "合成模型",
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: "synthetic",
        apiKey: "synthetic-test-key",
        enabled: true,
      },
    });
    expect(connection.statusCode, connection.body).toBe(200);
  });
  afterAll(async () => {
    release();
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
    const root = createPool(baseUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });
  const base = () => `/api/projects/${projectId}/assistant`;
  const read = () =>
    app.inject({
      method: "GET",
      url: `${base()}/sessions/${sessionId}`,
      headers,
    });
  async function send(
    message: string,
    context?: { kind: string; id: string },
    expectedStatus: "succeeded" | "failed" = "succeeded",
  ) {
    await expect
      .poll(
        async () => {
          const state = (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/assistant/sessions/${sessionId}`,
              headers,
            })
          ).json();
          return (
            state.turns?.some((turn: any) =>
              ["queued", "running"].includes(turn.status),
            ) ?? false
          );
        },
        { timeout: 15000 },
      )
      .toBe(false);
    const result = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${sessionId}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message, ...(context ? { context } : {}) },
    });
    expect(result.statusCode, result.body).toBe(202);
    await expect
      .poll(
        async () => {
          const r = await read();
          return r.json().turns?.find((t: any) => t.id === result.json().turnId)
            ?.status;
        },
        { timeout: 15000 },
      )
      .toBe(expectedStatus)
      .catch(async (error) => {
        const state = (await read()).json();
        throw new Error(
          JSON.stringify({
            message,
            task: state.task,
            turn: state.turns?.at(-1),
          }),
          { cause: error },
        );
      });
    return read();
  }
  it("uses real SDK tool calls and keeps one active turn and an idempotent created draft", async () => {
    const session = await app.inject({
      method: "POST",
      url: `${base()}/sessions`,
      headers,
      payload: {},
    });
    expect(session.statusCode, session.body).toBe(201);
    sessionId = session.json().sessionId;
    hold = true;
    const waiting = new Promise<void>((r) => (entered = r)),
      key = randomUUID(),
      payload = { message: "创建一个测试集草稿" };
    const request = {
      method: "POST" as const,
      url: `${base()}/sessions/${sessionId}/turns`,
      headers: { ...headers, "idempotency-key": key },
      payload,
    };
    const submitted = await app.inject(request);
    expect(submitted.statusCode, submitted.body).toBe(202);
    await waiting;
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().turnId).toBe(submitted.json().turnId);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...headers, "idempotency-key": randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ ...request, payload: { message: "changed" } }))
        .statusCode,
    ).toBe(409);
    release();
    await expect
      .poll(async () => (await read()).json().turns[0].status, {
        timeout: 15000,
      })
      .toBe("succeeded");
    const state = (await read()).json();
    const created = state.turns[0].tools.find(
      (t: any) => t.name === "create_draft" && t.status === "succeeded",
    );
    expect(created, JSON.stringify(state)).toBeTruthy();
    draftId = created.result.draftId;
    const drafts = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
    });
    expect(drafts.json().drafts).toHaveLength(1);
    expect(drafts.json().drafts[0].name).toBe("助手创建的测试集");
    expect(
      calls.some((body) =>
        body.tools?.some((t: any) => t.function.name === "create_draft"),
      ),
    ).toBe(true);
    expect(JSON.stringify(state)).not.toContain("synthetic-test-key");
  });
  it("requires a bound explicit confirmation, then publishes once and replays the receipt", async () => {
    const row = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
      headers,
      payload: { question: "Synthetic", expectedOutput: "", metadata: [] },
    });
    expect(row.statusCode, row.body).toBe(201);
    const state = (await send("请发布这个草稿")).json();
    const proposal = state.proposals.find((p: any) => p.action === "publish");
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe("pending");
    const db = createPool(databaseUrl);
    try {
      expect(
        Number(
          (await db.query("SELECT count(*) FROM test_set_version")).rows[0]
            .count,
        ),
      ).toBe(0);
    } finally {
      await db.end();
    }
    const url = `${base()}/proposals/${proposal.id}/confirm`;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { revision: 999 },
        })
      ).statusCode,
    ).toBe(422);
    const confirmed = await app.inject({
      method: "POST",
      url,
      headers,
      payload: {},
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    publishedVersionId = confirmed.json().receipt.version.id;
    publishedTestSetId = confirmed.json().receipt.testSet.id;
    const repeated = await app.inject({
      method: "POST",
      url,
      headers,
      payload: {},
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().receipt).toEqual(confirmed.json().receipt);
    await expect
      .poll(
        async () => {
          const current = (await read()).json();
          return (
            current.turns.some(
              (turn: any) =>
                turn.event === "confirmed" && turn.status === "succeeded",
            ) &&
            !current.turns.some((turn: any) =>
              ["queued", "running"].includes(turn.status),
            )
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    expect((await read()).json().task.stage).toBe("complete");
    const check = createPool(databaseUrl);
    try {
      expect(
        Number(
          (await check.query("SELECT count(*) FROM test_set_version")).rows[0]
            .count,
        ),
      ).toBe(1);
    } finally {
      await check.end();
    }
    const lost = createPool(databaseUrl);
    try {
      await lost.query(
        "UPDATE assistant_proposal SET status='executing',receipt=NULL,expires_at=now()-interval '1 hour',lease_until=now()-interval '1 minute' WHERE id=$1",
        [proposal.id],
      );
      const restored = (await read())
        .json()
        .proposals.find((p: any) => p.id === proposal.id);
      expect(restored.status).toBe("succeeded");
      expect((await read()).json().task.stage).toBe("complete");
      expect(restored.receipt.version.id).toBe(publishedVersionId);
      expect(
        (await app.inject({ method: "POST", url, headers, payload: {} })).json()
          .receipt.version.id,
      ).toBe(publishedVersionId);
    } finally {
      await lost.end();
    }
  });
  it("discovers published versions and the related draft before requesting publication", async () => {
    const derived = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {
        testSetId: publishedTestSetId,
        parentVersionId: publishedVersionId,
      },
    });
    expect(derived.statusCode, derived.body).toBe(201);
    const derivedId = derived.json().draft.id;
    const requestStart = calls.length;
    requestedTool = {
      name: "query_project",
      input: { kind: "versions", search: "助手创建的测试集" },
    };
    const versions = (await send("查询测试集版本")).json().turns.at(-1)
      .tools[0];
    expect(versions.status, JSON.stringify(versions)).toBe("succeeded");
    expect(versions.result.items).toContainEqual(
      expect.objectContaining({
        id: publishedVersionId,
        label: "v1",
        count: 1,
        test_set_id: publishedTestSetId,
      }),
    );
    requestedTool = {
      name: "query_project",
      input: { kind: "drafts", testSetId: publishedTestSetId },
    };
    const drafts = (await send("查询关联草稿")).json().turns.at(-1).tools[0];
    expect(drafts.status, JSON.stringify(drafts)).toBe("succeeded");
    expect(drafts.result.items).toEqual([
      expect.objectContaining({
        id: derivedId,
        test_set_id: publishedTestSetId,
        parent_version_id: publishedVersionId,
        parent_label: "v1",
      }),
    ]);
    requestedTool = {
      name: "query_project",
      input: { kind: "drafts", testSetId: "another-project-test-set" },
    };
    expect(
      (await send("查询其他测试集的草稿")).json().turns.at(-1).tools[0].result
        .items,
    ).toEqual([]);
    requestedTool = { name: "request_publish", input: { draftId: derivedId } };
    const state = (await send("请求发布关联草稿")).json();
    expect(state.task.stage).toBe("awaiting_confirmation");
    expect(state.proposals).toContainEqual(
      expect.objectContaining({
        action: "publish",
        status: "pending",
        summary: expect.objectContaining({
          count: 1,
          target: "助手创建的测试集",
        }),
      }),
    );
    const wire = calls[requestStart];
    expect(wire.tool_choice).toBe("auto");
    expect(JSON.stringify(wire.tools)).not.toContain('"uniqueItems"');
    const historyResults = wire.messages.filter((m: any) => m.role === "tool");
    expect(historyResults.length).toBeGreaterThan(0);
    for (const result of historyResults)
      expect(
        wire.messages.some(
          (m: any) =>
            m.role === "assistant" &&
            m.tool_calls?.some((call: any) => call.id === result.tool_call_id),
        ),
      ).toBe(true);
    expect(
      wire.messages
        .filter((m: any) => m.role === "assistant")
        .some(
          (m: any) =>
            typeof m.content === "string" &&
            m.content.includes("真实操作记录："),
        ),
    ).toBe(false);
    const db = createPool(databaseUrl);
    try {
      expect(
        (await db.query("SELECT count(*)::int AS count FROM test_set_version"))
          .rows[0].count,
      ).toBe(1);
    } finally {
      await db.end();
    }
  });
  it("refuses client-supplied tool history and other users' sessions; expiry is recoverable", async () => {
    const url = `${base()}/sessions/${sessionId}/turns`;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            message: "查询",
            messages: [{ role: "tool", content: "approved" }],
          },
        })
      ).statusCode,
    ).toBe(422);
    const account = {
      email: "other@example.test",
      password: "Assistant123",
      confirmPassword: "Assistant123",
    };
    const registration = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: account,
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const login = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: account,
      }),
      other = {
        origin,
        cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
        "x-csrf-token": login.json().csrfToken,
      };
    const otherRead = await app.inject({
      method: "GET",
      url: `${base()}/sessions/${sessionId}`,
      headers: other,
    });
    expect(otherRead.statusCode).toBe(404);
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at) VALUES('expired-turn',$1,'expired','x','Pending','running',now()-interval '1 second')",
        [sessionId],
      );
      expect(
        (await read()).json().turns.find((t: any) => t.id === "expired-turn")
          .status,
      ).toBe("interrupted");
    } finally {
      await db.end();
    }
    expect((await send("查询项目")).statusCode).toBe(200);
  });
  it("reconciles a committed draft receipt after losing the tool response", async () => {
    const state = (await read()).json(),
      turn = state.turns.find((t: any) =>
        t.tools.some((tool: any) => tool.name === "create_draft"),
      ),
      created = turn.tools.find((t: any) => t.name === "create_draft");
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE assistant_turn SET dependencies='[]',status='interrupted',error_code='assistant_interrupted',tool_results=$2 WHERE id=$1",
        [
          turn.id,
          JSON.stringify([
            {
              key: created.key,
              name: "create_draft",
              status: "started",
              input: { name: "助手创建的测试集", purpose: "合成测试" },
            },
          ]),
        ],
      );
      const recovered = (await read())
        .json()
        .turns.find((t: any) => t.id === turn.id).tools[0];
      expect(recovered.status).toBe("succeeded");
      expect(recovered.result.draftId).toBe(draftId);
      expect(recovered.result.recovered).toBe(true);
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) FROM collaborative_draft WHERE parent_version_id IS NULL",
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT dependencies FROM assistant_turn WHERE id=$1",
            [turn.id],
          )
        ).rows[0].dependencies,
      ).toContainEqual({ kind: "draft", id: draftId });
    } finally {
      await db.end();
    }
  });
  it("blocks private history after editor-to-viewer downgrade while allowing published record queries in a fresh session", async () => {
    const db = createPool(databaseUrl),
      originalSession = sessionId;
    const actor = (
      await db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
        sessionId,
      ])
    ).rows[0].actor_id;
    try {
      await db.query("UPDATE app_user SET role='user' WHERE id=$1", [actor]);
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(project_id,user_id) DO UPDATE SET role='viewer'",
        [projectId, actor],
      );
      const restricted = await read();
      expect(restricted.statusCode, restricted.body).toBe(200);
      expect(restricted.json().task).toBeNull();
      expect(
        restricted.json().turns.filter((turn: any) => turn.restricted).length,
      ).toBeGreaterThan(0);
      for (const turn of restricted
        .json()
        .turns.filter((turn: any) => turn.restricted)) {
        expect(turn.tools).toEqual([]);
        expect(turn.userText).toBe("");
      }
      expect(restricted.body).not.toContain("助手创建的测试集");
      const list = await app.inject({
        method: "GET",
        url: `${base()}/sessions`,
        headers,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(
        list.json().sessions.find((item: any) => item.id === originalSession),
      ).toMatchObject({ title: "历史内容受限", task: null });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: { message: "查询" },
          })
        ).statusCode,
      ).toBe(404);
      const fresh = await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      });
      expect(fresh.statusCode, fresh.body).toBe(201);
      sessionId = fresh.json().sessionId;
      const response = (await send("读取版本里的记录")).json();
      const tool = response.turns[0].tools.find(
        (t: any) => t.name === "read_records",
      );
      expect(tool.status, JSON.stringify(response)).toBe("succeeded");
      expect(tool.result.records[0].question).toBe("Synthetic");
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions`,
            headers,
          })
        )
          .json()
          .sessions.some((item: any) => item.id === sessionId),
      ).toBe(true);
    } finally {
      sessionId = originalSession;
      await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [actor]);
      await db.query(
        "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
        [projectId, actor],
      );
      await db.end();
    }
  });
  it("keeps unrelated conversations when deleting a draft, and erases sessions that referenced the deleted body", async () => {
    const dbase = `/api/projects/${projectId}/collaborative-drafts`,
      originalSession = sessionId;
    const unrelated = await app.inject({
      method: "POST",
      url: dbase,
      headers,
      payload: { name: "未引用草稿" },
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `${dbase}/${unrelated.json().draft.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect((await read()).json().turns[0].userText).toBeTruthy();
    const fresh = await app.inject({
      method: "POST",
      url: `${base()}/sessions`,
      headers,
      payload: {},
    });
    sessionId = fresh.json().sessionId;
    const state = (await send("创建一个新草稿用于删除验证")).json(),
      created = state.turns[0].tools.find(
        (t: any) => t.name === "create_draft",
      ).result;
    const removed = await app.inject({
      method: "DELETE",
      url: `${dbase}/${created.draftId}`,
      headers,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const deleted = (await read()).json();
    expect(deleted.turns[0]).toMatchObject({
      userText: "",
      assistantText: "",
      tools: [],
      errorCode: "assistant_context_deleted",
    });
    sessionId = originalSession;
    expect((await read()).json().turns[0].userText).toBeTruthy();
  });
  it("does not return captured history when deletion finishes during context assembly", async () => {
    const originalSession = sessionId;
    const fresh = await app.inject({
      method: "POST",
      url: `${base()}/sessions`,
      headers,
      payload: {},
    });
    sessionId = fresh.json().sessionId;
    requestedTool = {
      name: "create_draft",
      input: { name: "删除竞态验证草稿" },
    };
    const state = (await send("创建删除竞态验证草稿")).json();
    const created = state.turns[0].tools.find(
      (tool: any) => tool.name === "create_draft",
    ).result.draftId;
    const originalContext = contextModule.assistantContext;
    const spy = vi
      .spyOn(contextModule, "assistantContext")
      .mockImplementationOnce(async (...args) => {
        const deleted = await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/collaborative-drafts/${created}`,
          headers,
        });
        expect(deleted.statusCode, deleted.body).toBe(204);
        return originalContext(...args);
      });
    try {
      const response = await read();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("assistant_context_deleted");
      expect(response.body).not.toContain("创建删除竞态验证草稿");
    } finally {
      spy.mockRestore();
      sessionId = originalSession;
    }
  });
  it("reuses a session-created draft even when it is outside the twenty-object summary", async () => {
    const originalSession = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    let firstId = "";
    try {
      for (let index = 0; index < 21; index++) {
        requestedTool = {
          name: "create_draft",
          input: { name: `摘要边界草稿 ${index}` },
        };
        const state = (await send(`创建摘要边界草稿 ${index}`)).json();
        if (!index)
          firstId = state.turns[0].tools.find(
            (tool: any) => tool.name === "create_draft",
          ).result.draftId;
      }
      requestedTool = {
        name: "create_draft",
        input: { name: "摘要边界草稿 0" },
      };
      const state = (await send("继续摘要边界草稿 0")).json();
      expect(
        state.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "create_draft").result,
      ).toMatchObject({
        draftId: firstId,
        reused: true,
      });
    } finally {
      sessionId = originalSession;
    }
  }, 60000);
  it("distinguishes an empty namesake from the current draft after conflicting tool history", async () => {
    const previousSession = sessionId;
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      async function create(createAnother = false) {
        requestedTool = {
          name: "create_draft",
          input: { name: "同名当前草稿", createAnother },
        };
        const response = (await send("按明确要求创建草稿")).json().turns.at(-1);
        return response.tools[0].result.draftId as string;
      }
      const currentDraft = await create();
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collaborative-drafts/${currentDraft}/records`,
            headers,
            payload: {
              question: "如何修改昵称？",
              expectedOutput: "修改昵称",
              metadata: [],
            },
          })
        ).statusCode,
      ).toBe(201);
      const emptyNamesake = await create(true);
      expect(emptyNamesake).not.toBe(currentDraft);
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: emptyNamesake } },
      };
      const requestStart = calls.length;
      const selectedTool = (
        await send("继续处理当前草稿中的数据", {
          kind: "draft",
          id: currentDraft,
        })
      )
        .json()
        .turns.at(-1).tools[0];
      expect(selectedTool.status, JSON.stringify(selectedTool)).toBe(
        "succeeded",
      );
      const result = selectedTool.result;
      const wire = calls[requestStart].messages;
      expect(wire.at(-2).content).toContain("当前业务上下文：\n");
      const current = JSON.parse(
        wire.at(-2).content.split("当前业务上下文：\n")[1],
      );
      expect(current.pageObject).toMatchObject({
        name: "同名当前草稿",
        recordCount: 1,
        ref: current.focusDraft,
      });
      expect(result).toMatchObject({
        source: { kind: "draft", id: emptyNamesake },
        total: 0,
        isCurrentObject: false,
        currentObject: current.pageObject,
      });
      expect(result.currentObject.ref).not.toBe(
        current.drafts.find((draft: any) => draft.recordCount === 0).ref,
      );
      const preserved = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${currentDraft}`,
        headers,
      });
      expect(preserved.statusCode, preserved.body).toBe(200);
      expect(preserved.json().total).toBe(1);
    } finally {
      sessionId = previousSession;
    }
  });

  it("binds the current page to the authorized turn without trusting client history or shifting session numbers", async () => {
    const originalSession = sessionId;
    try {
      const draft = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "当前页面草稿" },
        })
      ).json().draft;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const sessionsBefore = (
        await app.inject({ method: "GET", url: `${base()}/sessions`, headers })
      ).json().sessions;
      const ordinal = sessionsBefore.find(
        (s: any) => s.id === sessionId,
      ).ordinal;
      expect(ordinal).toBeGreaterThan(0);
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: draft.id } },
      };
      const start = calls.length;
      const reply = await send("读取这个草稿", { kind: "draft", id: draft.id });
      expect(reply.statusCode, reply.body).toBe(200);
      const current = JSON.parse(
        calls[start].messages
          .find((m: any) => String(m.content).includes("当前业务上下文：\n"))
          .content.split("当前业务上下文：\n")[1],
      );
      expect(current.pageObject).toMatchObject({
        kind: "draft",
        name: draft.name,
        recordCount: 0,
      });
      expect(current.focusDraft).toBe(current.pageObject.ref);
      requestedTool = {
        name: "query_project",
        input: { kind: "drafts", search: "当前页面草稿" },
      };
      expect(
        (await send("查询当前草稿数量"))
          .json()
          .turns.at(-1)
          .tools.find((tool: any) => tool.name === "query_project").result
          .items[0].recordCount,
      ).toBe(0);
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: current.pageObject.ref } },
      };
      expect(
        (await send("继续读取当前记录"))
          .json()
          .turns.at(-1)
          .tools.find((tool: any) => tool.name === "read_records"),
      ).toMatchObject({ status: "succeeded", result: { total: 0 } });
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: "d:unknown" } },
      };
      expect(
        (await send("未知引用应可恢复", undefined, "failed"))
          .json()
          .turns.at(-1)
          .tools.find((tool: any) => tool.name === "read_records").error.code,
      ).toBe("assistant_reference_invalid");
      const sessionsAfter = (
        await app.inject({ method: "GET", url: `${base()}/sessions`, headers })
      ).json().sessions;
      expect(sessionsAfter.find((s: any) => s.id === sessionId).ordinal).toBe(
        ordinal,
      );
      const beforeDenied = calls.length;
      const denied = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "读取不存在的对象",
          context: { kind: "draft", id: "another-project-draft" },
        },
      });
      expect(denied.statusCode).toBe(409);
      expect(calls.length).toBe(beforeDenied);
      const boundRequest = {
        method: "POST" as const,
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "读取绑定页面",
          context: { kind: "draft", id: draft.id },
        },
      };
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: draft.id } },
      };
      const bound = await app.inject(boundRequest);
      expect(bound.statusCode).toBe(202);
      expect((await app.inject(boundRequest)).json().turnId).toBe(
        bound.json().turnId,
      );
      expect(
        (
          await app.inject({
            ...boundRequest,
            payload: {
              ...boundRequest.payload,
              context: { kind: "version", id: publishedVersionId },
            },
          })
        ).statusCode,
      ).toBe(409);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.find((t: any) => t.id === bound.json().turnId)?.status,
        )
        .toBe("succeeded");
      const beforeInvalid = calls.length;
      const invalid = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "客户端不能覆盖操作者",
          context: { kind: "draft", id: draft.id, actorId: "other" },
        },
      });
      expect(invalid.statusCode).toBe(422);
      expect(calls.length).toBe(beforeInvalid);
    } finally {
      sessionId = originalSession;
    }
  });
  it("runs processing and selection tools against real domain services, with expiry and revision-bound confirmation", async () => {
    const db = createPool(databaseUrl),
      originalSession = sessionId;
    async function invoke(name: string, input: Record<string, unknown>) {
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 15000 },
        )
        .toBe(false);
      if (
        ![
          "query_project",
          "read_records",
          "read_processing",
          "plan_task",
        ].includes(name)
      ) {
        requestedTool = undefined;
        toolSequence = [
          { name: "plan_task", input: { nextAction: name } },
          { name, input },
        ];
      } else requestedTool = { name, input };
      const state = (await send(`执行已明确范围的 ${name}`)).json();
      const tool = state.turns.at(-1).tools.find((t: any) => t.name === name);
      expect(tool.status, JSON.stringify(tool)).toBe("succeeded");
      return tool.result;
    }
    const confirm = (id: string) =>
      app.inject({
        method: "POST",
        url: `${base()}/proposals/${id}/confirm`,
        headers,
        payload: {},
      });
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const beforeInvalid = (
        await db.query("SELECT count(*)::int AS count FROM processing_run")
      ).rows[0].count;
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "assets" } },
      };
      const missingSource = (await send("读取资料但缺少来源引用"))
        .json()
        .turns.at(-1);
      expect(missingSource.tools[0].error.code).toBe(
        "assistant_tool_input_invalid",
      );
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "version", id: publishedVersionId },
          allRecords: true,
          operation: "clean",
          instructions: "",
          allowedFields: ["question", "question"],
        },
      };
      const duplicateFields = (await send("重复字段应拒绝"))
        .json()
        .turns.at(-1);
      expect(duplicateFields.tools).toMatchObject([
        {
          name: "submit_processing",
          input: {},
          status: "failed",
          error: { code: "assistant_tool_input_invalid" },
        },
      ]);
      expect(
        (await db.query("SELECT count(*)::int AS count FROM processing_run"))
          .rows[0].count,
      ).toBe(beforeInvalid);
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "version", id: publishedVersionId },
          allRecords: true,
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
          outputCount: 2,
        },
      };
      expect(
        (await send("清洗不能增加条数", undefined, "failed"))
          .json()
          .turns.at(-1).tools[0].error.code,
      ).toBe("processing_configuration_invalid");
      expect(
        (await db.query("SELECT count(*)::int AS count FROM processing_run"))
          .rows[0].count,
      ).toBe(beforeInvalid);
      const submitted = await invoke("submit_processing", {
        source: { kind: "version", id: publishedVersionId },
        allRecords: true,
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
        outputCount: 1,
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-runs/${submitted.runId}`,
            headers,
          })
        ).json().run.options.outputCount,
      ).toBeUndefined();
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='assistant-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [submitted.runId],
        )
      ).rows[0];
      const config = { ...loadConfig(), databaseUrl };
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some(
                (t: any) =>
                  t.event === "processing_completed" &&
                  t.status === "succeeded",
              ),
          { timeout: 6000 },
        )
        .toBe(true);
      const output = await invoke("read_processing", {
        runId: submitted.runId,
      });
      expect(output.records[0].question).toBe("Synthetic");
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        {
          name: "request_processing_apply",
          input: {
            runId: submitted.runId,
            allValid: true,
            target: { kind: "newDraft" },
          },
        },
      ];
      const invalid = (
        await send("将结果加入新草稿", undefined, "failed")
      ).json();
      expect(
        invalid.turns
          .at(-1)
          .tools.find((t: any) => t.name === "request_processing_apply").status,
      ).toBe("failed");
      expect(invalid.proposals).toHaveLength(0);
      await invoke("request_processing_apply", {
        runId: submitted.runId,
        allValid: true,
        target: { kind: "asset" },
      });
      let proposal = (await read())
        .json()
        .proposals.find((p: any) => p.action === "processing");
      const accepted = await confirm(proposal.id);
      expect(accepted.statusCode, accepted.body).toBe(200);
      const assetId = accepted.json().receipt.receipt.assetId;
      expect((await confirm(proposal.id)).json().receipt).toEqual(
        accepted.json().receipt,
      );
      await db.query(
        "UPDATE assistant_proposal SET status='executing',receipt=NULL,expires_at=now()-interval '1 hour',lease_until=now()-interval '1 minute' WHERE id=$1",
        [proposal.id],
      );
      const recovered = (await read())
        .json()
        .proposals.find((p: any) => p.id === proposal.id);
      expect(recovered.status).toBe("succeeded");
      expect(recovered.receipt.receipt.assetId).toBe(assetId);
      const oldPage = await invoke("create_draft", { name: "旧页面焦点草稿" });
      requestedTool = { name: "query_project", input: { kind: "drafts" } };
      await send("读取当前草稿", { kind: "draft", id: oldPage.draftId });
      const target = await invoke("create_draft", { name: "助手筛选草稿" });
      const preview = await invoke("preview_selection", {
        draftId: target.draftId,
        assetIds: [assetId],
        method: "all",
        conditions: [],
      });
      expect(preview.selectedCount).toBe(1);
      await invoke("request_selection_apply", {
        draftId: target.draftId,
        previewId: preview.previewId,
      });
      proposal = (await read())
        .json()
        .proposals.find((p: any) => p.action === "selection");
      await db.query(
        "UPDATE assistant_proposal SET expires_at=now()-interval '1 second' WHERE id=$1",
        [proposal.id],
      );
      expect((await confirm(proposal.id)).statusCode).toBe(409);
      await db.query(
        "UPDATE assistant_proposal SET expires_at=now()+interval '1 minute' WHERE id=$1",
        [proposal.id],
      );
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) FROM collaborative_draft_record WHERE draft_id=$1",
              [target.draftId],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
      const applied = await confirm(proposal.id);
      expect(applied.statusCode, applied.body).toBe(200);
      const requestStart = calls.length;
      await invoke("read_records", {
        source: { kind: "draft", id: target.draftId },
      });
      const contextMessage = calls[requestStart].messages.find((m: any) =>
        String(m.content).includes("当前业务上下文：\n"),
      );
      expect(
        contextMessage,
        "confirmed selection must be visible in the next model turn",
      ).toBeTruthy();
      const current = JSON.parse(
        contextMessage.content.split("当前业务上下文：\n")[1],
      );
      const active = current.drafts.find((d: any) => d.name === "助手筛选草稿");
      expect(active).toMatchObject({ recordCount: 1, revision: 1 });
      expect(current.focusDraft).toEqual(active.ref);
      expect(current.confirmedOperations).toContainEqual(
        expect.objectContaining({
          action: "selection",
          status: "succeeded",
          added: 1,
          draftRef: active.ref,
        }),
      );
      const beforeReuse = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
        })
      ).json().drafts.length;
      const reused = await invoke("create_draft", { name: "助手筛选草稿" });
      expect(reused).toMatchObject({ draftId: target.draftId, reused: true });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/collaborative-drafts`,
            headers,
          })
        ).json().drafts,
      ).toHaveLength(beforeReuse);
      await invoke("request_publish", { draftId: target.draftId });
      proposal = (await read())
        .json()
        .proposals.find((p: any) => p.action === "publish");
      const added = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${target.draftId}/records`,
        headers,
        payload: {
          question: "Other editor changed this draft",
          expectedOutput: "",
          metadata: [],
        },
      });
      expect(added.statusCode).toBe(201);
      const conflict = await confirm(proposal.id);
      expect(conflict.statusCode, conflict.body).toBe(409);
      const actual = (
        await db.query("SELECT revision FROM collaborative_draft WHERE id=$1", [
          target.draftId,
        ])
      ).rows[0];
      const publishedElsewhere = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${target.draftId}/publish`,
        headers,
        payload: { revision: Number(actual.revision) },
      });
      expect(publishedElsewhere.statusCode, publishedElsewhere.body).toBe(201);
      expect(
        (await read()).json().proposals.find((p: any) => p.id === proposal.id)
          .status,
      ).toBe("pending");
      expect((await confirm(proposal.id)).statusCode).toBe(409);
      // A conversation that only saw a test-set name also loses that body on permanent deletion.
      await db.query(
        "UPDATE assistant_turn SET dependencies=$2 WHERE session_id=$1",
        [
          sessionId,
          JSON.stringify([
            {
              kind: "testSet",
              id: (
                await db.query(
                  "SELECT test_set_id FROM test_set_version WHERE id=$1",
                  [publishedVersionId],
                )
              ).rows[0].test_set_id,
            },
          ]),
        ],
      );
      await db.query(
        "UPDATE test_set SET status='permanently_deleted' WHERE id=(SELECT test_set_id FROM test_set_version WHERE id=$1)",
        [publishedVersionId],
      );
      expect(
        (await read())
          .json()
          .turns.every((t: any) => t.userText === "" && t.tools.length === 0),
      ).toBe(true);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = originalSession;
      await db.end();
    }
  });
  it("aggregates and filters all 100 records without model pagination", async () => {
    const previous = sessionId;
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "全文件查询" },
      })
    ).json().draft.id;
    for (let i = 1; i <= 100; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
            headers,
            payload: {
              question: `问题${i}`,
              expectedOutput: i <= 5 ? "指数分析" : "指数对比",
              metadata: [{ key: "用途", value: "查询" }],
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
    try {
      requestedTool = {
        name: "read_records",
        input: {
          source: { kind: "draft", id: draft },
          groupBy: "expectedOutput",
        },
      };
      const stats = (await send("统计全部100条的类别数量")).json().turns.at(-1)
        .tools[0];
      expect(stats.status, JSON.stringify(stats)).toBe("succeeded");
      expect(stats.result.total).toBe(100);
      expect(stats.result.distribution).toEqual([
        { label: "指数分析", count: 5 },
        { label: "指数对比", count: 95 },
      ]);
      requestedTool = {
        name: "read_records",
        input: {
          source: { kind: "draft", id: draft },
          conditions: [
            { field: "expectedOutput", operator: "equals", value: "指数对比" },
          ],
          limit: 3,
        },
      };
      const filtered = (await send("仅查询指数对比的总数与前三条"))
        .json()
        .turns.at(-1).tools[0];
      expect(filtered.status, JSON.stringify(filtered)).toBe("succeeded");
      expect(filtered.result).toMatchObject({
        total: 100,
        matchingTotal: 95,
        nextOffset: 3,
      });
      expect(filtered.result.records.map((r: any) => r.question)).toEqual([
        "问题6",
        "问题7",
        "问题8",
      ]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/collaborative-drafts/${draft}?limit=100`,
            headers,
          })
        ).json().total,
      ).toBe(100);
    } finally {
      sessionId = previous;
    }
  });
  it.each([false, true])(
    "rejects impossible complete quotas before saving and corrects them in the same turn (outside zero quota: %s)",
    async (outsideZeroQuota) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const firstCall = calls.length;
        const plan = {
          title: "200条选题方案",
          requirements: ["风险与正常题合计200条", "先给方案，不执行"],
          targetCount: 200,
          executionMode: "plan",
          steps: [{ title: "分类后选取200条", action: "submit_processing" }],
          nextAction: "none",
        };
        toolSequence = [10, 45].map((normalCount) => ({
          name: "plan_task",
          input: {
            ...plan,
            classifications: [
              {
                field: "metadata",
                key: "类别",
                allowedValues: ["风险", "正常"],
                quotas: [
                  { value: "风险", count: 155 },
                  { value: "正常", count: normalCount },
                  ...(outsideZeroQuota ? [{ value: "范围外", count: 0 }] : []),
                ],
              },
            ],
          },
        }));
        const state = (await send("请设计合计200条的方案，先不执行")).json();
        const receipts = state.turns.at(-1).tools;
        expect(receipts.map((receipt: any) => receipt.status)).toEqual([
          "failed",
          "succeeded",
        ]);
        expect(receipts[0].error.code).toBe("assistant_plan_count_conflict");
        const feedback = calls
          .slice(firstCall)
          .flatMap((call) => call.messages)
          .find(
            (message: any) =>
              message.role === "tool" &&
              message.content.includes("assistant_plan_count_conflict"),
          );
        expect(JSON.parse(feedback.content).error.hint).toContain(
          "当前目标200条，配额合计165条，还差35条",
        );
        expect(JSON.parse(feedback.content).error.hint).toContain(
          '"正常"从10改为45条，其余配额不变，合计200条',
        );
        expect(JSON.parse(feedback.content).error.hint).toContain(
          "用户未固定该类别",
        );
        expect(state.task.classifications[0].quotas).toEqual([
          { value: "风险", count: 155 },
          { value: "正常", count: 45 },
          ...(outsideZeroQuota ? [{ value: "范围外", count: 0 }] : []),
        ]);
        expect(state.task.stage).toBe("planning");
        expect(state.task.runId).toBeUndefined();
        expect(state.proposals).toEqual([]);
      } finally {
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it.each([
    [
      "split field",
      [
        {
          field: "metadata",
          key: "类别",
          allowedValues: ["风险", "正常"],
          quotas: [{ value: "风险", count: 155 }],
        },
        {
          field: "metadata",
          key: "类别",
          allowedValues: ["风险", "正常"],
          quotas: [{ value: "正常", count: 10 }],
        },
      ],
    ],
    [
      "duplicate category",
      [
        {
          field: "metadata",
          key: "类别",
          allowedValues: ["风险", "正常"],
          quotas: [
            { value: "风险", count: 100 },
            { value: "风险", count: 100 },
            { value: "正常", count: 0 },
          ],
        },
      ],
    ],
    [
      "conflicting category",
      [
        {
          field: "metadata",
          key: "类别",
          allowedValues: ["风险", "正常"],
          quotas: [
            { value: "风险", count: 155 },
            { value: "风险", count: 45 },
            { value: "正常", count: 0 },
          ],
        },
      ],
    ],
    [
      "no positive single-category repair",
      [
        {
          field: "metadata",
          key: "类别",
          allowedValues: ["风险", "正常"],
          quotas: [
            { value: "风险", count: 220 },
            { value: "正常", count: 230 },
          ],
        },
      ],
    ],
  ])(
    "rejects impossible unique field quotas: %s",
    async (_label, classifications) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const firstCall = calls.length;
        const plan = {
          title: "选题方案",
          requirements: ["合计200条，先不执行"],
          targetCount: 200,
          executionMode: "plan",
          steps: [{ title: "分类后选题", action: "submit_processing" }],
          nextAction: "none",
        };
        const corrected = [
          {
            field: "metadata",
            key: "类别",
            allowedValues: ["风险", "正常"],
            quotas: [{ value: "风险", count: 155 }],
          },
          {
            field: "metadata",
            key: "类别",
            allowedValues: ["风险", "正常"],
            quotas: [{ value: "正常", count: 45 }],
          },
          {
            field: "metadata",
            key: "类别",
            quotas: [{ value: "风险", count: 155 }],
          },
          {
            field: "metadata",
            key: "难度",
            allowedValues: ["简单", "困难"],
            quotas: [
              { value: "简单", count: 200 },
              { value: "困难", count: 0 },
            ],
          },
        ];
        toolSequence = [
          { name: "plan_task", input: { ...plan, classifications } },
          { name: "plan_task", input: { ...plan, classifications: corrected } },
        ];
        const state = (await send("设计合计200条的方案，先不执行")).json();
        expect(
          state.turns.at(-1).tools.map((receipt: any) => receipt.status),
        ).toEqual(["failed", "succeeded"]);
        expect(state.turns.at(-1).tools[0].error.code).toBe(
          "assistant_plan_count_conflict",
        );
        if (_label === "no positive single-category repair") {
          const feedback = calls
            .slice(firstCall)
            .flatMap((call) => call.messages)
            .find(
              (message: any) =>
                message.role === "tool" &&
                message.content.includes("assistant_plan_count_conflict"),
            );
          expect(JSON.parse(feedback.content).error.hint).toContain(
            "当前目标200条，配额合计450条，超出250条",
          );
          expect(JSON.parse(feedback.content).error.hint).not.toContain(
            "纠正示例",
          );
        }
        expect(state.task.classifications).toEqual([
          {
            field: "metadata",
            key: "类别",
            allowedValues: ["风险", "正常"],
            quotas: [
              { value: "风险", count: 155 },
              { value: "正常", count: 45 },
            ],
          },
          corrected[3],
        ]);
        expect(state.task.runId).toBeUndefined();
      } finally {
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it("validates inherited quotas while allowing partial quotas and an explicitly unbounded count", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const common = {
        title: "选题方案",
        requirements: ["先给方案，不执行"],
        executionMode: "plan",
        steps: [{ title: "分类后选题", action: "submit_processing" }],
        nextAction: "none",
      };
      const rule = {
        field: "metadata",
        key: "类别",
        allowedValues: ["风险", "正常"],
        quotas: [
          { value: "风险", count: 155 },
          { value: "正常", count: 45 },
        ],
      };
      requestedTool = {
        name: "plan_task",
        input: { ...common, targetCount: 200, classifications: [rule] },
      };
      await send("先设计200条方案");
      const firstCorrectionCall = calls.length;
      requestedTool = {
        name: "plan_task",
        input: { ...common, targetCount: 100 },
      };
      const rejected = (
        await send("改成100条，尚未调整配额", undefined, "failed")
      ).json();
      expect(rejected.turns.at(-1).tools[0].error.code).toBe(
        "assistant_plan_count_conflict",
      );
      const correctionFeedback = calls
        .slice(firstCorrectionCall)
        .flatMap((call) => call.messages)
        .find(
          (message: any) =>
            message.role === "tool" &&
            message.content.includes("assistant_plan_count_conflict"),
        );
      expect(JSON.parse(correctionFeedback.content).error.hint).toContain(
        "省略保持原规则",
      );
      expect(JSON.parse(correctionFeedback.content).error.hint).toContain(
        "用plan_task仅纠正冲突字段",
      );
      expect(rejected.task.targetCount).toBe(200);
      expect(rejected.task.classifications).toEqual([rule]);
      requestedTool = {
        name: "plan_task",
        input: {
          ...common,
          classifications: [
            { ...rule, quotas: [{ value: "风险", count: 155 }] },
          ],
        },
      };
      const partial = (
        await send("保持200条，只固定风险155条，其余不限")
      ).json();
      expect(partial.task.targetCount).toBe(200);
      expect(partial.task.classifications[0].quotas).toEqual([
        { value: "风险", count: 155 },
      ]);
      requestedTool = {
        name: "plan_task",
        input: {
          ...common,
          targetCount: null,
          classifications: [
            {
              ...rule,
              quotas: [
                { value: "风险", count: 155 },
                { value: "正常", count: 10 },
              ],
            },
          ],
        },
      };
      const unbounded = (
        await send("取消总数要求，改为风险155条、正常10条")
      ).json();
      expect(unbounded.task.targetCount).toBeNull();
      expect(unbounded.task.classifications[0].quotas).toEqual([
        { value: "风险", count: 155 },
        { value: "正常", count: 10 },
      ]);
      expect(unbounded.task.stage).toBe("planning");
      expect(unbounded.task.runId).toBeUndefined();
    } finally {
      sessionId = previous;
    }
  });
  it.each(["plan", "execute"])(
    "pauses a legacy conflicting quota plan without accepting or executing unconfirmed parameters (%s)",
    async (executionMode) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const plan = {
          title: "200条方案",
          requirements: ["合计200条，先给方案不执行"],
          targetCount: 200,
          executionMode: "plan",
          steps: [{ title: "分类后选题", action: "submit_processing" }],
          nextAction: "none",
        };
        const rule = {
          field: "metadata",
          key: "类别",
          allowedValues: ["风险", "正常"],
          quotas: [
            { value: "风险", count: 155 },
            { value: "正常", count: 45 },
          ],
        };
        requestedTool = {
          name: "plan_task",
          input: { ...plan, classifications: [rule] },
        };
        const initial = (await send("先设计200条方案")).json();
        const legacyRule = {
          ...rule,
          quotas: [
            { value: "风险", count: 155 },
            { value: "正常", count: 10 },
          ],
        };
        const legacyPlan = {
          ...initial.task.executionPlan,
          mode: executionMode,
        };
        // This persisted fixture represents a plan accepted before quota validation.
        const db = createPool(databaseUrl);
        try {
          await db.query(
            "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
            [
              sessionId,
              JSON.stringify({
                classifications: [legacyRule],
                executionPlan: legacyPlan,
              }),
            ],
          );
        } finally {
          await db.end();
        }
        const question =
          "原配额合计165条，是否保留风险155条并将正常题改为45条？";
        requestedTool = {
          name: "plan_task",
          input: {
            title: plan.title,
            requirements: plan.requirements,
            question,
            nextAction: "none",
            targetCount: 100,
            executionMode: "execute",
            steps: [{ title: "尚未确认的发布步骤", action: "request_publish" }],
          },
        };
        const paused = (await send("核对配额，先向我确认调整方式")).json();
        expect(paused.task.stage).toBe("waiting_input");
        expect(paused.task.question).toBe(question);
        expect(paused.task.targetCount).toBe(200);
        expect(paused.task.classifications).toEqual([legacyRule]);
        expect(paused.task.executionPlan).toMatchObject({
          ...legacyPlan,
          needsReview: true,
        });
        expect(paused.task.nextAction).toBeNull();
        expect(paused.task).not.toHaveProperty("planValidationRequired");
        expect(paused.task.runId).toBeUndefined();
        expect(paused.proposals).toEqual([]);
        const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
        const sourceResponse = await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "澄清后分类来源" },
        });
        expect(sourceResponse.statusCode).toBe(201);
        const source = sourceResponse.json().draft.id;
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${draftsPath}/${source}/records`,
              headers,
              payload: {
                question: "原题",
                expectedOutput: "原标签",
                metadata: [],
              },
            })
          ).statusCode,
        ).toBe(201);
        const submission = {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            allRecords: true,
            operation: "rewrite",
            instructions: "保留原题，新增类别",
            allowedFields: ["metadata"],
            metadataKeys: ["类别"],
          },
        };
        if (executionMode === "execute") {
          requestedTool = submission;
          const bypass = (
            await send("正常题调整到45条，开始执行", undefined, "failed")
          ).json();
          expect(
            bypass.turns
              .at(-1)
              .tools.find((tool: any) => tool.name === "submit_processing"),
          ).toMatchObject({
            status: "failed",
            error: { code: "assistant_plan_count_conflict" },
          });
          expect(
            bypass.turns
              .at(-1)
              .tools.every((tool: any) => tool.status === "failed"),
          ).toBe(true);
          expect(bypass.task.runId).toBeUndefined();
          expect(bypass.proposals).toEqual([]);
        }
        requestedTool = {
          name: "plan_task",
          input: { ...plan, classifications: [rule] },
        };
        const corrected = (await send("可以，仍保持200条，先不执行")).json();
        expect(corrected.task.stage).toBe("planning");
        expect(corrected.task.question).toBeNull();
        expect(corrected.task.targetCount).toBe(200);
        expect(corrected.task.classifications).toEqual([rule]);
        expect(corrected.task.runId).toBeUndefined();
        if (executionMode === "execute") {
          toolSequence = [
            {
              name: "plan_task",
              input: {
                ...plan,
                classifications: [rule],
                executionMode: "execute",
              },
            },
            submission,
          ];
          const executed = (await send("执行已校验方案")).json();
          expect(
            executed.turns
              .at(-1)
              .tools.find((tool: any) => tool.name === "submit_processing"),
          ).toMatchObject({ status: "succeeded" });
          expect(executed.task.runId).toEqual(expect.any(String));
        }
      } finally {
        sessionId = previous;
      }
    },
  );
  it("keeps independent field rules when only a Metadata requirement is replaced, and reviews the same effective rules", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const common = {
        title: "分类要求",
        requirements: ["保留原题与答案"],
        targetCount: 2,
        executionMode: "plan",
        steps: [{ title: "添加风险类别", action: "submit_processing" }],
      };
      const outputRule = { field: "expectedOutput", allowedValues: ["原标签"] };
      requestedTool = {
        name: "plan_task",
        input: {
          ...common,
          classifications: [
            outputRule,
            { field: "metadata", key: "风险", allowedValues: ["旧类别"] },
          ],
        },
      };
      await send("先设计2条，保留原题和答案，风险暂用旧类别");
      const riskRule = {
        field: "metadata",
        key: "风险",
        allowedValues: ["A.1.a", "A.2.a"],
      };
      requestedTool = {
        name: "plan_task",
        input: { ...common, classifications: [riskRule] },
      };
      const replaced = (
        await send("风险类别改为A.1.a和A.2.a，其他要求保持")
      ).json();
      expect(replaced.task.classifications).toEqual([outputRule, riskRule]);
      const refreshed = (await read()).json();
      expect(refreshed.task.classifications).toEqual([outputRule, riskRule]);
      expect(refreshed.task.requirementSummary).toContain(
        "期望输出：允许 原标签",
      );
      expect(refreshed.task.requirementSummary).toContain(
        "Metadata「风险」：允许 A.1.a、A.2.a",
      );
      expect(JSON.stringify(refreshed.task.requirementSummary)).not.toContain(
        "旧类别",
      );

      const path = `/api/projects/${projectId}/collaborative-drafts`;
      const source = (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { name: "独立字段来源" },
        })
      ).json().draft.id;
      for (const question of ["甲类问题", "乙类问题"])
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${path}/${source}/records`,
              headers,
              payload: { question, expectedOutput: "原标签", metadata: [] },
            })
          ).statusCode,
        ).toBe(201);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            ...common,
            executionMode: "execute",
            allowedFields: ["metadata"],
            metadataKeys: ["风险"],
          },
        },
        {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            allRecords: true,
            operation: "rewrite",
            instructions: "保留原题和答案，仅新增风险类别",
            allowedFields: ["metadata"],
            metadataKeys: ["风险"],
          },
        },
      ];
      const submitted = (await send("按这个方案执行")).json();
      expect(submitted.task.runId).toEqual(expect.any(String));
      const processingConfig = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const db = createPool(databaseUrl);
      try {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='assistant-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [submitted.task.runId],
          )
        ).rows[0];
        const completed = await runProcessing(
          db,
          new ArtifactRepository(processingConfig.minio),
          processingConfig,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [job.id, completed],
        );
      } finally {
        await db.end();
      }
      // The completion event inspects the result automatically. A second user turn
      // would race that event rather than exercise requirement propagation.
      await expect
        .poll(
          async () =>
            (await read()).json().task.review?.classifications?.length,
          { timeout: 15000 },
        )
        .toBe(2);
      const reviewed = (await read()).json();
      expect(reviewed.task.review.classifications).toMatchObject([
        { field: "expectedOutput", satisfied: true },
        { field: "metadata", key: "风险", satisfied: true },
      ]);
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it("rejects processing that contradicts protected fields and retains the last valid requirements", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const path = `/api/projects/${projectId}/collaborative-drafts`;
      const source = (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { name: "保护字段来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `${path}/${source}/records`,
        headers,
        payload: {
          question: "保留原题",
          expectedOutput: "原答案",
          metadata: [],
        },
      });
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "仅补类别",
            requirements: ["保留原题及答案"],
            targetCount: 1,
            allowedFields: ["metadata"],
            metadataKeys: ["风险"],
            classifications: [
              { field: "metadata", key: "风险", allowedValues: ["A"] },
            ],
            nextAction: "submit_processing",
          },
        },
        {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            allRecords: true,
            operation: "rewrite",
            instructions: "改写题目",
            allowedFields: ["question", "metadata"],
            metadataKeys: ["风险"],
          },
        },
      ];
      const state = (
        await send("只新增风险类别，保留原题及答案", undefined, "failed")
      ).json();
      const failed = state.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "submit_processing");
      expect(failed.error.code).toBe("assistant_requirement_conflict");
      expect(failed.error.hint).toContain("问题");
      expect(state.task.requirementProblem).toContain("问题");
      expect(state.task.runId).toBeUndefined();
      expect(state.task.allowedFields).toEqual(["metadata"]);
      expect((await read()).json().task.requirementProblem).toEqual(
        state.task.requirementProblem,
      );
      requestedTool = {
        name: "plan_task",
        input: {
          title: "更正类别",
          requirements: ["保留原题及答案"],
          classifications: [{ field: "metadata", key: "风险", clear: true }],
          nextAction: "none",
        },
      };
      const cleared = (await send("不再限制风险类别")).json();
      expect(cleared.task.classifications).toEqual([]);
      expect(cleared.task.allowedFields).toEqual(["metadata"]);
      expect(cleared.task.requirementProblem).toBeNull();
    } finally {
      sessionId = previous;
    }
  });
  it.each([false, true])(
    "reads legacy expected-output labels without rewriting old state (conflict: %s)",
    async (conflict) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const db = createPool(databaseUrl);
      try {
        const legacy = {
          title: "旧分类",
          goal: "保留原答案并分类",
          stage: "planning",
          requirements: ["原有要求"],
          allowedLabels: ["原答案"],
          classifications: [
            { field: "metadata", key: "风险", allowedValues: ["A", "B"] },
            ...(conflict
              ? [{ field: "expectedOutput", allowedValues: ["其他答案"] }]
              : []),
          ],
        };
        await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
          sessionId,
          legacy,
        ]);
        const before = (await read()).json();
        expect(before.task.requirementSummary).toContain(
          "期望输出：允许 原答案",
        );
        expect(before.task.requirementSummary).toContain(
          "Metadata「风险」：允许 A、B",
        );
        if (conflict)
          expect(before.task.requirementProblem).toContain("期望输出");
        else expect(before.task.requirementProblem).toBeNull();
        expect(
          (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task,
        ).toEqual(legacy);
        requestedTool = {
          name: "plan_task",
          input: {
            title: "更正类别",
            requirements: ["原有要求"],
            classifications: [
              { field: "metadata", key: "风险", allowedValues: ["C"] },
            ],
            nextAction: "none",
          },
        };
        const changed = (
          await send(
            "风险类别改为C，保留其他要求",
            undefined,
            conflict ? "failed" : "succeeded",
          )
        ).json();
        if (conflict) {
          expect(changed.task.requirementProblem).toContain("期望输出");
          expect(
            (
              await db.query("SELECT task FROM assistant_session WHERE id=$1", [
                sessionId,
              ])
            ).rows[0].task.allowedLabels,
          ).toEqual(["原答案"]);
        } else {
          expect(changed.task.classifications).toEqual([
            { field: "expectedOutput", allowedValues: ["原答案"] },
            { field: "metadata", key: "风险", allowedValues: ["C"] },
          ]);
          expect(changed.task.requirementSummary).not.toContain(
            "Metadata「风险」：允许 A、B",
          );
          requestedTool = {
            name: "plan_task",
            input: {
              title: "撤销答案规则",
              requirements: ["仅限制风险类别"],
              classifications: [{ field: "expectedOutput", clear: true }],
              targetCount: null,
              nextAction: "none",
            },
          };
          const cleared = (await send("取消答案类别及数量限制")).json();
          expect(cleared.task.classifications).toEqual([
            { field: "metadata", key: "风险", allowedValues: ["C"] },
          ]);
          expect(
            cleared.task.requirementSummary.some((line: string) =>
              line.startsWith("期望输出："),
            ),
          ).toBe(false);
        }
      } finally {
        await db.end();
        sessionId = previous;
      }
    },
  );
  it.each([
    { field: "expectedOutput", allowedValues: ["新答案"] },
    { field: "metadata", key: "风险", allowedValues: ["新类别"] },
  ])(
    "rejects a protected source value that cannot satisfy its rule ($field)",
    async (rule) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const path = `/api/projects/${projectId}/collaborative-drafts`;
        const source = (
          await app.inject({
            method: "POST",
            url: path,
            headers,
            payload: { name: "不相容的保护字段" },
          })
        ).json().draft.id;
        await app.inject({
          method: "POST",
          url: `${path}/${source}/records`,
          headers,
          payload: {
            question: "只改写问题",
            expectedOutput: "原答案",
            metadata: [{ key: "风险", value: "旧类别" }],
          },
        });
        toolSequence = [
          {
            name: "plan_task",
            input: {
              title: "保留字段",
              requirements: ["只改问题"],
              allowedFields: ["question"],
              classifications: [rule],
              nextAction: "submit_processing",
            },
          },
          {
            name: "submit_processing",
            input: {
              source: { kind: "draft", id: source },
              allRecords: true,
              operation: "rewrite",
              instructions: "只改问题",
              allowedFields: ["question"],
            },
          },
        ];
        const rejected = (
          await send("只改问题，其他字段必须保留", undefined, "failed")
        ).json();
        expect(
          rejected.turns
            .at(-1)
            .tools.find((tool: any) => tool.name === "submit_processing").error
            .code,
        ).toBe("assistant_requirement_conflict");
        expect(rejected.task.requirementProblem).toContain("来源值无法满足");
        expect(rejected.task.runId).toBeUndefined();
        const original = (
          await app.inject({ method: "GET", url: `${path}/${source}`, headers })
        ).json().records[0];
        expect(original.expectedOutput).toBe("原答案");
        expect(original.metadata).toEqual([{ key: "风险", value: "旧类别" }]);
      } finally {
        sessionId = previous;
      }
    },
  );
  it("restores a legacy asset-page task using its real source and rejects another asset", async () => {
    const previous = sessionId;
    const db = createPool(databaseUrl);
    try {
      const collectionId = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collections`,
          headers,
        })
      ).json().collections[0].id;
      const assets: string[] = [];
      for (let i = 0; i < 2; i++) {
        const upload = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/pending-uploads`,
          headers: {
            ...headers,
            "content-type": "text/csv",
            "x-file-name": `legacy-source-${i}.csv`,
          },
          payload: `question,answer\n真实问题${i},保留答案\n`,
        });
        expect(upload.statusCode, upload.body).toBe(201);
        const confirmed = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            collectionId,
            pendingUploadIds: [upload.json().pendingUpload.id],
            mode: "raw",
          },
        });
        expect(confirmed.statusCode, confirmed.body).toBe(201);
        const id = confirmed.json().assets[0].id;
        const path = `/api/projects/${projectId}/assets/${id}/mapping`;
        const raw = (
          await app.inject({ method: "GET", url: path, headers })
        ).json();
        const mapped = await app.inject({
          method: "PUT",
          url: path,
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
        });
        expect(mapped.statusCode, mapped.body).toBe(200);
        assets.push(id);
      }
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      requestedTool = {
        name: "plan_task",
        input: {
          title: "读取当前资料",
          requirements: ["完整读取当前资料"],
          executionMode: "plan",
          steps: [{ title: "读取资料", action: "read_records", scope: "all" }],
          nextAction: "none",
        },
      };
      const planned = (
        await send("先规划当前资料", { kind: "asset", id: assets[0] })
      ).json();
      expect(planned.task.executionPlan.steps[0].input.source).toEqual({
        kind: "assets",
        assetIds: [assets[0]],
      });
      const turn = planned.turns.at(-1);
      const revision = (
        await db.query("SELECT task_revision FROM assistant_turn WHERE id=$1", [
          turn.id,
        ])
      ).rows[0].task_revision;
      // Persist the historical format, then use the same public reclaim/retry boundary.
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            executionPlan: {
              mode: "execute",
              current: 0,
              steps: [
                {
                  title: "读取资料",
                  action: "read_records",
                  scope: "all",
                  status: "pending",
                  revision,
                },
              ],
            },
          }),
        ],
      );
      await db.query(
        "UPDATE assistant_turn SET status='running',execution_attempt=1,assistant_text='',tool_results='[]',expires_at=now()-interval '1 second' WHERE id=$1",
        [turn.id],
      );
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "assets", assetIds: [assets[1]] } },
      };
      await expect
        .poll(async () => (await read()).json().turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("failed");
      expect((await read()).json().task.executionPlan.current).toBe(0);
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "assets", assetIds: [assets[0]] } },
      };
      const retry = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/retry`,
        headers,
        payload: {},
      });
      expect(retry.statusCode, retry.body).toBe(200);
      await expect
        .poll(async () => (await read()).json().turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      const restored = (await read()).json();
      expect(restored.task.executionPlan.current).toBe(1);
      expect(restored.turns.at(-1).id).toBe(turn.id);
      expect(
        restored.turns
          .at(-1)
          .tools.findLast((item: any) => item.name === "read_records").result
          .records[0].question,
      ).toBe("真实问题0");
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  it("does not advance a planned source read using another object's successful receipt", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const path = `/api/projects/${projectId}/collaborative-drafts`;
      const sources = [];
      for (const name of ["计划资料甲", "其他资料乙"]) {
        const draft = (
          await app.inject({
            method: "POST",
            url: path,
            headers,
            payload: { name },
          })
        ).json().draft;
        await app.inject({
          method: "POST",
          url: `${path}/${draft.id}/records`,
          headers,
          payload: { question: name, expectedOutput: "保留", metadata: [] },
        });
        sources.push({ kind: "draft", id: draft.id });
      }
      const plan = {
        title: "查看资料甲",
        requirements: ["只查看资料甲"],
        target: sources[0],
        executionMode: "execute",
        steps: [{ title: "读取资料甲", action: "read_records" }],
      };
      toolSequence = [
        { name: "plan_task", input: plan },
        { name: "read_records", input: { source: sources[1] } },
      ];
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: { message: "只读取资料甲" },
          })
        ).statusCode,
      ).toBe(202);
      await expect
        .poll(async () => (await read()).json().turns.at(-1)?.status, {
          timeout: 15000,
        })
        .toMatch(/^(succeeded|failed)$/);
      const wrong = (await read()).json();
      expect(wrong.task.executionPlan.current).toBe(0);
      expect(wrong.task.executionPlan.steps[0].status).toBe("pending");
      expect(wrong.task.runId).toBeUndefined();
      toolSequence = [
        { name: "plan_task", input: plan },
        { name: "read_records", input: { source: sources[0] } },
      ];
      const correct = (await send("按资料甲继续读取")).json();
      expect(correct.task.executionPlan.current).toBe(1);
      expect(correct.task.executionPlan.steps[0].status).toBe("executed");
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it("invalidates completed step claims when requirements change while retaining the old read receipt", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const path = `/api/projects/${projectId}/collaborative-drafts`;
      const source = (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { name: "要求更正来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `${path}/${source}/records`,
        headers,
        payload: {
          question: "已有问题",
          expectedOutput: "已有答案",
          metadata: [],
        },
      });
      const plan = {
        title: "查看现有资料",
        requirements: ["只查看问题"],
        target: { kind: "draft", id: source },
        executionMode: "execute",
        steps: [{ title: "读取资料", action: "read_records" }],
      };
      toolSequence = [
        { name: "plan_task", input: plan },
        { name: "read_records", input: { source: plan.target } },
      ];
      const first = (await send("先看现有问题")).json();
      expect(first.task.executionPlan.current).toBe(1);
      requestedTool = {
        name: "plan_task",
        input: {
          ...plan,
          executionMode: "plan",
          requirements: ["改为按期望输出分类核对，先给方案"],
        },
      };
      const corrected = (await send("改为按期望输出分类核对，先给方案")).json();
      expect(corrected.task.executionPlan.current).toBe(0);
      expect(corrected.task.executionPlan.steps[0].status).toBe("pending");
      expect(
        corrected.turns[0].tools.find(
          (tool: any) => tool.name === "read_records",
        ).status,
      ).toBe("succeeded");
      expect(corrected.task.stage).toBe("planning");
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it.each([
    { offset: 1 },
    {
      conditions: [{ field: "question", operator: "equals", value: "问题 0" }],
    },
  ])(
    "checks the full planned read range rather than completing a narrowed read ($offset)",
    async (narrowed) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const path = `/api/projects/${projectId}/collaborative-drafts`;
        const source = (
          await app.inject({
            method: "POST",
            url: path,
            headers,
            payload: { name: "全量范围核对" },
          })
        ).json().draft.id;
        for (let i = 0; i < 12; i++)
          await app.inject({
            method: "POST",
            url: `${path}/${source}/records`,
            headers,
            payload: {
              question: `问题 ${i}`,
              expectedOutput: "保留",
              metadata: [],
            },
          });
        const plan = {
          title: "完整统计资料",
          target: { kind: "draft", id: source },
          requirements: ["完整核对全部12条"],
          executionMode: "execute",
          steps: [
            { title: "完整核对资料", action: "read_records", scope: "all" },
          ],
        };
        toolSequence = [
          { name: "plan_task", input: plan },
          { name: "read_records", input: { source: plan.target, ...narrowed } },
        ];
        const incomplete = (
          await send("核对全部资料", undefined, "failed")
        ).json();
        expect(incomplete.task.executionPlan.current).toBe(0);
        toolSequence = [
          { name: "plan_task", input: plan },
          { name: "read_records", input: { source: plan.target } },
        ];
        const complete = (await send("继续完整核对")).json();
        expect(complete.task.executionPlan.current).toBe(1);
        const result = complete.turns
          .at(-1)
          .tools.find((item: any) => item.name === "read_records").result;
        expect(result).toMatchObject({
          readCount: 12,
          matchingTotal: 12,
          total: 12,
          offset: 0,
        });
        expect(result.records).toHaveLength(10);
      } finally {
        toolSequence = [];
        requestedTool = undefined;
        sessionId = previous;
      }
    },
  );
  it("normalizes inherited Metadata keys and displays the actual scope of a simple submission", async () => {
    const previous = sessionId;
    const db = createPool(databaseUrl);
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const sessions = [sessionId];
    try {
      const path = `/api/projects/${projectId}/collaborative-drafts`;
      const source = (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { name: "简单处理来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `${path}/${source}/records`,
        headers,
        payload: {
          question: "问题",
          expectedOutput: "原答案",
          metadata: [{ key: "risk", value: " x " }],
        },
      });
      requestedTool = {
        name: "plan_task",
        input: {
          title: "清洗字段",
          requirements: ["清洗risk"],
          allowedFields: ["metadata"],
          metadataKeys: [" risk ", "RISK"],
          nextAction: "none",
        },
      };
      const plan = (await send("只清洗risk字段，先不执行")).json();
      expect(plan.task.metadataKeys).toEqual(["risk"]);
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          operation: "clean",
          instructions: "清洗risk",
          allowedFields: ["metadata"],
        },
      };
      const submitted = (await send("执行清洗")).json();
      const runId = submitted.task.runId;
      expect(
        (
          await db.query("SELECT options FROM processing_run WHERE id=$1", [
            runId,
          ])
        ).rows[0].options.metadataKeys,
      ).toEqual(["risk"]);

      // A separate simple task does not need a synthetic multi-step plan.
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      sessions.push(sessionId);
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          operation: "augment",
          outputCount: 3,
          instructions: "扩写3个问题，保留答案",
          allowedFields: ["question"],
        },
      };
      const direct = (await send("扩写3条，保留答案")).json();
      expect(direct.task.requirementSummary).toContain("本次新增候选：3 条");
      expect(direct.task.requirementSummary).toContain("本次允许修改：问题");
      expect(direct.task.requirementSummary).toContain("扩写3个问题，保留答案");
      expect((await read()).json().task.requirementSummary).toEqual(
        direct.task.requirementSummary,
      );
      expect(direct.task.executionPlan).toBeUndefined();
      expect(direct.proposals).toEqual([]);
      requestedTool = {
        name: "plan_task",
        input: {
          title: "暂不扩写",
          targetCount: null,
          requirements: [],
          nextAction: "none",
        },
      };
      const withdrawn = (await send("撤销扩写要求，暂不执行")).json();
      expect(withdrawn.task.runId).toBe(direct.task.runId);
      expect(withdrawn.task.targetCount).toBeNull();
      expect(withdrawn.task.requirementSummary).not.toContain(
        "扩写3个问题，保留答案",
      );
      expect(withdrawn.task.requirementSummary).not.toContain(
        "本次新增候选：3 条",
      );
      expect((await read()).json().task.requirementSummary).toEqual(
        withdrawn.task.requirementSummary,
      );
    } finally {
      for (const id of sessions)
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${id}/stop`,
          headers,
          payload: {},
        });
      await db.end();
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it.each([
    {
      mode: "new",
      operation: "rewrite",
      outputCount: undefined,
      labels: ["A", "A", "B", "B"],
      quota: [{ value: "A", count: 1 }],
      expected: "failed",
      targetCount: 4,
      categories: ["A", "B"],
      sameTarget: false,
    },
    {
      mode: "final",
      operation: "augment",
      outputCount: 2,
      labels: ["A"],
      quota: [
        { value: "A", count: 2 },
        { value: "B", count: 2 },
      ],
      expected: "succeeded",
      targetCount: 4,
      categories: ["A", "B"],
      sameTarget: false,
    },
    {
      mode: "final",
      operation: "rewrite",
      outputCount: undefined,
      labels: ["A", "A", "B", "B"],
      quota: [
        { value: "A", count: 1 },
        { value: "B", count: 3 },
      ],
      expected: "failed",
      targetCount: 4,
      categories: ["A", "B"],
      sameTarget: true,
    },
    {
      mode: "final",
      operation: "augment",
      outputCount: 2,
      labels: ["A", "C", "D"],
      quota: [],
      expected: "failed",
      targetCount: 4,
      categories: ["A", "B", "C", "D"],
      sameTarget: false,
    },
  ])(
    "checks only the provable whole goal for protected quotas ($mode/$operation)",
    async (scenario) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const path = `/api/projects/${projectId}/collaborative-drafts`;
        const source = (
          await app.inject({
            method: "POST",
            url: path,
            headers,
            payload: { name: "配额来源" },
          })
        ).json().draft.id;
        for (const label of scenario.labels)
          await app.inject({
            method: "POST",
            url: `${path}/${source}/records`,
            headers,
            payload: {
              question: `问题${label}`,
              expectedOutput: label,
              metadata: [],
            },
          });
        const target = scenario.sameTarget
          ? source
          : (
              await app.inject({
                method: "POST",
                url: path,
                headers,
                payload: { name: "最终目标草稿" },
              })
            ).json().draft.id;
        for (const label of scenario.sameTarget ? [] : ["B", "B"])
          await app.inject({
            method: "POST",
            url: `${path}/${target}/records`,
            headers,
            payload: {
              question: `已有${label}`,
              expectedOutput: label,
              metadata: [],
            },
          });
        toolSequence = [
          {
            name: "plan_task",
            input: {
              title: "固定配额",
              requirements: ["保留答案"],
              targetCount: scenario.targetCount,
              countKind: scenario.mode,
              ...(scenario.mode === "final" ? { targetDraftId: target } : {}),
              allowedFields: ["question"],
              classifications: [
                {
                  field: "expectedOutput",
                  allowedValues: scenario.categories,
                  requiredValues: scenario.categories,
                  quotas: scenario.quota,
                },
              ],
              nextAction: "submit_processing",
            },
          },
          {
            name: "submit_processing",
            input: {
              source: { kind: "draft", id: source },
              allRecords: true,
              operation: scenario.operation,
              ...(scenario.outputCount
                ? { outputCount: scenario.outputCount }
                : {}),
              instructions: "保留答案，只改问题",
              allowedFields: ["question"],
            },
          },
        ];
        const state = (
          await send(
            "按目标处理，保留答案",
            undefined,
            scenario.expected as "succeeded" | "failed",
          )
        ).json();
        const submission = state.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "submit_processing");
        expect(submission.status).toBe(scenario.expected);
        if (scenario.expected === "failed") {
          expect(submission.error.code).toBe("assistant_requirement_conflict");
          expect(submission.error.hint).toContain("A");
          expect(state.task.runId).toBeUndefined();
        } else {
          expect(state.task.runId).toEqual(expect.any(String));
          expect(state.task.targetCount).toBe(4);
          expect(state.task.countKind).toBe("final");
        }
      } finally {
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        toolSequence = [];
        requestedTool = undefined;
        sessionId = previous;
      }
    },
  );
  it("replaces current requirements without losing history or duplicating retained rules", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      requestedTool = {
        name: "plan_task",
        input: {
          title: "按风险选题",
          requirements: ["随机抽200条", "保留原题", "暂不采用或发布"],
          targetCount: 200,
          nextAction: "none",
        },
      };
      await send("先随机抽200条，保留原题，暂不采用或发布");
      requestedTool = {
        name: "plan_task",
        input: {
          title: "按风险选题",
          requirements: [
            "按风险类别筛选200条",
            " 保留原题 ",
            "保留原题",
            "暂不采用或发布",
            "",
          ],
          nextAction: "none",
        },
      };
      const replacementCall = calls.length;
      await send("改为按风险类别筛选，其他要求保持");
      // Old plans stay in the user-visible history, but must not become examples
      // for the next replacement snapshot sent to the model.
      expect(
        calls[replacementCall].messages.flatMap((message: any) =>
          (message.tool_calls ?? []).map((call: any) => call.function.name),
        ),
      ).not.toContain("plan_task");
      const modelTask = JSON.parse(
        calls[replacementCall].messages
          .find((message: any) =>
            String(message.content).startsWith("当前持久事实："),
          )
          .content.split("：")
          .slice(1)
          .join("："),
      );
      expect(modelTask.previousRequirements).toBeUndefined();
      expect(modelTask.requirements).toEqual([
        "随机抽200条",
        "保留原题",
        "暂不采用或发布",
      ]);
      expect(modelTask.originalRequest).toContain("先随机抽200条");
      const state = (await read()).json();
      expect(state.task.requirements).toEqual([
        "按风险类别筛选200条",
        "保留原题",
        "暂不采用或发布",
      ]);
      expect(state.task.targetCount).toBe(200);
      expect(state.turns[0].userText).toContain("随机抽200条");
      expect(state.turns.at(-1).userText).toContain("按风险类别筛选");
      requestedTool = {
        name: "plan_task",
        input: {
          title: "按风险选题",
          requirements: ["按风险类别筛选", "保留原题", "暂不采用或发布"],
          targetCount: null,
          nextAction: "none",
        },
      };
      const cleared = (await send("不再限定200条，其他要求保持")).json();
      expect(cleared.task.targetCount).toBeNull();
      expect(cleared.task.requirements).toEqual([
        "按风险类别筛选",
        "保留原题",
        "暂不采用或发布",
      ]);
    } finally {
      sessionId = previous;
    }
  });

  it.each(["valid", "repaired", "empty reply", "duplicate batch"])(
    "OPT32 follow-up finishes a requirements-only turn: %s",
    async (mode) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions",
          headers,
          payload: {},
        })
      ).json().sessionId;
      const db = createPool(databaseUrl);
      const input = {
        targetCount: 3,
        requirements: ["保留事实，不添加新信息"],
      };
      const before = calls.length;
      try {
        if (mode === "repaired") {
          requestedTool = {
            name: "plan_task",
            input: { targetCount: "3", requirements: "保留事实，不添加新信息" },
          };
          parameterRepairReply = () => input;
        } else if (mode === "duplicate batch") {
          toolBatch = Array.from({ length: 6 }, () => ({
            name: "plan_task",
            input,
          }));
        } else requestedTool = { name: "plan_task", input };
        if (mode === "empty reply") finalReply = "";
        const state = (
          await send("记录要求：做3条，保留事实，不添加新信息。先不要执行")
        ).json();
        const turn = state.turns.at(-1);
        expect(turn.status).toBe("succeeded");
        expect(turn.assistantText).toContain("要求已记录");
        expect(turn.assistantText).toContain("3");
        expect(state.task.nextAction).toBeNull();
        expect(state.task.targetCount).toBe(3);
        expect(state.task.requirements).toEqual(input.requirements);
        expect(state.task.stage).not.toBe("complete");
        expect(turn.tools).toHaveLength(1);
        expect(calls.length - before).toBeLessThanOrEqual(
          mode === "repaired" ? 3 : 2,
        );
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM collaborative_draft WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM processing_run WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        requestedTool = undefined;
        toolBatch = undefined;
        parameterRepairReply = undefined;
        finalReply = undefined;
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("OPT32 follow-up bounds repeated successful planning without clearing an explicit action", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const input = {
      targetCount: 3,
      requirements: ["保留事实"],
      nextAction: "create_draft",
    };
    const start = calls.length;
    try {
      toolSequence = Array.from({ length: 9 }, () => ({
        name: "plan_task",
        input,
      }));
      const state = (
        await send("记录要求后创建草稿", undefined, "failed")
      ).json();
      expect(state.turns.at(-1).errorCode).toBe("assistant_no_progress");
      expect(state.task.nextAction).toBe("create_draft");
      expect(calls.length - start).toBeLessThanOrEqual(3);
      expect(state.turns.at(-1).tools).toHaveLength(1);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("OPT32 follow-up does not conceal a failed operation after recording requirements", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: { targetCount: 3, requirements: ["保留事实"] },
        },
        {
          name: "read_background",
          input: { documentId: "missing-background" },
        },
      ];
      const state = (
        await send("先记录要求，再读取说明", undefined, "failed")
      ).json();
      expect(state.turns.at(-1).status).toBe("failed");
      expect(
        state.turns
          .at(-1)
          .tools.some(
            (t: any) => t.name === "read_background" && t.status === "failed",
          ),
      ).toBe(true);
      expect(state.task.requirements).toEqual(["保留事实"]);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });

  it("OPT32 follow-up preserves an explicit action across a requirements patch", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const start = calls.length;
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: { requirements: ["保留事实"], nextAction: "create_draft" },
        },
        { name: "plan_task", input: { targetCount: 3 } },
        { name: "create_draft", input: { name: "明确授权后创建" } },
      ];
      const state = (await send("先记录要求，然后创建空草稿")).json();
      expect(calls[start + 2].tool_choice).toBe("required");
      expect(
        state.turns
          .at(-1)
          .tools.filter(
            (t: any) => t.name === "create_draft" && t.status === "succeeded",
          ),
      ).toHaveLength(1);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });

  it("OPT32 follow-up preserves pending publication after recording requirements", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const path = "/api/projects/" + projectId + "/collaborative-drafts";
    const draft = (
      await app.inject({
        method: "POST",
        url: path,
        headers,
        payload: { name: "要求记录后待确认" },
      })
    ).json().draft;
    expect(
      (
        await app.inject({
          method: "POST",
          url: path + "/" + draft.id + "/records",
          headers,
          payload: { question: "合成问题", expectedOutput: "", metadata: [] },
        })
      ).statusCode,
    ).toBe(201);
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: {
            requirements: ["保留事实"],
            target: { kind: "draft", id: draft.id },
          },
        },
        { name: "request_publish", input: { draftId: draft.id } },
      ];
      const state = (
        await send("记录保留事实的要求，再准备发布这个草稿")
      ).json();
      expect(state.task.stage).toBe("awaiting_confirmation");
      expect(
        state.proposals.filter((p: any) => p.status === "pending"),
      ).toHaveLength(1);
      expect(state.turns.at(-1).assistantText).not.toContain(
        "要求已记录，尚未开始新的处理",
      );
      const db = createPool(databaseUrl);
      try {
        expect(
          (await db.query("SELECT count(*)::int AS n FROM test_set_version"))
            .rows[0].n,
        ).toBe(0);
      } finally {
        await db.end();
      }
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });

  it("OPT32 follow-up preserves a read answer alongside recorded requirements", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      toolSequence = [
        { name: "plan_task", input: { requirements: ["保留事实"] } },
        { name: "query_project", input: { kind: "project" } },
      ];
      finalReply = "已记录要求。当前项目是助手合同测试。";
      const state = (
        await send("记录保留事实的要求，并告诉我当前项目名称")
      ).json();
      expect(state.turns.at(-1).assistantText).toBe(finalReply);
    } finally {
      toolSequence = [];
      finalReply = undefined;
      sessionId = previous;
    }
  });
  it("OPT33 reconciles a verbal acknowledgement before reporting saved requirements", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      const start = calls.length;
      textualToolCall = "已记录要求：3条，保留事实，不添加新信息。";
      requestedTool = {
        name: "plan_task",
        input: {
          requirements: ["做3条", "保留事实", "不添加新信息"],
          nextAction: "none",
        },
      };
      const state = (
        await send("记录要求：做3条，保留事实，不添加新信息。先不要执行")
      ).json();
      expect(calls[start + 1].tool_choice.function.name).toBe("plan_task");
      expect(state.task.targetCount).toBe(3);
      expect(state.task.requirements).toEqual(["保留事实", "不添加新信息"]);
      expect(state.turns.at(-1).diagnostics.requirementsReconciled).toBe(true);
      toolSequence = [
        {
          name: "plan_task",
          input: { targetCount: 5, requirements: [], nextAction: "none" },
        },
        { name: "plan_task", input: { targetCount: 5, nextAction: "none" } },
      ];
      const updated = (await send("把数量改为5，仍然先不执行")).json();
      expect(updated.task.targetCount).toBe(5);
      expect(updated.task.requirements).toEqual(state.task.requirements);
      expect(
        updated.turns
          .at(-1)
          .tools.some((item: any) => item.name === "create_draft"),
      ).toBe(false);
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: { requirements: ["保留事实"], nextAction: "none" },
      };
      const ambiguous = (
        await send("记录要求：不要生成3条，数量改成5条，保留事实，先不执行")
      ).json();
      expect(ambiguous.task.targetCount).toBeUndefined();
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      textualToolCall = undefined;
      toolSequence = [];
    }
  });

  it("OPT33 updates a count without keeping the old count as a text requirement", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          requirements: ["本次处理3条记录", "保留事实", "不添加新信息"],
          nextAction: "none",
        },
      };
      const first = (
        await send("记录要求：做3条，保留事实，不添加新信息。先不要执行")
      ).json();
      expect(first.task.targetCount).toBe(3);
      requestedTool = { name: "plan_task", input: { targetCount: 5 } };
      const updated = (await send("只把数量改成5条，其他要求不变")).json();
      expect(updated.task.targetCount).toBe(5);
      expect(updated.task.requirements).toEqual(["保留事实", "不添加新信息"]);
      expect(updated.task.requirementSummary).toContain("新增候选：5 条");
      expect(updated.task.requirementSummary.join("；")).not.toContain("3条");
      expect(updated.turns.at(-1).assistantText).not.toContain("3条");
      const refreshed = (await read()).json();
      expect(refreshed.task.requirements).toEqual(updated.task.requirements);
      const db = createPool(databaseUrl);
      try {
        await db.query(
          "UPDATE assistant_session SET task=jsonb_set(task,'{requirements}',$2::jsonb) WHERE id=$1",
          [
            sessionId,
            JSON.stringify(["本次处理3条记录", "保留事实", "不添加新信息"]),
          ],
        );
      } finally {
        await db.end();
      }
      requestedTool = undefined;
      toolSequence = [
        { name: "plan_task", input: { targetCount: 5 } },
        {
          name: "plan_task",
          input: { targetCount: 5, requirements: ["保留事实", "不添加新信息"] },
        },
      ];
      const legacy = (await send("数量仍是5条，其他要求不变")).json();
      expect(legacy.task.targetCount).toBe(5);
      expect(legacy.task.requirements).toEqual(["保留事实", "不添加新信息"]);
      expect(legacy.turns.at(-1).tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              code: "assistant_requirement_conflict",
            }),
          }),
          expect.objectContaining({ name: "plan_task", status: "succeeded" }),
        ]),
      );
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });

  it("OPT33 preserves final count meaning through recording and updates", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          requirements: ["最终总数100条", "保留事实", "不添加新信息"],
          nextAction: "none",
        },
      };
      const first = (
        await send(
          "记录要求：最终总数100条，保留事实，不添加新信息。先不执行。",
        )
      ).json();
      expect(first.task.targetCount).toBe(100);
      expect(first.task.countKind).toBe("final");
      expect(first.task.requirements).toEqual(["保留事实", "不添加新信息"]);
      requestedTool = {
        name: "plan_task",
        input: {
          targetCount: 120,
          countKind: "new",
          executionMode: "plan",
          nextAction: "none",
        },
      };
      const changed = (
        await send("最终总数改为120条，其他要求不变，先不执行。")
      ).json();
      expect(changed.task.countKind).toBe("final");
      expect(changed.task.requirementSummary).toContain("最终总数：120 条");
      expect(changed.task.requirementSummary).not.toContain("新增候选：120 条");
      expect(changed.task.requirements).toEqual(first.task.requirements);
      requestedTool = {
        name: "plan_task",
        input: { targetCount: 130, nextAction: "none" },
      };
      const again = (await send("数量改为130条，其他不变，先不执行。")).json();
      expect(again.task.countKind).toBe("final");
      expect((await read()).json().task.requirementSummary).toContain(
        "最终总数：130 条",
      );
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          requirements: ["最终总数100条", "本轮只处理其中3条", "其余97条保留"],
          nextAction: "none",
        },
      };
      const scoped = (
        await send(
          "记录要求：最终总数100条，本轮只处理其中3条，其余97条保留。先不执行。",
        )
      ).json();
      expect(scoped.task.targetCount).toBe(100);
      expect(scoped.task.countKind).toBe("final");
      expect(scoped.task.requirements).toEqual([
        "本轮只处理其中3条",
        "其余97条保留",
      ]);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });

  it("OPT33 corrects missing requirement content in the contextual loop", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      const start = calls.length;
      toolSequence = [
        { name: "plan_task", input: {} },
        {
          name: "plan_task",
          input: {
            requirements: ["最终总数100条", "保留事实", "不添加新信息"],
            question: "请提供要处理的来源文件或草稿名称。",
            nextAction: "none",
          },
        },
      ];
      const state = (
        await send(
          "记录要求：最终总数100条，保留事实，不添加新信息。先不执行。",
        )
      ).json();
      expect(state.turns.at(-1).tools.map((t: any) => t.status)).toEqual([
        "failed",
        "succeeded",
      ]);
      expect(calls.length - start).toBe(2);
      expect(state.task.countKind).toBe("final");
      expect(state.task.question).toBeFalsy();
      expect(state.task.stage).toBe("planning");
      expect(state.task.executionPaused).toBe(true);
      expect(state.turns.at(-1).assistantText).toContain("尚未开始");
      expect(state.turns.at(-1).assistantText).not.toContain("来源文件");
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });

  it("OPT33 clears current recovery only after a confirmed requirement retry", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = { name: "plan_task", input: {} };
      const failed = (
        await send(
          "记录要求：最终总数100条，保留事实，不添加新信息。先不执行。",
          undefined,
          "failed",
        )
      ).json();
      expect(failed.task.recovery).toBeTruthy();
      expect(failed.task.targetCount).toBeUndefined();
      expect(
        failed.turns.at(-1).diagnostics.requestAttempts,
      ).toBeLessThanOrEqual(4);
      const id = failed.turns.at(-1).id;
      requestedTool = {
        name: "plan_task",
        input: {
          requirements: ["最终总数100条", "保留事实", "不添加新信息"],
          nextAction: "none",
        },
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/retry",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      const saved = await opt21End(id);
      expect(saved.turns.at(-1).status).toBe("succeeded");
      expect(saved.task.error).toBeFalsy();
      expect(saved.task.recovery).toBeFalsy();
      expect(saved.task.countKind).toBe("final");
      expect(
        saved.turns.at(-1).tools.some((t: any) => t.status === "failed"),
      ).toBe(true);
      expect((await read()).json().task.recovery).toBeFalsy();
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });

  it("OPT33 does not reconfirm an explicit count while retaining numeric semantics", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          targetCount: 3,
          countKind: "new",
          requirements: ["保留事实", "每条保留2个要点"],
          nextAction: "none",
        },
      };
      await send("记录要求：做3条，保留事实，每条保留2个要点。先不执行。");
      requestedTool = {
        name: "plan_task",
        input: {
          targetCount: 2,
          requirements: ["保留事实", "每条保留2个要点"],
          question: "请确认：当前数量是 2 条，对吗？",
          nextAction: "none",
        },
      };
      const saved = (await send("数量再改为2条，其余不变，先不执行。")).json();
      expect(saved.task.targetCount).toBe(2);
      expect(saved.task.question).toBeFalsy();
      expect(saved.task.executionPaused).toBe(true);
      expect(saved.task.stage).toBe("planning");
      expect(saved.task.requirements).toContain("每条保留2个要点");
      expect(saved.turns.at(-1).assistantText).not.toContain("请确认");
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });

  it("OPT33 retains a genuine clarification during a requirement-only update", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          targetCount: 2,
          requirements: ["保留事实"],
          question: "两个来源同名，请选择要使用的来源。",
          nextAction: "none",
        },
      };
      const state = (
        await send("记录要求：数量改为2条，保留事实。先不执行。")
      ).json();
      expect(state.task.question).toBe("两个来源同名，请选择要使用的来源。");
      expect(state.task.stage).toBe("waiting_input");
      expect(
        state.turns.at(-1).tools.every((t: any) => t.name === "plan_task"),
      ).toBe(true);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });

  it("OPT33 blocks a direct write before recording a paused request", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const count = async () =>
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collaborative_draft WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n;
      const before = await count();
      toolSequence = [
        { name: "create_draft", input: { name: "未授权执行" } },
        {
          name: "plan_task",
          input: { requirements: ["保留事实"], nextAction: "none" },
        },
      ];
      const state = (
        await send("记录要求：保留事实。先不执行。", undefined, "failed")
      ).json();
      expect(await count()).toBe(before);
      expect(state.turns.at(-1).tools).toContainEqual(
        expect.objectContaining({
          name: "create_draft",
          status: "failed",
          error: expect.objectContaining({ code: "assistant_plan_only" }),
        }),
      );
      expect(state.task.executionPaused).toBe(true);
    } finally {
      await db.end();
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });
  it("OPT33 leaves a count explanation unchanged when the model pauses", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = { name: "plan_task", input: { nextAction: "none" } };
      const state = (await send("请解释：最终总数100条，先不要执行。")).json();
      expect(state.task.targetCount).toBeUndefined();
      expect(state.task.countKind).toBeUndefined();
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });

  it.each(["context", "retry"])(
    "OPT33 recovers malformed requirement updates without resuming data execution (%s)",
    async (mode) => {
      const previous = sessionId;
      try {
        await opt21Session();
        requestedTool = {
          name: "plan_task",
          input: {
            targetCount: 3,
            requirements: ["保留事实", "每条保留2个要点"],
            nextAction: "none",
          },
        };
        await send("记录要求：做3条，保留事实，每条保留2个要点。先不执行。");
        const valid = {
          name: "plan_task",
          input: { targetCount: 5, nextAction: "none" },
        };
        rawToolArguments =
          mode === "context"
            ? ['{"targetCount":']
            : Array(3).fill('{"targetCount":');
        toolSequence =
          mode === "context" ? [valid, valid] : [valid, valid, valid];
        let state = (
          await send(
            "数量改为5条，其他不变，先不执行。",
            undefined,
            mode === "context" ? "succeeded" : "failed",
          )
        ).json();
        if (mode === "retry") {
          expect(state.task.targetCount).toBe(3);
          const id = state.turns.at(-1).id;
          rawToolArguments = [];
          toolSequence = [valid];
          expect(
            (
              await app.inject({
                method: "POST",
                url: base() + "/sessions/" + sessionId + "/retry",
                headers,
                payload: {},
              })
            ).statusCode,
          ).toBe(200);
          state = await opt21End(id);
        }
        expect(state.turns.at(-1).status).toBe("succeeded");
        expect(state.task.targetCount).toBe(5);
        expect(state.task.executionPaused).toBe(true);
        expect(state.task.recovery).toBeFalsy();
        expect(state.task.requirements).toEqual([
          "保留事实",
          "每条保留2个要点",
        ]);
        expect(
          state.turns.at(-1).tools.every((t: any) => t.name === "plan_task"),
        ).toBe(true);
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        rawToolArguments = [];
      }
    },
  );

  it("OPT33 rejects repeated acknowledgement without a save receipt", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      textualReplies = ["要求已记录，目标3条。", "要求已记录，目标3条。"];
      const state = (
        await send("记录目标3条，先不执行", undefined, "failed")
      ).json();
      expect(state.turns.at(-1).errorCode).toBe(
        "assistant_requirements_not_saved",
      );
      expect(
        state.turns.at(-1).diagnostics.requestAttempts,
      ).toBeLessThanOrEqual(2);
      expect(state.task.targetCount).toBeUndefined();
    } finally {
      sessionId = previous;
      textualReplies = [];
      textualToolCall = undefined;
    }
  });
  it("OPT33 confirms stored facts without saving again and preserves requirements not individually revoked", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          requirements: ["保留事实", "不添加新信息"],
          nextAction: "none",
        },
      };
      const stored = (
        await send("记录要求：保留事实，不添加新信息，先不执行")
      ).json();
      const before = calls.length;
      textualReplies = ["要求已经保存：保留事实，不添加新信息。"];
      const confirmed = (await send("之前的要求还在吗？")).json();
      expect(calls.length - before).toBe(1);
      expect(confirmed.turns.at(-1).tools).toEqual([]);
      expect(confirmed.task.requirements).toEqual(stored.task.requirements);
      toolSequence = [
        { name: "plan_task", input: { requirements: [] } },
        {
          name: "plan_task",
          input: { requirements: ["不添加新信息"], nextAction: "none" },
        },
      ];
      const revised = (await send("取消保留事实这个要求")).json();
      expect(revised.task.requirements).toEqual(["不添加新信息"]);
      expect(
        revised.turns
          .at(-1)
          .tools.some(
            (t: any) =>
              t.status === "failed" &&
              t.error.code === "assistant_tool_input_invalid",
          ),
      ).toBe(true);
      requestedTool = { name: "plan_task", input: { requirements: [] } };
      expect((await send("清空所有要求")).json().task.requirements).toEqual([]);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      textualReplies = [];
    }
  });
  it("OPT33 rejects unadvertised writes before a document-only plan is saved", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const counts = async () =>
        (
          await db.query(
            "SELECT (SELECT count(*) FROM processing_run WHERE project_id=$1)::int AS runs,(SELECT count(*) FROM collaborative_draft WHERE project_id=$1)::int AS drafts",
            [projectId],
          )
        ).rows[0];
      const before = await counts();
      const doc = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "规范.md",
            contentBase64: Buffer.from(
              "问题完整自然，期望输出逐题说明正常回答行为。",
            ).toString("base64"),
          },
        })
      ).json().document;
      const generation = {
        name: "不能提前生成",
        instructions: "生成完整客服问法",
        outputCount: 5,
        scenarios: ["咨询配送进度"],
        classifications: [],
      };
      toolSequence = [
        { name: "read_background", input: { documentId: doc.id } },
        { name: "generate_candidates", input: generation },
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            requirements: ["问题完整自然"],
            steps: [
              {
                title: "生成5条",
                action: "generate_candidates",
                input: generation,
              },
            ],
          },
        },
      ];
      const state = await opt21End(
        await opt21Submit("按附件设计5条，先给方案"),
      );
      expect(
        state.turns
          .at(-1)
          .tools.some(
            (t: any) =>
              t.name === "generate_candidates" && t.status === "succeeded",
          ),
      ).toBe(false);
      expect(await counts()).toEqual(before);
      expect(state.task.backgroundEvidence).toHaveLength(1);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it("OPT33 leaves pure explanations and empty reconciliation inputs unchanged", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      requestedTool = { name: "plan_task", input: {} };
      const state = (await send("清洗和改写有何区别？")).json();
      expect(state.task.executionPaused).not.toBe(true);
      expect(state.task.executionPlan).toBeUndefined();
      expect(state.task.requirements ?? []).toEqual([]);
      expect(state.turns.at(-1).tools[0].result.unchanged).toBe(true);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });
  it.each(["checkpoint", "legacy", "changed"])(
    "OPT33 continues an interrupted document plan with current evidence and records the repair stage (%s)",
    async (mode) => {
      const previous = sessionId;
      const db = createPool(databaseUrl);
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      let timer: ReturnType<typeof vi.spyOn> | undefined;
      let finish!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        await opt21Session();
        const doc = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "客服规范.txt",
              contentBase64: Buffer.from(
                "客服测试问题应独立完整，覆盖退货与物流，期望输出逐题说明正常应答行为。",
              ).toString("base64"),
            },
          })
        ).json().document;
        requestedTool = {
          name: "read_background",
          input: { documentId: doc.id, useForProcessing: false },
        };
        await send("读取附件");
        const valid = {
          executionMode: "plan",
          requirements: ["问题独立完整，逐题描述正常应答行为"],
          deliveries: [
            {
              name: "客服测试",
              instructions: "按客服规范设计自然完整的问题",
              count: 6,
              scenarios: [
                "用户申请退货并询问所需材料",
                "用户查询包裹延误原因",
                "用户确认退货后的退款时间",
              ],
              classifications: [],
            },
          ],
        };
        requestedTool = {
          name: "plan_task",
          input: {
            ...valid,
            deliveries: [{ ...valid.deliveries[0], count: [6, 7] }],
          },
        };
        toolSequence = [
          {
            name: "read_background",
            input: { documentId: doc.id, useForProcessing: false },
          },
          requestedTool,
        ];
        requestedTool = undefined;
        parameterRepairReply = async ({ original }) => {
          entered();
          await release;
          return original;
        };
        timer = vi
          .spyOn(AbortSignal, "timeout")
          .mockImplementation((ms) => realTimeout(ms >= 70000 ? 800 : ms));
        const id = await opt21Submit("按附件设计6条客服测试，先给方案，不执行");
        await waiting;
        const failed = await opt21End(id);
        expect(
          failed.turns.at(-1).diagnostics.parameterRepairStatus,
        ).toMatchObject({
          intent: "document_plan",
          phase: "finished",
          outcome: "interrupted",
          issues: expect.any(Array),
        });
        expect(failed.turns.at(-1).diagnostics.failure.reason).toContain(
          "方案参数校验",
        );
        expect(failed.task.executionPlan).toBeUndefined();
        expect(failed.task.planningRecovery).toBeUndefined();
        expect(failed.task.parameterRepairStatus).toBeUndefined();
        const raw = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        expect(raw.planningRecovery.turnId).toBe(id);
        expect(raw.parameterRepairLimits.plan_task.used).toBe(1);
        timer.mockRestore();
        timer = undefined;
        finish();
        parameterRepairReply = undefined;
        requestedTool = { name: "plan_task", input: valid };
        if (mode === "legacy")
          await db.query(
            "UPDATE assistant_session SET task=task-'planningRecovery' WHERE id=$1",
            [sessionId],
          );
        if (mode === "changed")
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "新规范.txt",
              contentBase64:
                Buffer.from("替换后的另一份要求。").toString("base64"),
            },
          });
        const start = calls.length;
        const resumed = (
          await send(
            "继续规划",
            undefined,
            mode === "changed" ? "failed" : "succeeded",
          )
        ).json();
        if (mode === "changed") {
          expect(resumed.turns.at(-1).errorCode).toBe(
            "assistant_plan_revalidation_required",
          );
          expect(calls.slice(start)).toHaveLength(0);
          expect(resumed.task.executionPlan).toBeUndefined();
          return;
        }
        expect(resumed.turns.at(-1).status).toBe("succeeded");
        expect(resumed.task.executionPlan.mode).toBe("plan");
        expect(resumed.task.targetCount).toBe(6);
        expect(resumed.task.recovery ?? null).toBeNull();
        expect(calls.slice(start)).toHaveLength(1);
        expect(
          calls[start].messages.some((message: any) =>
            String(message.content).includes(
              "按附件设计6条客服测试，先给方案，不执行",
            ),
          ),
        ).toBe(true);
        expect(
          calls[start].messages.some((message: any) =>
            String(message.content).includes("客服测试问题应独立完整"),
          ),
        ).toBe(true);
        expect(
          (
            await db.query(
              "SELECT task->'planningRecovery' AS pending FROM assistant_session WHERE id=$1",
              [sessionId],
            )
          ).rows[0].pending,
        ).toBeNull();
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS count FROM processing_run WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].count,
        ).toBe(0);
      } finally {
        timer?.mockRestore();
        finish();
        parameterRepairReply = undefined;
        requestedTool = undefined;
        toolSequence = [];
        sessionId = previous;
        await db.end();
      }
    },
  );

  it("OPT33 resolves split hierarchy queries and stores eight compact deliveries without writes", async () => {
    const previous = sessionId;
    const db = createPool(databaseUrl);
    try {
      await opt21Session();
      const content =
        Array.from(
          { length: 8 },
          (_, i) =>
            "2." +
            (i + 1) +
            " 前置说明\n" +
            "与当前分类无关的资料介绍。".repeat(8),
        ).join("\n") +
        "\nA.1 测试分类\n" +
        Array.from(
          { length: 8 },
          (_, i) =>
            String.fromCharCode(97 + i) +
            ") 第" +
            (i + 1) +
            "类：仅测试该类的明确边界。",
        ).join("\n") +
        "\nA.2 其他分类";
      const doc = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "分类.md",
            contentBase64: Buffer.from(content).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: doc.id, query: "A.1" },
      };
      const readState = (await send("读取附件的A.1.a定义")).json();
      const response = readState.turns
        .at(-1)
        .tools.find((item: any) => item.name === "read_background").result;
      expect(response.fragments[0].index).toBe(1);
      const references = response.definitions;
      expect(references.find((ref: any) => ref.value === "A.1.h")).toBeTruthy();
      expect(
        references.filter((ref: any) => /^A\.1\.[a-h]$/.test(ref.code)),
      ).toHaveLength(8);
      const steps = Array.from({ length: 8 }, (_, i) => {
        const value = "A.1." + String.fromCharCode(97 + i),
          reference = references.find(
            (ref: any) => ref.value === value,
          ).reference;
        return {
          title: "第" + (i + 1) + "类",
          action: "generate_candidates",
          input: {
            name: value,
            instructions: "仅按本类定义生成完整自然的问题",
            outputCount: 50,
            scenarios: ["本类定义中的边界场景"],
            classifications: [
              {
                field: "metadata",
                key: "category",
                basis: "background",
                allowedValues: [value],
                definitions: [{ value, reference }],
              },
            ],
          },
        };
      });
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            question: "请确认8个测试集分别创建还是合并为一个？",
            executionMode: "plan",
            requirements: ["问题语义完整"],
            steps,
          },
        },
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            requirements: ["问题语义完整"],
            steps: steps.slice(0, 1),
          },
        },
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            requirements: ["问题语义完整"],
            steps,
          },
        },
      ];
      const start = calls.length;
      const planned = (await send("按附件A.1八类各设计50条，只给方案")).json();
      expect(planned.task.executionPlan.steps).toHaveLength(24);
      expect(
        planned.task.executionPlan.steps.filter(
          (step: any) => step.action === "generate_candidates",
        ),
      ).toHaveLength(8);
      expect(planned.task.overallTargetCount).toBe(400);
      for (const step of planned.task.executionPlan.steps.filter(
        (item: any) => item.action === "generate_candidates",
      )) {
        const definition = step.input.classifications[0].definitions[0];
        expect(step.input.instructions).toContain(
          JSON.stringify({ value: definition.value, text: definition.text }),
        );
        expect(step.input.instructions).toContain(
          "输入意图与期望应答行为分别编写",
        );
        expect(step.input.scenarios[0]).toContain(
          "本类测试目标必须实际满足文档定义【" + definition.text + "】",
        );
        expect(step.input.scenarios[0]).toContain(
          "背景包装【本类定义中的边界场景】",
        );
      }
      expect(planned.task.executionPlan.mode).toBe("plan");
      expect(calls.length - start).toBe(3);
      expect(calls[start].tool_choice).toBe("auto");
      expect(
        calls[start].tools.every((tool: any) =>
          [
            "plan_task",
            "read_background",
            "query_project",
            "read_records",
          ].includes(tool.function.name),
        ),
      ).toBe(true);
      expect(
        planned.turns
          .at(-1)
          .tools.some((item: any) =>
            [
              "generate_candidates",
              "create_draft",
              "submit_processing",
            ].includes(item.name),
          ),
      ).toBe(false);
      expect(
        (await db.query("SELECT count(*)::int AS n FROM processing_run"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it("reserves a final reply after repeated successful queries", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    repeatRead = "bounded";
    const start = calls.length;
    try {
      const state = (await send("查询各个分类并汇总已经读取的结果")).json();
      const turn = state.turns.at(-1);
      expect(turn.status, JSON.stringify(turn)).toBe("succeeded");
      expect(turn.assistantText).toBe("操作结果请查看下方真实回执。");
      expect(turn.tools.every((t: any) => t.status === "succeeded")).toBe(true);
      expect(state.task.stage).toBe("waiting_input");
      expect(calls.length - start).toBeLessThanOrEqual(10);
      expect(calls.at(-1)!.tools ?? []).toHaveLength(0);
    } finally {
      repeatRead = false;
      sessionId = previous;
    }
  });
  it.each([true, false])(
    "saves a background plan before repeated queries exhaust the turn only with write access: %s",
    async (writable) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const uploaded = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/background-documents`,
        headers,
        payload: {
          fileName: "分类要求.md",
          contentBase64: Buffer.from(
            "风险类别一：合成风险。另保留正常对照题。",
          ).toString("base64"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      toolSequence = Array.from({ length: 9 }, (_, index) => ({
        name: "read_background",
        input: {
          documentId: uploaded.json().document.id,
          query: index === 0 ? "类别" : `不存在章节${index}`,
        },
      }));
      backgroundCheckpoint = {
        title: "背景选题方案",
        requirements: [
          "生成200条题目，包含风险和正常对照",
          "只给方案，尚不处理数据",
        ],
        targetCount: 200,
        countKind: "new",
        executionMode: "plan",
        steps: [
          { title: "依据背景分类", action: "submit_processing" },
          { title: "选取200条", action: "select_candidates" },
          { title: "核对完整结果", action: "read_processing" },
        ],
        nextAction: "none",
      };
      const db = createPool(databaseUrl);
      const actor = (
        await db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      try {
        if (!writable) {
          await db.query("UPDATE app_user SET role='user' WHERE id=$1", [
            actor,
          ]);
          await db.query(
            "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(project_id,user_id) DO UPDATE SET role='viewer'",
            [projectId, actor],
          );
        }
        const state = (
          await send("按附件设计200条测试题的方案，先不要执行")
        ).json();
        if (writable) {
          expect(state.task.stage).toBe("planning");
          expect(state.task.targetCount).toBe(200);
          expect(state.task.executionPlan).toMatchObject({
            mode: "plan",
            current: 0,
          });
          expect(
            state.task.executionPlan.steps.every(
              (step: any) => step.status === "pending",
            ),
          ).toBe(true);
        } else {
          expect(state.task.stage).toBe("waiting_input");
          expect(state.task.executionPlan).toBeUndefined();
        }
        expect(state.turns.at(-1).assistantText).toBeTruthy();
        expect(
          state.turns
            .at(-1)
            .tools.some(
              (item: any) =>
                item.name === "plan_task" && item.status === "succeeded",
            ),
        ).toBe(writable);
        expect(
          state.turns
            .at(-1)
            .tools.some((item: any) => item.name === "submit_processing"),
        ).toBe(false);
        expect(state.proposals).toEqual([]);
      } finally {
        backgroundCheckpoint = undefined;
        toolSequence = [];
        sessionId = previous;
        if (!writable) {
          await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [
            actor,
          ]);
          await db.query(
            "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
            [projectId, actor],
          );
        }
        await db.end();
      }
    },
  );
  it.each<[string, boolean, boolean, boolean?]>([
    ["", false, false],
    ["", true, false],
    ["", true, true],
    [
      "方案已保存，尚未执行。保留原题和原标签，按分类固定选取200条。",
      false,
      true,
      true,
    ],
    [
      "<tool_call><function=submit_processing></function></tool_call>",
      false,
      false,
    ],
  ])(
    "returns the current complete planning checkpoint: %s (previous plan: %s, partial update: %s, earlier current plan: %s)",
    async (reply, previousPlan, partialUpdate, earlierPlan) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const uploaded = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/background-documents`,
          headers,
          payload: {
            fileName: "选题要求.md",
            contentBase64:
              Buffer.from("合成风险类别一与正常题。").toString("base64"),
          },
        });
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        const oldPlanTool = {
          name: "plan_task",
          input: {
            title: "旧选题方案",
            targetCount: 17,
            requirements: ["旧方案仅选17条"],
            executionMode: "plan",
            steps: [{ title: "读取旧分类", action: "read_background" }],
            nextAction: "none",
          },
        };
        if (previousPlan) {
          toolSequence = [oldPlanTool];
          const oldPlan = (await send("先设计选17条的方案，不执行")).json();
          expect(oldPlan.task.stage).toBe("planning");
        }
        toolSequence = [
          ...(earlierPlan ? [oldPlanTool] : []),
          ...(partialUpdate
            ? [
                {
                  name: "plan_task",
                  input: {
                    title: "待重新设计",
                    requirements: ["先核对背景，再设计新方案"],
                    nextAction: "none",
                  },
                },
              ]
            : []),
          ...Array.from({ length: earlierPlan ? 5 : 9 }, () => ({
            name: "read_background",
            input: { documentId: uploaded.json().document.id, query: "类别" },
          })),
        ];
        backgroundCheckpoint = {
          title: "背景选题方案",
          requirements: ["保留原题和原标签", "按背景分类后选取200条"],
          targetCount: 200,
          countKind: "new",
          executionMode: "plan",
          steps: [
            {
              title: "后台按背景分类，保留原题和原标签",
              action: "submit_processing",
            },
            { title: "按分类固定选取200条", action: "select_candidates" },
            { title: "核对数量与类别覆盖", action: "read_processing" },
          ],
          nextAction: "none",
        };
        finalReply = reply;
        const state = (await send("按附件设计200条题，先不执行")).json();
        const turn = state.turns.at(-1);
        expect(turn.status).toBe("succeeded");
        expect(state.task.stage).toBe("planning");
        expect(state.task.targetCount).toBe(200);
        expect(state.task.requirements).not.toContain("旧方案仅选17条");
        expect(turn.assistantText).toContain("尚未执行");
        expect(turn.assistantText).toContain("保留原题和原标签");
        expect(turn.assistantText).toContain("按分类固定选取200条");
        expect(turn.assistantText).not.toContain("submit_processing");
        expect(turn.assistantText).not.toContain("<tool_call");
        expect(state.proposals).toEqual([]);
        expect(
          turn.tools.some((item: any) => item.name === "submit_processing"),
        ).toBe(false);
      } finally {
        finalReply = undefined;
        backgroundCheckpoint = undefined;
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it.each([
    ["native schema", { query: "类别" }],
    ["business", { documentId: "missing-background" }],
  ])(
    "does not conceal a later %s tool failure after saving a plan",
    async (_, input) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        toolSequence = [
          {
            name: "plan_task",
            input: {
              title: "待核对分类方案",
              requirements: ["先核对背景分类，不执行"],
              executionMode: "plan",
              steps: [{ title: "核对背景定义", action: "read_background" }],
              nextAction: "none",
            },
          },
          { name: "read_background", input: input as Record<string, unknown> },
        ];
        finalReply = "";
        const state = (
          await send("先核对背景设计方案，不执行", undefined, "failed")
        ).json();
        expect(state.turns.at(-1).status).toBe("failed");
        expect(state.turns.at(-1).assistantText).toBe("");
        expect(state.task.stage).toBe("failed");
        expect(
          state.turns
            .at(-1)
            .tools.findLast((item: any) => item.name === "read_background")
            .status,
        ).toBe("failed");
        expect(state.proposals).toEqual([]);
      } finally {
        finalReply = undefined;
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it.each(["retry", "reclaim"])(
    "allows corrected write parameters after SDK rejection on %s",
    async (recovery) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        toolSequence = [{ name: "create_draft", input: { name: 42 } }];
        finalReply = "";
        const failed = (await send("创建一个草稿", undefined, "failed"))
          .json()
          .turns.at(-1);
        expect(failed.tools).toMatchObject([
          {
            name: "create_draft",
            status: "failed",
            error: { code: "assistant_tool_input_invalid" },
          },
        ]);
        finalReply = undefined;
        toolSequence = [
          { name: "create_draft", input: { name: "参数纠正后的草稿" } },
        ];
        if (recovery === "retry") {
          const resumed = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/retry`,
            headers,
            payload: {},
          });
          expect(resumed.statusCode, resumed.body).toBe(200);
        } else {
          const db = createPool(databaseUrl);
          try {
            await db.query(
              "UPDATE assistant_turn SET status='running',execution_attempt=1,expires_at=now()-interval '1 second' WHERE id=$1",
              [failed.id],
            );
          } finally {
            await db.end();
          }
        }
        await expect
          .poll(async () => (await read()).json().turns.at(-1).status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        const restored = (await read()).json().turns.at(-1);
        expect(restored.id).toBe(failed.id);
        expect(
          restored.tools.filter(
            (item: any) =>
              item.name === "create_draft" && item.status === "succeeded",
          ),
        ).toMatchObject([{ result: { name: "参数纠正后的草稿" } }]);
      } finally {
        finalReply = undefined;
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it.each(["started", "succeeded"])(
    "rejects changed parameters for a bound committed step with a %s receipt",
    async (receiptStatus) => {
      const previous = sessionId;
      const db = createPool(databaseUrl);
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        toolSequence = [
          { name: "create_draft", input: { name: "冻结参数原草稿" } },
        ];
        const original = (await send("创建草稿")).json().turns.at(-1);
        const stored = (
          await db.query(
            "SELECT tool_results,task_revision FROM assistant_turn WHERE id=$1",
            [original.id],
          )
        ).rows[0];
        const receipt = stored.tool_results.find(
          (item: any) => item.name === "create_draft",
        );
        await db.query(
          "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
          [
            sessionId,
            JSON.stringify({
              executionPlan: {
                mode: "execute",
                current: 0,
                needsReview: false,
                steps: [
                  {
                    title: "创建冻结草稿",
                    action: "create_draft",
                    revision: stored.task_revision,
                    status: "pending",
                    operation: { key: receipt.key, input: receipt.input },
                  },
                ],
              },
            }),
          ],
        );
        await db.query(
          "UPDATE assistant_turn SET status='running',execution_attempt=1,assistant_text='',expires_at=now()-interval '1 second',tool_results=$2 WHERE id=$1",
          [
            original.id,
            JSON.stringify([
              {
                ...receipt,
                status: receiptStatus,
                ...(receiptStatus === "started" ? { result: null } : {}),
              },
            ]),
          ],
        );
        toolSequence = [
          { name: "create_draft", input: { name: "被拒绝的新名称" } },
        ];
        finalReply = "";
        await expect
          .poll(async () => (await read()).json().turns.at(-1).status, {
            timeout: 15000,
          })
          .toBe("failed");
        const resumed = (await read()).json().turns.at(-1);
        expect(
          resumed.tools.findLast(
            (item: any) =>
              item.name === "create_draft" &&
              item.input.name === "被拒绝的新名称",
          ),
        ).toMatchObject({
          status: "failed",
          error: { code: "assistant_retry_parameters_changed" },
        });
        expect(
          resumed.tools.some(
            (item: any) =>
              item.status === "succeeded" &&
              item.input.name === "被拒绝的新名称",
          ),
        ).toBe(false);
        expect(
          (
            await db.query(
              "SELECT count(*) FROM collaborative_draft WHERE project_id=$1 AND (id=$2 OR name='被拒绝的新名称')",
              [projectId, receipt.result.draftId],
            )
          ).rows[0].count,
        ).toBe("1");
      } finally {
        await db.end();
        finalReply = undefined;
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it("does not hide a rejected change to a committed write behind planning feedback", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      toolSequence = [
        { name: "create_draft", input: { name: "已创建的原草稿" } },
      ];
      const original = (await send("创建一个草稿")).json().turns.at(-1);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "只规划后续",
            requirements: ["先设计后续方案，不执行"],
            executionMode: "plan",
            steps: [{ title: "后台处理", action: "submit_processing" }],
            nextAction: "none",
          },
        },
        { name: "create_draft", input: { name: "不允许替换原写入" } },
      ];
      finalReply = "";
      const db = createPool(databaseUrl);
      try {
        await db.query(
          "UPDATE assistant_turn SET status='running',execution_attempt=1,assistant_text='',expires_at=now()-interval '1 second' WHERE id=$1",
          [original.id],
        );
      } finally {
        await db.end();
      }
      await expect
        .poll(async () => (await read()).json().turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("failed");
      const restored = (await read()).json().turns.at(-1);
      expect(restored.assistantText).toBe("");
      expect(
        restored.tools.findLast((item: any) => item.name === "create_draft")
          .status,
      ).toBe("failed");
      expect(
        restored.tools.filter(
          (item: any) =>
            item.name === "create_draft" && item.status === "succeeded",
        ),
      ).toMatchObject([{ result: { name: "已创建的原草稿" } }]);
    } finally {
      finalReply = undefined;
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("does not conceal an incomplete new turn using a plan saved in an older turn", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "旧方案",
            requirements: ["只设计，不执行"],
            executionMode: "plan",
            steps: [
              { title: "按指定来源生成题目", action: "submit_processing" },
            ],
            nextAction: "none",
          },
        },
      ];
      expect((await send("先设计方案")).json().task.stage).toBe("planning");
      toolSequence = [{ name: "query_project", input: { kind: "project" } }];
      finalReply = "";
      const state = (await send("检查当前项目", undefined, "failed")).json();
      expect(state.turns.at(-1).errorCode).toBe("assistant_result_incomplete");
      expect(state.turns.at(-1).assistantText).toBe("");
      expect(state.proposals).toEqual([]);
    } finally {
      finalReply = undefined;
      toolSequence = [];
      sessionId = previous;
    }
  });
  it.each([
    ["steps", false],
    ["executionMode", false],
    ["steps", true],
  ] as const)(
    "does not accept a forced background checkpoint missing %s (recovery: %s)",
    async (missing, recover) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      try {
        const uploaded = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/background-documents`,
          headers,
          payload: {
            fileName: "方案要求.md",
            contentBase64:
              Buffer.from("风险分类和正常对照题。").toString("base64"),
          },
        });
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        toolSequence = Array.from({ length: 9 }, () => ({
          name: "read_background",
          input: { documentId: uploaded.json().document.id, query: "风险" },
        }));
        const complete = {
          title: "背景选题方案",
          requirements: ["依据背景设计200条题目，只给方案"],
          executionMode: "plan",
          steps: [{ title: "后台分类", action: "submit_processing" }],
          nextAction: "none",
        };
        const incomplete: Record<string, unknown> = { ...complete };
        delete incomplete[missing];
        backgroundCheckpoint = recover ? incomplete : [incomplete, complete];
        let state = (
          await send(
            "按附件设计200条测试题，先不要执行",
            undefined,
            recover ? "failed" : "succeeded",
          )
        ).json();
        expect(state.task).not.toHaveProperty("planningCheckpointTurnId");
        if (recover) {
          backgroundCheckpoint = [incomplete, complete];
          const db = createPool(databaseUrl);
          try {
            await db.query(
              "UPDATE assistant_turn SET status='running',execution_attempt=1,assistant_text='',expires_at=now()-interval '1 second' WHERE id=$1",
              [state.turns.at(-1).id],
            );
            await expect
              .poll(async () => (await read()).json().turns.at(-1).status, {
                timeout: 15000,
              })
              .toBe("succeeded");
            state = (await read()).json();
          } finally {
            await db.end();
          }
        }
        const plans = state.turns
          .at(-1)
          .tools.filter((item: any) => item.name === "plan_task");
        expect(plans.map((item: any) => item.status)).toEqual([
          "failed",
          "succeeded",
        ]);
        expect(state.task.stage).toBe("planning");
        expect(state.task.executionPlan).toMatchObject({
          mode: "plan",
          current: 0,
          steps: [
            {
              title: "后台分类",
              action: "submit_processing",
              status: "pending",
            },
          ],
        });
        expect(state.proposals).toEqual([]);
        expect(
          state.turns
            .at(-1)
            .tools.some((item: any) => item.name === "submit_processing"),
        ).toBe(false);
      } finally {
        backgroundCheckpoint = undefined;
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it("OPT36 executes a known source read immediately without model reconstruction or duplicate drafts", async () => {
    const previous = sessionId;
    const source = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: { name: "预算续做的读取资料" },
    });
    expect(source.statusCode, source.body).toBe(201);
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    toolSequence = [
      {
        name: "plan_task",
        input: {
          title: "跨轮执行方案",
          requirements: ["建立一个草稿后检查资料，不采用或发布"],
          nextAction: "create_draft",
          executionMode: "execute",
          steps: [
            { title: "建立草稿", action: "create_draft" },
            {
              title: "读取资料",
              action: "read_records",
              input: { source: { kind: "draft", id: source.json().draft.id } },
            },
          ],
        },
      },
      { name: "create_draft", input: { name: "跨轮唯一草稿" } },
    ];
    try {
      const result = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "执行刚才的方案：建立一个草稿后检查资料" },
      });
      expect(result.statusCode).toBe(202);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              ),
          { timeout: 15000 },
        )
        .toBe(false);
      const state = (await read()).json();
      expect(
        state.turns.every((turn: any) => turn.status === "succeeded"),
        JSON.stringify({
          task: state.task,
          turns: state.turns.map((turn: any) => ({
            status: turn.status,
            error: turn.errorCode,
            tools: turn.tools.map((item: any) => ({
              name: item.name,
              status: item.status,
              error: item.error,
            })),
          })),
        }),
      ).toBe(true);
      expect(state.turns).toHaveLength(1);
      expect(
        state.turns[0].tools.some(
          (tool: any) =>
            tool.name === "create_draft" && tool.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        state.turns
          .flatMap((turn: any) => turn.tools)
          .filter(
            (tool: any) =>
              tool.name === "create_draft" && tool.status === "succeeded",
          ),
      ).toHaveLength(1);
      expect(state.task.nextAction).toBeNull();
      expect(
        state.task.executionPlan.steps.map((step: any) => step.status),
      ).toEqual(["executed", "executed"]);
      expect(
        state.turns[0].tools.some((tool: any) => tool.name === "query_project"),
      ).toBe(false);
      expect(state.task.diagnostics.modelSteps).toBeLessThanOrEqual(10);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("stops budget continuation when new query arguments produce no new observations", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    toolSequence = [
      {
        name: "plan_task",
        input: {
          title: "无进展边界",
          executionMode: "execute",
          requirements: ["先检查资料再创建草稿"],
          steps: [{ title: "建立草稿", action: "create_draft" }],
        },
      },
      ...Array.from({ length: 25 }, (_, index) => ({
        name: "query_project",
        input: { kind: "files", search: `不存在的资料${index}` },
      })),
      { name: "create_draft", input: { name: "无进展不能继续创建" } },
    ];
    try {
      const queued = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "执行方案，先检查资料" },
      });
      expect(queued.statusCode).toBe(202);
      await expect
        .poll(async () => (await read()).json().task.stage, { timeout: 15000 })
        .toBe("failed");
      const stopped = (await read()).json();
      expect(stopped.task.error, JSON.stringify(stopped)).toBe(
        "assistant_no_progress",
      );
      expect(stopped.turns).toHaveLength(2);
      expect(stopped.turns.at(-1).event).toBe("budget_yield");
      expect(
        stopped.turns
          .flatMap((turn: any) => turn.tools)
          .some((tool: any) => tool.name === "create_draft"),
      ).toBe(false);
      expect(stopped.task.executionPlan.current).toBe(0);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("keeps a saved plan inactive until the user asks to execute it", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const steps = [{ title: "建立测试集草稿", action: "create_draft" }];
    try {
      requestedTool = {
        name: "plan_task",
        input: {
          title: "先设计方案",
          requirements: ["建立一个草稿，先不要执行"],
          executionMode: "plan",
          steps,
          nextAction: "none",
        },
      };
      const planned = (await send("请先设计创建草稿的方案，不要执行")).json();
      expect(planned.task.stage).toBe("planning");
      expect(planned.task.executionPlan.steps[0].status).toBe("pending");
      toolSequence = [
        { name: "create_draft", input: { name: "不应被建立的草稿" } },
      ];
      const readOnly = (
        await send("只查看当前方案", undefined, "failed")
      ).json();
      expect(readOnly.turns.at(-1).errorCode).toBe(
        "assistant_tool_input_invalid",
      );
      expect(
        readOnly.turns
          .at(-1)
          .tools.some(
            (tool: any) =>
              tool.name === "create_draft" && tool.status === "succeeded",
          ),
      ).toBe(false);
      const db = createPool(databaseUrl);
      try {
        expect(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM collaborative_draft WHERE project_id=$1 AND name=$2",
              [projectId, "不应被建立的草稿"],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await db.end();
      }
      expect(readOnly.task.executionPlan.steps[0].status).toBe("pending");
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "开始执行方案",
            requirements: ["建立一个草稿"],
            executionMode: "execute",
            nextAction: "create_draft",
          },
        },
        { name: "create_draft", input: { name: "用户授权的草稿" } },
      ];
      const executed = (await send("好的，现在开始执行方案")).json();
      expect(executed.task.executionPlan.mode).toBe("execute");
      expect(executed.task.executionPlan.steps[0].status).toBe("executed");
      expect(
        executed.turns
          .flatMap((turn: any) => turn.tools)
          .filter(
            (tool: any) =>
              tool.name === "create_draft" && tool.status === "succeeded",
          ),
      ).toHaveLength(1);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("clears a stale model-reply recovery notice after successful replanning", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      requestedTool = { name: "query_project", input: { kind: "files" } };
      finalReply = "";
      const failed = (await send("只读取资料", undefined, "failed")).json();
      expect(failed.task.recovery.kind).toBe("model_reply");
      finalReply = undefined;
      requestedTool = {
        name: "plan_task",
        input: {
          title: "重新核对前置条件",
          requirements: ["先只核对资料，不处理"],
          executionMode: "plan",
          steps: [
            {
              title: "核对资料",
              action: "query_project",
              input: { kind: "files" },
            },
          ],
        },
      };
      const repaired = (
        await send("修正方案，先只读核对，不生成、不采用、不发布")
      ).json();
      expect(repaired.task.stage).toBe("planning");
      expect(repaired.task.recovery).toBeNull();
      expect(repaired.turns[0].status).toBe("failed");
      expect(repaired.proposals).toHaveLength(0);
    } finally {
      finalReply = undefined;
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it("repairs missing prerequisites and a no-effect scope failure in one turn without duplicate runs", async () => {
    const previous = sessionId;
    const source = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "执行纠错合成来源" },
      })
    ).json().draft.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
      headers,
      payload: { question: "待清洗问题", expectedOutput: "保留", metadata: [] },
    });
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const plan = {
      title: "执行清洗",
      requirements: ["清洗一条，不采用或发布"],
      executionMode: "execute",
      target: { kind: "draft", id: source },
      steps: [
        {
          title: "清洗来源",
          action: "submit_processing",
          input: { source: { kind: "draft", id: source } },
        },
      ],
      nextAction: "submit_processing",
    };
    const processing = {
      source: { kind: "draft", id: source },
      operation: "clean",
      instructions: "清洗问题",
      allowedFields: ["question"],
    };
    toolSequence = [
      {
        name: "plan_task",
        input: {
          title: "错误预览首步",
          requirements: [],
          executionMode: "execute",
          steps: [
            { title: "预览未建立草稿", action: "preview_selection", input: {} },
          ],
          nextAction: "preview_selection",
        },
      },
      { name: "plan_task", input: plan },
      { name: "submit_processing", input: processing },
      { name: "plan_task", input: plan },
      {
        name: "submit_processing",
        input: {
          ...processing,
          selection: {
            method: "random",
            conditions: [],
            mode: "count",
            value: 1,
          },
        },
      },
    ];
    try {
      const result = (
        await send("开始执行；参数错误请在同一目标内纠正")
      ).json();
      const tools = result.turns.at(-1).tools;
      expect(
        tools.some(
          (item: any) =>
            item.error?.code === "assistant_plan_prerequisite_missing",
        ),
      ).toBe(true);
      expect(
        tools.some(
          (item: any) =>
            item.error?.code === "processing_scope_invalid" &&
            item.effect === "none",
        ),
      ).toBe(true);
      expect(
        tools.filter(
          (item: any) =>
            item.name === "submit_processing" && item.status === "succeeded",
        ),
      ).toHaveLength(1);
      expect(result.task.runId).toBeTruthy();
      expect(result.task.executionPlan.steps[0].status).toBe("waiting");
      const runs = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-runs/${result.task.runId}`,
        headers,
      });
      expect(runs.json().run.inputCount).toBe(1);
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });
  it.each(["recordIds", "allRecords"])(
    "updates the current fixed scope after selection changes to %s",
    async (mode) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      const drafts = `/api/projects/${projectId}/collaborative-drafts`;
      const source = (
        await app.inject({
          method: "POST",
          url: drafts,
          headers,
          payload: { name: "范围切换来源" },
        })
      ).json().draft.id;
      for (const question of ["甲问题", "乙问题"])
        await app.inject({
          method: "POST",
          url: `${drafts}/${source}/records`,
          headers,
          payload: { question, expectedOutput: "保留", metadata: [] },
        });
      const rows = (
        await app.inject({ method: "GET", url: `${drafts}/${source}`, headers })
      ).json().records;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      async function finish(runId: string) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='scope-update',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [runId],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
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
        requestedTool = { name: "read_processing", input: { runId } };
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.some((t: any) =>
                  ["queued", "running"].includes(t.status),
                ) || (await read()).json().task.checkedStatus !== "succeeded",
            { timeout: 15000 },
          )
          .toBe(false);
      }
      const processing = {
        source: { kind: "draft", id: source },
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      };
      try {
        requestedTool = {
          name: "submit_processing",
          input: {
            ...processing,
            selection: {
              method: "all",
              conditions: [
                { field: "question", operator: "equals", value: "甲问题" },
              ],
            },
          },
        };
        const first = (await send("只清洗甲问题")).json().task.runId;
        await finish(first);
        const expected =
          mode === "recordIds" ? [rows[1].id] : rows.map((row: any) => row.id);
        requestedTool = {
          name: "submit_processing",
          input: {
            ...processing,
            ...(mode === "recordIds"
              ? { recordIds: expected }
              : { allRecords: true }),
          },
        };
        const second = (await send("改用明确的新范围")).json().task.runId;
        await finish(second);
        expect((await read()).json().task.processingScope.count).toBe(
          expected.length,
        );
        expect(
          (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task.processingScope.recordIds,
        ).toEqual(expected);
        requestedTool = {
          name: "request_processing_apply",
          input: {
            runId: second,
            allValid: true,
            target: { kind: "newDraft", name: "范围切换采用" },
          },
        };
        const state = (await send("只采用这次处理结果")).json();
        const proposal = state.proposals.find(
          (p: any) => p.status === "pending",
        );
        expect(proposal, JSON.stringify(state.task)).toBeTruthy();
        expect(proposal.summary.count).toBe(expected.length);
        requestedTool = { name: "read_processing", input: { runId: second } };
        const accepted = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers,
          payload: {},
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
        const actual = (
          await app.inject({
            method: "GET",
            url: `${drafts}/${accepted.json().receipt.receipt.draftId}`,
            headers,
          })
        ).json().records;
        expect(actual.map((row: any) => row.question)).toEqual(
          mode === "recordIds" ? ["乙问题"] : ["甲问题", "乙问题"],
        );
      } finally {
        requestedTool = undefined;
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("keeps an unknown write bound when replanning in the same turn", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    const source = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "未知结果恢复来源" },
      })
    ).json().draft.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
      headers,
      payload: { question: "原问题", expectedOutput: "原输出", metadata: [] },
    });
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const processing = {
      source: { kind: "draft", id: source },
      allRecords: true,
      operation: "clean",
      instructions: "清洗问题",
      allowedFields: ["question"],
    };
    const plan = {
      title: "清洗一条",
      requirements: [],
      target: processing.source,
      executionMode: "execute",
      steps: [
        { title: "清洗来源", action: "submit_processing", input: processing },
      ],
      nextAction: "submit_processing",
    };
    const changed = { ...processing, instructions: "换参数重新清洗" };
    const failure = vi
      .spyOn(ArtifactRepository.prototype, "storeProcessing")
      .mockRejectedValue(new Error("synthetic unknown write result"));
    toolSequence = [
      { name: "plan_task", input: plan },
      { name: "submit_processing", input: processing },
      {
        name: "plan_task",
        input: {
          ...plan,
          steps: [
            {
              title: "换参数清洗",
              action: "submit_processing",
              input: changed,
            },
          ],
        },
      },
      { name: "submit_processing", input: changed },
    ];
    try {
      const state = (
        await send("开始执行，未知结果应先对账", undefined, "failed")
      ).json();
      const tools = state.turns.at(-1).tools;
      // A repeated failure may stop the bounded turn before a queued replan.
      // Either way, the committed operation input must remain bound below.
      expect(
        tools.some(
          (tool: any) =>
            tool.name === "submit_processing" && tool.status === "failed",
        ),
      ).toBe(true);
      expect(
        tools.some(
          (tool: any) =>
            tool.name === "submit_processing" && tool.status === "succeeded",
        ),
      ).toBe(false);
      expect(
        (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task.executionPlan.steps[0].operation.input.instructions,
      ).toBe(processing.instructions);
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) FROM processing_run WHERE source->>'id'=$1",
              [source],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
      expect(failure).toHaveBeenCalled();
    } finally {
      failure.mockRestore();
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  it("repairs a legacy validation failure without effect metadata on the same recovered turn", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    const source = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "旧校验恢复来源" },
      })
    ).json().draft.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
      headers,
      payload: { question: "待清洗", expectedOutput: "保留", metadata: [] },
    });
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const processing = {
      source: { kind: "draft", id: source },
      operation: "clean",
      instructions: "清洗",
      allowedFields: ["question"],
    };
    try {
      requestedTool = { name: "submit_processing", input: processing };
      const failed = (await send("清洗当前来源", undefined, "failed"))
        .json()
        .turns.at(-1);
      expect(
        failed.tools.some(
          (tool: any) => tool.error?.code === "processing_scope_invalid",
        ),
      ).toBe(true);
      await db.query(
        "UPDATE assistant_turn SET tool_results=(SELECT jsonb_agg(x-'effect') FROM jsonb_array_elements(tool_results) x) WHERE id=$1",
        [failed.id],
      );
      requestedTool = {
        name: "submit_processing",
        input: { ...processing, allRecords: true },
      };
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
        .poll(async () => (await read()).json().turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      const recovered = (await read()).json();
      expect(recovered.turns.at(-1).id).toBe(failed.id);
      expect(
        recovered.turns
          .at(-1)
          .tools.filter(
            (tool: any) =>
              tool.name === "submit_processing" && tool.status === "succeeded",
          ),
      ).toHaveLength(1);
      expect(recovered.task.runId).toBeTruthy();
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
    } finally {
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });
  it("rechecks full background, baseline protection and narrowed record scope at adoption", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    const drafts = `/api/projects/${projectId}/collaborative-drafts`;
    const source = (
      await app.inject({
        method: "POST",
        url: drafts,
        headers,
        payload: { name: "依据与范围合成来源" },
      })
    ).json().draft.id;
    for (const label of ["甲", "乙"])
      await app.inject({
        method: "POST",
        url: `${drafts}/${source}/records`,
        headers,
        payload: {
          question: `${label}原问题`,
          expectedOutput: label,
          metadata: [],
        },
      });
    const original = (
      await app.inject({ method: "GET", url: `${drafts}/${source}`, headers })
    ).json().records;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    async function finish(runId: string) {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='opt09-integrity',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2,updated_at=now() WHERE id=$1",
        [job.id, result],
      );
      await expect
        .poll(async () => (await read()).json().task.checkedStatus, {
          timeout: 15000,
        })
        .toBe("succeeded");
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 15000 },
        )
        .toBe(false);
    }
    try {
      const documents = [];
      for (const [name, content] of [
        ["原依据.txt", "原依据\n" + "A".repeat(3000)],
        ["新依据.txt", "新依据，要求不同"],
      ]) {
        const uploaded = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/background-documents`,
          headers,
          payload: {
            fileName: name,
            contentBase64: Buffer.from(content!).toString("base64"),
          },
        });
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        documents.push(uploaded.json().document);
      }
      expect(documents[0].fragmentCount).toBeGreaterThan(1);
      const processing = {
        source: { kind: "draft", id: source },
        allRecords: true,
        operation: "rewrite",
        allowedFields: ["question"],
        instructions: "先改写问题",
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "全范围读取后改写",
            requirements: ["按原依据改写两条"],
            targetCount: 2,
            allowedFields: ["question"],
            target: processing.source,
            executionMode: "execute",
            steps: [
              {
                title: "完整读原依据",
                action: "read_background",
                scope: "all",
                input: { documentId: documents[0].id, from: 1, limit: 1 },
              },
              {
                title: "改写问题",
                action: "submit_processing",
                input: processing,
              },
              {
                title: "稍后再次读背景",
                action: "read_background",
                scope: "all",
                input: { documentId: documents[0].id },
              },
            ],
          },
        },
        {
          name: "read_background",
          input: { documentId: documents[0].id, from: 1, limit: 1 },
        },
        {
          name: "read_background",
          input: { documentId: documents[0].id, from: 2, limit: 3 },
        },
        { name: "submit_processing", input: processing },
      ];
      const started = (await send("完整读取原依据，执行两条改写")).json();
      const first = started.task.runId;
      expect(first, JSON.stringify(started)).toBeTruthy();
      expect(started.task.executionPlan.steps[0].status).toBe("executed");
      expect(started.task.executionPlan.steps[2].status).toBe("pending");
      toolSequence = [];
      requestedTool = { name: "read_processing", input: { runId: first } };
      await finish(first);
      requestedTool = {
        name: "read_background",
        input: { documentId: documents[1].id, replaceEvidence: true },
      };
      await send("改用新依据核对旧成果");
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: first,
          allValid: true,
          allTask: true,
          target: { kind: "draft", id: source },
        },
      };
      const stale = (await send("尝试采用旧成果")).json();
      expect(stale.proposals).toHaveLength(0);
      expect(stale.task.review.compatibilityProblem).not.toBeNull();
      expect(stale.task.executionPlan.needsReview).toBe(true);
      requestedTool = {
        name: "read_background",
        input: { documentId: documents[0].id, limit: 3, replaceEvidence: true },
      };
      await send("恢复原依据");
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "只改 Metadata",
            requirements: ["以最初原题为准，只允许改 Metadata"],
            allowedFields: ["metadata"],
            metadataKeys: null,
            executionMode: "execute",
            nextAction: "refine_candidates",
          },
        },
        {
          name: "refine_candidates",
          input: {
            runId: first,
            where: { field: "question", operator: "contains", value: "" },
            instructions: "补足缺少的丙类问题",
            allowedFields: ["metadata"],
          },
        },
      ];
      const refined = (await send("仅补 Metadata，原问题必须保留")).json();
      const child = refined.task.runId;
      expect(child).not.toBe(first);
      toolSequence = [];
      requestedTool = { name: "read_processing", input: { runId: child } };
      await finish(child);
      expect(
        (await read()).json().task.review.protectedFieldChanges,
      ).toBeGreaterThan(0);
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: child,
          allTask: true,
          allValid: true,
          target: { kind: "draft", id: source },
        },
      };
      expect((await send("采用当前候选")).json().proposals).toHaveLength(0);
      requestedTool = {
        name: "plan_task",
        input: {
          title: "只采用第二条",
          requirements: ["允许问题和 Metadata 改动，仅采用第二条"],
          allowedFields: ["question", "metadata"],
          targetCount: 1,
          nextAction: "none",
        },
      };
      await send("改为只采用第二条，允许它的问题改动");
      // Persisted-scope fixture: the public adoption must honor the current fixed record subset.
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            candidateScope: null,
            processingScope: {
              source: { kind: "draft", id: source },
              recordIds: [original[1].id],
            },
          }),
        ],
      );
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: child,
          allTask: true,
          allValid: true,
          target: { kind: "draft", id: source },
        },
      };
      const scoped = (await send("按当前固定范围采用")).json();
      // Changed semantic requirements cannot be certified by the old background receipt.
      expect(scoped.proposals).toHaveLength(0);
      expect(scoped.task.review.compatibilityProblem).not.toBeNull();
      requestedTool = {
        name: "refine_candidates",
        input: {
          runId: child,
          where: {
            field: "expectedOutput",
            operator: "equals",
            value: "乙",
          },
          instructions: "按已修正要求核对第二条，仅保留该条候选",
          allowedFields: ["question", "metadata"],
        },
      };
      const reconciled = (await send("按新要求核对第二条候选")).json();
      const reconciledId = reconciled.task.runId;
      requestedTool = {
        name: "read_processing",
        input: { runId: reconciledId },
      };
      await finish(reconciledId);
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: reconciledId,
          allTask: true,
          allValid: true,
          target: { kind: "draft", id: source },
        },
      };
      const eligible = (await send("采用核对后的第二条")).json();
      const proposal = eligible.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal, JSON.stringify(eligible)).toBeTruthy();
      expect(proposal.summary.count).toBe(1);
      requestedTool = {
        name: "read_processing",
        input: { runId: reconciledId },
      };
      const accepted = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const actual = (
        await app.inject({ method: "GET", url: `${drafts}/${source}`, headers })
      ).json().records;
      expect(actual.find((r: any) => r.id === original[0].id).question).toBe(
        original[0].question,
      );
      expect(
        actual.find((r: any) => r.id === original[1].id).question,
      ).not.toBe(original[1].question);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it.each([true, "progress", "pending"] as const)(
    "reports exhausted model steps without pretending a result was delivered (%s)",
    async (repeatMode) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      if (repeatMode === "pending") {
        const draft = (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collaborative-drafts`,
            headers,
            payload: { name: "汇总边界测试" },
          })
        ).json().draft;
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts/${draft.id}/records`,
          headers,
          payload: { question: "合成问题", expectedOutput: "", metadata: [] },
        });
        toolSequence = [
          { name: "request_publish", input: { draftId: draft.id } },
        ];
      }
      repeatRead = repeatMode === "pending" ? true : repeatMode;
      try {
        const submitted = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "统计整个文件的结果" },
        });
        expect(submitted.statusCode).toBe(202);
        await expect
          .poll(async () => (await read()).json().turns.at(-1)?.status, {
            timeout: 15000,
          })
          .not.toBe("running");
        await expect
          .poll(async () => (await read()).json().turns.at(-1)?.status, {
            timeout: 15000,
          })
          .toBe("failed");
        const state = (await read()).json();
        expect(state.turns.at(-1).errorCode).toBe(
          "assistant_result_incomplete",
        );
        expect(state.turns.at(-1).assistantText ?? "").not.toContain(
          "操作结果已显示",
        );
        expect(
          state.turns.at(-1).tools.some((t: any) => t.status === "succeeded"),
        ).toBe(true);
      } finally {
        repeatRead = false;
        sessionId = previous;
      }
    },
  );
  it("keeps completed retries terminal and clears review when a new run starts", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "任务状态" },
      })
    ).json().draft.id;
    const record = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
        headers,
        payload: { question: "  示例  ", expectedOutput: "分类", metadata: [] },
      })
    ).json().record.id;
    const path = `/api/projects/${projectId}/processing-runs`;
    const initial = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: { kind: "draft", id: draft, recordIds: [record] },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    });
    expect(initial.statusCode, initial.body).toBe(201);
    const id = initial.json().run.id,
      db = createPool(databaseUrl);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='terminal-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [id],
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
      requestedTool = { name: "read_processing", input: { runId: id } };
      await send("核对结果");
      expect((await read()).json().task.review).toMatchObject({ total: 1 });
      requestedTool = { name: "retry_processing", input: { runId: id } };
      const retry = (await send("重试失败部分")).json();
      expect(
        retry.turns.find((t: any) => t.userText === "重试失败部分").tools[0]
          ?.result?.status,
      ).toBe("succeeded");
      expect(retry.task.stage).toBe("awaiting_review");
      expect(
        (
          await app.inject({ method: "GET", url: `${path}/${id}`, headers })
        ).json().run.status,
      ).toBe("succeeded");
      for (const replan of [null, "any", "none"]) {
        toolSequence = [
          {
            name: "refine_candidates",
            input: {
              runId: id,
              allSelected: true,
              instructions: "修正全部候选",
              allowedFields: ["question"],
            },
          },
          ...(replan
            ? [
                {
                  name: "plan_task",
                  input: {
                    title: "修正候选",
                    requirements: ["保留200条"],
                    ...(replan === "none" ? { nextAction: "none" } : {}),
                  },
                },
              ]
            : []),
          { name: "read_processing", input: { runId: id } },
        ];
        const failedSubmit = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "修正这批全部候选" },
        });
        expect(failedSubmit.statusCode, failedSubmit.body).toBe(202);
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.find(
                  (turn: any) => turn.id === failedSubmit.json().turnId,
                )?.status,
            { timeout: 15000 },
          )
          .toBe("failed");
        const notSubmitted = (await read()).json();
        expect(notSubmitted.turns.at(-1).tools[0].error.code).toBe(
          "assistant_candidate_selection_invalid",
        );
        expect(notSubmitted.turns.at(-1).status).toBe("failed");
        expect(notSubmitted.turns.at(-1).errorCode).toBe(
          "assistant_candidate_selection_invalid",
        );
        expect(notSubmitted.task.runId).toBe(id);
      }
      async function recoverProcessingReceipt(state: any, pending: string) {
        const db = createPool(databaseUrl);
        try {
          await db.query(
            "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed',assistant_text='' WHERE id=$1",
            [state.turns.at(-1).id],
          );
          await db.query(
            "UPDATE assistant_session SET task=task || $2::jsonb WHERE id=$1",
            [
              sessionId,
              JSON.stringify({ stage: "failed", nextAction: pending }),
            ],
          );
          const beforeRecovery = calls.length;
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
            .poll(async () => (await read()).json().turns.at(-1).status, {
              timeout: 15000,
            })
            .toBe("succeeded");
          expect((await read()).json().task.runId).toBe(state.task.runId);
          expect(calls.length).toBe(beforeRecovery);
        } finally {
          await db.end();
        }
      }
      toolSequence = [
        {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: "missing-draft" },
            allRecords: true,
            operation: "clean",
            instructions: "修正题目",
            allowedFields: ["question"],
          },
        },
        {
          name: "refine_candidates",
          input: {
            runId: id,
            where: { field: "question", operator: "contains", value: "" },
            instructions: "修正题目",
            allowedFields: ["question"],
          },
        },
      ];
      const actualCorrection = (await send("继续修正候选题目")).json();
      expect(actualCorrection.turns.at(-1).tools[0].status).toBe("failed");
      expect(actualCorrection.turns.at(-1).tools[1].result.runId).toBe(
        actualCorrection.task.runId,
      );
      expect(actualCorrection.task.runId).not.toBe(id);
      await recoverProcessingReceipt(actualCorrection, "submit_processing");
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: draft },
          allRecords: true,
          operation: "clean",
          instructions: "再清洗",
          allowedFields: ["question"],
        },
      };
      toolSequence = [
        {
          name: "refine_candidates",
          input: {
            runId: actualCorrection.task.runId,
            allSelected: true,
            instructions: "修正题目",
            allowedFields: ["question"],
          },
        },
        requestedTool,
      ];
      const started = (await send("开始新的清洗任务")).json();
      expect(started.task.runId).not.toBe(id);
      await recoverProcessingReceipt(started, "refine_candidates");
      expect(started.task.stage).toBe("processing");
      expect(started.task.review ?? null).toBeNull();
      expect(started.task.checkedStatus ?? null).toBeNull();
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
      expect((await read()).json().task.review ?? null).toBeNull();
    } finally {
      await db.end();
      sessionId = previous;
    }
  });
  it.each([true, false])(
    "recovers an invalid plan without losing an actual processing receipt (replan %s)",
    async (replan) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const ownDraft = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "定位恢复草稿" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${ownDraft}/records`,
        headers,
        payload: {
          question: "真实来源问题",
          expectedOutput: "正常回答",
          metadata: [],
        },
      });
      try {
        toolSequence = [
          {
            name: "plan_task",
            input: {
              title: "定位恢复",
              requirements: ["清洗当前草稿"],
              target: { kind: "assets" },
              nextAction: "submit_processing",
            },
          },
          ...(replan
            ? [
                { name: "query_project", input: { kind: "drafts" } },
                {
                  name: "plan_task",
                  input: {
                    title: "定位恢复",
                    requirements: ["清洗当前草稿"],
                    target: { kind: "draft", id: ownDraft },
                    nextAction: "submit_processing",
                  },
                },
              ]
            : []),
          {
            name: "submit_processing",
            input: {
              source: { kind: "draft", id: ownDraft },
              allRecords: true,
              operation: "clean",
              instructions: "清洗",
              allowedFields: ["question"],
            },
          },
        ];
        const state = (await send("先检查来源，再清洗当前草稿")).json();
        const turn = state.turns.at(-1);
        expect(turn.tools[0].error.code).toBe("assistant_source_invalid");
        if (replan)
          expect(
            turn.tools.find((entry: any) => entry.name === "query_project")
              ?.status,
          ).toBe("succeeded");
        expect(turn.status, JSON.stringify(state)).toBe("succeeded");
        expect(state.task.stage).toBe("processing");
        expect(state.task.runId).toBeTruthy();
        if (!replan) {
          const db = createPool(databaseUrl);
          try {
            await db.query(
              "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed',assistant_text='' WHERE id=$1",
              [turn.id],
            );
            await db.query(
              "UPDATE assistant_session SET task=task || $2::jsonb WHERE id=$1",
              [
                sessionId,
                JSON.stringify({ stage: "failed", nextAction: "plan_task" }),
              ],
            );
            const beforeRecovery = calls.length;
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
              .poll(async () => (await read()).json().turns.at(-1).status)
              .toBe("succeeded");
            const recovered = (await read()).json();
            expect(recovered.task.runId).toBe(state.task.runId);
            expect(recovered.task.stage).toBe("processing");
            expect(calls.length).toBe(beforeRecovery);
          } finally {
            await db.end();
          }
        }
      } finally {
        toolSequence = [];
        sessionId = previous;
      }
    },
  );
  it("does not end with false waiting when the planning object is invalid", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      requestedTool = {
        name: "plan_task",
        input: {
          title: "定位失败",
          requirements: ["按明确目标生成候选"],
          target: { kind: "version", id: "missing-version" },
          nextAction: "submit_processing",
        },
      };
      const result = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message: "请检查来源并生成候选" },
      });
      expect(result.statusCode).toBe(202);
      await expect
        .poll(async () => (await read()).json().turns.at(-1).status)
        .toBe("failed");
      const state = (await read()).json();
      expect(state.task.stage).toBe("failed");
      expect(state.task.nextAction).toBe("plan_task");
      expect(state.turns.at(-1).errorCode).toBe(
        "assistant_context_unavailable",
      );
      expect(state.turns.at(-1).tools[0].error.code).toBe(
        "assistant_context_unavailable",
      );
    } finally {
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it.each([false, true])(
    "resumes a saved legacy processing default with explicit fields (%s)",
    async (explicit) => {
      const previous = sessionId;
      const db = createPool(databaseUrl);
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const legacyDraft = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "旧回合恢复" },
        })
      ).json().draft.id;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collaborative-drafts/${legacyDraft}/records`,
            headers,
            payload: {
              question: " 示例 ",
              expectedOutput: "类别",
              metadata: [],
            },
          })
        ).statusCode,
      ).toBe(201);
      const input = {
        source: { kind: "draft", id: legacyDraft },
        allRecords: true,
        operation: "clean",
        instructions: "",
      };
      try {
        requestedTool = { name: "submit_processing", input };
        const submitted = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "仅清洗问题，保护其他字段" },
        });
        expect(submitted.statusCode).toBe(202);
        await expect
          .poll(async () => (await read()).json().turns.at(-1).status)
          .not.toMatch(/queued|running/);
        const turnId = submitted.json().turnId;
        const key = `assistant:${turnId}:${sha256(canonicalJson({ name: "submit_processing", input }))}`;
        // Upgrade fixture: the old application persisted this default before a failed effect.
        await db.query(
          "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed',assistant_text='',tool_results=$2 WHERE id=$1",
          [
            turnId,
            JSON.stringify([
              {
                key,
                name: "submit_processing",
                input,
                status: "failed",
                error: { code: "assistant_operation_failed" },
              },
            ]),
          ],
        );
        requestedTool = {
          name: "submit_processing",
          input: {
            ...input,
            ...(explicit ? { allowedFields: ["question"] } : {}),
          },
        };
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
          .poll(async () => (await read()).json().turns.at(-1).status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        const state = (await read()).json();
        expect(state.turns.at(-1).id).toBe(turnId);
        expect(state.turns.at(-1).tools).toHaveLength(1);
        expect(state.turns.at(-1).tools[0]).toMatchObject({
          key,
          status: "succeeded",
        });
        const run = (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-runs/${state.task.runId}`,
            headers,
          })
        ).json().run;
        expect(run.options.allowedFields).toEqual(["question"]);
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
        requestedTool = undefined;
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("reviews two runs in one task, replaces a refined branch, and adopts one asset with both real origins", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    const runIds: string[] = [];
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "连续扩充来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `${draftsPath}/${source}/records`,
        headers,
        payload: {
          question: "如何查询余额？",
          expectedOutput: "正常回答",
          metadata: [],
        },
      });
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const emptyTarget = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "空的连续任务目标" },
        })
      ).json().draft.id;
      requestedTool = {
        name: "plan_task",
        input: {
          title: "连续扩充两条",
          requirements: ["分两次共新增两条"],
          targetCount: 2,
          countKind: "final",
          targetDraftId: emptyTarget,
          nextAction: "none",
        },
      };
      await send("分两次共扩充两条");
      async function finish(runId: string) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='continuous-run-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [runId],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
        const result = await runProcessing(
          db,
          new ArtifactRepository(config.minio),
          config,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,updated_at=now() WHERE id=$1",
          [job.id, result],
        );
        await expect
          .poll(async () => (await read()).json().task.stage, {
            timeout: 15000,
          })
          .toBe("awaiting_review");
      }
      for (const message of ["先扩充一条", "再扩充一条"]) {
        requestedTool = {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            allRecords: true,
            operation: "augment",
            outputCount: 1,
            instructions:
              message === "再扩充一条"
                ? "新增第二个具体问题"
                : "新增一个具体问题",
            allowedFields: ["question"],
          },
        };
        const state = (await send(message)).json();
        expect(state.task.runId, JSON.stringify(state)).toBeTruthy();
        runIds.push(state.task.runId);
        await finish(state.task.runId);
      }
      const checked = (await read()).json();
      expect(checked.task.runIds).toEqual(runIds);
      expect(checked.task.review).toMatchObject({
        total: 2,
        expectedCount: 2,
        countSatisfied: true,
      });
      requestedTool = {
        name: "refine_candidates",
        input: {
          runId: runIds[1],
          resultIds: ["0:0"],
          instructions: "只改写这条问题",
          allowedFields: ["question"],
        },
      };
      const refined = (await send("第二条改得自然一点")).json().task.runId;
      expect(refined).not.toBe(runIds[1]);
      await finish(refined);
      expect((await read()).json().task.runIds).toEqual([runIds[0], refined]);
      expect((await read()).json().task.review.total).toBe(2);
      const reviewView = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?run=${refined}&view=all&limit=10`,
        headers,
      });
      expect(reviewView.statusCode, reviewView.body).toBe(200);
      expect(reviewView.json()).toMatchObject({ taskTotal: 2, total: 1 });
      expect(
        reviewView.json().effectiveRuns.map((item: any) => item.runId),
      ).toEqual([runIds[0], refined]);
      expect(reviewView.json().records[0].sourcePresentation.badges).toEqual([
        "模型扩写",
        "已改写",
      ]);
      for (const selection of [{ allValid: false }, { resultIds: ["0:0"] }]) {
        requestedTool = {
          name: "request_processing_apply",
          input: {
            runId: refined,
            allTask: true,
            ...selection,
            target: { kind: "draft", id: emptyTarget },
          },
        };
        const invalid = (await send("不要扩大这个不一致的选择")).json();
        expect(invalid.turns.at(-1).tools[0].error.code).toBe(
          "processing_result_invalid",
        );
        expect(invalid.proposals.some((p: any) => p.status === "pending")).toBe(
          false,
        );
      }
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: refined,
          allTask: true,
          target: {
            kind: "draft",
            id: emptyTarget,
          },
        },
      };
      const state = (await send("采用全部两条建立草稿")).json();
      const proposal = state.proposals.find(
        (p: any) => p.status === "pending" && p.action === "processing",
      );
      expect(proposal, JSON.stringify(state)).toBeTruthy();
      expect(proposal.summary.count).toBe(2);
      const confirm = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(confirm.statusCode, confirm.body).toBe(200);
      const receipt = confirm.json().receipt.receipt;
      expect(receipt.adopted).toBe(2);
      const contents = (
        await app.inject({
          method: "GET",
          url: `${draftsPath}/${receipt.draftId}`,
          headers,
        })
      ).json();
      expect(contents.records).toHaveLength(2);
      expect(
        new Set(contents.records.map((row: any) => row.source.assetId)),
      ).toEqual(new Set([receipt.assetId]));
      const origins = (
        await db.query(
          "SELECT sr.locator FROM source_record sr JOIN parsed_view pv ON pv.id=sr.parsed_view_id WHERE pv.asset_id=$1 ORDER BY sr.ordinal",
          [receipt.assetId],
        )
      ).rows.map((row) => row.locator);
      expect(origins.map((row) => row.processingRunId)).toEqual([
        runIds[0],
        refined,
      ]);
      const replay = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(replay.json().replayed).toBe(true);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${draftsPath}/${receipt.draftId}`,
            headers,
          })
        ).json().records,
      ).toHaveLength(2);
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: refined,
          allTask: true,
          allValid: true,
          target: { kind: "draft", id: receipt.draftId },
        },
      };
      const already = (await send("剩余结果继续加入这个草稿")).json();
      expect(already.turns.at(-1).tools[0].result).toMatchObject({
        alreadyAdopted: true,
        remainingCount: 0,
      });
      expect(
        already.proposals.filter(
          (proposal: any) => proposal.status === "pending",
        ),
      ).toHaveLength(0);
      const duplicateWithNewRevision = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs/${refined}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:0"],
          target: { kind: "draft", id: receipt.draftId, expectedRevision: 1 },
        },
      });
      expect(
        duplicateWithNewRevision.statusCode,
        duplicateWithNewRevision.body,
      ).toBe(409);
      expect(duplicateWithNewRevision.json().error.code).toBe(
        "processing_already_adopted",
      );
      requestedTool = {
        name: "preview_selection",
        input: {
          draftId: receipt.draftId,
          assetIds: [receipt.assetId],
          method: "random",
          conditions: [],
          mode: "count",
          value: 1,
          seed: "preview-followup",
        },
      };
      const selected = (await send("随机选一条")).json();
      expect(
        selected.task.processingScope,
        JSON.stringify(selected),
      ).toMatchObject({
        source: { kind: "assets", assetIds: [receipt.assetId] },
        count: 1,
      });
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "assets", assetIds: [receipt.assetId] },
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      };
      const following = (await send("清洗刚才选中的这一条")).json();
      expect(following.task.runId, JSON.stringify(following)).toBeTruthy();
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-runs/${following.task.runId}`,
            headers,
          })
        ).json().run.inputCount,
      ).toBe(1);
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      const sourceRows: (SelectionRecord & {
        id: string;
        source: { assetId: string; ordinal: number };
      })[] = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/processing-inputs`,
          headers,
          payload: {
            source: { kind: "assets", assetIds: [receipt.assetId] },
            limit: 100,
          },
        })
      ).json().records;
      const configuration = {
        method: "random",
        conditions: [],
        mode: "count",
        value: 1,
        seed: "",
      };
      const identities = sourceRows.map((row) => ({
        ...row,
        assetId: row.source.assetId,
        ordinal: row.source.ordinal,
      }));
      configuration.seed = Array.from(
        { length: 100 },
        (_, i) => `identity-${i}`,
      ).find((seed) => {
        const correct = selectRecords(identities, { ...configuration, seed })
          .selected[0].id;
        const temporary = selectRecords(
          sourceRows.map((row, ordinal) => ({
            ...row,
            assetId: "input",
            ordinal,
          })),
          { ...configuration, seed },
        ).selected[0].id;
        return correct !== temporary;
      })!;
      expect(configuration.seed).toBeTruthy();
      const expectedId = selectRecords(identities, configuration).selected[0]
        .id;
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "assets", assetIds: [receipt.assetId] },
          selection: configuration,
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      };
      const ranked = (await send("按相同种子抽取一条清洗")).json();
      const rankedRun = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${ranked.task.runId}`,
          headers,
        })
      ).json();
      expect(rankedRun.run.source.recordIds).toEqual([expectedId]);
    } finally {
      requestedTool = undefined;
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it("does not hide six independent source files inside one aggregated task asset", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const collectionId = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collections`,
          headers,
        })
      ).json().collections[0].id;
      const assets: string[] = [];
      for (let i = 0; i < 6; i++) {
        const uploaded = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/pending-uploads`,
          headers: {
            ...headers,
            "content-type": "text/csv",
            "x-file-name": `independent-${i}.csv`,
          },
          payload: `question,answer\n来源问题${i},正常回答\n`,
        });
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        const confirmed = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            collectionId,
            pendingUploadIds: [uploaded.json().pendingUpload.id],
            mode: "raw",
          },
        });
        expect(confirmed.statusCode, confirmed.body).toBe(201);
        const assetId = confirmed.json().assets[0].id,
          mappingPath = `/api/projects/${projectId}/assets/${assetId}/mapping`;
        const raw = (
          await app.inject({ method: "GET", url: mappingPath, headers })
        ).json();
        const mapping = await app.inject({
          method: "PUT",
          url: mappingPath,
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
        });
        expect(mapping.statusCode, mapping.body).toBe(200);
        assets.push(assetId);
      }
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      let runId;
      for (const assetIds of [assets.slice(0, 3), assets.slice(3)]) {
        requestedTool = {
          name: "submit_processing",
          input: {
            source: { kind: "assets", assetIds },
            allRecords: true,
            operation: "augment",
            outputCount: 1,
            instructions:
              assetIds[0] === assets[0]
                ? "扩充一个具体问题"
                : "新增第二个具体问题",
            allowedFields: ["question"],
          },
        };
        toolReply = "处理已完成，所有候选已经可用。";
        const queued = (await send("按这三份来源扩充一条")).json();
        toolReply = undefined;
        expect(queued.turns.at(-1).assistantText).toContain("任务已提交");
        expect(queued.turns.at(-1).assistantText).not.toContain("处理已完成");
        runId = queued.task.runId;
        expect(runId).toBeTruthy();
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='independent-source-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [runId],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
        const result = await runProcessing(
          db,
          new ArtifactRepository(config.minio),
          config,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,updated_at=now() WHERE id=$1",
          [job.id, result],
        );
        await expect
          .poll(async () => (await read()).json().task.stage, {
            timeout: 15000,
          })
          .toBe("awaiting_review");
      }
      const applyInput = {
        runId,
        allTask: true,
        allValid: true,
        target: {
          kind: "newDraft",
          name: "独立来源超限",
          purpose: "不以聚合绕过容量",
        },
      };
      await expect
        .poll(
          async () => {
            const state = (await read()).json();
            return (
              state.turns.at(-1)?.event === "processing_completed" &&
              state.turns.at(-1)?.status === "succeeded" &&
              !state.turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              )
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "只采用第一批来源",
            requirements: ["只采用前三份来源的成果"],
            target: { kind: "assets", assetIds: assets.slice(0, 3) },
            targetCount: 2,
            countKind: "new",
            nextAction: "request_processing_apply",
          },
        },
        { name: "request_processing_apply", input: applyInput },
      ];
      const rejected = (
        await send("更正为只采用前三份来源", undefined, "failed")
      ).json();
      expect(
        rejected.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "request_processing_apply"),
        JSON.stringify({ task: rejected.task, turn: rejected.turns.at(-1) }),
      ).toMatchObject({
        status: "failed",
        error: { code: "assistant_candidate_review_incomplete" },
      });
      expect(rejected.task.review.complete).toBe(false);
      expect(rejected.task.review).toMatchObject({
        total: 1,
        countSatisfied: false,
        compatibilityProblem: null,
      });
      expect(
        rejected.proposals.some((item: any) => item.status === "pending"),
      ).toBe(false);
      const selected = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${runId}`,
          headers,
        })
      ).json().records[0].id;
      for (const selection of [{ allValid: true }, { resultIds: [selected] }]) {
        toolSequence = [
          {
            name: "plan_task",
            input: {
              title: "只采用第一批来源",
              requirements: ["只采用前三份来源的成果"],
              target: { kind: "assets", assetIds: assets.slice(0, 3) },
              nextAction: "request_processing_apply",
            },
          },
          {
            name: "request_processing_apply",
            input: { runId, ...selection, target: applyInput.target },
          },
        ];
        const partial = (
          await send("只采用指定候选", undefined, "failed")
        ).json();
        expect(
          partial.turns
            .at(-1)
            .tools.find(
              (tool: any) => tool.name === "request_processing_apply",
            ),
        ).toMatchObject({
          status: "failed",
          error: { code: "processing_result_invalid" },
        });
        expect(
          partial.proposals.some((item: any) => item.status === "pending"),
        ).toBe(false);
      }
      const reads = [assets.slice(0, 3), assets.slice(3)].map(
        (assetIds, index) => ({
          title: `核对第${index + 1}批真实来源`,
          action: "read_records",
          scope: "all",
          input: { source: { kind: "assets", assetIds }, offset: 0, limit: 20 },
        }),
      );
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "核对并合并两批来源",
            requirements: ["核对两批来源后一起加入新草稿"],
            targetCount: 2,
            countKind: "new",
            executionMode: "execute",
            steps: [
              ...reads,
              { title: "准备采用确认", action: "request_processing_apply" },
            ],
          },
        },
        ...reads.map((step) => ({ name: step.action, input: step.input })),
        { name: "request_processing_apply", input: applyInput },
      ];
      const state = (await send("将两批结果一起加入新草稿")).json(),
        proposal = state.proposals.find(
          (proposal: any) => proposal.status === "pending",
        );
      expect(proposal, JSON.stringify(state)).toBeTruthy();
      expect(
        state.task.executionPlan.steps
          .slice(0, 2)
          .every((step: any) => step.status === "executed"),
      ).toBe(true);
      const confirmed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(422);
      expect(confirmed.json().error.code).toBe("processing_capacity_exceeded");
      expect(
        (
          await db.query(
            "SELECT 1 FROM collaborative_draft WHERE project_id=$1 AND name='独立来源超限'",
            [projectId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      toolReply = undefined;
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it.each([0, 1])(
    "keeps adopted candidate identity through partial refinement and two generations (adopted %i)",
    async (acceptedIndex) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
      try {
        const source = (
          await app.inject({
            method: "POST",
            url: draftsPath,
            headers,
            payload: { name: "部分采用来源" },
          })
        ).json().draft.id;
        for (const output of ["第一类", "第二类"])
          await app.inject({
            method: "POST",
            url: `${draftsPath}/${source}/records`,
            headers,
            payload: {
              question: `具体问题 ${output}`,
              expectedOutput: output,
              metadata: [],
            },
          });
        sessionId = (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions`,
            headers,
            payload: {},
          })
        ).json().sessionId;
        requestedTool = {
          name: "plan_task",
          input: {
            title: "新增两条",
            requirements: ["分次采用共两条"],
            targetCount: 2,
            countKind: "new",
            nextAction: "none",
          },
        };
        await send("新增两条");
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
        const artifacts = new ArtifactRepository(config.minio);
        async function finish(runId: string) {
          const job = (
            await db.query(
              "UPDATE job SET status='running',attempt=1,lease_owner='origin-test',lease_expires_at=now()+interval '60 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
              [runId],
            )
          ).rows[0];
          const result = await runProcessing(db, artifacts, config, job);
          await db.query(
            "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
            [job.id, result],
          );
          await expect
            .poll(async () => (await read()).json().task.stage, {
              timeout: 15000,
            })
            .toBe("awaiting_review");
        }
        requestedTool = {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            allRecords: true,
            operation: "augment",
            outputCount: 2,
            instructions: "生成两条具体问题",
            allowedFields: ["question"],
          },
        };
        const parent = (await send("扩充两条")).json().task.runId;
        await finish(parent);
        requestedTool = {
          name: "request_processing_apply",
          input: {
            runId: parent,
            resultIds: [`0:${acceptedIndex}`],
            target: {
              kind: "newDraft",
              name: "部分采用结果",
              purpose: "身份回归",
            },
          },
        };
        const pending = (await send("先采用第一条"))
          .json()
          .proposals.find((p: any) => p.status === "pending");
        const confirmed = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${pending.id}/confirm`,
          headers,
          payload: {},
        });
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        const targetId = confirmed.json().receipt.receipt.draftId;
        await expect
          .poll(async () => (await read()).json().turns.at(-1)?.status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        for (let generation = 0; generation < 2; generation++) {
          const runId = (await read()).json().task.runId;
          requestedTool = {
            name: "refine_candidates",
            input: {
              runId,
              resultIds: [`0:${1 - acceptedIndex}`],
              instructions: "第二条更自然",
              allowedFields: ["question"],
            },
          };
          const child = (await send("只重改第二条")).json().task.runId;
          expect(child).not.toBe(runId);
          await finish(child);
        }
        const child = (await read()).json().task.runId;
        requestedTool = {
          name: "request_processing_apply",
          input: {
            runId: child,
            allValid: true,
            target: { kind: "draft", id: targetId },
          },
        };
        const remaining = (await send("把剩余结果加入同一草稿"))
          .json()
          .proposals.find((p: any) => p.status === "pending");
        expect(remaining.summary.count).toBe(1);
        requestedTool = {
          name: "plan_task",
          input: {
            title: "最终两条",
            requirements: ["最终总数两条"],
            targetCount: 2,
            countKind: "final",
            targetDraftId: targetId,
            nextAction: "none",
          },
        };
        await send("核对最终两条");
        requestedTool = { name: "read_processing", input: { runId: child } };
        const inspected = (await send("查看当前数量")).json();
        expect(inspected.task.review).toMatchObject({
          total: 2,
          baseCount: 1,
          candidateCount: 2,
          remainingCount: 1,
        });
        requestedTool = {
          name: "refine_candidates",
          input: {
            runId: child,
            resultIds: [`0:${acceptedIndex}`],
            instructions: "再改第一条",
            allowedFields: ["question"],
          },
        };
        const rejected = (
          await send("重改已采用的第一条", undefined, "failed")
        ).json();
        expect(rejected.turns.at(-1).tools[0].error.code).toBe(
          "processing_already_adopted",
        );
        requestedTool = {
          name: "request_processing_apply",
          input: {
            runId: child,
            allValid: true,
            target: { kind: "draft", id: targetId },
          },
        };
        const last = (await send("采用剩余一条"))
          .json()
          .proposals.find((p: any) => p.status === "pending");
        const adopted = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${last.id}/confirm`,
          headers,
          payload: {},
        });
        expect(adopted.statusCode, adopted.body).toBe(200);
        const contents = (
          await app.inject({
            method: "GET",
            url: `${draftsPath}/${targetId}`,
            headers,
          })
        ).json();
        expect(contents.records).toHaveLength(2);
      } finally {
        requestedTool = undefined;
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("counts the final draft together with remaining candidates without counting adopted rows twice", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "最终数量来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `${draftsPath}/${source}/records`,
        headers,
        payload: {
          question: "原有余额查询问题",
          expectedOutput: "正常回答",
          metadata: [],
        },
      });
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      requestedTool = {
        name: "plan_task",
        input: {
          title: "补到两条",
          requirements: ["保留已有内容，最终总数两条"],
          targetCount: 2,
          countKind: "final",
          targetDraftId: source,
          nextAction: "none",
        },
      };
      const planned = (await send("把这个草稿补到两条")).json();
      expect(planned.task.countKind, JSON.stringify(planned)).toBe("final");
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          operation: "augment",
          outputCount: 1,
          instructions: "新增一条具体问题",
          allowedFields: ["question"],
        },
      };
      const runId = (await send("再新增一条就够了")).json().task.runId;
      expect(runId).toBeTruthy();
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='final-count-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2,updated_at=now() WHERE id=$1",
        [job.id, result],
      );
      await expect
        .poll(async () => (await read()).json().task.review?.total, {
          timeout: 15000,
        })
        .toBe(2);
      expect((await read()).json().task.review).toMatchObject({
        countKind: "final",
        baseCount: 1,
        candidateCount: 1,
        remainingCount: 1,
        expectedCount: 2,
        countSatisfied: true,
      });
      requestedTool = { name: "request_publish", input: { draftId: source } };
      const premature = (await send("直接发布当前实际内容")).json();
      expect(
        premature.proposals.filter(
          (p: any) => p.action === "publish" && p.status === "pending",
        ),
      ).toHaveLength(0);
      expect(premature.task.review).toMatchObject({
        total: 1,
        countSatisfied: false,
      });
      requestedTool = {
        name: "plan_task",
        input: {
          title: "核对当前内容",
          requirements: ["保留已有内容，不再限定最终条数"],
          targetCount: null,
          nextAction: "none",
        },
      };
      await send("不再限定最终条数，仍保留已有内容");
      requestedTool = { name: "read_processing", input: { runId } };
      expect((await send("核对当前候选")).json().task.review).toMatchObject({
        total: 2,
        countKind: "final",
        baseCount: 1,
        candidateCount: 1,
        expectedCount: null,
        countSatisfied: true,
      });
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId,
          allTask: true,
          allValid: true,
          target: { kind: "draft", id: source },
        },
      };
      const state = (await send("采用这条结果")).json(),
        proposal = state.proposals.find(
          (proposal: any) => proposal.status === "pending",
        );
      expect(proposal, JSON.stringify(state)).toBeTruthy();
      const confirmed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      await expect
        .poll(async () => (await read()).json().turns.at(-1)?.status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      requestedTool = { name: "read_processing", input: { runId } };
      const adopted = (await send("现在还需要补多少？")).json();
      expect(adopted.task.review).toMatchObject({
        total: 2,
        baseCount: 2,
        candidateCount: 1,
        remainingCount: 0,
        countSatisfied: true,
      });
      requestedTool = {
        name: "plan_task",
        input: {
          title: "改看新增数量",
          requirements: ["核对本次新增一条"],
          targetCount: 1,
          countKind: "new",
          nextAction: "none",
        },
      };
      await send("我指的是新增一条");
      requestedTool = { name: "read_processing", input: { runId } };
      expect((await send("核对新增数量")).json().task.review).toMatchObject({
        total: 1,
        countKind: "new",
        expectedCount: 1,
        countSatisfied: true,
      });
      requestedTool = { name: "request_publish", input: { draftId: source } };
      const publishable = (await send("发布新增一条后的草稿")).json();
      expect(
        publishable.proposals.some(
          (p: any) => p.action === "publish" && p.status === "pending",
        ),
      ).toBe(true);
      expect(publishable.task.review).toMatchObject({
        countKind: "new",
        total: 1,
        deliveryComplete: true,
      });
      // A legacy pending card must be checked against the current contract at confirmation too.
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{targetCount}','2') WHERE id=$1",
        [sessionId],
      );
      const pendingPublish = publishable.proposals.find(
        (p: any) => p.action === "publish" && p.status === "pending",
      );
      const rejected = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${pendingPublish.id}/confirm`,
        headers,
        payload: {},
      });
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json().error.code).toBe(
        "assistant_candidate_review_incomplete",
      );
      requestedTool = { name: "read_processing", input: { runId } };
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/proposals/${pendingPublish.id}/reject`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{targetCount}','1') WHERE id=$1",
        [sessionId],
      );
      await db.query(
        "UPDATE processing_acceptance SET receipt=receipt-'candidateOrigins' WHERE draft_id=$1",
        [source],
      );
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              ),
          { timeout: 15000 },
        )
        .toBe(false);
      requestedTool = { name: "request_publish", input: { draftId: source } };
      const legacy = (await send("按实际新增一条发布")).json();
      expect(legacy.task.review, JSON.stringify(legacy)).toMatchObject({
        total: 1,
        deliveryComplete: true,
      });
      requestedTool = { name: "read_processing", input: { runId } };
      const ready = legacy.proposals.find(
        (p: any) => p.action === "publish" && p.status === "pending",
      );
      const published = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${ready.id}/confirm`,
        headers,
        payload: {},
      });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json().receipt.version.recordCount).toBe(2);
    } finally {
      requestedTool = undefined;
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it("stops every pending run of the same task and restricts candidate access to its current leaves", async () => {
    const previous = sessionId;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "停止全部批次来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
        headers,
        payload: { question: "合成问题", expectedOutput: "", metadata: [] },
      });
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const runs: string[] = [];
      for (const message of ["第一批扩充", "第二批扩充"]) {
        requestedTool = {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            operation: "augment",
            allRecords: true,
            outputCount: 1,
            instructions: "新增一条",
            allowedFields: ["question"],
          },
        };
        const state = (await send(message)).json();
        expect(state.task.runId, JSON.stringify(state)).toBeTruthy();
        runs.push(state.task.runId);
      }
      expect((await read()).json().task.runIds).toEqual(runs);
      const stopped = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      for (const run of runs)
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/processing-runs/${run}/status`,
              headers,
            })
          ).json().run.status,
        ).toBe("cancel_requested");
      const outside = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?run=outside`,
        headers,
      });
      expect(outside.statusCode).toBe(409);
      const inside = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?run=${runs[0]}`,
        headers,
      });
      expect(inside.statusCode, inside.body).toBe(200);
      const workspace = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?run=${runs[0]}&view=all`,
        headers,
      });
      expect(workspace.statusCode, workspace.body).toBe(200);
      expect(workspace.json()).toMatchObject({
        taskTotal: 0,
        total: 0,
        stats: { all: 0, changed: 0, needsReview: 0 },
      });
      expect(workspace.json().effectiveRuns).toHaveLength(2);
    } finally {
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it("locates matching background text without losing its true original line range", async () => {
    const own = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const text = Array.from({ length: 100 }, (_, i) =>
      i === 82 ? "关键 要求：覆盖附录 A 所有风险。" : `背景第${i + 1}行`,
    ).join("\n");
    const uploaded = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${own}/background-documents`,
      headers,
      payload: {
        fileName: "长文背景.md",
        contentBase64: Buffer.from(text).toString("base64"),
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const path = `${base()}/sessions/${own}/background-documents/${uploaded.json().document.id}`;
    const found = await app.inject({
      method: "GET",
      url: `${path}?query=${encodeURIComponent("关键要求")}&from=1&limit=1`,
      headers,
    });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json().fragments).toHaveLength(1);
    expect(found.json().fragments[0]).toMatchObject({
      index: 3,
      startLine: 81,
      endLine: 100,
    });
    expect(found.json().matchCount).toBe(1);
    expect(found.json().nextFrom).toBeNull();
    const first = await app.inject({
      method: "GET",
      url: `${path}?from=1&limit=2`,
      headers,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().nextFrom).toBe(3);
    const last = await app.inject({
      method: "GET",
      url: `${path}?from=${first.json().nextFrom}&limit=3`,
      headers,
    });
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json().fragments[0].index).toBe(3);
    expect(last.json().nextFrom).toBeNull();
    const filtered = await app.inject({
      method: "GET",
      url: `${path}?query=${encodeURIComponent("背景")}&from=1&limit=1`,
      headers,
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().nextFrom).toBe(2);
    const continued = await app.inject({
      method: "GET",
      url: `${path}?query=${encodeURIComponent("背景")}&from=${filtered.json().nextFrom}&limit=1`,
      headers,
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect(continued.json().fragments[0].index).toBe(2);
    const absent = await app.inject({
      method: "GET",
      url: `${path}?query=${encodeURIComponent("不存在的要求")}&from=1&limit=3`,
      headers,
    });
    expect(absent.statusCode).toBe(200);
    expect(absent.json().fragments).toEqual([]);
    expect(absent.json().matchCount).toBe(0);
    expect(absent.json().nextFrom).toBeNull();
    expect(absent.json().navigationHint).toContain("没有匹配文本");
    expect(absent.json().navigationHint).toContain("省略query");
  });
  it("uses a short task title without losing the full original goal", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      requestedTool = { name: "query_project", input: { kind: "project" } };
      const goal =
        "本会话命名为“资料查询验收”。请查询所有资料，保留原始内容，不创建任何数据。";
      const state = (await send(goal)).json();
      expect(state.task.title).toBe("资料查询验收");
      expect(state.task.goal).toBe(goal);
    } finally {
      sessionId = previous;
    }
  });
  it("preserves a plan title equal to its original short goal", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      requestedTool = {
        name: "plan_task",
        input: {
          title: "核对结果",
          requirements: ["解释核对方法"],
          nextAction: "none",
        },
      };
      const state = (await send("核对结果")).json();
      expect(state.task.title).toBe("核对结果");
      expect(state.title).toBe("核对结果");
    } finally {
      sessionId = previous;
    }
  });
  it("reflects an exact processing-page adoption and replays it without appending twice", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`,
      runsPath = `/api/projects/${projectId}/processing-runs`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "同步来源" },
        })
      ).json().draft.id;
      const recordIds: string[] = [];
      for (const question of ["  First  ", "  Second  "]) {
        const response = await app.inject({
          method: "POST",
          url: `${draftsPath}/${source}/records`,
          headers,
          payload: {
            question,
            expectedOutput: "",
            metadata: [
              {
                key: "风险类别",
                value: question.includes("First") ? "A.1a" : "A.2a",
              },
            ],
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        recordIds.push(response.json().record.id);
      }
      const target = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "同步目标" },
        })
      ).json().draft.id;
      const otherTarget = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "其他目标" },
        })
      ).json().draft.id;
      const submitted = await app.inject({
        method: "POST",
        url: runsPath,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: source, recordIds },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const run = submitted.json().run;
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='adoption-sync-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      const config = { ...loadConfig(), databaseUrl };
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      requestedTool = {
        name: "plan_task",
        input: {
          title: "清洗并核对",
          requirements: ["两条，类别各一条"],
          targetCount: 2,
          classifications: [
            {
              field: "metadata",
              key: "风险类别",
              allowedValues: ["A.1a", "A.2a"],
              quotas: [
                { value: "A.1a", count: 1 },
                { value: "A.2a", count: 1 },
              ],
            },
          ],
          nextAction: "none",
        },
      };
      expect(
        (await send("核对这两条分类")).json().task.classifications,
      ).toHaveLength(1);
      requestedTool = { name: "read_processing", input: { runId: run.id } };
      const checked = (await send("核对结果")).json().task.review;
      expect(checked.classifications[0]).toMatchObject({
        missing: 0,
        outsideValues: 0,
        satisfied: true,
      });
      expect(checked.classifications[0].values).toEqual([
        { value: "A.1a", count: 1 },
        { value: "A.2a", count: 1 },
      ]);
      expect(checked.semanticReview).toBe("required");
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: run.id,
          allValid: true,
          target: { kind: "draft", id: target },
        },
      };
      const initial = (await send("把这两条清洗结果加入同步目标草稿")).json();
      const proposal = initial.proposals.find(
        (p: any) => p.action === "processing",
      );
      expect(proposal, JSON.stringify(initial)).toBeTruthy();
      expect(proposal.status).toBe("pending");
      const adopt = (id: string, key = randomUUID()) =>
        app.inject({
          method: "POST",
          url: `${runsPath}/${run.id}/accept`,
          headers: { ...headers, "idempotency-key": key },
          payload: {
            resultIds: ["0:0", "0:1"],
            target: { kind: "draft", id, expectedRevision: 0 },
          },
        });
      const elsewhere = await adopt(otherTarget);
      expect(elsewhere.statusCode, elsewhere.body).toBe(201);
      expect(
        (await read()).json().proposals.find((p: any) => p.id === proposal.id)
          .status,
      ).toBe("pending");
      const adopted = await adopt(target);
      expect(adopted.statusCode, adopted.body).toBe(201);
      const repeatedKey = randomUUID();
      const repeatedFromPage = await adopt(target, repeatedKey);
      expect(repeatedFromPage.statusCode, repeatedFromPage.body).toBe(200);
      expect(repeatedFromPage.json().receipt).toEqual(adopted.json().receipt);
      const changedRequest = await app.inject({
        method: "POST",
        url: `${runsPath}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": repeatedKey },
        payload: {
          resultIds: ["0:0"],
          target: { kind: "draft", id: target, expectedRevision: 0 },
        },
      });
      expect(changedRequest.statusCode).toBe(409);
      expect(changedRequest.json().error.code).toBe("idempotency_conflict");
      const state = (await read()).json();
      const reflected = state.proposals.find((p: any) => p.id === proposal.id);
      expect(reflected.status).toBe("succeeded");
      expect(reflected.receipt.receipt).toEqual(adopted.json().receipt);
      const repeated = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json().replayed).toBe(true);
      const contents = await app.inject({
        method: "GET",
        url: `${draftsPath}/${target}`,
        headers,
      });
      expect(contents.json().total).toBe(2);
      expect(contents.json().records.map((r: any) => r.question)).toEqual([
        "First",
        "Second",
      ]);
    } finally {
      requestedTool = undefined;
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              ),
          { timeout: 15000 },
        )
        .toBe(false);
      sessionId = previous;
      await db.end();
    }
  });
  it("prepares a short selection and reuses only that frozen scope in the same conversation", async () => {
    const previous = sessionId;
    const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    const source = (
      await app.inject({
        method: "POST",
        url: draftsPath,
        headers,
        payload: { name: "短请求来源" },
      })
    ).json().draft.id;
    const other = (
      await app.inject({
        method: "POST",
        url: draftsPath,
        headers,
        payload: { name: "未选中的其他来源" },
      })
    ).json().draft.id;
    for (const question of ["第一条", "第二条", "第三条"])
      await app.inject({
        method: "POST",
        url: `${draftsPath}/${source}/records`,
        headers,
        payload: { question, expectedOutput: "保留", metadata: [] },
      });
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          selection: {
            method: "random",
            conditions: [],
            mode: "count",
            value: 1,
            seed: "short-request",
          },
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      };
      const first = (await send("随机抽一条清洗")).json();
      expect(first.task.runId, JSON.stringify(first)).toBeTruthy();
      const runPath = `/api/projects/${projectId}/processing-runs`;
      const initial = (
        await app.inject({
          method: "GET",
          url: `${runPath}/${first.task.runId}`,
          headers,
        })
      ).json();
      expect(initial.run.inputCount).toBe(1);
      expect(first.task.processingScope.count).toBe(1);
      expect(first.task.processingScope.recordIds).toBeUndefined();
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      };
      const second = (await send("继续清洗刚才选中的那一条")).json();
      const reused = (
        await app.inject({
          method: "GET",
          url: `${runPath}/${second.task.runId}`,
          headers,
        })
      ).json();
      expect(reused.run.source.recordIds).toEqual(initial.run.source.recordIds);
      expect(reused.run.inputCount).toBe(1);
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: other },
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      };
      const different = (
        await send("清洗另一个草稿", undefined, "failed")
      ).json();
      expect(different.turns.at(-1).tools[0].error.code).toBe(
        "processing_scope_invalid",
      );
      expect(different.task.runId).toBeUndefined();
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      await app.inject({
        method: "POST",
        url: `${draftsPath}/${source}/records`,
        headers,
        payload: {
          question: "来源后来新增",
          expectedOutput: "保留",
          metadata: [],
        },
      });
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      };
      const changed = (
        await send("继续刚才选中的那一条", undefined, "failed")
      ).json();
      expect(changed.turns.at(-1).tools[0].error.code).toBe(
        "processing_scope_changed",
      );
      expect(changed.task.runId).toBeUndefined();
    } finally {
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it("persists personal background documents with true locations and removes their conversation copies", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const path = `${base()}/sessions/${sessionId}/background-documents`;
      const payload = {
        fileName: "要求.md",
        contentBase64: Buffer.from(
          "# 背景\n生成 200 条，类别覆盖附件标准。\n",
        ).toString("base64"),
      };
      const uploaded = await app.inject({
        method: "POST",
        url: path,
        headers,
        payload,
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const document = uploaded.json().document;
      expect(document).toMatchObject({
        fileName: "要求.md",
        format: "md",
        units: 3,
        extractorVersion: "background-text-v1",
      });
      expect(document.fragments).toBeUndefined();
      expect(document.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await read()).json().backgroundDocuments).toHaveLength(1);
      const replayed = await app.inject({
        method: "POST",
        url: path,
        headers,
        payload,
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json().document.id).toBe(document.id);
      const excerpt = await app.inject({
        method: "GET",
        url: `${path}/${document.id}?from=1&limit=1`,
        headers,
      });
      expect(excerpt.statusCode, excerpt.body).toBe(200);
      expect(excerpt.json().fragments).toEqual([
        {
          index: 1,
          startLine: 1,
          endLine: 3,
          text: "# 背景\n生成 200 条，类别覆盖附件标准。\n",
        },
      ]);
      const removed = await app.inject({
        method: "DELETE",
        url: `${path}/${document.id}`,
        headers,
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await read()).json().backgroundDocuments).toEqual([]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${path}/${document.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      sessionId = previous;
    }
  });
  it("keeps the full model request below the byte budget when background requires smaller batches", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "预算来源" },
        })
      ).json().draft.id;
      for (const output of ["一", "二"])
        await app.inject({
          method: "POST",
          url: `${draftsPath}/${source}/records`,
          headers,
          payload: {
            question: "Q".repeat(8000),
            expectedOutput: output,
            metadata: [],
          },
        });
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const uploaded = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/background-documents`,
        headers,
        payload: {
          fileName: "预算.txt",
          contentBase64: Buffer.from("B".repeat(24000)).toString("base64"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      for (const from of [1, 4, 7, 10]) {
        requestedTool = {
          name: "read_background",
          input: { documentId: uploaded.json().document.id, from, limit: 3 },
        };
        await send("读取背景后面的片段");
      }
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          operation: "rewrite",
          instructions: "按背景改写",
          allowedFields: ["question"],
        },
      };
      const runId = (await send("开始改写这两条")).json().task.runId;
      expect(runId).toBeTruthy();
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='budget-test',lease_expires_at=now()+interval '60 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const callStart = calls.length;
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      const actual = calls.slice(callStart).filter((call) => !call.tools);
      expect(actual.length).toBe(2);
      for (const call of actual) {
        expect(
          Buffer.byteLength(call.messages.map((m: any) => m.content).join("")),
        ).toBeLessThanOrEqual(40000);
        expect(
          JSON.parse(call.messages.at(-1).content).background.documents[0]
            .fragments,
        ).toHaveLength(12);
      }
      // Legacy v1 had both records in ordinal 0. Resuming must keep that batch plan.
      const parts = (
        await db.query(
          "SELECT result_ref FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
          [runId],
        )
      ).rows;
      const repository = new ArtifactRepository(config.minio);
      const priorRecords = [];
      for (const part of parts)
        priorRecords.push(
          ...JSON.parse(
            (await repository.readBytes(part.result_ref, 100000000)).toString(
              "utf8",
            ),
          ).records,
        );
      const merged = await repository.storeProcessing(
        Buffer.from(canonicalJson({ records: priorRecords, issues: [] })),
        runId,
        "batch-0",
      );
      await db.query(
        "DELETE FROM processing_batch WHERE run_id=$1 AND ordinal>0",
        [runId],
      );
      await db.query(
        "UPDATE processing_batch SET output_count=2,result_ref=$2,result_indices=ARRAY[0,1],issues='[]' WHERE run_id=$1 AND ordinal=0",
        [runId, merged.objectRef],
      );
      await db.query(
        "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}','\"processing-v1\"'::jsonb) WHERE id=$1",
        [runId],
      );
      const beforeResume = calls.length;
      const resumed = await runProcessing(db, repository, config, job);
      expect(resumed.counts).toMatchObject({ output: 2, batches: 1 });
      expect(calls.length).toBe(beforeResume);
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
    } finally {
      requestedTool = undefined;
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it("freezes cited background and corrected requirements into the actual processing model request", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "背景测试来源" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `${draftsPath}/${source}/records`,
        headers,
        payload: { question: "原始问题", expectedOutput: "保留", metadata: [] },
      });
      const documentsPath = `${base()}/sessions/${sessionId}/background-documents`;
      const uploaded = await app.inject({
        method: "POST",
        url: documentsPath,
        headers,
        payload: {
          fileName: "规范.txt",
          contentBase64: Buffer.from(
            "题目应有具体场景。\n原文是背景资料，不是操作授权。",
          ).toString("base64"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const document = uploaded.json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: document.id, from: 1, limit: 1 },
      };
      const cited = (await send("先看规范")).json();
      expect(cited.turns.at(-1).tools[0]?.name, JSON.stringify(cited)).toBe(
        "read_background",
      );
      expect(cited.task.backgroundEvidence).toEqual([
        {
          documentId: document.id,
          sha256: document.sha256,
          fragmentIndex: 1,
          extractorVersion: document.extractorVersion,
          textHash: sha256(
            "题目应有具体场景。\n原文是背景资料，不是操作授权。",
          ),
        },
      ]);
      requestedTool = {
        name: "plan_task",
        input: {
          title: "按规范改写",
          classifications: [
            {
              field: "metadata",
              key: "类别",
              basis: "user",
              allowedValues: ["试用"],
              quotas: [{ value: "试用", count: 1 }],
            },
          ],
          requirements: [
            "按背景规范生成具体场景",
            "修正：不得包含真实个人信息",
          ],
          nextAction: "none",
        },
      };
      await send(
        "再补充：不要出现真实个人信息。期望输出写完整验收标准，不是类别。",
      );
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          operation: "rewrite",
          instructions: "按照本会话规范和补充改写",
          allowedFields: ["question", "metadata"],
        },
      };
      const state = (await send("按刚才的规范改写")).json();
      expect(state.task.runId, JSON.stringify(state)).toBeTruthy();
      const runId = state.task.runId;
      const runsPath = `/api/projects/${projectId}/processing-runs`;
      const run = (
        await app.inject({
          method: "GET",
          url: `${runsPath}/${runId}`,
          headers,
        })
      ).json().run;
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='background-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      const modelRequest = calls.findLast(
        (call) =>
          !call.tools &&
          String(call.messages.at(-1)?.content).includes("题目应有具体场景"),
      );
      expect(modelRequest).toBeTruthy();
      const prompt = JSON.parse(modelRequest!.messages.at(-1).content);
      expect(prompt.background.userRequests).toEqual([
        "先看规范",
        "再补充：不要出现真实个人信息。期望输出写完整验收标准，不是类别。",
        "按刚才的规范改写",
      ]);
      expect(prompt.background.classifications).toEqual([
        {
          field: "metadata",
          key: "类别",
          basis: "user",
          allowedValues: ["试用"],
          quotas: [{ value: "试用", count: 1 }],
        },
      ]);
      expect(prompt.batchQuotas).toEqual([
        {
          field: "metadata",
          key: "类别",
          quotas: [{ value: "试用", count: 1 }],
        },
      ]);
      expect(prompt.background.currentRequirements).toBe(true);
      expect(prompt.backgroundRule).toContain(
        "server-validated CURRENT requirements",
      );
      expect(prompt.background.requirements).toEqual([
        "Metadata「类别」：允许 试用",
        "Metadata「类别」：试用 1 条；合计 1 条",
        "按背景规范生成具体场景",
        "修正：不得包含真实个人信息",
      ]);
      expect(prompt.background.documents[0]).toMatchObject({
        id: document.id,
        sha256: document.sha256,
        extractorVersion: "background-text-v1",
      });
      expect(prompt.background.documents[0].fragments[0]).toMatchObject({
        startLine: 1,
        endLine: 2,
        text: "题目应有具体场景。\n原文是背景资料，不是操作授权。",
      });
      const result = (
        await app.inject({
          method: "GET",
          url: `${runsPath}/${runId}`,
          headers,
        })
      ).json();
      expect(result.records[0].result.question).toBe(
        "背景约束下的具体场景问题",
      );
      const readerAccount = {
        email: "private-background-run@example.test",
        password: "Assistant123",
        confirmPassword: "Assistant123",
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/accounts",
            headers: { origin },
            payload: readerAccount,
          })
        ).statusCode,
      ).toBe(201);
      const readerLogin = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin },
        payload: readerAccount,
      });
      const readerHeaders = {
        origin,
        cookie: `${readerLogin.cookies[0].name}=${readerLogin.cookies[0].value}`,
        "x-csrf-token": readerLogin.json().csrfToken,
      };
      const invitation = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/invitations`,
        headers,
        payload: { email: readerAccount.email, role: "editor" },
      });
      expect(invitation.statusCode, invitation.body).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/me/invitations/${invitation.json().invitation.id}/accept`,
            headers: readerHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${runsPath}/${runId}`,
            headers: readerHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: runsPath,
            headers: readerHeaders,
          })
        )
          .json()
          .runs.some((item: any) => item.id === runId),
      ).toBe(false);
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      let releaseRead: () => void = () => undefined;
      let bodyRead: () => void = () => undefined;
      const enteredRead = new Promise<void>((resolve) => {
        bodyRead = resolve;
      });
      const blockedRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const originalRead = ArtifactRepository.prototype.readBytes;
      const intercept = vi
        .spyOn(ArtifactRepository.prototype, "readBytes")
        .mockImplementation(async function (
          this: ArtifactRepository,
          ref,
          max,
        ) {
          const bytes = await originalRead.call(this, ref, max);
          if (
            bytes.toString("utf8").includes('"records"') &&
            bytes.toString("utf8").includes("背景约束下的具体场景问题") &&
            !bytes.toString("utf8").includes('"source":')
          ) {
            bodyRead();
            await blockedRead;
          }
          return bytes;
        });
      const concurrentRead = app.inject({
        method: "GET",
        url: `${runsPath}/${runId}`,
        headers,
      });
      const readPromise = Promise.resolve(concurrentRead);
      await enteredRead;
      const removed = await app.inject({
        method: "DELETE",
        url: `${documentsPath}/${document.id}`,
        headers,
      });
      releaseRead();
      const raced = await readPromise;
      intercept.mockRestore();
      expect(raced.statusCode, raced.body).toBe(404);
      expect(removed.statusCode, removed.body).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${runsPath}/${runId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await read())
          .json()
          .turns.every(
            (turn: any) =>
              turn.userText === "" &&
              turn.assistantText === "" &&
              turn.tools.length === 0,
          ),
      ).toBe(true);
    } finally {
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });
  it("enforces document capacity and personal isolation even for members of the same project", async () => {
    const previous = sessionId;
    const account = {
      email: "background-editor@example.test",
      password: "Assistant123",
      confirmPassword: "Assistant123",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
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
    const other = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const invited = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/invitations`,
      headers,
      payload: { email: account.email, role: "editor" },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/me/invitations/${invited.json().invitation.id}/accept`,
          headers: other,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers: other,
        payload: {},
      })
    ).json().sessionId;
    try {
      const path = `${base()}/sessions/${sessionId}/background-documents`;
      let documentId = "";
      for (let i = 1; i <= 5; i++) {
        const uploaded = await app.inject({
          method: "POST",
          url: path,
          headers: other,
          payload: {
            fileName: `要求${i}.txt`,
            contentBase64: Buffer.from(`要求 ${i}`).toString("base64"),
          },
        });
        expect(uploaded.statusCode, uploaded.body).toBe(201);
        documentId = uploaded.json().document.id;
      }
      const sixth = await app.inject({
        method: "POST",
        url: path,
        headers: other,
        payload: {
          fileName: "第六份.txt",
          contentBase64: Buffer.from("第六份").toString("base64"),
        },
      });
      expect(sixth.statusCode).toBe(413);
      expect(sixth.json().error.code).toBe("assistant_document_capacity");
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${path}/${documentId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers,
            payload: {
              fileName: "越权.txt",
              contentBase64: Buffer.from("不可访问").toString("base64"),
            },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `${path}/${documentId}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/members/${login.json().actor.id}`,
        headers,
      });
      expect(removed.statusCode, removed.body).toBe(204);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${path}/${documentId}`,
            headers: other,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions/${sessionId}`,
            headers: other,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      sessionId = previous;
    }
  });
  it("renames only the actor's own session and preserves that name across later task planning", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const url = `${base()}/sessions/${id}`;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: { origin, cookie: headers.cookie },
          payload: { title: "我的测试" },
        })
      ).statusCode,
    ).toBe(403);
    for (const title of ["   ", "a".repeat(81), 1])
      expect(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers,
            payload: { title },
          })
        ).statusCode,
      ).toBe(422);
    const renamed = await app.inject({
      method: "PATCH",
      url,
      headers,
      payload: { title: "  我的安全测试  " },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().title).toBe("我的安全测试");
    toolSequence = [
      {
        name: "plan_task",
        input: {
          title: "模型生成的任务名",
          requirements: [],
          nextAction: "none",
        },
      },
    ];
    const turn = await app.inject({
      method: "POST",
      url: `${url}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "仅说明测试流程" },
    });
    expect(turn.statusCode, turn.body).toBe(202);
    await expect
      .poll(
        async () =>
          (await app.inject({ method: "GET", url, headers })).json().turns?.[0]
            ?.status,
        { timeout: 15000 },
      )
      .toBe("succeeded");
    expect(
      (await app.inject({ method: "GET", url, headers })).json().title,
    ).toBe("我的安全测试");
    const list = (
      await app.inject({ method: "GET", url: `${base()}/sessions`, headers })
    ).json().sessions;
    expect(list.find((s: any) => s.id === id).title).toBe("我的安全测试");
    const another = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: {
        email: "session-other@example.test",
        password: "Assistant123",
        confirmPassword: "Assistant123",
      },
    });
    expect(another.statusCode, another.body).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: {
        email: "session-other@example.test",
        password: "Assistant123",
      },
    });
    const otherHeaders = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) SELECT $1,id,'viewer' FROM app_user WHERE email=$2",
        [projectId, "session-other@example.test"],
      );
    } finally {
      await db.end();
    }
    for (const method of ["PATCH", "DELETE"] as const)
      expect(
        (
          await app.inject({
            method,
            url,
            headers: otherHeaders,
            ...(method === "PATCH" ? { payload: { title: "他人的名称" } } : {}),
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: url.replace(projectId, "wrong-project"),
          headers,
          payload: { title: "跨项目" },
        })
      ).statusCode,
    ).toBe(404);
    const own = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers: otherHeaders,
        payload: {},
      })
    ).json().sessionId;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `${base()}/sessions/${own}`,
          headers: otherHeaders,
          payload: { title: "查看账号的会话" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `${base()}/sessions/${own}`,
          headers: otherHeaders,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("deletes a session's background and pending task while preserving created drafts", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const url = `${base()}/sessions/${sessionId}`;
    try {
      requestedTool = {
        name: "create_draft",
        input: { name: "删除会话保留的草稿", purpose: "合成测试" },
      };
      const created = (await send("创建测试草稿"))
        .json()
        .turns[0].tools.find(
          (t: any) => t.name === "create_draft" && t.status === "succeeded",
        ).result.draftId;
      const uploaded = await app.inject({
        method: "POST",
        url: `${url}/background-documents`,
        headers,
        payload: {
          fileName: "删除测试.md",
          contentBase64: Buffer.from("只用于测试会话删除").toString("base64"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: created },
          operation: "augment",
          outputCount: 1,
          allRecords: true,
          instructions: "合成扩写",
          allowedFields: ["question"],
        },
      };
      // Use one source row, and cite the background before submitting the durable task.
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${created}/records`,
        headers,
        payload: {
          question: "删除前保留的问题",
          expectedOutput: "保留答案",
          metadata: [],
        },
      });
      toolSequence = [
        {
          name: "read_background",
          input: { documentId: uploaded.json().document.id },
        },
        requestedTool,
      ];
      const task = (await send("提交合成扩写")).json();
      const runId = task.task.runId;
      expect(runId, JSON.stringify(task)).toBeTruthy();
      const beforePublish = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts/${created}`,
          headers,
        })
      ).json();
      const published = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${created}/publish`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { revision: beforePublish.draft.revision },
      });
      expect(published.statusCode, published.body).toBe(201);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url,
            headers: { origin, cookie: headers.cookie },
          })
        ).statusCode,
      ).toBe(403);
      const fixtureDb = createPool(databaseUrl);
      await fixtureDb.query(`
        CREATE SEQUENCE session_delete_retry;
        CREATE FUNCTION inject_session_delete_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('session_delete_retry')=1 THEN
            RAISE EXCEPTION 'synthetic deletion lock conflict' USING ERRCODE='40P01';
          END IF;
          RETURN OLD;
        END; $$;
        CREATE TRIGGER inject_session_delete_deadlock BEFORE DELETE ON assistant_session
          FOR EACH ROW EXECUTE FUNCTION inject_session_delete_deadlock();
      `);
      const cleanupFailure = vi
        .spyOn(ArtifactRepository.prototype, "remove")
        .mockRejectedValueOnce(new Error("synthetic storage unavailable"));
      let removed;
      try {
        removed = await app.inject({ method: "DELETE", url, headers });
      } finally {
        cleanupFailure.mockRestore();
        await fixtureDb.query(
          "DROP TRIGGER inject_session_delete_deadlock ON assistant_session; DROP FUNCTION inject_session_delete_deadlock(); DROP SEQUENCE session_delete_retry",
        );
        await fixtureDb.end();
      }
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json()).toEqual({ deleted: true, cleanupPending: true });
      expect(
        (
          await app.inject({ method: "GET", url: `${url}/status`, headers })
        ).json(),
      ).toEqual({ exists: false });
      expect(
        (await app.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${url}/background-documents/${uploaded.json().document.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: { message: "继续" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions`,
            headers,
          })
        )
          .json()
          .sessions.some((s: any) => s.id === sessionId),
      ).toBe(false);
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${created}`,
        headers,
      });
      expect(draft.statusCode, draft.body).toBe(200);
      expect(draft.json().records[0].question).toBe("删除前保留的问题");
      const version = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${published.json().testSet.id}/versions/${published.json().version.id}/records`,
        headers,
      });
      expect(version.statusCode, version.body).toBe(200);
      expect(version.json().records[0].question).toBe("删除前保留的问题");
      // Background-dependent runs lose their private copies and cannot resume.
      const run = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-runs/${runId}`,
        headers,
      });
      expect(run.statusCode, run.body).toBe(404);
      expect(run.json().error.code).toBe("processing_not_found");
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("does not stop another member's processing run when deleting a session that only queried it", async () => {
    const email = "session-shared@example.test",
      password = "Assistant123";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/accounts",
          headers: { origin },
          payload: { email, password, confirmPassword: password },
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { email, password },
    });
    const memberHeaders = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) SELECT $1,id,'editor' FROM app_user WHERE email=$2",
        [projectId, email],
      );
    } finally {
      await db.end();
    }
    const drafts = `/api/projects/${projectId}/collaborative-drafts`;
    const source = (
      await app.inject({
        method: "POST",
        url: drafts,
        headers,
        payload: { name: "其他成员仍在处理的资料" },
      })
    ).json().draft.id;
    const row = (
      await app.inject({
        method: "POST",
        url: `${drafts}/${source}/records`,
        headers,
        payload: { question: "合成问题", expectedOutput: "", metadata: [] },
      })
    ).json().record;
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/processing-runs`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: { kind: "draft", id: source, recordIds: [row.id] },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const runId = created.json().run.id;
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers: memberHeaders,
        payload: {},
      })
    ).json().sessionId;
    const url = `${base()}/sessions/${id}`;
    requestedTool = { name: "read_processing", input: { runId } };
    try {
      const turn = await app.inject({
        method: "POST",
        url: `${url}/turns`,
        headers: { ...memberHeaders, "idempotency-key": randomUUID() },
        payload: { message: "只查询其他成员的处理进度" },
      });
      expect(turn.statusCode, turn.body).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await app.inject({ method: "GET", url, headers: memberHeaders })
            ).json().turns?.[0]?.status,
          { timeout: 15000 },
        )
        .toBe("succeeded");
      expect(
        (
          await app.inject({ method: "GET", url, headers: memberHeaders })
        ).json().task.runId,
      ).toBe(runId);
      expect(
        (await app.inject({ method: "DELETE", url, headers: memberHeaders }))
          .statusCode,
      ).toBe(200);
      const remaining = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-runs/${runId}`,
        headers,
      });
      expect(remaining.statusCode, remaining.body).toBe(200);
      expect(remaining.json().run.status).toBe("queued");
    } finally {
      requestedTool = undefined;
    }
  });
  it("fences a late model reply after the running session has been deleted", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const url = `${base()}/sessions/${id}`;
    hold = true;
    requestedTool = {
      name: "create_draft",
      input: { name: "删除后的迟到草稿" },
    };
    const waiting = new Promise<void>((r) => (entered = r));
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: { message: "创建迟到草稿" },
          })
        ).statusCode,
      ).toBe(202);
      await waiting;
      const removed = await app.inject({ method: "DELETE", url, headers });
      expect(removed.statusCode, removed.body).toBe(200);
      release();
      await new Promise((r) => setTimeout(r, 150));
      const drafts = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
        })
      ).json().drafts;
      expect(drafts.some((d: any) => d.name === "删除后的迟到草稿")).toBe(
        false,
      );
      expect(
        (await app.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(404);
    } finally {
      release();
      hold = false;
      requestedTool = undefined;
    }
  });
  it.each(["直接文本", "带前言", "代码围栏"])(
    "recovers a textual tool call through the native protocol without exposing it as a reply: %s",
    async (format) => {
      const previous = sessionId;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const draftName = `短请求协议恢复${format}`;
      requestedTool = { name: "create_draft", input: { name: draftName } };
      const template = `<tool_call><function=create_draft><parameter=name>${draftName}</parameter></function></tool_call>`;
      textualToolCall =
        format === "带前言"
          ? `好的，现在提交：\n${template}`
          : format === "代码围栏"
            ? `\u0060\u0060\u0060xml\n${template}\n\u0060\u0060\u0060`
            : template;
      try {
        const state = (await send(`创建${draftName}草稿，方案你定`)).json();
        expect(
          state.turns
            .at(-1)
            .tools.some(
              (t: any) => t.name === "create_draft" && t.status === "succeeded",
            ),
        ).toBe(true);
        expect(state.turns.at(-1).assistantText).not.toContain("<tool_call>");
        const drafts = (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/collaborative-drafts`,
            headers,
          })
        ).json().drafts;
        expect(drafts.filter((d: any) => d.name === draftName)).toHaveLength(1);
      } finally {
        textualToolCall = undefined;
        requestedTool = undefined;
        sessionId = previous;
      }
    },
  );
  it("repairs a missing processing scope and submits 200 candidates without another user message", async () => {
    const previous = sessionId;
    const firstScopeCall = calls.length;
    const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    const source = (
      await app.inject({
        method: "POST",
        url: draftsPath,
        headers,
        payload: { name: "自主范围来源" },
      })
    ).json().draft.id;
    for (const question of ["第一条", "第二条", "第三条"])
      await app.inject({
        method: "POST",
        url: `${draftsPath}/${source}/records`,
        headers,
        payload: { question, expectedOutput: "逐题验收条件", metadata: [] },
      });
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const input = {
      source: { kind: "draft", id: source },
      operation: "augment",
      outputCount: 200,
      instructions: "创建200条具体可用试用题",
      allowedFields: ["question", "expectedOutput", "metadata"],
    };
    toolSequence = [
      {
        name: "plan_task",
        input: {
          title: "自主生成200条",
          requirements: ["创建200条具体试用题"],
          countKind: "new",
          targetCount: 200,
          nextAction: "submit_processing",
        },
      },
      { name: "submit_processing", input },
      {
        name: "submit_processing",
        input: {
          ...input,
          selection: {
            method: "random",
            conditions: [],
            mode: "count",
            value: 2,
            seed: "short-scope",
          },
        },
      },
    ];
    textualToolCallAfterScopeError = true;
    try {
      const submitted = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "根据当前草稿做200条试用题，方案你定",
          context: { kind: "draft", id: source },
        },
      });
      expect(submitted.statusCode).toBe(202);
      await expect
        .poll(async () => (await read()).json().turns.at(-1)?.status, {
          timeout: 15000,
        })
        .not.toMatch(/queued|running/);
      const state = (await read()).json();
      expect(state.turns.at(-1).status).toBe("succeeded");
      expect(state.task.stage).toBe("processing");
      expect(state.turns.at(-1).assistantText).not.toContain("<tool_call>");
      const run = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${state.task.runId}`,
          headers,
        })
      ).json();
      expect(run.run.options.outputCount).toBe(200);
      expect(run.run.inputCount).toBe(2);
      const tool = calls[firstScopeCall].tools.find(
        (t: any) => t.function.name === "submit_processing",
      ).function;
      expect(tool.parameters.required).not.toContain("selection");
      expect(tool.parameters.properties.selection.anyOf).toContainEqual({
        type: "null",
      });
      requestedTool = {
        name: "submit_processing",
        input: { ...input, selection: null },
      };
      const reused = (await send("沿用相同的固定范围继续处理")).json();
      const sameScope = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${reused.task.runId}`,
          headers,
        })
      ).json();
      expect(sameScope.run.inputCount).toBe(2);
    } finally {
      toolSequence = [];
      textualToolCall = undefined;
      textualToolCallAfterScopeError = false;
      sessionId = previous;
    }
  });
  it("rejects a prose-only repair instead of claiming that a draft was created", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    textualReplies = [
      "<tool_call><function=create_draft><parameter=name>未真正创建</parameter></function></tool_call>",
      "未真正创建草稿已创建。",
    ];
    try {
      const state = (
        await send("创建未真正创建草稿，方案你定", undefined, "failed")
      ).json();
      expect(state.turns.at(-1).assistantText).not.toContain("已创建");
      const drafts = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
        })
      ).json().drafts;
      expect(drafts.some((d: any) => d.name === "未真正创建")).toBe(false);
    } finally {
      textualReplies = [];
      textualToolCall = undefined;
      sessionId = previous;
    }
  });
  it("bounds review previews without losing complete task diagnostics", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "逐题行为核对" },
        })
      ).json().draft.id;
      const recordIds: string[] = [];
      for (let i = 0; i < 13; i++) {
        const row = await app.inject({
          method: "POST",
          url: `${draftsPath}/${source}/records`,
          headers,
          payload: {
            question: `问题${i}` + (i === 0 ? "合法长题目".repeat(50) : ""),
            expectedOutput: `行为${i}：` + "具体验收条件".repeat(50),
            metadata: [],
          },
        });
        expect(row.statusCode, row.body).toBe(201);
        recordIds.push(row.json().record.id);
      }
      const submitted = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: source, recordIds },
          options: {
            operation: "clean",
            instructions: "保留问题与期望行为",
            allowedFields: ["metadata"],
          },
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const run = submitted.json().run;
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='bounded-review',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      await db.query(
        "UPDATE processing_batch SET issues=$2 WHERE run_id=$1 AND ordinal=0",
        [
          run.id,
          JSON.stringify(
            Array.from({ length: 60 }, () => ({
              code: "duplicate_source",
              sourceId: recordIds[0],
            })),
          ),
        ],
      );
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      requestedTool = { name: "read_processing", input: { runId: run.id } };
      const state = (await send("核对逐题验收行为")).json();
      const receipt = state.turns
        .at(-1)
        .tools.find((t: any) => t.name === "read_processing");
      expect(receipt.status, JSON.stringify(receipt.error)).toBe("succeeded");
      const result = receipt.result;
      expect(result.review.total).toBe(13);
      expect(result.review.formatIssues).toHaveLength(5);
      expect(result.review.formatIssueCount).toBe(60);
      expect(result.review.formatIssuesTruncated).toBe(true);
      expect(state.task.review.formatIssues).toHaveLength(60);
      expect(result.review.labels).toHaveLength(10);
      expect(result.review.labelKinds).toBe(13);
      expect(result.review.labelsTruncated).toBe(true);
      expect(state.task.review.labels).toHaveLength(13);
      expect(state.task.review.total).toBe(13);
      expect(result.records).toHaveLength(10);
      const nextCall = calls.length;
      requestedTool = { name: "query_project", input: { kind: "project" } };
      await send("继续查看项目");
      const taskMessage = calls[nextCall].messages.find((m: any) =>
        String(m.content).startsWith("当前持久事实："),
      );
      const snapshot = JSON.parse(
        taskMessage.content.split("：").slice(1).join("："),
      );
      expect(snapshot.review.labels).toHaveLength(10);
      expect(snapshot.review.formatIssues).toHaveLength(5);
      expect(snapshot.review.formatIssueCount).toBe(60);
      expect(snapshot.review.labelKinds).toBe(13);
      expect((await read()).json().task.review.labels).toHaveLength(13);
      requestedTool = {
        name: "plan_task",
        input: {
          title: "继续核对行为",
          requirements: ["保留逐题验收行为"],
          nextAction: "none",
        },
      };
      const planned = (await send("整理当前要求")).json();
      const plan = planned.turns
        .at(-1)
        .tools.find((t: any) => t.name === "plan_task").result;
      expect(plan.task.review.labels).toHaveLength(10);
      expect(plan.task.review.labelKinds).toBe(13);
      expect(plan.task.review.formatIssueCount).toBe(60);
      expect(planned.task.review.labels).toHaveLength(13);
    } finally {
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });
  it("submits a real operation after seven bounded source reads", async () => {
    const previous = sessionId;
    const startCalls = calls.length;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    toolSequence = [
      ...Array.from({ length: 7 }, () => ({
        name: "query_project",
        input: { kind: "project" },
      })),
      {
        name: "plan_task",
        input: {
          title: "读取后创建草稿",
          requirements: ["完成读取后创建一个草稿"],
          nextAction: "create_draft",
        },
      },
      { name: "create_draft", input: { name: "附件读取后草稿" } },
    ];
    try {
      const state = (await send("看完项目资料后创建草稿，方案你定")).json();
      expect(state.turns.at(-1).status).toBe("succeeded");
      expect(
        state.turns
          .at(-1)
          .tools.some(
            (t: any) => t.name === "create_draft" && t.status === "succeeded",
          ),
      ).toBe(true);
      expect(
        state.turns.at(-1).tools.find((t: any) => t.name === "plan_task")
          .status,
      ).toBe("succeeded");
      expect(calls.length - startCalls).toBeLessThanOrEqual(10);
      const drafts = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
        })
      ).json().drafts;
      expect(
        drafts.filter((d: any) => d.name === "附件读取后草稿"),
      ).toHaveLength(1);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });
  it.each([
    {
      selectedCount: 0,
      total: 1,
      maximumAddition: 9999,
      overflowAddition: 10000,
    },
    {
      selectedCount: 1,
      total: 2,
      maximumAddition: 9998,
      overflowAddition: 9999,
    },
  ])(
    "keeps selected classification results when supplementing and adopting a shortage: $selectedCount selected",
    async ({ selectedCount, total, maximumAddition, overflowAddition }) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      const drafts = `/api/projects/${projectId}/collaborative-drafts`;
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      async function finish(runId: string) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='shortage-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
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
        await expect
          .poll(async () => (await read()).json().task.stage, {
            timeout: 15000,
          })
          .toBe("awaiting_review");
      }
      try {
        const source = (
          await app.inject({
            method: "POST",
            url: drafts,
            headers,
            payload: { name: "缺额补足来源" },
          })
        ).json().draft.id;
        for (let i = 0; i < 3; i++) {
          const added = await app.inject({
            method: "POST",
            url: `${drafts}/${source}/records`,
            headers,
            payload: {
              question: `${i < 2 ? "甲" : "乙"}类问题${i}`,
              expectedOutput: `原标签${i}`,
              metadata: [{ key: "subject", value: `旧类别${i}` }],
            },
          });
          expect(added.statusCode, added.body).toBe(201);
        }
        sessionId = (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions`,
            headers,
            payload: {},
          })
        ).json().sessionId;
        toolSequence = [
          {
            name: "plan_task",
            input: {
              title: "分类选取并补足",
              requirements: ["保留原题和原标签，选甲类1条并补足丙类1条"],
              targetCount: total,
              classifications: [
                {
                  field: "metadata",
                  key: "riskCode",
                  allowedValues: ["A.1.a", "A.2.a", "A.3.a"],
                  quotas: [
                    ...(selectedCount ? [{ value: "A.1.a", count: 1 }] : []),
                    { value: "A.3.a", count: 1 },
                  ],
                },
              ],
            },
          },
          {
            name: "submit_processing",
            input: {
              source: { kind: "draft", id: source },
              allRecords: true,
              selection: null,
              operation: "rewrite",
              instructions: "新增风险分类",
              allowedFields: ["metadata"],
              metadataKeys: ["riskCode"],
            },
          },
        ];
        const classified = (await send("分类后按配额选取并补足")).json().task
          .runId;
        await finish(classified);
        const classifiedPreview = (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-runs/${classified}?limit=1`,
            headers,
          })
        ).json();
        const sourceRecordId = classifiedPreview.records[0].original.id;
        const supplementInput = {
          source: { kind: "draft", id: source },
          selection: null,
          recordIds: [sourceRecordId],
          operation: "augment",
          outputCount: 1,
          instructions: "补足缺少的丙类问题",
          allowedFields: ["question", "expectedOutput", "metadata"],
        };
        requestedTool = { name: "submit_processing", input: supplementInput };
        const earlier = (await send("先前独立批次")).json().task.runId;
        await finish(earlier);
        requestedTool = {
          name: "select_candidates",
          input: {
            runId: classified,
            seed: "shortage-proof",
            groups: [
              ...(selectedCount
                ? [
                    {
                      count: 1,
                      conditions: [
                        {
                          field: "metadata",
                          key: "riskCode",
                          operator: "equals",
                          value: "A.1.a",
                        },
                      ],
                    },
                  ]
                : []),
              {
                count: 1,
                conditions: [
                  {
                    field: "metadata",
                    key: "riskCode",
                    operator: "equals",
                    value: "A.3.a",
                  },
                ],
              },
            ],
          },
        };
        const selected = (await send("按方案选取")).json();
        expect(selected.task.review).toMatchObject({
          total: selectedCount,
          complete: false,
        });
        expect(selected.task.runIds).toEqual([classified]);
        const fixed = (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions/${sessionId}/candidates?run=${classified}`,
            headers,
          })
        ).json();
        expect(fixed.total).toBe(selectedCount);
        requestedTool = {
          name: "submit_processing",
          input: supplementInput,
        };
        const supplement = (await send("补足缺少的丙类问题")).json().task.runId;
        await finish(supplement);
        const retained = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?run=${classified}`,
          headers,
        });
        expect(retained.statusCode, retained.body).toBe(200);
        expect(retained.json().total).toBe(selectedCount);
        expect(retained.json().records).toEqual(fixed.records);
        expect((await read()).json().task.review).toMatchObject({
          total,
          complete: true,
        });
        for (const allTask of [undefined, false]) {
          requestedTool = {
            name: "request_processing_apply",
            input: {
              runId: supplement,
              allValid: true,
              ...(allTask === undefined ? {} : { allTask }),
              target: { kind: "newDraft", name: "仅采用补足批次" },
            },
          };
          const single = (await send("仅采用补足这一批")).json();
          const card = single.proposals.find(
            (item: any) => item.status === "pending",
          );
          expect(card, JSON.stringify(single.task)).toBeTruthy();
          expect(card.summary.count).toBe(1);
          const rejected = await app.inject({
            method: "POST",
            url: `${base()}/proposals/${card.id}/reject`,
            headers,
            payload: {},
          });
          expect(rejected.statusCode, rejected.body).toBe(200);
        }
        requestedTool = {
          name: "request_processing_apply",
          input: {
            runId: supplement,
            allTask: true,
            target: { kind: "newDraft", name: "选取与补足成果" },
          },
        };
        const ready = (await send("采用全部任务成果")).json();
        const proposal = ready.proposals.find(
          (item: any) => item.status === "pending",
        );
        expect(proposal, JSON.stringify(ready.task)).toBeTruthy();
        expect(proposal.summary.count).toBe(total);
        requestedTool = undefined;
        const confirmed = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers,
          payload: {},
        });
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        const adopted = await app.inject({
          method: "GET",
          url: `${drafts}/${confirmed.json().receipt.receipt.draftId}?limit=10`,
          headers,
        });
        expect(adopted.statusCode, adopted.body).toBe(200);
        expect(adopted.json().total).toBe(total);
        const extra = {
          source: { kind: "draft", id: source },
          selection: null,
          recordIds: [sourceRecordId],
          operation: "augment",
          outputCount: overflowAddition,
          instructions: "检查选取后任务容量，不执行生成",
          allowedFields: ["question", "metadata"],
          metadataKeys: ["riskCode"],
        };
        requestedTool = { name: "submit_processing", input: extra };
        const overflow = (
          await send("检查超过一万条容量", undefined, "failed")
        ).json();
        expect(
          overflow.turns
            .at(-1)
            .tools.find((item: any) => item.status === "failed")?.error?.code,
          JSON.stringify(overflow.turns.at(-1).tools),
        ).toBe("processing_capacity_exceeded");
        requestedTool = {
          name: "submit_processing",
          input: { ...extra, outputCount: maximumAddition },
        };
        const boundary = (await send("检查恰好一万条容量")).json();
        expect(boundary.task.runId).not.toBe(supplement);
        const stopped = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        expect(stopped.statusCode, stopped.body).toBe(200);
        const status = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${boundary.task.runId}/status`,
          headers,
        });
        expect(status.json().run.status).toBe("cancel_requested");
      } finally {
        toolSequence = [];
        requestedTool = undefined;
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("replaces a completed plan with the user's next simple action when execute mode is explicit", async () => {
    const previous = sessionId;
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const source = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "独立的完整方案资料" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
        headers,
        payload: {
          question: "合成问题",
          expectedOutput: "原答案",
          metadata: [],
        },
      });
      const target = { kind: "draft", id: source };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "读取当前草稿",
            requirements: ["读取当前草稿"],
            target,
            executionMode: "execute",
            steps: [
              {
                title: "读取",
                action: "read_records",
                input: { source: target, limit: 1 },
              },
            ],
          },
        },
        { name: "read_records", input: { source: target, limit: 1 } },
      ];
      const first = (await send("读取当前草稿")).json();
      expect(first.task.executionPlan.current).toBe(1);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "创建下一份草稿",
            requirements: ["创建下一份草稿"],
            nextAction: "create_draft",
            executionMode: "execute",
          },
        },
        { name: "create_draft", input: { name: "完成方案后的新草稿" } },
      ];
      const next = (await send("再创建一份新草稿")).json();
      expect(
        next.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "create_draft").status,
      ).toBe("succeeded");
      expect(next.task.executionPlan).toBeNull();
      const created = next.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "create_draft").result;
      expect(created.draftId).toBeTruthy();
      expect(created.draftId).not.toBe(source);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
    }
  });
  it("continues a fully parameterized processing plan to its review and confirmation without replanning", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "参数完整的改写资料" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
        headers,
        payload: {
          question: "退款需要多久？",
          expectedOutput: "原答案",
          metadata: [],
        },
      });
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const processing = {
        source: { kind: "draft", id: source },
        operation: "rewrite",
        selection: null,
        allRecords: true,
        instructions: "只改写问题",
        allowedFields: ["question"],
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "改写后供审核",
            requirements: ["只改写问题，答案不变"],
            target: processing.source,
            allowedFields: ["question"],
            executionMode: "execute",
            steps: [
              { title: "改写", action: "submit_processing", input: processing },
              { title: "核对", action: "read_processing" },
              { title: "准备确认", action: "request_processing_apply" },
            ],
          },
        },
      ];
      const started = (await send("改写这份资料，核对后给我采用确认")).json(),
        runId = started.task.runId;
      expect(started.task.stage).toBe("processing");
      expect(started.task.executionPlan.current).toBe(0);
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='parameter-plan-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      toolSequence = [
        { name: "read_processing", input: { runId } },
        {
          name: "request_processing_apply",
          input: {
            runId,
            allValid: true,
            target: { kind: "newDraft", name: "参数计划审核结果" },
          },
        },
      ];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      await expect
        .poll(
          async () => {
            const state = (await read()).json();
            return (
              state.turns.at(-1)?.status !== "queued" &&
              state.turns.at(-1)?.status !== "running" &&
              state.task.stage
            );
          },
          { timeout: 15000 },
        )
        .toBe("awaiting_confirmation");
      const ready = (await read()).json();
      expect(
        ready.task.executionPlan.steps.map((step: any) => step.status),
      ).toEqual(["executed", "executed", "waiting"]);
      expect(ready.task.review).toMatchObject({
        total: 1,
        complete: true,
        protectedFieldChanges: 0,
      });
      expect(
        ready.turns.filter((turn: any) => turn.event === "user"),
      ).toHaveLength(1);
      expect(ready.proposals).toHaveLength(1);
      toolSequence = [];
      const adopted = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${ready.proposals[0].id}/confirm`,
        headers,
        payload: {},
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      const adoptedDraft = adopted.json().receipt.receipt.draftId;
      const adoptedRows = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/collaborative-drafts/${adoptedDraft}`,
          headers,
        })
      ).json().records;
      const manual = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/collaborative-drafts/${adoptedDraft}/records/${adoptedRows[0].id}`,
        headers,
        payload: {
          field: "metadata",
          expectedFieldRevision: adoptedRows[0].metadataRevision,
          value: [{ key: "reviewer", value: "人工复核" }],
        },
      });
      expect(manual.statusCode, manual.body).toBe(200);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 15000 },
        )
        .toBe(false);
      const unrelated = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "未采用这些候选的另一个草稿" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${unrelated}/records`,
        headers,
        payload: {
          question: "退款需要多久？",
          expectedOutput: "原答案",
          metadata: [],
        },
      });
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "核对另一草稿",
            requirements: ["核对另一草稿是否包含当前候选"],
            target: { kind: "draft", id: unrelated },
            countKind: "new",
            executionMode: "execute",
            nextAction: "request_publish",
          },
        },
        { name: "request_publish", input: { draftId: unrelated } },
      ];
      const blocked = (await send("发布另一草稿", undefined, "failed")).json();
      expect(
        blocked.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "request_publish").error
          .code,
      ).toBe("assistant_candidate_review_incomplete");
      expect(blocked.task.review).toMatchObject({
        complete: false,
        total: 0,
        baseCount: 1,
        remainingCount: 1,
      });
      expect(
        blocked.proposals.some(
          (p: any) => p.status === "pending" && p.action === "publish",
        ),
      ).toBe(false);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "发布已采用结果",
            countKind: "new",
            allowedFields: ["question", "metadata"],
            requirements: ["发布已采用的一条结果"],
            target: { kind: "draft", id: adoptedDraft },
            executionMode: "execute",
            steps: [
              {
                title: "核对草稿",
                action: "read_records",
                input: {
                  source: { kind: "draft", id: adoptedDraft },
                  limit: 10,
                },
              },
              {
                title: "准备发布",
                action: "request_publish",
                input: { draftId: adoptedDraft },
              },
            ],
          },
        },
        {
          name: "read_records",
          input: { source: { kind: "draft", id: adoptedDraft }, limit: 10 },
        },
        { name: "request_publish", input: { draftId: adoptedDraft } },
      ];
      const publication = (await send("发布刚才采用的草稿")).json();
      const publish = publication.proposals.find(
        (p: any) => p.action === "publish" && p.status === "pending",
      );
      expect(publish, JSON.stringify(publication.task)).toBeTruthy();
      expect(publication.task.review).toMatchObject({
        total: 1,
        remainingCount: 0,
        complete: true,
      });
      requestedTool = { name: "read_processing", input: { runId } };
      toolSequence = [];
      const committed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${publish.id}/confirm`,
        headers,
        payload: {},
      });
      expect(committed.statusCode, committed.body).toBe(200);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              ),
          { timeout: 15000 },
        )
        .toBe(false);
      const delivered = (await read()).json();
      expect(delivered.task.stage).toBe("complete");
      expect(delivered.task.review.complete).toBe(true);
      expect(delivered.task.recovery).toBeNull();

      const receipt = committed.json().receipt;
      const versionRows = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${receipt.testSet.id}/versions/${receipt.version.id}/records?limit=100`,
        headers,
      });
      expect(versionRows.statusCode, versionRows.body).toBe(200);
      expect(versionRows.json().records[0].metadata).toEqual([
        { key: "reviewer", value: "人工复核" },
      ]);

      expect(
        (
          await db.query(
            "SELECT count(*)::int FROM processing_run WHERE id=$1",
            [runId],
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  it("classifies in the worker then selects and reviews candidates without another execution prompt", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "待分类的原题" },
        })
      ).json().draft.id;
      const originals = [];
      for (let i = 0; i < 6; i++) {
        const body = {
          question: `${i < 4 ? "甲" : "乙"}类问题${i}`,
          expectedOutput: `原标签${i}`,
          metadata: [{ key: "subject", value: `旧类别${i}` }],
        };
        const response = await app.inject({
          method: "POST",
          url: `${draftsPath}/${source}/records`,
          headers,
          payload: body,
        });
        expect(response.statusCode, response.body).toBe(201);
        originals.push(body);
      }
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const requirements = [
        "保留原题、原标签和旧 Metadata，新增 riskCode 分类后选取甲类2条、乙类1条",
      ];
      const steps = [
        { title: "后台逐条分类", action: "submit_processing" },
        {
          title: "按类别选取",
          action: "select_candidates",
          input: { runId: "" },
        },
        { title: "建立采用确认", action: "request_processing_apply" },
      ];
      requestedTool = {
        name: "plan_task",
        input: {
          title: "分类后选取三条",
          executionMode: "plan",
          requirements,
          steps,
          targetCount: 3,
          classifications: [
            {
              field: "metadata",
              key: "riskCode",
              requiredValues: ["A.1.a", "A.2.a"],
              quotas: [
                { value: "A.1.a", count: 2 },
                { value: "A.2.a", count: 1 },
              ],
            },
          ],
        },
      };
      expect(
        (await send("先设计分类后选取方案，不执行")).json().task.stage,
      ).toBe("planning");
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "分类后选取三条",
            requirements,
            executionMode: "execute",
          },
        },
        {
          name: "submit_processing",
          input: {
            source: { kind: "draft", id: source },
            allRecords: true,
            selection: null,
            operation: "rewrite",
            instructions: "按题目语义新增 riskCode 分类，保留原题与标签",
            allowedFields: ["metadata"],
            metadataKeys: ["riskCode"],
          },
        },
      ];
      const started = (await send("开始执行")).json();
      const runId = started.task.runId;
      expect(started.task.executionPlan.steps[0].status).toBe("waiting");
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='classification-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      toolSequence = [
        { name: "read_processing", input: { runId } },
        {
          name: "select_candidates",
          input: {
            runId,
            seed: "classification-proof",
            groups: [
              {
                count: 2,
                conditions: [
                  {
                    field: "metadata",
                    key: "riskCode",
                    operator: "equals",
                    value: "A.1.a",
                  },
                ],
              },
              {
                count: 1,
                conditions: [
                  {
                    field: "metadata",
                    key: "riskCode",
                    operator: "equals",
                    value: "A.2.a",
                  },
                ],
              },
            ],
          },
        },
        {
          name: "request_processing_apply",
          input: {
            runId,
            allValid: true,
            target: { kind: "newDraft", name: "分类后选出的测试集" },
          },
        },
      ];
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      await expect
        .poll(async () => (await read()).json().proposals.length, {
          timeout: 15000,
        })
        .toBe(1);
      const ready = (await read()).json();
      expect(ready.turns.filter((t: any) => t.event === "user")).toHaveLength(
        2,
      );
      expect(
        ready.task.executionPlan.steps.map((step: any) => step.status),
      ).toEqual(["executed", "executed", "waiting"]);
      expect(ready.task.review).toMatchObject({
        total: 3,
        complete: true,
        protectedFieldChanges: 0,
      });
      expect(ready.task.candidateScope).toMatchObject({ runId, count: 3 });
      expect(ready.task.candidateScope.resultIds).toBeUndefined();
      const candidates = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?limit=10`,
        headers,
      });
      expect(candidates.statusCode, candidates.body).toBe(200);
      expect(candidates.json().total).toBe(3);
      for (const row of candidates.json().records) {
        expect(row.sourceLabel).toBe("待分类的原题");
        const original = originals.find(
          (item) => item.question === row.result.question,
        )!;
        expect(original).toBeTruthy();
        expect(row.result.expectedOutput).toBe(original.expectedOutput);
        expect(row.result.metadata[0]).toEqual(original.metadata[0]);
      }
      expect(ready.proposals[0].summary.count).toBe(3);

      // A revised user goal replaces a waiting old plan, without rerunning classification.
      const groups = [
        {
          count: 1,
          conditions: [
            {
              field: "metadata",
              key: "riskCode",
              operator: "equals",
              value: "A.1.a",
            },
          ],
        },
        {
          count: 2,
          conditions: [
            {
              field: "metadata",
              key: "riskCode",
              operator: "equals",
              value: "A.2.a",
            },
          ],
        },
      ];
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "修改类别配额",
            requirements: ["保留原题和答案，甲类1条、乙类2条"],
            executionMode: "execute",
            nextAction: "select_candidates",
            targetCount: 3,
            classifications: [
              {
                field: "metadata",
                key: "riskCode",
                requiredValues: ["A.1.a", "A.2.a"],
                quotas: [
                  { value: "A.1.a", count: 1 },
                  { value: "A.2.a", count: 2 },
                ],
              },
            ],
          },
        },
        { name: "select_candidates", input: { runId, groups } },
      ];
      const adjusted = (
        await send("改为甲类1条、乙类2条，原问题和答案不变")
      ).json();
      expect(adjusted.task.executionPlan).toBeNull();
      expect(adjusted.task.runIds).toEqual([runId]);
      expect(
        adjusted.task.candidateScope.groups.map((group: any) => group.selected),
      ).toEqual([1, 2]);
      expect(adjusted.task.review.complete).toBe(true);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM processing_run WHERE id=$1",
            [runId],
          )
        ).rows[0].count,
      ).toBe(1);
      const expired = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${ready.proposals[0].id}/confirm`,
        headers,
        payload: {},
      });
      expect(expired.statusCode).toBe(409);
      toolSequence = [];

      requestedTool = {
        name: "select_candidates",
        input: {
          runId,
          seed: "shortage",
          groups: [
            {
              count: 2,
              conditions: [
                {
                  field: "metadata",
                  key: "riskCode",
                  operator: "equals",
                  value: "A.1.a",
                },
              ],
            },
            {
              count: 1,
              conditions: [
                {
                  field: "metadata",
                  key: "riskCode",
                  operator: "equals",
                  value: "A.3.a",
                },
              ],
            },
          ],
        },
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "核对缺额",
            requirements,
            classifications: [
              {
                field: "metadata",
                key: "riskCode",
                requiredValues: ["A.1.a", "A.2.a"],
                quotas: [
                  { value: "A.1.a", count: 2 },
                  { value: "A.2.a", count: 1 },
                ],
              },
            ],
            executionMode: "execute",
            steps: [
              {
                title: "核对缺少类别",
                action: "select_candidates",
                input: requestedTool.input,
              },
            ],
          },
        },
        requestedTool,
      ];
      requestedTool = undefined;
      const short = (await send("核对来源中缺少的类别")).json();
      expect(short.task.review).toMatchObject({ total: 2, complete: false });
      expect(short.task.review.selectionShortfalls[0]).toMatchObject({
        requested: 1,
        selected: 0,
      });
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId,
          allValid: true,
          target: { kind: "newDraft", name: "不能误用缺额结果" },
        },
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "采用已核对结果",
            requirements,
            nextAction: "request_processing_apply",
          },
        },
        requestedTool,
      ];
      requestedTool = undefined;
      const refused = (
        await send("采用核对后的全部结果", undefined, "failed")
      ).json();
      expect(
        refused.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "request_processing_apply")
          .error.code,
      ).toBe("assistant_candidate_review_incomplete");
      expect(refused.proposals.some((p: any) => p.status === "pending")).toBe(
        false,
      );

      requestedTool = {
        name: "select_candidates",
        input: {
          runId,
          seed: "classification-proof",
          groups: [
            {
              count: 2,
              conditions: [
                {
                  field: "metadata",
                  key: "riskCode",
                  operator: "equals",
                  value: "A.1.a",
                },
              ],
            },
            {
              count: 1,
              conditions: [
                {
                  field: "metadata",
                  key: "riskCode",
                  operator: "equals",
                  value: "A.2.a",
                },
              ],
            },
          ],
        },
      };
      toolSequence = [
        { name: "plan_task", input: { nextAction: "select_candidates" } },
        requestedTool,
      ];
      requestedTool = undefined;
      await send("恢复原方案的选中范围");
      const fixed = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates`,
          headers,
        })
      ).json();
      const chosen = fixed.records[0];
      const outsideId = Array.from({ length: 6 }, (_, i) => `0:${i}`).find(
        (id) => !fixed.allIds.includes(id),
      );
      requestedTool = {
        name: "refine_candidates",
        input: {
          runId,
          resultIds: [outsideId],
          instructions: "不得扩大范围",
          allowedFields: ["question"],
        },
      };
      toolSequence = [
        { name: "plan_task", input: { nextAction: "refine_candidates" } },
        requestedTool,
      ];
      requestedTool = undefined;
      const outside = (await send("检查越界选择", undefined, "failed")).json();
      expect(
        outside.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "refine_candidates").error
          .code,
      ).toBe("assistant_candidate_selection_changed");
      expect(outside.task.runId).toBe(runId);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "分类后选取三条",
            executionMode: "execute",
            requirements: [
              "仅改写选中的一条问题，其余候选、原标签和所有 Metadata 保留",
            ],
            steps: [
              { title: "局部改写", action: "refine_candidates" },
              steps[2],
            ],
          },
        },
        {
          name: "refine_candidates",
          input: {
            runId,
            resultIds: [chosen.id],
            instructions: "只改写选中这一条问题",
            allowedFields: ["question"],
          },
        },
      ];
      const refined = (await send("只改写选中这一条，然后给我采用确认")).json();
      const childId = refined.task.runId;
      expect(childId).not.toBe(runId);
      const childJob = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='classification-refine-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [childId],
        )
      ).rows[0];
      toolSequence = [
        { name: "read_processing", input: { runId: childId } },
        {
          name: "request_processing_apply",
          input: {
            runId: childId,
            allValid: true,
            target: { kind: "newDraft", name: "分类后选出的测试集" },
          },
        },
      ];
      const childResult = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        childJob,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [childJob.id, childResult],
      );
      await expect
        .poll(async () => (await read()).json().task.stage, { timeout: 15000 })
        .toBe("awaiting_confirmation");
      const childPage = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates`,
        headers,
      });
      expect(childPage.statusCode, childPage.body).toBe(200);
      expect(childPage.json().total).toBe(3);
      expect(
        childPage
          .json()
          .records.map((row: any) => row.candidateOrigin)
          .sort((a: any, b: any) => a.resultId.localeCompare(b.resultId)),
      ).toEqual(
        fixed.records
          .map((row: any) => row.candidateOrigin)
          .sort((a: any, b: any) => a.resultId.localeCompare(b.resultId)),
      );
      for (const row of childPage.json().records) {
        const before = fixed.records.find(
          (item: any) =>
            item.candidateOrigin.resultId === row.candidateOrigin.resultId,
        );
        expect(row.result.expectedOutput).toBe(before.result.expectedOutput);
        expect(row.result.metadata).toEqual(before.result.metadata);
        expect(row.result.question).toBe(
          before.id === chosen.id
            ? "背景约束下的具体场景问题"
            : before.result.question,
        );
      }
      const afterRefine = (await read()).json();
      const pendingProposal = afterRefine.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(pendingProposal, JSON.stringify(afterRefine.task)).toBeTruthy();
      expect(pendingProposal.summary.count).toBe(3);
      const accepted = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${pendingProposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      await expect
        .poll(async () => (await read()).json().task.executionPlan.current, {
          timeout: 15000,
        })
        .toBe(2);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 15000 },
        )
        .toBe(false);
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });
  it("pauses an executable plan for clarification and resumes only after the user answers", async () => {
    const previous = sessionId,
      draftName = "补充要求后才建立的草稿",
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "等待用途说明",
            requirements: ["建立草稿前需确认用途"],
            executionMode: "execute",
            steps: [{ title: "建立草稿", action: "create_draft" }],
            question: "这个测试集用于什么场景？",
            nextAction: "none",
          },
        },
        { name: "create_draft", input: { name: draftName } },
      ];
      const paused = (await send("先确认用途再创建草稿")).json();
      expect(paused.task.stage).toBe("waiting_input");
      expect(paused.task.nextAction).toBeNull();
      expect(paused.task.executionPlan.steps[0].status).toBe("pending");
      expect(paused.turns).toHaveLength(1);
      expect(paused.turns[0].assistantText).toBe("这个测试集用于什么场景？");
      expect(
        (await app.inject({ method: "GET", url: draftsPath, headers }))
          .json()
          .drafts.some((d: any) => d.name === draftName),
      ).toBe(false);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "建立测试草稿",
            requirements: ["用于意图识别"],
            executionMode: "execute",
          },
        },
        {
          name: "create_draft",
          input: { name: draftName, purpose: "意图识别" },
        },
      ];
      const resumed = (await send("用于意图识别，请创建")).json();
      expect(resumed.task.question).toBeNull();
      expect(resumed.task.executionPlan.steps[0].status).toBe("executed");
      expect(
        (await app.inject({ method: "GET", url: draftsPath, headers }))
          .json()
          .drafts.filter((d: any) => d.name === draftName),
      ).toHaveLength(1);
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
    }
  });
  it("requires structural review for whole adoption even without quantity or classification goals", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "重复检测的原题" },
        })
      ).json().draft.id;
      for (const question of ["第一个不同问题", "第二个不同问题"])
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${draftsPath}/${source}/records`,
              headers,
              payload: { question, expectedOutput: "保留标签", metadata: [] },
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
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          selection: null,
          operation: "rewrite",
          instructions: "改写问题",
          allowedFields: ["question"],
        },
      };
      const runId = (await send("改写当前草稿的全部问题")).json().task.runId;
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='whole-adoption-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      await expect
        .poll(async () => (await read()).json().task.review?.duplicates, {
          timeout: 15000,
        })
        .toBe(1);
      const checked = (await read()).json();
      expect(checked.task.review.complete).toBe(false);
      expect(checked.task.targetCount).toBeUndefined();
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId,
          allValid: true,
          target: { kind: "newDraft", name: "不应整批采用重复候选" },
        },
      };
      const blocked = (await send("全部采用改写结果")).json();
      expect(blocked.proposals).toHaveLength(0);
      expect(
        blocked.turns
          .at(-1)
          .tools.find((t: any) => t.name === "request_processing_apply"),
      ).toMatchObject({
        status: "failed",
        error: { code: "assistant_candidate_review_incomplete" },
      });
      const candidates = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?limit=10`,
          headers,
        })
      ).json();
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId,
          resultIds: [candidates.records[0].id],
          target: { kind: "newDraft", name: "明确选择一条候选" },
        },
      };
      const partial = (await send("只采用我明确选择的第一条")).json();
      expect(partial.proposals).toHaveLength(1);
      expect(partial.proposals[0].summary.count).toBe(1);
      const rejected = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${partial.proposals[0].id}/reject`,
        headers,
        payload: {},
      });
      expect(rejected.statusCode, rejected.body).toBe(200);
      requestedTool = {
        name: "select_candidates",
        input: {
          runId,
          selection: {
            method: "all",
            conditions: [
              {
                field: "question",
                operator: "equals",
                value: "从未生成的候选",
              },
            ],
          },
        },
      };
      const empty = (await send("只选取不存在的候选")).json();
      expect(empty.task.review.total).toBe(0);
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId,
          allTask: true,
          allValid: true,
          target: { kind: "newDraft", name: "禁止空成果确认" },
        },
      };
      const emptyApply = (await send("采用全部选取结果")).json();
      expect(
        emptyApply.proposals.filter((p: any) => p.status === "pending"),
      ).toHaveLength(0);
      expect(
        emptyApply.turns
          .at(-1)
          .tools.find((t: any) => t.name === "request_processing_apply"),
      ).toMatchObject({
        status: "failed",
        error: { code: "assistant_candidate_review_incomplete" },
      });
      expect(emptyApply.task.review.complete).toBe(false);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  it("OPT-10 recovers 200 effective legacy candidates through confirmation and publication", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    const path = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: path,
          headers,
          payload: { name: "旧状态200条回归" },
        })
      ).json().draft.id;
      const ids: string[] = [];
      for (let i = 1; i <= 392; i++)
        ids.push(
          (
            await app.inject({
              method: "POST",
              url: `${path}/${source}/records`,
              headers,
              payload: {
                question: `甲问题${i}`,
                expectedOutput: `答案${i}`,
                metadata: [],
              },
            })
          ).json().record.id,
        );
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const processing = {
        source: { kind: "draft", id: source },
        operation: "rewrite",
        instructions: "保留原文，新增分类",
        allowedFields: ["metadata"],
        metadataKeys: ["risk"],
      };
      async function finish(runId: string) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='opt10-legacy',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [runId],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
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
        await expect
          .poll(async () => (await read()).json().task.review?.runId, {
            timeout: 15000,
          })
          .toBe(runId);
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.every(
                  (t: any) => !["queued", "running"].includes(t.status),
                ),
            { timeout: 15000 },
          )
          .toBe(true);
      }
      const runs: string[] = [];
      for (const recordIds of [ids.slice(0, 200), ids.slice(192, 392)]) {
        requestedTool = {
          name: "submit_processing",
          input: { ...processing, recordIds },
        };
        const runId = (await send("分类这批已选记录")).json().task.runId;
        runs.push(runId);
        await finish(runId);
      }
      const task = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      const selected = { method: "random", mode: "count", value: 200 };
      const target = { kind: "newDraft", name: "200条有效成果" };
      // Historical fixture: two independently frozen runs, eight overlapping source records,
      // and a plan that mistakenly repeated the same random-selection configuration.
      task.executionPlan = {
        mode: "execute",
        current: 2,
        steps: [
          ...runs.map((runId, i) => ({
            id: `legacy-${i}`,
            title: "已处理",
            action: "submit_processing",
            input: { ...processing, selection: selected },
            status: "executed",
            receipt: { key: `legacy-${i}`, runId },
          })),
          {
            id: "review",
            title: "核对已有成果",
            action: "read_processing",
            input: { runId: runs[1] },
            status: "pending",
          },
          {
            id: "adopt",
            title: "提交采用确认",
            action: "request_processing_apply",
            input: { runId: runs[1], allTask: true, target },
            status: "pending",
          },
        ],
      };
      task.processingScope.stepId = "legacy-1";
      task.targetCount = 200;
      task.countKind = "new";
      task.requirements = ["保留原文，分类已选200条"];
      task.classifications = [];
      task.executionPlan.requirementsKey = planRequirementsKey(task);
      await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
        sessionId,
        task,
      ]);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "继续200条",
            requirements: task.requirements,
            executionMode: "execute",
            nextAction: "read_processing",
            steps: task.executionPlan.steps.map(
              ({ title, action, input }: any) => ({ title, action, input }),
            ),
          },
        },
        { name: "read_processing", input: { runId: runs[1] } },
        {
          name: "request_processing_apply",
          input: { runId: runs[1], allTask: true, target },
        },
      ];
      const reviewed = (await send("核对已有成果并给我确认")).json();
      expect(
        reviewed.turns.at(-1).tools.filter((t: any) => t.status === "failed"),
        JSON.stringify(
          reviewed.turns.at(-1).tools.map((t: any) => ({
            name: t.name,
            status: t.status,
            error: t.error,
          })),
        ),
      ).toEqual([]);
      expect(
        reviewed.task.review,
        JSON.stringify(reviewed.task.review),
      ).toMatchObject({
        total: 200,
        complete: true,
        protectedFieldChanges: 0,
      });
      const ready = (await read()).json();
      const proposal = ready.proposals.find((p: any) => p.status === "pending");
      expect(proposal.summary.count).toBe(200);
      requestedTool = { name: "read_processing", input: { runId: runs[1] } };
      const adopted = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      const destination = adopted.json().receipt.receipt.draftId;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/proposals/${proposal.id}/confirm`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.every(
                (t: any) => !["queued", "running"].includes(t.status),
              ),
          { timeout: 15000 },
        )
        .toBe(true);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "发布200条",
            requirements: ["发布已采用的200条"],
            target: { kind: "draft", id: destination },
            targetDraftId: destination,
            countKind: "final",
            targetCount: 200,
            executionMode: "execute",
            nextAction: "request_publish",
            steps: [
              {
                title: "发布",
                action: "request_publish",
                input: { draftId: destination },
              },
            ],
          },
        },
        { name: "request_publish", input: { draftId: destination } },
      ];
      const publication = (await send("发布已采用的200条")).json();
      const publish = publication.proposals.find(
        (p: any) => p.status === "pending" && p.action === "publish",
      );
      expect(publish.summary.count).toBe(200);
      const committed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${publish.id}/confirm`,
        headers,
        payload: {},
      });
      expect(committed.statusCode, committed.body).toBe(200);
      const receipt = committed.json().receipt;
      const rows = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${receipt.testSet.id}/versions/${receipt.version.id}/records?limit=100`,
        headers,
      });
      expect(rows.statusCode).toBe(200);
      const secondPage = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/solo-test-sets/${receipt.testSet.id}/versions/${receipt.version.id}/records?limit=100&offset=100`,
          headers,
        })
      ).json();
      expect([...rows.json().records, ...secondPage.records]).toHaveLength(200);
      expect(rows.json().records[0].question).toContain("甲问题");
      const csv = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${receipt.testSet.id}/versions/${receipt.version.id}/data.csv`,
        headers,
      });
      expect(csv.statusCode, csv.body).toBe(200);
      const exported = parseCsv(csv.body, { columns: true, bom: true });
      expect(exported).toHaveLength(200);
      expect(exported.map((row: any) => row.question)).toEqual(
        Array.from({ length: 200 }, (_, i) => `甲问题${i + 193}`),
      );
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.every(
                (t: any) => !["queued", "running"].includes(t.status),
              ),
          { timeout: 15000 },
        )
        .toBe(true);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  it("OPT-10 rejects invented document definitions and recovers a mutually exclusive planning input", async () => {
    const previous = sessionId;
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const document = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/background-documents`,
          headers,
          payload: {
            fileName: "分类定义.md",
            contentBase64: Buffer.from(
              "A.1.a 表示甲类问题。\nA.2.a 表示乙类问题。",
              "utf8",
            ).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: document.id },
      };
      await send("先读取分类定义");
      const plan = {
        title: "按附件分类",
        requirements: ["按附件真实定义分类"],
        nextAction: "none",
      };
      requestedTool = {
        name: "plan_task",
        input: {
          ...plan,
          classifications: [
            {
              field: "metadata",
              key: "risk",
              basis: "background",
              allowedValues: ["A.1.a"],
              definitions: [{ value: "A.1.a", text: "不存在的定义" }],
            },
          ],
        },
      };
      const invalid = (
        await send("按文档定义制定分类", undefined, "failed")
      ).json();
      expect(
        invalid.turns.at(-1).tools.find((t: any) => t.name === "plan_task"),
      ).toMatchObject({
        status: "failed",
        error: { code: "assistant_background_rule_mismatch" },
      });
      expect(invalid.task.classifications ?? []).toEqual([]);
      const valid = {
        ...plan,
        classifications: [
          {
            field: "metadata",
            key: "risk",
            basis: "background",
            allowedValues: ["A.1.a", "A.2.a"],
            definitions: [
              { value: "A.1.a", text: "表示甲类问题。" },
              { value: "A.2.a", text: "表示乙类问题。" },
            ],
          },
        ],
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            ...valid,
            question: "参数修正",
            nextAction: "select_candidates",
          },
        },
        { name: "plan_task", input: { ...valid, steps: {} } },
        { name: "plan_task", input: valid },
      ];
      const corrected = (await send("纠正分类并保存方案")).json();
      const tools = corrected.turns
        .at(-1)
        .tools.filter((t: any) => t.name === "plan_task");
      expect(tools[0]).toMatchObject({
        status: "failed",
        error: { code: "assistant_tool_input_invalid" },
      });
      expect(tools[0].error.hint).toContain("question");
      expect(tools[1]).toMatchObject({
        status: "failed",
        error: { code: "assistant_tool_input_invalid" },
      });
      expect(tools[1].error.hint).toContain("steps");
      expect(tools[2].status).toBe("succeeded");
      expect(corrected.task.classifications[0].allowedValues).toEqual([
        "A.1.a",
        "A.2.a",
      ]);
      const wirePlan = calls
        .at(-1)!
        .tools.find((t: any) => t.function.name === "plan_task");
      expect(wirePlan.function.parameters.allOf).toBeUndefined();
      expect(wirePlan.function.parameters.anyOf).toBeUndefined();
      expect(wirePlan.function.parameters.required).toEqual([]);
      const acceptsPlan = new Ajv({ strict: false }).compile(
        wirePlan.function.parameters,
      );
      const validPlan = { title: "继续处理", requirements: [] };
      expect(acceptsPlan({ ...validPlan, nextAction: "read_processing" })).toBe(
        true,
      );
      expect(
        acceptsPlan({
          ...validPlan,
          question: "选取方式？",
          nextAction: "none",
        }),
      ).toBe(true);
      // The thin wire schema describes values; the actual tool below rejected
      // question plus an execution action before saving any contradictory plan.
      expect(acceptsPlan({ nextAction: "read_processing" })).toBe(true);
      expect(acceptsPlan({ targetCount: 4 })).toBe(true);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
    }
  });

  it.each([false, true])(
    "OPT-10 stops repeated SDK parameter failures before executing another write (same batch: %s)",
    async (sameBatch) => {
      const previous = sessionId;
      try {
        sessionId = (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions`,
            headers,
            payload: {},
          })
        ).json().sessionId;
        toolSequence = [
          { name: "plan_task", input: { title: 1 } },
          { name: "plan_task", input: { title: 2 } },
          { name: "create_draft", input: { name: "不得执行的草稿" } },
        ];
        if (sameBatch) {
          toolBatch = toolSequence;
          toolSequence = [];
        }
        const state = (
          await send("测试参数恢复停止边界", undefined, "failed")
        ).json();
        const results = state.turns.at(-1).tools;
        expect(results.filter((t: any) => t.name === "plan_task")).toHaveLength(
          2,
        );
        expect(results[0].error.hint).toContain("title");
        expect(
          results.some(
            (t: any) => t.name === "create_draft" && t.status === "succeeded",
          ),
        ).toBe(false);
        expect(
          state.turns.at(-1).diagnostics?.toolCalls ??
            state.task.diagnostics.toolCalls,
        ).toBeLessThan(12);
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        toolBatch = undefined;
      }
    },
  );
  it("OPT-10 reuses a fixed random input through successive processing steps", async () => {
    const previous = sessionId;
    const db = createPool(databaseUrl);
    const draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "固定输入连续处理" },
        })
      ).json().draft.id;
      for (let i = 1; i <= 40; i++)
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${draftsPath}/${source}/records`,
              headers,
              payload: {
                question: `甲问题${i}`,
                expectedOutput: `答案${i}`,
                metadata: [],
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
      const input = {
        source: { kind: "draft", id: source },
        operation: "rewrite",
        instructions: "只增加分类",
        allowedFields: ["metadata"],
        metadataKeys: ["risk"],
      };
      const selection = {
        method: "random",
        conditions: [],
        mode: "count",
        value: 20,
      };
      requestedTool = {
        name: "read_records",
        input: {
          source: input.source,
          selection: { ...selection, seed: "fixed-first" },
        },
      };
      const selected = (await send("先固定20条，不改写内容")).json();
      expect(selected.task.processingScope.count).toBe(20);
      expect(selected.task.runId).toBeUndefined();
      expect(selected.turns.at(-1).tools[0].result.matchingTotal).toBe(20);
      requestedTool = {
        name: "submit_processing",
        input: { ...input, selection: { ...selection, seed: "fixed-first" } },
      };
      const first = (await send("随机选20条，保留原文并增加分类")).json().task
        .runId;
      async function finish(id: string) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='opt10',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        const config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
        const receipt = await runProcessing(
          db,
          new ArtifactRepository(config.minio),
          config,
          job,
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [job.id, receipt],
        );
        await expect
          .poll(async () => (await read()).json().task.review?.runId, {
            timeout: 15000,
          })
          .toBe(id);
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.every(
                  (t: any) => !["queued", "running"].includes(t.status),
                ),
            { timeout: 15000 },
          )
          .toBe(true);
      }
      await finish(first);
      const initial = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${first}?limit=100`,
          headers,
        })
      ).json();
      requestedTool = {
        name: "submit_processing",
        input: { ...input, instructions: "同一批重新核对分类", selection },
      };
      const second = (await send("对已固定的20条继续核对分类")).json().task
        .runId;
      await finish(second);
      const following = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${second}?limit=100`,
          headers,
        })
      ).json();
      expect(following.records.map((r: any) => r.original.id)).toEqual(
        initial.records.map((r: any) => r.original.id),
      );
      expect((await read()).json().task.review.total).toBe(20);
      requestedTool = {
        name: "submit_processing",
        input: {
          ...input,
          instructions: "明确重新抽取",
          selection: { ...selection, seed: "different-second" },
        },
      };
      const third = (await send("明确重新抽一批20条")).json().task.runId;
      await finish(third);
      const redrawn = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/processing-runs/${third}?limit=100`,
          headers,
        })
      ).json();
      expect(redrawn.records.map((r: any) => r.original.id)).not.toEqual(
        initial.records.map((r: any) => r.original.id),
      );
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });

  it("OPT18 stops automatic continuation when the processing budget is exhausted", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const draft = (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts`,
          headers,
          payload: { name: "预算停止" },
        })
      ).json().draft.id;
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
        headers,
        payload: { question: "原问题", expectedOutput: "分类", metadata: [] },
      });
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: draft },
          allRecords: true,
          selection: null,
          operation: "rewrite",
          instructions: "改写",
          allowedFields: ["question"],
        },
      };
      const submitted = (await send("改写此问题")).json(),
        runId = submitted.task.runId;
      expect(runId).toBeTruthy();
      const before = calls.length;
      // The model would try to submit again if the completion event reached it.
      await db.query(
        "INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at) VALUES($1,0,3,now())",
        [runId],
      );
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed',counts=jsonb_build_object('processingBatches',1),updated_at=now() WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [runId],
      );
      await expect
        .poll(
          async () => {
            const turn = (await read()).json().turns.at(-1);
            return (
              turn?.event === "processing_completed" &&
              turn.status === "succeeded"
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      const done = (await read()).json();
      expect(done.turns.at(-1).assistantText).toContain("已达到本批次处理上限");
      expect(done.task.runId).toBe(runId);
      expect(done.task.stage).toBe("awaiting_review");
      expect(calls.length).toBe(before);
      const submitAgain = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: draft },
          allRecords: true,
          selection: null,
          operation: "rewrite",
          instructions: "改写",
          allowedFields: ["question"],
        },
      };
      toolBatch = [{ name: "read_processing", input: { runId } }, submitAgain];
      requestedTool = undefined;
      // Reuse the public recovery path with an automatic yield that has no eager processing read.
      await db.query(
        "UPDATE assistant_turn SET status='running',event='budget_yield',tool_results='[]',execution_attempt=1,expires_at=now()-interval '1 second' WHERE id=$1",
        [done.turns.at(-1).id],
      );
      await expect
        .poll(async () => (await read()).json().turns.at(-1).status, {
          timeout: 15000,
        })
        .toBe("succeeded");
      const late = (await read()).json();
      expect(late.turns.at(-1).assistantText).toContain("已达到本批次处理上限");
      expect(late.task.runId).toBe(runId);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM processing_run WHERE project_id=$1 AND source->>'id'=$2",
            [projectId, draft],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      requestedTool = undefined;
      toolBatch = undefined;
      sessionId = previous;
      await db.end();
    }
  });
  it("keeps clarification paused when its processing run completes", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl),
      draftsPath = `/api/projects/${projectId}/collaborative-drafts`;
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: draftsPath,
          headers,
          payload: { name: "澄清时的后台来源" },
        })
      ).json().draft.id;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${draftsPath}/${source}/records`,
            headers,
            payload: {
              question: "一个原问题",
              expectedOutput: "原标签",
              metadata: [],
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
      requestedTool = {
        name: "submit_processing",
        input: {
          source: { kind: "draft", id: source },
          allRecords: true,
          selection: null,
          operation: "rewrite",
          instructions: "改写问题",
          allowedFields: ["question"],
        },
      };
      const runId = (await send("改写当前问题")).json().task.runId;
      const clarification = {
        name: "plan_task",
        input: {
          title: "等待用途确认",
          requirements: ["确认用途后才采用结果"],
          executionMode: "execute",
          steps: [
            { title: "准备采用确认", action: "request_processing_apply" },
          ],
          question: "这些结果准备用于什么场景？",
          nextAction: "none",
        },
      };
      requestedTool = clarification;
      const waiting = (await send("先等等，确认用途后再采用")).json();
      expect(waiting.task.stage).toBe("waiting_input");
      expect(waiting.task.nextAction).toBeNull();
      for (const event of ["user", "processing_completed"]) {
        const beforeRecovery = calls.length;
        requestedTool = {
          name: "create_draft",
          input: { name: "未回答问题时不得创建的草稿" },
        };
        await db.query(
          "UPDATE assistant_turn SET status='running',execution_attempt=1,event=$2,assistant_text='',expires_at=now()-interval '1 second' WHERE id=$1",
          [waiting.turns.at(-1).id, event],
        );
        await expect
          .poll(async () => (await read()).json().turns.at(-1).status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        const recovered = (await read()).json();
        expect(recovered.task.stage).toBe("waiting_input");
        expect(recovered.task.question).toBe(clarification.input.question);
        expect(recovered.turns.at(-1).assistantText).toBe(
          clarification.input.question,
        );
        expect(recovered.proposals).toHaveLength(0);
        expect(calls.length).toBe(beforeRecovery);
      }
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='clarification-test',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const completed = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, completed],
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const finished = (await read()).json();
      expect(finished.task.stage).toBe("waiting_input");
      expect(finished.turns).toHaveLength(2);
      expect(finished.proposals).toHaveLength(0);
      requestedTool = clarification;
      expect((await send("仍需先确认用途")).json().task.stage).toBe(
        "waiting_input",
      );
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "准备采用结果",
            requirements: ["用于意图识别"],
            executionMode: "execute",
            steps: [
              { title: "准备采用确认", action: "request_processing_apply" },
              { title: "准备发布确认", action: "request_publish" },
            ],
          },
        },
        {
          name: "request_processing_apply",
          input: {
            runId,
            allValid: true,
            target: { kind: "newDraft", name: "用途已确认的测试集" },
          },
        },
        {
          name: "plan_task",
          input: {
            title: "确认发布用途",
            // Publication pauses in question; the already reviewed adoption requirements stay unchanged.
            requirements: ["用于意图识别"],
            question: "发布后的测试集由谁使用？",
            nextAction: "none",
          },
        },
      ];
      let adoptionProposal: any;
      let releaseContext: () => void = () => undefined;
      let enteredContext: () => void = () => undefined;
      const contextEntered = new Promise<void>((resolve) => {
        enteredContext = resolve;
      });
      const contextGate = new Promise<void>((resolve) => {
        releaseContext = resolve;
      });
      const originalContext = contextModule.assistantContext;
      const intercept = vi
        .spyOn(contextModule, "assistantContext")
        .mockImplementationOnce(async (...args) => {
          enteredContext();
          await contextGate;
          return originalContext(...args);
        });
      try {
        const submitted = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { message: "用于意图识别，现在采用" },
        });
        expect(submitted.statusCode, submitted.body).toBe(202);
        await contextEntered;
        await db.query(
          "UPDATE assistant_turn SET expires_at=now()-interval '1 second' WHERE id=$1",
          [submitted.json().turnId],
        );
        await expect
          .poll(async () => (await read()).json().turns.at(-1).status, {
            timeout: 15000,
          })
          .toBe("succeeded");
        const resumed = (await read()).json();
        expect(resumed.task.stage).toBe("waiting_input");
        expect(resumed.task.question).toBe("发布后的测试集由谁使用？");
        expect(resumed.proposals).toHaveLength(1);
        adoptionProposal = resumed.proposals[0];
      } finally {
        releaseContext();
        intercept.mockRestore();
      }
      const beforeConfirmation = calls.length;
      requestedTool = {
        name: "create_draft",
        input: { name: "确认采用不得绕过发布澄清" },
      };
      const confirmed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${adoptionProposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some(
                (t: any) =>
                  t.event === "confirmed" &&
                  !["queued", "running"].includes(t.status),
              ),
          { timeout: 15000 },
        )
        .toBe(true);
      const stillWaiting = (await read()).json();
      expect(stillWaiting.task.stage).toBe("waiting_input");
      expect(stillWaiting.task.question).toBe("发布后的测试集由谁使用？");
      expect(stillWaiting.task.nextAction).toBeNull();
      expect(stillWaiting.task.executionPlan.steps[0].status).toBe("executed");
      expect(stillWaiting.task.executionPlan.steps[1].status).toBe("pending");
      expect(stillWaiting.proposals).toHaveLength(1);
      expect(calls.length).toBe(beforeConfirmation);
      const draftId = confirmed.json().receipt.receipt.draftId;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            title: "准备发布结果",
            requirements: ["用于意图识别", "发布后由评测团队使用"],
            executionMode: "execute",
          },
        },
        { name: "request_publish", input: { draftId } },
      ];
      const readyToPublish = (await send("评测团队使用，请准备发布")).json();
      expect(readyToPublish.task.question).toBeNull();
      expect(readyToPublish.task.stage).toBe("awaiting_confirmation");
      expect(readyToPublish.task.executionPlan.steps[1].status).toBe("waiting");
      expect(
        readyToPublish.proposals.some((p: any) => p.action === "publish"),
      ).toBe(true);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  it.each([
    [429, "rate_limit"],
    [503, "temporary_service"],
    [401, "provider_rejected"],
    ["network", "network_error"],
    ["json", "output_protocol"],
    ["shape", "output_protocol"],
  ] as const)(
    "OPT-20 classifies provider failure %s through the public session",
    async (failure, category) => {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const before = calls.length;
      providerFailure = failure;
      providerFailureRemaining = [429, 503, "network"].includes(failure)
        ? 3
        : 1;
      const response = await send("查询项目信息", undefined, "failed");
      const state = response.json();
      const turn = state.turns.at(-1);
      expect(turn.diagnostics.failure).toMatchObject({
        layer: "model",
        category,
      });
      expect(turn.diagnostics).toMatchObject({
        requestAttempts: [429, 503, "network"].includes(failure) ? 3 : 1,
        modelRevision: 1,
        contractVersion: "assistant-diagnostics-v1",
      });
      expect(turn.diagnostics.failure.httpStatus).toBe(
        typeof failure === "number" ? failure : null,
      );
      expect(turn.diagnostics.diagnosticId).toBe(turn.id);
      expect(state.task.recovery.message.length).toBeGreaterThan(10);
      expect(response.body).not.toContain("private-provider-canary");
      expect(response.body).not.toContain("synthetic-test-key");
      expect(calls.length - before).toBe(
        [429, 503, "network"].includes(failure) ? 3 : 1,
      );
    },
  );
  it("OPT-20 preserves completed operations when the provider fails during the summary", async () => {
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    providerFailure = 503;
    providerFailureRemaining = 3;
    failAfterTool = true;
    const state = (
      await send("创建一个测试集草稿", undefined, "failed")
    ).json();
    const turn = state.turns.at(-1);
    expect(
      turn.tools.filter(
        (t: any) => t.name === "create_draft" && t.status === "succeeded",
      ),
    ).toHaveLength(1);
    expect(turn.diagnostics.retainedOperations).toBe(1);
    expect(turn.diagnostics.failure.category).toBe("temporary_service");
    expect(state.task.recovery.message).toContain("保留");
  });
  it("OPT-20 does not count a pending confirmation as a completed data operation", async () => {
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "待确认诊断" },
      })
    ).json().draft.id;
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
      headers,
      payload: {
        question: "合成问题",
        expectedOutput: "合成答案",
        metadata: [],
      },
    });
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    requestedTool = { name: "request_publish", input: { draftId: draft } };
    providerFailure = 503;
    providerFailureRemaining = 3;
    failAfterTool = true;
    try {
      const state = (
        await send("准备发布这个草稿", { kind: "draft", id: draft }, "failed")
      ).json();
      expect(state.proposals.some((p: any) => p.status === "pending")).toBe(
        true,
      );
      expect(state.turns.at(-1).diagnostics.retainedOperations).toBe(0);
    } finally {
      requestedTool = undefined;
    }
  });
  it.each([undefined, "ECONNRESET", "TimeoutError"])(
    "OPT-20 identifies application faults %s without leaking the exception",
    async (fault) => {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const original = contextModule.assistantContext;
      const spy = vi
        .spyOn(contextModule, "assistantContext")
        .mockImplementation(async (...args) => {
          if (args.length === 4)
            throw Object.assign(
              new Error("private-application-canary"),
              fault === "TimeoutError" ? { name: fault } : { code: fault },
            );
          return original(...args);
        });
      try {
        const state = (await send("查询项目信息", undefined, "failed")).json();
        expect(state.turns.at(-1).diagnostics.failure).toMatchObject({
          layer: "application",
          category: "internal_error",
        });
        expect(JSON.stringify(state)).not.toContain(
          "private-application-canary",
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  async function opt21Session() {
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
  }
  async function opt21Submit(
    message = "查询项目信息",
    context?: { kind: string; id: string },
  ) {
    const r = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${sessionId}/turns`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message, ...(context ? { context } : {}) },
    });
    expect(r.statusCode, r.body).toBe(202);
    return r.json().turnId;
  }
  async function opt21End(id: string) {
    await expect
      .poll(
        async () =>
          ["failed", "succeeded", "interrupted"].includes(
            (await read()).json().turns.find((t: any) => t.id === id)?.status,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    return (await read()).json();
  }
  it.each([429, 503, "network"] as const)(
    "OPT-21 recovers transient %s once without replaying tools",
    async (failure) => {
      await opt21Session();
      const before = calls.length;
      providerFailure = failure;
      providerFailureRemaining = 1;
      const state = await opt21End(await opt21Submit());
      const turn = state.turns.at(-1);
      expect(turn.status).toBe("succeeded");
      expect(turn.diagnostics.transportRetries).toBe(1);
      expect(turn.diagnostics.retryWaits).toMatchObject([
        { used: 1, delayMs: 500 },
      ]);
      expect(
        turn.tools.filter(
          (t: any) => t.name === "query_project" && t.status === "succeeded",
        ),
      ).toHaveLength(1);
      expect(calls[before]).toEqual(calls[before + 1]);
      expect(turn.diagnostics.requestAttempts).toBe(3);
    },
  );
  it("OPT-21 shares retry budget between model steps", async () => {
    await opt21Session();
    const before = calls.length;
    toolSequence = [
      { name: "query_project", input: { kind: "project" } },
      { name: "query_project", input: { kind: "testSets" } },
    ];
    providerFaults = [503, null, 503, null, 503];
    try {
      const state = await opt21End(await opt21Submit());
      const turn = state.turns.at(-1);
      expect(turn.status).toBe("failed");
      expect(calls.length - before).toBe(5);
      expect(turn.diagnostics.transportRetries).toBe(2);
      expect(turn.diagnostics.retryWaits.map((x: any) => x.delayMs)).toEqual([
        500, 1000,
      ]);
    } finally {
      providerFaults = [];
      providerFailure = undefined;
      toolSequence = [];
    }
  });
  it("OPT-21 honors excessive Retry-After without another request", async () => {
    await opt21Session();
    const before = calls.length;
    providerFailure = 429;
    providerRetryAfter = "120";
    try {
      const state = await opt21End(await opt21Submit());
      expect(state.turns.at(-1).status).toBe("failed");
      expect(state.turns.at(-1).diagnostics.transportRetries).toBe(0);
      expect(calls.length - before).toBe(1);
    } finally {
      providerRetryAfter = undefined;
      providerFailure = undefined;
    }
  });
  it("OPT-21 stops during Retry-After and never sends the retry", async () => {
    await opt21Session();
    const before = calls.length;
    providerFailure = 429;
    providerRetryAfter = "2";
    try {
      await opt21Submit();
      await expect
        .poll(async () => (await read()).json().task.transportRecovery?.retry, {
          timeout: 5000,
        })
        .toBe(1);
      const stop = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      expect(stop.statusCode, stop.body).toBe(200);
      await new Promise((r) => setTimeout(r, 2200));
      expect(calls.length - before).toBe(1);
      expect((await read()).json().task.stage).toBe("stopped");
    } finally {
      providerRetryAfter = undefined;
      providerFailure = undefined;
    }
  });
  it("OPT-21 stops a revoked write turn before its retry", async () => {
    await opt21Session();
    const before = calls.length;
    const db = createPool(databaseUrl);
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "撤权恢复边界" },
      })
    ).json().draft.id;
    const actor = (
      await db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
        sessionId,
      ])
    ).rows[0].actor_id;
    providerFailure = 429;
    providerRetryAfter = "2";
    try {
      const id = await opt21Submit("查询当前草稿", {
        kind: "draft",
        id: draft,
      });
      await expect
        .poll(async () => (await read()).json().task.transportRecovery?.retry, {
          timeout: 5000,
        })
        .toBe(1);
      await db.query("UPDATE app_user SET role='user' WHERE id=$1", [actor]);
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(project_id,user_id) DO UPDATE SET role='viewer'",
        [projectId, actor],
      );
      await new Promise((r) => setTimeout(r, 2200));
      expect(calls.length - before).toBe(1);
      expect(
        (await db.query("SELECT status FROM assistant_turn WHERE id=$1", [id]))
          .rows[0].status,
      ).toBe("failed");
      expect((await read()).statusCode).toBe(404);
    } finally {
      providerRetryAfter = undefined;
      providerFailure = undefined;
      await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [actor]);
      await db.query(
        "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
        [projectId, actor],
      );
      await db.end();
    }
  });
  it("OPT-21 retains original receipt and cumulative budgets on concurrent recovery", async () => {
    await opt21Session();
    const db = createPool(databaseUrl);
    const original = draftCreateModule.createSharedDraft;
    const spy = vi
      .spyOn(draftCreateModule, "createSharedDraft")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("response lost");
      });
    providerFailure = 503;
    providerFailureRemaining = 3;
    failAfterTool = true;
    try {
      const state = await opt21End(await opt21Submit("创建一个测试集草稿"));
      const turn = state.turns.at(-1);
      expect(turn.status).toBe("failed");
      const receipt = turn.tools.find(
        (t: any) => t.name === "create_draft" && t.status === "succeeded",
      );
      expect(receipt.result.recovered).toBe(true);
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{autoCount}','7') WHERE id=$1",
        [sessionId],
      );
      const request = {
        method: "POST" as const,
        url: `${base()}/sessions/${sessionId}/retry`,
        headers,
        payload: {},
      };
      const retries = await Promise.all([
        app.inject(request),
        app.inject(request),
      ]);
      expect(retries.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const restored = await opt21End(turn.id);
      expect(restored.task.autoCount).toBe(7);
      const current = (
        await db.query(
          "SELECT execution_attempt,tool_results FROM assistant_turn WHERE id=$1",
          [turn.id],
        )
      ).rows[0];
      expect(current.execution_attempt).toBe(2);
      expect(
        current.tool_results.find(
          (t: any) => t.name === "create_draft" && t.status === "succeeded",
        ).key,
      ).toBe(receipt.key);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM draft_creation_receipt WHERE operation_key=$1",
            [receipt.key],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(restored.turns.at(-1).diagnostics.transportRetries).toBe(2);
    } finally {
      spy.mockRestore();
      providerFailure = undefined;
      failAfterTool = false;
      providerFailureRemaining = 1;
      await db.end();
    }
  });
  it("OPT-21 blocks unknown writes until a receipt can be verified", async () => {
    await opt21Session();
    const spy = vi
      .spyOn(draftCreateModule, "createSharedDraft")
      .mockRejectedValue(new Error("unknown outcome"));
    try {
      requestedTool = {
        name: "create_draft",
        input: { name: "唯一未知回执边界" },
      };
      const state = await opt21End(await opt21Submit("创建一个测试集草稿"));
      const turn = state.turns.at(-1);
      expect(turn.status).toBe("failed");
      expect(spy).toHaveBeenCalledTimes(1);
      requestedTool = {
        name: "create_draft",
        input: { name: "唯一未知回执边界" },
      };
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
      const recovered = await opt21End(turn.id);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(recovered.turns.at(-1).diagnostics.failure.category).toBe(
        "effect_unknown",
      );
    } finally {
      spy.mockRestore();
      requestedTool = undefined;
    }
  });
  it("OPT-21 preserves real completed candidates when the final explanation fails", async () => {
    const db = createPool(databaseUrl);
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: { name: "处理结果保留" },
      })
    ).json().draft.id;
    for (const question of ["  甲问题  ", "  乙问题  "])
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draft}/records`,
        headers,
        payload: { question, expectedOutput: "原答案", metadata: [] },
      });
    await opt21Session();
    requestedTool = {
      name: "submit_processing",
      input: {
        source: { kind: "draft", id: draft },
        allRecords: true,
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    };
    try {
      const submitted = await opt21End(
        await opt21Submit("清理首尾空白", { kind: "draft", id: draft }),
      );
      const runId = submitted.task.runId;
      const job = (
        await db.query(
          "UPDATE job SET status='running',lease_owner='opt21',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const cfg = { ...loadConfig(), databaseUrl };
      const result = await runProcessing(
        db,
        new ArtifactRepository(cfg.minio),
        cfg,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      await expect
        .poll(async () => (await read()).json().task.stage, { timeout: 10000 })
        .toBe("awaiting_review");
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 5000 },
        )
        .toBe(false);
      const before = (
        await db.query("SELECT count(*)::int AS count FROM processing_run")
      ).rows[0].count;
      requestedTool = { name: "query_project", input: { kind: "project" } };
      providerFailure = 503;
      providerFailureRemaining = 3;
      failAfterTool = true;
      const state = await opt21End(await opt21Submit("说明当前已完成的结果"));
      expect(state.turns.at(-1).status).toBe("failed");
      expect(state.task.stage).toBe("awaiting_review");
      expect(state.task.runId).toBe(runId);
      expect(state.task.review.total).toBe(2);
      expect(state.task.canRetryTurn).toBe(true);
      expect(
        (await db.query("SELECT count(*)::int AS count FROM processing_run"))
          .rows[0].count,
      ).toBe(before);
      requestedTool = { name: "query_project", input: { kind: "project" } };
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
      const recovered = await opt21End(state.turns.at(-1).id);
      expect(recovered.turns.at(-1).status).toBe("succeeded");
      expect(recovered.task.recovery).toBeNull();
      // Legacy interruption after writing a valid output still has a recoverable batch.
      await db.query(
        "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}',to_jsonb('processing-v5'::text)) WHERE id=$1",
        [runId],
      );
      await db.query(
        "UPDATE processing_batch SET error_code='processing_batch_failed',model_attempts=1 WHERE run_id=$1",
        [runId],
      );
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=$1",
        [job.id],
      );
      await db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"awaiting_review","checkedStatus":"failed"}\'::jsonb WHERE id=$1',
        [sessionId],
      );
      const endpoint = `/api/projects/${projectId}/processing-runs/${runId}/status`;
      expect(
        (await app.inject({ method: "GET", url: endpoint, headers })).json()
          .recovery.canRetry,
      ).toBe(true);
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
      expect(
        (
          await db.query(
            "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
            [runId],
          )
        ).rows[0].model_attempts,
      ).toBe(1);
      // An expired explanation must not block a separately valid Worker recovery.
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=$1",
        [job.id],
      );
      await db.query(
        'UPDATE assistant_session SET task=jsonb_set(task,\'{turnBudget,deadlineAt}\',\'1\')||\'{"stage":"awaiting_review","checkedStatus":"failed","recovery":{"kind":"model_reply"}}\'::jsonb WHERE id=$1',
        [sessionId],
      );
      expect((await read()).json().task.canRetryTurn).toBe(false);
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
      expect(
        (
          await db.query(
            "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
            [runId],
          )
        ).rows[0].model_attempts,
      ).toBe(1);
    } finally {
      requestedTool = undefined;
      providerFailure = undefined;
      providerFailureRemaining = 1;
      failAfterTool = false;
      await db.end();
    }
  });
  it("OPT-21 refuses exhausted time and executor recovery budgets", async () => {
    await opt21Session();
    const db = createPool(databaseUrl);
    providerFailure = 401;
    try {
      const state = await opt21End(await opt21Submit());
      const id = state.turns.at(-1).id;
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{turnBudget,deadlineAt}',to_jsonb(1::bigint)) WHERE id=$1",
        [sessionId],
      );
      const request = {
        method: "POST" as const,
        url: `${base()}/sessions/${sessionId}/retry`,
        headers,
        payload: {},
      };
      expect((await app.inject(request)).statusCode).toBe(409);
      expect((await read()).json().task.canRetryTurn).toBe(false);
      await db.query(
        "UPDATE assistant_session SET task=task-'turnBudget' WHERE id=$1",
        [sessionId],
      );
      await db.query(
        "UPDATE assistant_turn SET execution_attempt=3 WHERE id=$1",
        [id],
      );
      expect((await app.inject(request)).statusCode).toBe(409);
      expect((await read()).json().task.canRetryTurn).toBe(false);
    } finally {
      await db.end();
    }
  });
  it("OPT-21 keeps an expired reclaimed turn's original budget", async () => {
    await opt21Session();
    const db = createPool(databaseUrl);
    providerFailure = 401;
    try {
      const state = await opt21End(await opt21Submit());
      const id = state.turns.at(-1).id;
      const before = calls.length;
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{turnBudget}', $2::jsonb)||'{\"stage\":\"inspecting\"}'::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            ...state.task.turnBudget,
            deadlineAt: 1,
            modelSteps: 5,
            toolCalls: 7,
            transportRetries: 2,
          }),
        ],
      );
      await db.query(
        "UPDATE assistant_turn SET status='running',expires_at=now()-interval '1 second',execution_attempt=1 WHERE id=$1",
        [id],
      );
      await expect
        .poll(
          async () => {
            const t = (
              await db.query(
                "SELECT status,execution_attempt FROM assistant_turn WHERE id=$1",
                [id],
              )
            ).rows[0];
            return t.status === "failed" && t.execution_attempt === 2;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      const recovered = (await read()).json();
      expect(recovered.task.turnBudget).toMatchObject({
        deadlineAt: 1,
        modelSteps: 5,
        toolCalls: 7,
        transportRetries: 2,
      });
      expect(calls.length).toBe(before);
      expect(recovered.task.canRetryTurn).toBe(false);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/retry`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await db.end();
    }
  });
  async function opt22Draft(label: string) {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: { name: label },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().draft.id;
    for (const question of ["  甲问题  ", "  乙问题  ", "  丙问题  "]) {
      const record = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${id}/records`,
        headers,
        payload: {
          question,
          expectedOutput: "保留答案",
          metadata: [{ key: "类别", value: "原类别" }],
        },
      });
      expect(record.statusCode, record.body).toBe(201);
    }
    return id;
  }
  it("OPT-22 identifies unsupported argument fields before a valid correction", async () => {
    const previous = sessionId;
    try {
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      requestedTool = undefined;
      toolSequence = [
        { name: "plan_task", input: { nextAction: "none", count: 4 } },
        { name: "plan_task", input: { nextAction: "none" } },
      ];
      const state = (await send("修正参数并保留原要求")).json();
      const records = state.turns.at(-1).tools;
      expect(records[0].status).toBe("failed");
      expect(records[0].error.hint).toContain("count");
      expect(records[0].error.hint).not.toContain("省略");
      expect(records[1].status).toBe("succeeded");
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });

  it("OPT-22 keeps real read receipts through partial plan updates and reordered requirements", async () => {
    const draft = await opt22Draft("要求顺序核对");
    await opt21Session();
    const before = calls.length;
    toolSequence = [
      {
        name: "plan_task",
        input: {
          executionMode: "execute",
          requirements: ["保留答案", "整理问题"],
          targetCount: 8,
          steps: [
            { title: "读取", action: "read_records", scope: "all" },
            {
              title: "核对资料",
              action: "query_project",
              input: { kind: "project" },
            },
          ],
        },
      },
      { name: "read_records", input: {} },
      { name: "plan_task", input: { executionMode: "plan" } },
    ];
    const initial = await opt21End(
      await opt21Submit("先读取再保留方案", { kind: "draft", id: draft }),
    );
    expect(initial.task.executionPlan.current).toBe(1);
    const receipt = initial.task.executionPlan.steps[0];
    expect(receipt.status).toBe("executed");
    expect(
      calls
        .slice(before)
        .some(
          (call) =>
            !call.tools.some(
              (tool: any) => tool.function.name === "submit_processing",
            ),
        ),
    ).toBe(true);
    const afterReads = calls.length;
    requestedTool = {
      name: "plan_task",
      input: {
        requirements: [" 整理问题 ", "保留答案", "保留答案  "],
        executionMode: "plan",
      },
    };
    const reordered = await opt21End(
      await opt21Submit("只整理要求顺序，不执行"),
    );
    expect(reordered.turns.at(-1).status).toBe("succeeded");
    expect(reordered.task.executionPlan.current).toBe(1);
    expect(reordered.task.executionPlan.steps[0]).toMatchObject({
      id: receipt.id,
      status: "executed",
    });
    expect(
      calls
        .slice(afterReads)
        .every((call) =>
          call.tools.every((tool: any) =>
            [
              "plan_task",
              "read_records",
              "query_project",
              "read_background",
            ].includes(tool.function.name),
          ),
        ),
    ).toBe(true);
    requestedTool = {
      name: "plan_task",
      input: { targetCount: 4, executionMode: "plan" },
    };
    const changed = await opt21End(
      await opt21Submit("数量改为4条，仍只给方案"),
    );
    expect(changed.task.requirements).toEqual(["整理问题", "保留答案"]);
    expect(changed.task.targetCount).toBe(4);
    expect(changed.task.executionPlan.current).toBe(0);
    requestedTool = {
      name: "plan_task",
      input: { requirements: [], targetCount: null, executionMode: "plan" },
    };
    const cleared = await opt21End(await opt21Submit("撤销文字和数量要求"));
    expect(cleared.task.requirements).toEqual([]);
    expect(cleared.task.targetCount).toBeNull();
  });
  it("OPT-22 submits short actions using the same fixed input and rejects an unbound new source", async () => {
    const draft = await opt22Draft("短参数固定范围");
    await opt21Session();
    toolSequence = [
      {
        name: "plan_task",
        input: { allowedFields: ["question"], nextAction: "submit_processing" },
      },
      {
        name: "submit_processing",
        input: {
          operation: "clean",
          instructions: "",
          selection: {
            method: "random",
            conditions: [],
            mode: "count",
            value: 1,
            seed: "opt22",
          },
        },
      },
    ];
    const state = await opt21End(
      await opt21Submit("清洗选中的一条", { kind: "draft", id: draft }),
    );
    expect(state.task.processingScope.count).toBe(1);
    expect(
      state.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "submit_processing").status,
    ).toBe("succeeded");
    const first = state.task.runId;
    const db = createPool(databaseUrl);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',lease_owner='opt22',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [first],
        )
      ).rows[0];
      const cfg = { ...loadConfig(), databaseUrl };
      const result = await runProcessing(
        db,
        new ArtifactRepository(cfg.minio),
        cfg,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      await expect
        .poll(async () => (await read()).json().task.stage, { timeout: 10000 })
        .toBe("awaiting_review");
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 10000 },
        )
        .toBe(false);
      requestedTool = {
        name: "submit_processing",
        input: { operation: "clean", instructions: "" },
      };
      const second = await opt21End(await opt21Submit("同一条再清洗一次"));
      expect(second.task.processingScope.count).toBe(1);
      expect(second.task.processingScope.hash).toBe(
        state.task.processingScope.hash,
      );
      expect(second.task.runId).not.toBe(first);
      const run = (
        await db.query(
          "SELECT input_count,options FROM processing_run WHERE id=$1",
          [second.task.runId],
        )
      ).rows[0];
      expect(run.input_count).toBe(1);
      expect(run.options.allowedFields).toEqual(["question"]);
      const other = await opt22Draft("新范围必须重选");
      toolSequence = [
        {
          name: "plan_task",
          input: {
            target: { kind: "draft", id: other },
            nextAction: "submit_processing",
          },
        },
        {
          name: "submit_processing",
          input: { operation: "clean", instructions: "" },
        },
      ];
      const changed = await opt21End(
        await opt21Submit("更换来源，但尚未指定新范围"),
      );
      expect(
        changed.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "submit_processing").error
          .code,
      ).toBe("processing_scope_invalid");
      expect(changed.task.processingScope).toBeNull();
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM processing_run WHERE id=ANY($1::text[])",
            [[first, second.task.runId]],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it("OPT-22 returns field conflicts as failed plans without changing current rules", async () => {
    await opt21Session();
    requestedTool = {
      name: "plan_task",
      input: {
        targetCount: 4,
        classifications: [
          {
            field: "expectedOutput",
            allowedValues: ["A"],
            quotas: [{ value: "A", count: 2 }],
          },
        ],
        question: "是否确认？",
        nextAction: "none",
      },
    };
    const state = await opt21End(await opt21Submit("按固定配额设计方案"));
    const tool = state.turns
      .at(-1)
      .tools.find((t: any) => t.name === "plan_task");
    expect(tool.status).toBe("failed");
    expect(tool.error.code).toBe("assistant_plan_count_conflict");
    expect(tool.error.hint).toContain("期望输出");
    expect(state.task.targetCount).toBeUndefined();
    expect(state.task.classifications).toEqual([]);
  });
  it("OPT-22 invalidates an existing confirmation atomically when effective constraints change", async () => {
    const draft = await opt22Draft("同回合确认失效");
    await opt21Session();
    toolBatch = [
      { name: "request_publish", input: {} },
      {
        name: "plan_task",
        input: { requirements: ["先重新核对"], targetCount: 4 },
      },
    ];
    const state = await opt21End(
      await opt21Submit("准备发布后补充要求", { kind: "draft", id: draft }),
    );
    const proposal = state.proposals[0];
    expect(proposal.status).toBe("invalid");
    const confirmed = await app.inject({
      method: "POST",
      url: `${base()}/proposals/${proposal.id}/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(confirmed.statusCode).toBe(409);
    const db = createPool(databaseUrl);
    try {
      expect(
        (
          await db.query("SELECT status FROM collaborative_draft WHERE id=$1", [
            draft,
          ])
        ).rows[0].status,
      ).toBe("editing");
    } finally {
      await db.end();
    }
  });
  it.each([false, true])(
    "OPT-22 revokes a claimed confirmation while keeping committed receipts: %s",
    async (committed) => {
      const draft = await opt22Draft("确认竞争" + committed);
      await opt21Session();
      let releasePlan!: () => void,
        enteredPlan!: () => void,
        releasePublish!: () => void,
        enteredPublish!: () => void;
      const waitingPlan = new Promise<void>(
          (resolve) => (enteredPlan = resolve),
        ),
        planGate = new Promise<void>((resolve) => (releasePlan = resolve));
      const waitingPublish = new Promise<void>(
          (resolve) => (enteredPublish = resolve),
        ),
        publishGate = new Promise<void>(
          (resolve) => (releasePublish = resolve),
        );
      const update = taskModule.updateTask,
        publish = fenceModule.guardAssistantCommit;
      const pausePlan = vi
        .spyOn(taskModule, "updateTask")
        .mockImplementation(async (...args) => {
          if ((args[2].requirements as string[])?.includes("领取后更正要求")) {
            enteredPlan();
            await planGate;
          }
          return update(...args);
        });
      const pausePublish = vi
        .spyOn(fenceModule, "guardAssistantCommit")
        .mockImplementation(async (...args) => {
          if (!committed && args[1].assistantGuard?.proposalId) {
            enteredPublish();
            await publishGate;
          }
          return publish(...args);
        });
      let confirmation: Promise<Awaited<ReturnType<typeof read>>> | undefined;
      try {
        toolBatch = [
          { name: "request_publish", input: {} },
          {
            name: "plan_task",
            input: { requirements: ["领取后更正要求"], targetCount: 4 },
          },
        ];
        const turnId = await opt21Submit("准备发布并补充条件", {
          kind: "draft",
          id: draft,
        });
        await waitingPlan;
        const proposal = (await read()).json().proposals[0];
        confirmation = app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {},
        });
        const done = confirmation!;
        if (committed) {
          expect((await done).statusCode).toBe(200);
          // Only the test DB loses the acknowledgement after the real domain commit.
          const db = createPool(databaseUrl);
          try {
            await db.query(
              "UPDATE assistant_proposal SET status='executing',receipt=NULL,lease_until=now()+interval '60 seconds' WHERE id=$1",
              [proposal.id],
            );
          } finally {
            await db.end();
          }
        } else await waitingPublish;
        releasePlan();
        await opt21End(turnId);
        releasePublish();
        expect((await done).statusCode).toBe(committed ? 200 : 409);
        const state = (await read()).json(),
          stored = state.proposals.find((p: any) => p.id === proposal.id);
        expect(stored.status).toBe(committed ? "succeeded" : "invalid");
        const db = createPool(databaseUrl);
        try {
          expect(
            (
              await db.query(
                "SELECT status FROM collaborative_draft WHERE id=$1",
                [draft],
              )
            ).rows[0].status,
          ).toBe(committed ? "published" : "editing");
        } finally {
          await db.end();
        }
        if (committed) {
          expect(stored.receipt).toBeTruthy();
          const replay = await app.inject({
            method: "POST",
            url: `${base()}/proposals/${proposal.id}/confirm`,
            headers,
            payload: {},
          });
          expect(replay.statusCode, replay.body).toBe(200);
          expect(replay.json().replayed).toBe(true);
          await expect
            .poll(
              async () =>
                (await read())
                  .json()
                  .turns.some((t: any) =>
                    ["queued", "running"].includes(t.status),
                  ),
              { timeout: 10000 },
            )
            .toBe(false);
        }
      } finally {
        releasePlan();
        releasePublish();
        await confirmation;
        pausePlan.mockRestore();
        pausePublish.mockRestore();
        toolBatch = undefined;
      }
    },
  );
  it("OPT-23 keeps selected older metadata candidates after eight turns and rejects replaced identities", async () => {
    const draft = await opt22Draft("选中旧批次 Metadata");
    await opt21Session();
    const db = createPool(databaseUrl);
    async function finish(id: string, awaitReview = true) {
      const job = (
        await db.query(
          "UPDATE job SET status='running',lease_owner='opt22',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [id],
        )
      ).rows[0];
      const cfg = { ...loadConfig(), databaseUrl },
        result = await runProcessing(
          db,
          new ArtifactRepository(cfg.minio),
          cfg,
          job,
        );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      if (awaitReview)
        await expect
          .poll(async () => (await read()).json().task.stage, {
            timeout: 10000,
          })
          .toBe("awaiting_review");
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 10000 },
        )
        .toBe(false);
    }
    async function selectedTurn(message: string, runId: string) {
      const r = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message, candidates: { runId, resultIds: ["0:0"] } },
      });
      expect(r.statusCode, r.body).toBe(202);
      return opt21End(r.json().turnId);
    }
    try {
      requestedTool = {
        name: "submit_processing",
        input: {
          operation: "clean",
          instructions: "",
          selection: {
            method: "all",
            conditions: [
              { field: "question", operator: "contains", value: "甲" },
            ],
          },
        },
      };
      const first = (
        await opt21End(
          await opt21Submit("清洗甲问题", { kind: "draft", id: draft }),
        )
      ).task.runId;
      await finish(first);
      requestedTool = {
        name: "submit_processing",
        input: {
          operation: "clean",
          instructions: "",
          selection: {
            method: "all",
            conditions: [
              { field: "question", operator: "contains", value: "乙" },
            ],
          },
        },
      };
      const second = (await opt21End(await opt21Submit("再清洗乙问题"))).task
        .runId;
      await finish(second);
      // This fixture authorizes both batches as the current collection. A standalone
      // fixed input otherwise narrows the task to 乙, and an old 甲 ID must be rejected.
      await db.query(
        "UPDATE assistant_session SET task=task-'processingScope' WHERE id=$1",
        [sessionId],
      );
      const current = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      expect(
        current.records.map((row: any) => row.result.question).join(" "),
      ).toContain("甲");
      expect(
        current.records.map((row: any) => row.result.question).join(" "),
      ).toContain("乙");
      toolSequence = [
        {
          name: "plan_task",
          input: {
            allowedFields: ["question", "metadata"],
            metadataKeys: ["类别"],
            nextAction: "refine_candidates",
          },
        },
        {
          name: "refine_candidates",
          input: {
            runId: second,
            allSelected: true,
            instructions: "改类别",
            allowedFields: ["metadata"],
          },
        },
      ];
      const wrong = await selectedTurn("只修改勾选甲问题的类别", first);
      expect(
        wrong.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates").status,
      ).toBe("failed");
      requestedTool = {
        name: "refine_candidates",
        input: {
          allSelected: true,
          instructions: "只改类别",
          allowedFields: ["metadata"],
        },
      };
      requestedTool = { name: "query_project", input: { kind: "project" } };
      for (let i = 0; i < 8; i++)
        await opt21End(await opt21Submit("查询项目信息"));
      toolSequence = [
        { name: "plan_task", input: { nextAction: "refine_candidates" } },
        {
          name: "refine_candidates",
          input: {
            allSelected: true,
            instructions: "只改类别",
            allowedFields: ["metadata"],
          },
        },
      ];
      const fixed = await opt21End(await opt21Submit("沿用刚才勾选的甲问题"));
      expect(
        fixed.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates").status,
      ).toBe("succeeded");
      const child = (
        await db.query(
          "SELECT parent_run_id,input_count,options FROM processing_run WHERE id=$1",
          [fixed.task.runId],
        )
      ).rows[0];
      expect(child.parent_run_id).toBe(first);
      expect(child.input_count).toBe(1);
      expect(child.options.metadataKeys).toEqual(["类别"]);
      expect(child.options.allowedFields).toContain("metadata");
      const beforeStale = (
        await db.query("SELECT count(*)::int AS count FROM processing_run")
      ).rows[0].count;
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            selectedCandidates: { runId: first, resultIds: ["0:0"] },
            stage: "awaiting_review",
            nextAction: "refine_candidates",
          }),
        ],
      );
      requestedTool = {
        name: "refine_candidates",
        input: {
          allSelected: true,
          instructions: "沿用旧选择",
          allowedFields: ["metadata"],
        },
      };
      const stale = await opt21End(await opt21Submit("继续修改这条"));
      expect(
        stale.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates").error.code,
      ).toBe("assistant_candidate_selection_changed");
      expect(
        (await db.query("SELECT count(*)::int AS count FROM processing_run"))
          .rows[0].count,
      ).toBe(beforeStale);
      await db.query(
        'UPDATE assistant_session SET task=task||\'{"selectedCandidates":null,"nextAction":null}\'::jsonb WHERE id=$1',
        [sessionId],
      );
      requestedTool = {
        name: "submit_processing",
        input: {
          operation: "clean",
          instructions: "",
          selection: {
            method: "all",
            conditions: [
              { field: "question", operator: "contains", value: "乙" },
            ],
          },
        },
      };
      const replacement = (await opt21End(await opt21Submit("重做乙问题"))).task
        .runId;
      await finish(replacement, false);
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            selectedCandidates: { runId: second, resultIds: ["0:0"] },
            nextAction: "refine_candidates",
            stage: "awaiting_review",
          }),
        ],
      );
      const beforeIndependent = (
        await db.query("SELECT count(*)::int AS count FROM processing_run")
      ).rows[0].count;
      requestedTool = {
        name: "refine_candidates",
        input: {
          allSelected: true,
          instructions: "沿用旧乙选择",
          allowedFields: ["metadata"],
        },
      };
      const replaced = await opt21End(
        await opt21Submit("修改之前勾选的乙问题"),
      );
      expect(
        replaced.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates").error.code,
      ).toBe("assistant_candidate_selection_changed");
      expect(
        (await db.query("SELECT count(*)::int AS count FROM processing_run"))
          .rows[0].count,
      ).toBe(beforeIndependent);
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      await db.end();
    }
  });
  it("OPT-23 rebuilds current source facts after fifty unrelated history entries", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = await opt22Draft("长会话当前来源");
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          target: { kind: "draft", id: source },
          targetCount: 2,
          allowedFields: ["metadata"],
          metadataKeys: ["类别"],
          requirements: ["保留问题和答案"],
          nextAction: "none",
        },
      };
      expect(
        (
          await opt21End(await opt21Submit("按当前来源保留题目与答案"))
        ).turns.at(-1).status,
      ).toBe("succeeded");
      await db.query(
        "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,assistant_text,status,created_at,expires_at) SELECT 'turn_'||md5($1||i::text),$1,'history-'||i::text,'synthetic','历史原话：已撤销的要求','历史说明','succeeded',now()+i*interval '1 microsecond',now()+interval '90 seconds' FROM generate_series(1,50) i",
        [sessionId],
      );
      const before = calls.length;
      requestedTool = { name: "read_records", input: {} };
      const state = await opt21End(await opt21Submit("继续查看当前来源"));
      expect(
        state.turns.at(-1).tools.find((t: any) => t.name === "read_records"),
      ).toMatchObject({
        status: "succeeded",
        input: { source: { kind: "draft", id: source } },
      });
      const request = calls[before];
      const context = JSON.parse(
        request.messages
          .find((m: any) => String(m.content).includes("当前业务上下文：\n"))
          .content.split("当前业务上下文：\n")[1],
      );
      expect(context.drafts.map((d: any) => d.name)).toContain(
        "长会话当前来源",
      );
      const facts = JSON.parse(
        request.messages
          .find((m: any) => String(m.content).startsWith("当前持久事实："))
          .content.split("当前持久事实：")[1],
      );
      expect(facts).toMatchObject({
        targetCount: 2,
        allowedFields: ["metadata"],
        metadataKeys: ["类别"],
        requirements: ["保留问题和答案"],
      });
      expect(Buffer.byteLength(JSON.stringify(request.messages))).toBeLessThan(
        90000,
      );
      expect(state.turns.some((t: any) => t.userText.includes("已撤销"))).toBe(
        true,
      );
    } finally {
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });

  it("OPT-23 summarizes a large live read and allows a bounded reread", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = await opt22Draft("大读取摘要");
      const metadata = Array.from({ length: 10 }, (_, i) => ({
        key: `key${i}`,
        value: "可用元数据".repeat(60),
      }));
      await db.query(
        "INSERT INTO collaborative_draft_record(id,draft_id,position,question,expected_output,metadata,updated_by) SELECT 'record_'||md5($1||i::text),$1,10+i,$2,'保留答案',$3::jsonb,(SELECT updated_by FROM collaborative_draft_record WHERE draft_id=$1 LIMIT 1) FROM generate_series(1,12) i",
        [source, "真实问题".repeat(120), JSON.stringify(metadata)],
      );
      await opt21Session();
      toolSequence = [
        {
          name: "plan_task",
          input: {
            target: { kind: "draft", id: source },
            executionMode: "execute",
            steps: [
              {
                title: "全量读取",
                action: "read_records",
                scope: "all",
                input: { source: { kind: "draft", id: source }, limit: 20 },
              },
            ],
          },
        },
        {
          name: "read_records",
          input: { source: { kind: "draft", id: source }, limit: 20 },
        },
      ];
      const state = await opt21End(await opt21Submit("查看较多资料"));
      const result = state.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "read_records").result;
      expect(state.task.executionPlan.steps[0].status).toBe("executed");
      expect(result).toMatchObject({
        total: 15,
        readCount: 15,
        contentTruncated: true,
        readAgain: { tool: "read_records" },
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(30000);
      requestedTool = {
        name: "read_records",
        input: { ...result.readAgain.input, limit: 1 },
      };
      const reread = await opt21End(await opt21Submit("重新读取一条正文"));
      expect(reread.turns.at(-1).tools[0].result.records).toHaveLength(1);
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });

  it.each([
    "single",
    "confirmed-failure",
    "restored-run",
    "changed-rules",
    "eight-deliveries",
  ] as const)(
    "OPT36 executes saved deliveries through background and confirmation without model reconstruction (%s)",
    async (variant) => {
      const count =
        variant === "single" ? 1 : variant === "eight-deliveries" ? 8 : 2;
      const previous = sessionId,
        db = createPool(databaseUrl);
      let lost: ReturnType<typeof vi.spyOn> | undefined;
      let tailReturnedAt = 0;
      let confirmedContext: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await opt21Session();
        const document = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "GB附录A原始摘录.txt",
              contentBase64: readFileSync(
                "tests/fixtures/assistant-gb-original-fragment.txt",
              ).toString("base64"),
            },
          })
        ).json().document;
        requestedTool = {
          name: "read_background",
          input: { documentId: document.id },
        };
        const background = await opt21End(await opt21Submit("读取附件"));
        const catalog = background.turns
          .at(-1)
          .tools.find((t: any) => t.name === "read_background")
          .result.definitions;
        const deliveries = Array.from(
          { length: count },
          (_, index) => ["A.1.a", "A.1.b"][index % 2],
        ).map((value) => ({
          name: "OPT36 " + value + " " + randomUUID(),
          count: 5,
          instructions: "按对应定义生成完整自然的用户问题",
          scenarios: [
            "用户说明背景后提出具体请求",
            "用户带限定条件提出请求",
            "用户询问实现对应目标的方法",
          ],
          classifications: [
            {
              field: "metadata",
              key: "riskCategory",
              basis: "background",
              allowedValues: [value],
              requiredValues: [value],
              quotas: [{ value, count: 5 }],
              definitions: [
                {
                  value,
                  reference: catalog.find((entry: any) => entry.value === value)
                    .reference,
                },
              ],
            },
          ],
        }));
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries,
            requirements: ["问题语义完整，期望输出写逐题具体安全行为"],
          },
        };
        const planned = await opt21End(
          await opt21Submit(
            count === 8
              ? "按附件规范建八份测试集，每份5条，先给方案，暂不执行。"
              : count === 2
                ? "GB A.1.a和A.1.b各一份5条，先给方案，暂不执行。"
                : "按文档为GB A.1.a建一份5条测试集，先给方案，暂不执行。",
          ),
        );
        expect(planned.task.executionPlan.mode).toBe("plan");
        const savedGenerations = planned.task.executionPlan.steps.filter(
          (s: any) => s.action === "generate_candidates",
        );
        expect(savedGenerations).toHaveLength(count);
        expect(planned.task.deliveries).toHaveLength(count);
        expect(
          planned.task.deliveries.every(
            (goal: any) =>
              goal.status === "planned" &&
              goal.count === 5 &&
              goal.savedCount === 0 &&
              !goal.draft &&
              !goal.run,
          ),
          JSON.stringify(planned.task.deliveries),
        ).toBe(true);
        const beforeDrafts = (
          await db.query(
            "SELECT count(*)::int n FROM collaborative_draft WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n;
        const create = processingStoreModule.createProcessingRun;
        lost = vi
          .spyOn(processingStoreModule, "createProcessingRun")
          .mockImplementationOnce(async (...args) => {
            await create(...args);
            await new Promise((resolve) => setTimeout(resolve, 35));
            tailReturnedAt = Date.now();
            throw new Error("synthetic committed response lost");
          });
        requestedTool = undefined;
        toolSequence = [];
        const modelRequests = () =>
          calls.filter((call) => Array.isArray(call.tools)).length;
        const modelBefore = modelRequests();
        let state = await opt21End(await opt21Submit("按当前已保存方案执行"));
        const finalBudget = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        expect(
          finalBudget.executionBudget.lastTurn.elapsedMs,
        ).toBeGreaterThanOrEqual(
          tailReturnedAt - finalBudget.turnBudget.startedAt,
        );
        const ids: string[] = [],
          drafts: string[] = [];
        const idle = async () => {
          await expect
            .poll(
              async () =>
                (await read())
                  .json()
                  .turns.some((t: any) =>
                    ["queued", "running"].includes(t.status),
                  ),
              { timeout: 15000 },
            )
            .toBe(false);
          return (await read()).json();
        };
        for (let index = 0; index < count; index++) {
          expect(state.task.stage, JSON.stringify(state.turns.at(-1))).toBe(
            "processing",
          );
          expect(state.task.deliveries[index]).toMatchObject({
            status: "processing",
            savedCount: 0,
            confirmed: false,
          });
          expect(
            state.task.deliveries
              .slice(0, index)
              .every(
                (goal: any) => goal.status === "saved" && goal.savedCount === 5,
              ),
            JSON.stringify({
              deliveries: state.task.deliveries,
              steps: state.task.executionPlan.steps.map((s: any) => ({
                id: s.id,
                status: s.status,
                receipt: s.receipt,
              })),
              last: state.turns.at(-1),
            }),
          ).toBe(true);
          const runId = state.task.runId;
          expect(runId).toBeTruthy();
          expect(ids).not.toContain(runId);
          ids.push(runId);
          const run = (
            await db.query(
              "SELECT target_draft_id,options,input_ref FROM processing_run WHERE id=$1",
              [runId],
            )
          ).rows[0];
          drafts.push(run.target_draft_id);
          expect(run.options.outputCount).toBe(5);
          expect(run.options.scenarios).toEqual(
            savedGenerations[index].input.scenarios,
          );
          const frozen = JSON.parse(
            (
              await new ArtifactRepository(loadConfig().minio).readBytes(
                run.input_ref,
                100000000,
              )
            ).toString(),
          );
          expect(frozen.background.classifications).toEqual(
            savedGenerations[index].input.classifications,
          );
          if (index === 0) {
            const turnId = state.turns.at(-1).id;
            const originalKey = state.task.executionPlan.steps[0].receipt.key;
            await db.query(
              "UPDATE assistant_turn SET status='failed',error_code='assistant_model_failed' WHERE id=$1",
              [turnId],
            );
            await db.query(
              "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
              [
                sessionId,
                JSON.stringify({ recovery: { kind: "model_reply" } }),
              ],
            );
            const recoveries = await Promise.all([
              app.inject({
                method: "POST",
                url: base() + "/sessions/" + sessionId + "/retry",
                headers,
                payload: {},
              }),
              app.inject({
                method: "POST",
                url: base() + "/sessions/" + sessionId + "/retry",
                headers,
                payload: {},
              }),
            ]);
            expect(
              recoveries.map((result) => result.statusCode).sort(),
            ).toEqual([200, 409]);
            state = await idle();
            expect(state.task.executionPlan.steps[0].receipt.key).toBe(
              originalKey,
            );
            expect(state.task.runId).toBe(runId);
          }
          await taskModule.collectProcessingEvents(db);
          await taskModule.collectProcessingEvents(db);
          expect((await idle()).task.runId).toBe(runId);
          expect(modelRequests()).toBe(modelBefore);
          await opt29Worker(runId);
          if (
            ["restored-run", "changed-rules"].includes(variant) &&
            index === 0
          ) {
            // A failed root can have complete current results after bounded continuation.
            // Simulate the old recompilation losing its waiting receipt; recover from
            // the same delivery's durable tool result, never submit another generation.
            await db.query(
              "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
              [runId],
            );
            expect(
              (await read()).json().task.deliveries[index].generatedCount,
            ).toBeNull();
            const repo = new ArtifactRepository(loadConfig().minio);
            const batch = (
              await db.query(
                "SELECT * FROM processing_batch WHERE run_id=$1 AND ordinal=0",
                [runId],
              )
            ).rows[0];
            const partialBody = JSON.parse(
              (await repo.readBytes(batch.result_ref, 1000000)).toString(),
            );
            partialBody.records = partialBody.records.slice(0, 3);
            const partialArtifact = await repo.storeProcessing(
              Buffer.from(JSON.stringify(partialBody)),
              runId,
              "batch-0",
            );
            await db.query(
              "UPDATE processing_batch SET result_ref=$2,output_count=3,result_indices=result_indices[1:3],error_code='processing_output_incomplete' WHERE run_id=$1 AND ordinal=0",
              [runId, partialArtifact.objectRef],
            );
            const refs = (
              await db.query(
                "SELECT current_refs FROM processing_task WHERE root_run_id=$1",
                [runId],
              )
            ).rows[0].current_refs;
            await db.query(
              "UPDATE processing_task SET current_refs=$2::jsonb,incomplete=true WHERE root_run_id=$1",
              [runId, JSON.stringify(refs.slice(0, 3))],
            );
            const path =
              "/api/projects/" + projectId + "/processing-tasks/" + runId;
            const partial = (
              await app.inject({ method: "GET", url: path, headers })
            ).json();
            expect(partial.task.generation).toMatchObject({
              validCount: 3,
              missingCount: 2,
            });
            const continuation = await app.inject({
              method: "POST",
              url: path + "/rounds",
              headers: { ...headers, "idempotency-key": randomUUID() },
              payload: {
                mode: "complete",
                expectedRevision: partial.task.revision,
              },
            });
            expect(continuation.statusCode, continuation.body).toBe(201);
            generationResponse = (prompt) =>
              prompt.generation.slots.map((slot: any) => ({
                question:
                  "补齐第" + slot.position + "个完整场景，应当怎样核验？",
                expectedOutput: "说明核验方法，不编造事实",
                metadata: [{ key: "riskCategory", value: "A.1.a" }],
              }));
            await opt29Worker(continuation.json().run.id);
            generationResponse = undefined;
            expect(
              (await read()).json().task.deliveries[index].generatedCount,
            ).toBeNull();
            const completed = (
              await app.inject({ method: "GET", url: path, headers })
            ).json();
            expect(completed.task.generation).toMatchObject({
              validCount: 5,
              missingCount: 0,
            });
            expect(
              completed.recovery.generationBudget.used,
            ).toBeLessThanOrEqual(3);
            await idle();
            const task = (
              await db.query("SELECT task FROM assistant_session WHERE id=$1", [
                sessionId,
              ])
            ).rows[0].task;
            task.executionPlan.steps.slice(0, 3).forEach((step: any) => {
              step.status = "pending";
              delete step.receipt;
              delete step.operation;
            });
            if (variant === "changed-rules") {
              task.requirements = [
                ...task.requirements,
                "期望输出现在必须只写一个固定标签",
              ];
              task.executionPlan.requirementsKey = planRequirementsKey(task);
            }
            task.executionPlan.current = 0;
            await db.query(
              "UPDATE assistant_session SET task=$2::jsonb WHERE id=$1",
              [sessionId, JSON.stringify(task)],
            );
            state = await opt21End(await opt21Submit("继续执行已保存方案"));
            if (variant === "changed-rules") {
              expect(
                state.proposals.filter((p: any) => p.status === "pending"),
              ).toHaveLength(0);
              expect(state.task.stage).not.toBe("awaiting_confirmation");
              expect(
                (
                  await db.query(
                    "SELECT count(*)::int n FROM processing_run WHERE target_draft_id=$1",
                    [run.target_draft_id],
                  )
                ).rows[0].n,
              ).toBe(2);
              expect(
                (
                  await db.query(
                    "SELECT count(*)::int n FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
                    [run.target_draft_id],
                  )
                ).rows[0].n,
              ).toBe(0);
              return;
            }
            expect(state.task.stage, JSON.stringify(state.turns.at(-1))).toBe(
              "awaiting_confirmation",
            );
            expect(state.task.runId).toBe(runId);
            expect(
              (
                await db.query(
                  "SELECT count(*)::int n FROM processing_run WHERE id=ANY($1::text[])",
                  [ids],
                )
              ).rows[0].n,
            ).toBe(1);
          }
          await taskModule.collectProcessingEvents(db);
          await taskModule.collectProcessingEvents(db);
          state = await idle();
          expect(state.task.stage, JSON.stringify(state.turns.at(-1))).toBe(
            "awaiting_confirmation",
          );
          expect(state.task.deliveries[index]).toMatchObject({
            status: "awaiting_confirmation",
            generatedCount: 5,
            savedCount: 0,
            confirmed: false,
          });
          const statusView = (
            await app.inject({
              method: "GET",
              url: base() + "/sessions/" + sessionId + "?view=status",
              headers,
            })
          ).json();
          expect(statusView.task.deliveries).toEqual(state.task.deliveries);
          expect(
            statusView.task.executionPlan.steps.some((step: any) => step.input),
          ).toBe(false);
          const proposal = state.proposals.find(
            (p: any) => p.status === "pending",
          );
          expect(proposal, JSON.stringify(state.turns.at(-1))).toBeDefined();
          const actual = (
            await db.query(
              "SELECT parameters FROM assistant_proposal WHERE id=$1",
              [proposal.id],
            )
          ).rows[0].parameters;
          expect(actual.target.id).toBe(run.target_draft_id);
          expect(
            (actual.resultGroups ?? [{ resultIds: actual.resultIds }]).flatMap(
              (g: any) => g.resultIds,
            ),
          ).toHaveLength(5);
          if (variant === "confirmed-failure" && index === 0)
            confirmedContext = vi
              .spyOn(contextModule, "currentTaskFacts")
              .mockImplementationOnce(() => {
                throw new Error("synthetic confirmation context failure");
              });
          if (variant === "eight-deliveries" && index === count - 1) {
            const originalCandidateStats = (
              await app.inject({
                method: "GET",
                url: base() + "/sessions/" + sessionId + "/candidates",
                headers,
              })
            ).json().stats;
            await db.query(
              "UPDATE assistant_session SET task=jsonb_set(jsonb_set(task,'{autoCount}',task->'autoEventLimit'),'{classifications}',$2::jsonb) WHERE id=$1",
              [
                sessionId,
                JSON.stringify(savedGenerations[0].input.classifications),
              ],
            );
            const viewed = (await read()).json();
            expect(viewed.task.classifications).toEqual(
              savedGenerations.at(-1).input.classifications,
            );
            const candidates = (
              await app.inject({
                method: "GET",
                url: base() + "/sessions/" + sessionId + "/candidates",
                headers,
              })
            ).json();
            expect(candidates.stats.contentChecked).toBe(
              originalCandidateStats.contentChecked,
            );
            expect(candidates.stats.contentPending).toBe(
              originalCandidateStats.contentPending,
            );
          }
          for (let repeat = 0; repeat < 2; repeat++) {
            const confirmed = await app.inject({
              method: "POST",
              url: base() + "/proposals/" + proposal.id + "/confirm",
              headers,
              payload: {},
            });
            expect(confirmed.statusCode, confirmed.body).toBe(200);
          }
          await taskModule.collectProcessingEvents(db);
          state = await idle();
          if (variant === "confirmed-failure" && index === 0) {
            confirmedContext?.mockRestore();
            expect(state.turns.at(-1).status).toBe("failed");
            const failedId = state.turns.at(-1).id;
            await db.query(
              "UPDATE assistant_session SET task=jsonb_set(task,'{turnBudget,deadlineAt}','0') WHERE id=$1",
              [sessionId],
            );
            state = await opt21End(await opt21Submit("继续执行已保存方案"));
            expect(state.task.stage, JSON.stringify(state.turns.at(-1))).toBe(
              "processing",
            );
            expect(
              state.turns.find((item: any) => item.id === failedId).status,
            ).toBe("failed");
            expect(modelRequests()).toBe(modelBefore);
          }
          expect(
            (
              await db.query(
                "SELECT count(*)::int n FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
                [run.target_draft_id],
              )
            ).rows[0].n,
          ).toBe(5);
        }
        expect(state.task.executionPlan.current).toBe(
          state.task.executionPlan.steps.length,
        );
        expect(
          state.task.executionPlan.steps.every(
            (s: any) => s.status === "executed",
          ),
        ).toBe(true);
        expect(state.task.stage).toBe("complete");
        if (variant === "eight-deliveries") {
          const persisted = (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task;
          expect(persisted.autoEventLimit).toBe(18);
          expect(persisted.autoCount).toBe(18);
          const turnCount = state.turns.length;
          await taskModule.collectProcessingEvents(db);
          await taskModule.collectProcessingEvents(db);
          expect((await read()).json().turns).toHaveLength(turnCount);
        }
        expect(
          state.task.deliveries.every(
            (goal: any) =>
              goal.status === "saved" &&
              goal.savedCount === 5 &&
              goal.draft.count === 5 &&
              goal.confirmed,
          ),
        ).toBe(true);
        expect(new Set(drafts).size).toBe(count);
        expect(modelRequests() - modelBefore).toBe(0);
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM collaborative_draft WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].n - beforeDrafts,
        ).toBe(count);
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM processing_run WHERE id=ANY($1::text[])",
              [ids],
            )
          ).rows[0].n,
        ).toBe(count);
        expect(
          state.turns
            .flatMap((t: any) => t.tools)
            .filter(
              (t: any) =>
                t.name === "generate_candidates" && t.status === "succeeded",
            ),
        ).toHaveLength(count);
        expect(
          state.turns.some((t: any) =>
            t.tools.some(
              (r: any) =>
                r.name === "generate_candidates" && r.result?.recovered,
            ),
          ),
        ).toBe(true);
        expect((await read()).json().task.executionPlan).toEqual(
          state.task.executionPlan,
        );
        if (count === 8) {
          // Reproduce a restored task paused after committed receipts, before terminal settlement.
          await db.query(
            "UPDATE assistant_session SET task=jsonb_set(task,'{stage}','\"waiting_input\"'::jsonb) WHERE id=$1",
            [sessionId],
          );
          const lastGoal = state.task.deliveries.at(-1);
          const beforeA = state.task.executionPlan.steps.filter(
            (step: any) => step.deliveryId === savedGenerations[0].deliveryId,
          );
          requestedTool = {
            name: "plan_task",
            input: {
              executionMode: "plan",
              deliveries: [
                {
                  id: lastGoal.id,
                  instructions:
                    "仅使用完整自然的生活场景问题，明确描述当前类别边界",
                },
              ],
            },
          };
          const changed = await opt21End(
            await opt21Submit(
              "修改最后一份的生成要求为完整自然的生活场景问题，明确描述类别边界；其他交付和共同要求不变，先保留方案，不执行。",
            ),
          );
          expect(
            changed.task.executionPlan?.mode,
            JSON.stringify(changed.turns.at(-1)),
          ).toBe("plan");
          const afterA = changed.task.executionPlan.steps.filter(
            (step: any) => step.deliveryId === savedGenerations[0].deliveryId,
          );
          expect(
            afterA.map((step: any) => ({
              status: step.status,
              receipt: step.receipt,
              input: step.input,
            })),
          ).toEqual(
            beforeA.map((step: any) => ({
              status: step.status,
              receipt: step.receipt,
              input: step.input,
            })),
          );
          expect(changed.task.deliveries[0]).toMatchObject({
            status: "saved",
            savedCount: 5,
          });
          expect(
            changed.task.executionPlan.steps.find(
              (step: any) =>
                step.deliveryId === lastGoal.id &&
                step.action === "generate_candidates",
            ).status,
          ).toBe("pending");
          const persistedAfter = (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task;
          expect(persistedAfter.autoEventLimit).toBe(18);
          expect(persistedAfter.autoCount).toBe(18);
          expect(
            Number(
              (
                await db.query(
                  "SELECT count(*) n FROM processing_run WHERE id=ANY($1::text[])",
                  [ids],
                )
              ).rows[0].n,
            ),
          ).toBe(count);
        }
      } finally {
        lost?.mockRestore();
        confirmedContext?.mockRestore();
        requestedTool = undefined;
        toolSequence = [];
        sessionId = previous;
        await db.end();
      }
    },
    90000,
  );

  it.each(["enlarged", "same-size"])(
    "OPT39 freezes event allowance once and pauses added work without new processing: %s",
    async (variant) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        const source = await opt22Draft("OPT39固定续步额度");
        await opt21Session();
        const steps = (count: number) =>
          Array.from({ length: count }, (_, index) => ({
            title: "清洗第" + (index + 1) + "轮",
            action: "submit_processing",
            input: {
              source: { kind: "draft", id: source },
              allRecords: true,
              operation: "clean",
              instructions: "",
              allowedFields: ["question"],
            },
          }));
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "plan",
            target: { kind: "draft", id: source },
            steps: steps(variant === "same-size" ? 6 : 1),
            requirements: ["只清洗问题，其他字段保留"],
          },
        };
        const initialPlan = await opt21End(
          await opt21Submit("暂存一轮清洗设置，不启动处理。", {
            kind: "draft",
            id: source,
          }),
        );
        expect(
          initialPlan.task.executionPlan?.steps.length,
          JSON.stringify(initialPlan.turns.at(-1)),
        ).toBe(variant === "same-size" ? 6 : 1);
        expect(
          (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task.autoEventLimit,
        ).toBeNull();
        requestedTool = {
          name: "plan_task",
          input: { executionMode: "execute" },
        };
        const started = await opt21End(
          await opt21Submit("按当前已保存方案执行"),
        );
        expect(started.task.stage, JSON.stringify(started.turns.at(-1))).toBe(
          "processing",
        );
        let before = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        const limit = variant === "same-size" ? 8 : 3;
        expect(before.autoEventLimit).toBe(limit);
        if (variant === "same-size") {
          before = {
            ...before,
            stage: "waiting_input",
            autoCount: 7,
            executionPlan: {
              ...before.executionPlan,
              current: 4,
              steps: before.executionPlan.steps.map(
                (step: any, index: number) => ({
                  ...step,
                  status: index < 4 ? "executed" : "pending",
                }),
              ),
            },
          };
          await db.query(
            "UPDATE assistant_session SET task=$2::jsonb WHERE id=$1",
            [sessionId, JSON.stringify(before)],
          );
        }
        const runCount = Number(
          (
            await db.query(
              "SELECT count(*) n FROM processing_run WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].n,
        );
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "execute",
            requirements: ["只清洗问题，其他字段保留"],
            steps:
              variant === "same-size"
                ? steps(6).map((step) => ({
                    ...step,
                    input: {
                      ...step.input,
                      instructions: "统一标点，保留原意",
                    },
                  }))
                : steps(5),
          },
        };
        const expanded = await opt21End(
          await opt21Submit(
            "将清洗方案增加到五轮，其他要求保持，按新方案执行。",
          ),
        );
        expect(
          expanded.task,
          JSON.stringify(
            expanded.turns
              .at(-1)
              ?.tools.filter((tool: any) => tool.status === "failed")
              .map((tool: any) => tool.error),
          ),
        ).toMatchObject({
          stage: "waiting_input",
          executionPaused: true,
          error: "assistant_auto_plan_limit",
          canContinueExecution: false,
        });
        const after = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        expect(after.autoEventLimit).toBe(limit);
        expect(after.autoCount).toBe(before.autoCount);
        expect(
          Number(
            (
              await db.query(
                "SELECT count(*) n FROM processing_run WHERE project_id=$1",
                [projectId],
              )
            ).rows[0].n,
          ),
        ).toBe(runCount);
      } finally {
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/stop",
          headers,
          payload: {},
        });
        requestedTool = undefined;
        toolSequence = [];
        sessionId = previous;
        await db.end();
      }
    },
  );

  it("OPT36 yields fixed reads at the original tool boundary without a model polling loop", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = await opt22Draft("OPT36固定读取预算");
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "execute",
          steps: Array.from({ length: 13 }, (_, offset) => ({
            title: "读取固定位置" + offset,
            action: "read_records",
            input: { source: { kind: "draft", id: source }, offset, limit: 1 },
          })),
        },
      };
      const before = calls.length;
      await opt21End(await opt21Submit("执行这些已确定的读取步骤，不修改数据"));
      await taskModule.collectProcessingEvents(db);
      await expect
        .poll(
          async () => {
            const state = (await read()).json();
            return (
              state.task.executionPlan.steps.every(
                (step: any) => step.status === "executed",
              ) &&
              !state.turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              )
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      const state = (await read()).json();
      expect(
        state.turns.some((turn: any) => turn.event === "budget_yield"),
      ).toBe(true);
      expect(calls.length - before).toBe(1);
      const budget = (
        await db.query(
          "SELECT task->'executionBudget' budget FROM assistant_session WHERE id=$1",
          [sessionId],
        )
      ).rows[0].budget;
      expect(budget.modelSteps).toBe(1);
      expect(budget.toolCalls).toBe(14);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });

  it.each(["retry", "time"])(
    "OPT36 enforces cumulative %s limits before another request",
    async (kind) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        await opt21Session();
        requestedTool = { name: "query_project", input: { kind: "project" } };
        await opt21End(await opt21Submit("查询项目"));
        const task = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        await db.query(
          "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
          [
            sessionId,
            JSON.stringify({
              executionBudget: {
                ...task.executionBudget,
                transportRetries: kind === "retry" ? 25 : 0,
                activeMs: kind === "time" ? 1040000 - 80 : 0,
              },
            }),
          ],
        );
        if (kind === "retry") {
          providerFailure = 503;
          providerFailureRemaining = 3;
        } else {
          hold = true;
          entered = () => undefined;
        }
        const before = calls.length;
        requestedTool = { name: "query_project", input: { kind: "project" } };
        const state = await opt21End(await opt21Submit("继续查询项目"));
        expect(state.turns.at(-1).status).toBe("failed");
        const saved = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        if (kind === "retry") {
          expect(calls.length - before).toBe(2);
          expect(saved.executionBudget.transportRetries).toBe(26);
          expect(state.turns.at(-1).errorCode).toBe("assistant_task_limit");
        } else {
          expect(calls.length - before).toBeLessThanOrEqual(1);
          expect(
            saved.turnBudget.deadlineAt - saved.turnBudget.startedAt,
          ).toBeLessThanOrEqual(80);
          expect([
            "assistant_budget_exhausted",
            "assistant_task_limit",
          ]).toContain(state.turns.at(-1).errorCode);
        }
      } finally {
        release();
        hold = false;
        providerFailure = undefined;
        providerFailureRemaining = 1;
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        await db.end();
      }
    },
  );

  it("OPT36 keeps cumulative execution limits across new user turns", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      requestedTool = { name: "query_project", input: { kind: "project" } };
      await opt21End(await opt21Submit("查询项目"));
      const first = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(first.executionBudget.modelSteps).toBeGreaterThan(0);
      requestedTool = { name: "query_project", input: { kind: "project" } };
      await opt21End(await opt21Submit("再次查询项目"));
      const second = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(second.executionBudget.modelSteps).toBeGreaterThan(
        first.executionBudget.modelSteps,
      );
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            autoCount: 12,
            stage: "failed",
            error: "assistant_task_limit",
            executionBudget: { ...second.executionBudget, modelSteps: 130 },
          }),
        ],
      );
      const before = calls.length;
      const blocked = await opt21End(await opt21Submit("继续查询项目"));
      expect(blocked.turns.at(-1).status).toBe("failed");
      expect(blocked.turns.at(-1).errorCode).toBe("assistant_task_limit");
      expect(blocked.task.autoCount).toBe(12);
      expect(calls.length).toBe(before);
      expect(
        (
          await db.query(
            "SELECT task->'executionBudget' budget FROM assistant_session WHERE id=$1",
            [sessionId],
          )
        ).rows[0].budget.modelSteps,
      ).toBe(130);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });

  it("OPT36 does not let a prior publication hide an unfinished saved step", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const draft = await opt22Draft("OPT36已发布但仍有待办");
      await opt21Session();
      requestedTool = { name: "request_publish", input: { draftId: draft } };
      const prepared = await opt21End(
        await opt21Submit("准备发布", { kind: "draft", id: draft }),
      );
      const proposal = prepared.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal).toBeDefined();
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [sessionId, JSON.stringify({ executionPaused: true })],
      );
      const confirmed = await app.inject({
        method: "POST",
        url: base() + "/proposals/" + proposal.id + "/confirm",
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((t: any) => ["queued", "running"].includes(t.status)),
          { timeout: 15000 },
        )
        .toBe(false);
      const checkpoint = {
        mode: "execute",
        needsReview: false,
        current: 0,
        steps: [
          {
            id: "remaining",
            title: "下一份尚未生成",
            action: "generate_candidates",
            status: "pending",
          },
        ],
      };
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            stage: "waiting_input",
            executionPaused: false,
            question: null,
            executionPlan: checkpoint,
          }),
        ],
      );
      expect((await read()).json().task.stage).not.toBe("complete");
      checkpoint.steps[0].status = "executed";
      checkpoint.current = 1;
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{executionPlan}',$2::jsonb) WHERE id=$1",
        [sessionId, JSON.stringify(checkpoint)],
      );
      expect((await read()).json().task.stage).toBe("complete");
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            stage: "waiting_input",
            executionPlan: {
              ...checkpoint,
              contractVersion: 1,
              steps: [
                {
                  ...checkpoint.steps[0],
                  deliveryId: "v1-uncredited",
                  input: {
                    name: "尚无采用回执的目标",
                    outputCount: 5,
                    classifications: [],
                    scenarios: ["完整自然问题"],
                  },
                },
              ],
            },
          }),
        ],
      );
      const v1Response = await read();
      expect(v1Response.statusCode, v1Response.body).toBe(200);
      const v1 = v1Response.json();
      expect(v1.task.stage).toBe("waiting_input");
      expect(v1.task.executionPlan.contractVersion).toBe(1);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });

  it("OPT40 preserves a blocked delivery while an independent goal completes and resumes only the supplied goal", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const upload = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + sessionId + "/background-documents",
        headers,
        payload: {
          fileName: "客服规范.md",
          contentBase64: readFileSync(
            "tests/fixtures/assistant-customer-intent.md",
          ).toString("base64"),
        },
      });
      expect(upload.statusCode, upload.body).toBe(201);
      requestedTool = {
        name: "read_background",
        input: { documentId: upload.json().document.id },
      };
      await opt21End(await opt21Submit("读取附件"));
      const goal = (name: string) => ({
        name,
        count: 3,
        instructions:
          "只生成完整自然的用户退款申请，明确请求退还货款，排除仅讨论或查询退款规则。",
        scenarios: [
          "在手机端提交申请",
          "收货后说明退款原因",
          "重复付款后联系客服",
        ],
        classifications: [],
      });
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: [
            {
              ...goal("缺少适用依据的兜底交付"),
              question: "请补充所依据的具体适用条件；仅有兜底条款不足以判定。",
            },
            goal("退款申请交付"),
          ],
          requirements: ["每条语义完整，不编造事实。"],
        },
      };
      const planned = await opt21End(
        await opt21Submit(
          "按附件建两份测试集，各3条；兜底部分缺少具体依据，先保留它的目标，独立退款部分可以执行。先给方案，暂不执行。",
        ),
      );
      expect(planned.task.deliveries[0]).toMatchObject({
        count: 3,
        status: "waiting_input",
        savedCount: 0,
      });
      expect(planned.task.executionPlan.current).toBe(3);
      const blockedId = planned.task.deliveries[0].id;
      requestedTool = undefined;
      const running = await opt21End(await opt21Submit("开始执行方案"));
      expect(running.task.stage, JSON.stringify(running.turns.at(-1))).toBe(
        "processing",
      );
      const runId = running.task.runId;
      await opt29Worker(runId);
      await taskModule.collectProcessingEvents(db);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .proposals.some((p: any) => p.status === "pending"),
          { timeout: 15000 },
        )
        .toBe(true);
      const waiting = (await read()).json();
      const proposal = waiting.proposals.find(
        (p: any) => p.status === "pending",
      );
      const confirmed = await app.inject({
        method: "POST",
        url: base() + "/proposals/" + proposal.id + "/confirm",
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      await expect
        .poll(async () => (await read()).json().task.stage, { timeout: 15000 })
        .toBe("waiting_input");
      const paused = (await read()).json();
      expect(paused.task.deliveries[0]).toMatchObject({
        id: blockedId,
        count: 3,
        status: "waiting_input",
        savedCount: 0,
      });
      expect(paused.task.deliveries[1]).toMatchObject({
        status: "saved",
        savedCount: 3,
      });
      expect(
        paused.task.executionPlan.steps
          .slice(0, 3)
          .every((s: any) => s.status === "pending"),
      ).toBe(true);
      const prior = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      const runCount = Number(
        (
          await db.query(
            "SELECT count(*) n FROM processing_run WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n,
      );
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: [
            {
              id: blockedId,
              question: null,
              instructions:
                "依据用户补充：仅在客户重复付款且明确请求退回多收款项时生成；未付款及只查询规则不属于本类。",
            },
          ],
        },
      };
      const supplied = await opt21End(
        await opt21Submit(
          "补充兜底适用条件：客户已重复付款并明确请求退回多收款项；把这个条件保存到第一份要求，只更新方案，暂不执行。",
        ),
      );
      expect(supplied.task.deliveries[0].question).toBeUndefined();
      expect(supplied.task.deliveries[1]).toMatchObject({
        status: "saved",
        savedCount: 3,
      });
      const after = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(after.autoEventLimit).toBe(prior.autoEventLimit);
      expect(after.autoCount).toBe(prior.autoCount);
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) n FROM processing_run WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].n,
        ),
      ).toBe(runCount);
    } finally {
      requestedTool = undefined;
      generationResponse = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });

  it.each(["distinct", "variants", "legacy"])(
    "OPT40 freezes question policy and excludes cross-batch collisions through completion: %s",
    async (variant) => {
      const previous = sessionId,
        db = createPool(databaseUrl),
        repo = new ArtifactRepository(loadConfig().minio);
      try {
        await opt21Session();
        const uploaded = await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "客服规范.md",
            contentBase64: readFileSync(
              "tests/fixtures/assistant-customer-intent.md",
            ).toString("base64"),
          },
        });
        requestedTool = {
          name: "read_background",
          input: { documentId: uploaded.json().document.id },
        };
        await opt21End(await opt21Submit("读取附件"));
        const count = variant === "distinct" ? 21 : 3;
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [
              {
                name: "OPT40问题策略" + variant,
                count,
                instructions: "生成完整的问题。允许同题多答案。",
                scenarios: ["手机端咨询", "邮件提交请求", "电话沟通"],
                classifications: [],
              },
            ],
            requirements: ["完整自然的问题，期望输出给出可核验的处理标准"],
          },
        };
        const prompt =
          variant === "variants"
            ? "按文档创建一份3条测试集，需要生成同题多答案对照样本，先给方案，暂不执行。"
            : "按文档创建一份" + count + "条测试集，先给方案，暂不执行。";
        await opt21End(await opt21Submit(prompt));
        const started = await opt21End(await opt21Submit("开始执行方案"));
        const runId = started.task.runId;
        expect(runId, JSON.stringify(started.turns.at(-1))).toBeTruthy();
        const raw = (
          await db.query(
            "SELECT input_ref,input_hash,execution_config FROM processing_run WHERE id=$1",
            [runId],
          )
        ).rows[0];
        const snapshot = JSON.parse(
          (await repo.readBytes(raw.input_ref, 100000000)).toString(),
        );
        expect(snapshot.background.questionPolicy).toBe(
          variant === "variants" ? "variants-v1" : "distinct-v1",
        );
        if (variant === "legacy") {
          delete snapshot.background.questionPolicy;
          const old = await repo.storeProcessing(
            Buffer.from(canonicalJson(snapshot)),
            runId,
            "input",
          );
          await db.query(
            "UPDATE processing_run SET input_ref=$2,input_hash=$3 WHERE id=$1",
            [runId, old.objectRef, old.sha256],
          );
        }
        generationResponse = (p: any) =>
          p.generation.slots.map((slot: any, index: number) => ({
            question:
              variant === "distinct"
                ? slot.position === 11
                  ? "唯一问题1"
                  : "唯一问题" + slot.position
                : index < 2
                  ? "同一个完整问题"
                  : "第三个完整问题",
            expectedOutput: "不同应答" + slot.position,
            metadata: [{ key: "index", value: String(slot.position) }],
          }));
        if (variant === "distinct") {
          await expect(opt29Worker(runId)).rejects.toThrow(
            "processing_batch_failed",
          );
          await db.query(
            "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
            [runId],
          );
        } else await opt29Worker(runId);
        const path =
          "/api/projects/" + projectId + "/processing-tasks/" + runId;
        const page = (
          await app.inject({ method: "GET", url: path + "?limit=100", headers })
        ).json();
        if (variant !== "distinct") {
          expect(page.task.generation).toMatchObject({
            validCount: 3,
            missingCount: 0,
          });
          return;
        }
        expect(page.task.generation).toMatchObject({
          validCount: 20,
          missingCount: 1,
        });
        const before = page.records.map((row: any) => ({
          id: row.id,
          result: row.result,
        }));
        const attempts = page.recovery.generationBudget.used;
        const prompts = calls
          .filter((call: any) => {
            try {
              return (
                JSON.parse(call.messages.at(-1).content).questionPolicy ===
                "distinct-v1"
              );
            } catch {
              return false;
            }
          })
          .map((call: any) => JSON.parse(call.messages.at(-1).content));
        expect(
          prompts.some((p: any) =>
            p.previousBatchExamples?.some(
              (row: any) =>
                row.question === "唯一问题1" &&
                !Object.hasOwn(row, "expectedOutput"),
            ),
          ),
        ).toBe(true);
        const completed = await app.inject({
          method: "POST",
          url: path + "/rounds",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { mode: "complete", expectedRevision: page.task.revision },
        });
        expect(completed.statusCode, completed.body).toBe(201);
        generationResponse = (p: any) =>
          p.generation.slots.map((slot: any) => ({
            question: "补齐唯一问题" + slot.position,
            expectedOutput: "可核验标准",
            metadata: [],
          }));
        await opt29Worker(completed.json().run.id);
        const final = (
          await app.inject({ method: "GET", url: path + "?limit=100", headers })
        ).json();
        expect(final.task.generation).toMatchObject({
          validCount: 21,
          missingCount: 0,
        });
        expect(
          final.records
            .filter((row: any) =>
              before.some((prior: any) => prior.id === row.id),
            )
            .map((row: any) => ({ id: row.id, result: row.result })),
        ).toEqual(before);
        expect(final.recovery.generationBudget.used).toBeGreaterThanOrEqual(
          attempts,
        );
        expect(final.recovery.generationBudget.used).toBeLessThanOrEqual(
          final.recovery.generationBudget.limit,
        );
        const unchanged = (
          await db.query(
            "SELECT input_ref,input_hash FROM processing_run WHERE id=$1",
            [runId],
          )
        ).rows[0];
        expect(unchanged.input_hash).toBe(raw.input_hash);
      } finally {
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/stop",
          headers,
          payload: {},
        });
        generationResponse = undefined;
        requestedTool = undefined;
        toolSequence = [];
        sessionId = previous;
        await db.end();
      }
    },
  );

  it("OPT40 excludes a collision outside the selected input and retains exhausted attempt accounting", async () => {
    const db = createPool(databaseUrl),
      cfg = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      },
      repo = new ArtifactRepository(cfg.minio);
    const draft = await opt22Draft("OPT40全目标基线");
    const extra = await app.inject({
      method: "POST",
      url:
        "/api/projects/" +
        projectId +
        "/collaborative-drafts/" +
        draft +
        "/records",
      headers,
      payload: {
        question: "背景约束下的具体场景问题",
        expectedOutput: "另一份既有答案",
        metadata: [],
      },
    });
    expect(extra.statusCode, extra.body).toBe(201);
    try {
      const rows = (
        await db.query(
          "SELECT id,question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted ORDER BY position,id",
          [draft],
        )
      ).rows;
      const created = await app.inject({
        method: "POST",
        url: "/api/projects/" + projectId + "/processing-runs",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: draft, recordIds: [rows[0].id] },
          options: {
            operation: "augment",
            instructions: "扩写一个新的完整问题",
            allowedFields: ["question"],
            outputCount: 1,
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().run.id;
      const frozen = (
        await db.query("SELECT input_ref FROM processing_run WHERE id=$1", [id])
      ).rows[0];
      const snapshot = JSON.parse(
        (await repo.readBytes(frozen.input_ref, 100000000)).toString(),
      );
      expect(snapshot.background.questionPolicy).toBe("distinct-v1");
      expect(snapshot.records).toHaveLength(1);
      expect(snapshot.deduplicationBaseline).toHaveLength(4);
      const execute = async () => {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt40-baseline',lease_expires_at=now()+interval '120 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        await runProcessing(db, repo, cfg, job);
      };
      await expect(execute()).rejects.toThrow("processing_batch_failed");
      const batch = (
        await db.query(
          "SELECT model_attempts,output_count,diagnostics FROM processing_batch WHERE run_id=$1",
          [id],
        )
      ).rows[0];
      expect(batch).toMatchObject({ model_attempts: 3, output_count: 0 });
      expect(
        batch.diagnostics.calls.reduce(
          (n: number, c: any) => n + (c.questionCollisions ?? 0),
          0,
        ),
      ).toBe(3);
      const before = calls.length;
      await expect(execute()).rejects.toThrow("processing_batch_failed");
      expect(calls.length).toBe(before);
      expect(
        (
          await db.query(
            "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
            [id],
          )
        ).rows[0].model_attempts,
      ).toBe(3);
      expect(
        (
          await db.query(
            "SELECT id,question,expected_output,metadata FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted ORDER BY position,id",
            [draft],
          )
        ).rows,
      ).toEqual(rows);
    } finally {
      await db.end();
    }
  });

  it("OPT35 saves one intent collection from business goals without side effects", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const counts = () =>
        db.query(
          "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
          [projectId],
        );
      const before = (await counts()).rows[0];
      await opt21Session();
      const upload = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + sessionId + "/background-documents",
        headers,
        payload: {
          fileName: "客服意图规范.md",
          contentBase64: readFileSync(
            "tests/fixtures/assistant-customer-intent.md",
          ).toString("base64"),
        },
      });
      expect(upload.statusCode, upload.body).toBe(201);
      requestedTool = {
        name: "read_background",
        input: { documentId: upload.json().document.id },
      };
      const readState = await opt21End(await opt21Submit("读取附件"));
      const catalog = readState.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "read_background")
        .result.definitions;
      const rules = ["expectedOutput", "metadata"].map((field) => ({
        field,
        ...(field === "metadata" ? { key: "intent" } : {}),
        basis: "background",
        allowedValues: ["退款申请", "物流查询"],
        quotas: [
          { value: "退款申请", count: 3 },
          { value: "物流查询", count: 3 },
        ],
        definitions: ["退款申请", "物流查询"].map((value) => ({
          value,
          reference: catalog.find((entry: any) => entry.value === value)
            .reference,
        })),
      }));
      const intent = {
        name: "客服意图6条",
        count: 6,
        countKind: "new",
        instructions: "生成语义完整自然的客服用户问题",
        scenarios: [
          "已付款用户希望退还货款",
          "用户询问如何发起退款",
          "用户查询配送进度和预计送达",
        ],
        classifications: rules,
      };
      toolSequence = [{ ...intent, classifications: [] }, intent].map(
        (delivery) => ({
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [delivery],
            requirements: ["语义完整自然，不编造具体订单号"],
          },
        }),
      );
      const saved = await opt21End(
        await opt21Submit(
          "一份 6 条，退款申请和物流查询各 3 条，不用原始数据，先给方案",
        ),
      );
      expect(
        saved.turns.at(-1).tools.at(-1),
        JSON.stringify(saved.turns.at(-1)),
      ).toMatchObject({ name: "plan_task", status: "succeeded" });
      expect(
        saved.turns
          .at(-1)
          .tools.filter((tool: any) => tool.name === "plan_task")
          .map((tool: any) => tool.status),
      ).toEqual(["failed", "succeeded"]);
      expect(
        saved.turns.at(-1).tools.find((tool: any) => tool.status === "failed")
          .error.hint,
      ).toContain("不能用空分类");
      expect(saved.turns.at(-1).assistantText).toContain("方案已保存");
      expect(saved.task.executionPlan.contractVersion).toBe(1);
      const generations = saved.task.executionPlan.steps.filter(
        (step: any) => step.action === "generate_candidates",
      );
      expect(generations).toHaveLength(1);
      expect(generations[0].deliveryId).toMatch(/^delivery_/);
      expect(generations[0].input.classifications).toHaveLength(2);
      expect(saved.task).toMatchObject({
        targetCount: 6,
        overallTargetCount: 6,
      });
      expect((await read()).json().task.executionPlan).toEqual(
        saved.task.executionPlan,
      );
      requestedTool = { name: "plan_task", input: { executionMode: "plan" } };
      const unchanged = await opt21End(
        await opt21Submit("总共6条，其他要求不变，先不要执行。"),
      );
      expect(
        unchanged.task.executionPlan.steps.find(
          (step: any) => step.action === "generate_candidates",
        ).deliveryId,
      ).toBe(generations[0].deliveryId);
      expect(unchanged.task.requirements).toEqual(saved.task.requirements);
      expect((await counts()).rows[0]).toEqual(before);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });

  it.each(["cleared", "merged", "resumed"])(
    "OPT35 keeps both GB deliveries through rejected references and %s correction",
    async (variant) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        const counts = () =>
          db.query(
            "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
            [projectId],
          );
        const before = (await counts()).rows[0];
        await opt21Session();
        const document = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "GB附录A原始摘录.txt",
              contentBase64: readFileSync(
                "tests/fixtures/assistant-gb-original-fragment.txt",
              ).toString("base64"),
            },
          })
        ).json().document;
        requestedTool = {
          name: "read_background",
          input: { documentId: document.id },
        };
        const background = await opt21End(await opt21Submit("读取附件"));
        const catalog = background.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "read_background")
          .result.definitions;
        const goals = ["A.1.a", "A.1.b"].map((value) => ({
          name: "GB " + value,
          count: 5,
          instructions: "按对应定义生成完整自然的用户问题",
          scenarios: [
            "用户说明前提后提出请求",
            "用户带具体限制提出请求",
            "用户询问完成目标的方法",
          ],
          classifications: [
            {
              field: "metadata",
              key: "riskCategory",
              basis: "background",
              allowedValues: [value],
              requiredValues: [value],
              quotas: [{ value, count: 5 }],
              definitions: [
                {
                  value,
                  reference: catalog.find((entry: any) => entry.value === value)
                    .reference,
                },
              ],
            },
          ],
        }));
        const bad = structuredClone(goals);
        bad[0].classifications[0].definitions[0].reference =
          goals[1].classifications[0].definitions[0].reference;
        const weakened = structuredClone(goals);
        if (variant === "merged") {
          weakened[0] = {
            ...weakened[0],
            name: "合并后的错误集合",
            count: 10,
            classifications: [
              {
                ...goals[0].classifications[0],
                allowedValues: ["A.1.a", "A.1.b"],
                requiredValues: ["A.1.a", "A.1.b"],
                quotas: goals.flatMap((goal) => goal.classifications[0].quotas),
                definitions: goals.flatMap(
                  (goal) => goal.classifications[0].definitions,
                ),
              },
            ],
          };
          weakened.splice(1);
        } else if (variant === "resumed") weakened.splice(1);
        else weakened[0].classifications = [];
        const call = (deliveries: typeof goals) => ({
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries,
            requirements: ["语义完整自然，期望输出写逐题具体安全行为"],
          },
        });
        const request =
          "按附件规范，GB A.1.a 和 A.1.b 各一份5条，不用原始数据。先给方案，暂不执行。";
        let saved;
        if (variant === "resumed") {
          toolSequence = [call(bad)];
          const failed = await opt21End(await opt21Submit(request));
          expect(failed.task.executionPlan).toBeUndefined();
          expect(
            (
              await db.query("SELECT task FROM assistant_session WHERE id=$1", [
                sessionId,
              ])
            ).rows[0].task.planningRecovery,
          ).toBeTruthy();
          toolSequence = [call(weakened), call(goals)];
          saved = await opt21End(await opt21Submit("继续规划"));
        } else {
          toolSequence = [bad, weakened, goals].map(call);
          saved = await opt21End(await opt21Submit(request));
        }
        const records = saved.turns
          .at(-1)
          .tools.filter((tool: any) => tool.name === "plan_task");
        expect(records, JSON.stringify(saved.turns.at(-1))).toHaveLength(
          variant === "resumed" ? 2 : 3,
        );
        expect(records.map((tool: any) => tool.status)).toEqual(
          variant === "resumed"
            ? ["failed", "succeeded"]
            : ["failed", "failed", "succeeded"],
        );
        if (variant === "resumed")
          expect(records[0].error.code).toBe("assistant_requirement_conflict");
        else {
          expect(records[0].error.code).toBe(
            "assistant_background_reference_invalid",
          );
          expect(records[1].error.hint).toContain(
            variant === "merged" ? "不能删除、合并" : "不能清空",
          );
        }
        const generations = () =>
          saved.task.executionPlan.steps.filter(
            (step: any) => step.action === "generate_candidates",
          );
        expect(generations()).toHaveLength(2);
        const ids = generations().map((step: any) => step.deliveryId);
        expect(new Set(ids).size).toBe(2);
        expect(saved.task).toMatchObject({
          targetCount: 5,
          overallTargetCount: 10,
        });
        expect(
          generations().map(
            (step: any) => step.input.classifications[0].quotas[0].count,
          ),
        ).toEqual([5, 5]);
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: goals.map((goal, index) => ({
              ...goal,
              id: ids[index],
              count: 3,
              classifications: goal.classifications.map((rule) => ({
                ...rule,
                quotas: rule.quotas.map((quota) => ({ ...quota, count: 3 })),
              })),
            })),
          },
        };
        const resized = await opt21End(
          await opt21Submit("改为各3条，其他要求不变，先不要执行。"),
        );
        expect(
          resized.turns.at(-1).tools.at(-1),
          JSON.stringify(resized.turns.at(-1)),
        ).toMatchObject({ status: "succeeded" });
        expect(resized.task).toMatchObject({
          targetCount: 3,
          overallTargetCount: 6,
        });
        const rows = resized.task.executionPlan.steps.filter(
          (step: any) => step.action === "generate_candidates",
        );
        expect(rows.map((step: any) => step.deliveryId)).toEqual(ids);
        expect(
          rows.map(
            (step: any) => step.input.classifications[0].quotas[0].count,
          ),
        ).toEqual([3, 3]);
        expect(rows[1].input.classifications[0].definitions).toEqual(
          generations()[1].input.classifications[0].definitions,
        );
        expect((await read()).json().task.executionPlan).toEqual(
          resized.task.executionPlan,
        );
        requestedTool = { name: "plan_task", input: { executionMode: "plan" } };
        const overall = await opt21End(
          await opt21Submit("总共6条，先不要执行。"),
        );
        expect(overall.task.overallTargetCount).toBe(6);
        expect(overall.task.runId).toBeUndefined();
        expect((await counts()).rows[0]).toEqual(before);
      } finally {
        requestedTool = undefined;
        toolSequence = [];
        sessionId = previous;
        await db.end();
      }
    },
  );

  it.each(["combined", "follow-up", "repeated-missing", "rejected-output"])(
    "recovers document planning from a missing delivery classification with original context (%s)",
    async (variant) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        await opt21Session();
        const document = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "GB附录A.txt",
              contentBase64: readFileSync(
                "tests/fixtures/assistant-gb-original-fragment.txt",
              ).toString("base64"),
            },
          })
        ).json().document;
        requestedTool = {
          name: "read_background",
          input: {
            documentId: document.id,
            query: "A.1.f",
            useForProcessing: variant !== "follow-up",
          },
        };
        finalReply = "色情对应 A.1.f 宣扬暴力、淫秽色情。";
        const readState = await opt21End(
          await opt21Submit(
            variant === "follow-up"
              ? "文档中色情属于哪类？回答即可。"
              : "读取附件",
          ),
        );
        finalReply = undefined;
        if (variant === "follow-up")
          expect(readState.task.backgroundEvidence).toEqual([]);
        const definitions = readState.turns
          .at(-1)
          .tools.find((t: any) => t.name === "read_background")
          .result.definitions;
        const definition = definitions.find(
          (d: any) => d.code === "A.1.f" || d.value === "A.1.f",
        );
        expect(definition).toBeDefined();
        const goal = {
          name: "色情风险10条",
          count: 10,
          countKind: "final",
          instructions:
            "仅针对淫秽色情子范围，问题完整自然，期望输出说明具体安全行为",
          scenarios: [
            "用户要求创作色情内容",
            "用户要求续写色情故事",
            "用户要求改写为色情描写",
          ],
          classifications: [
            {
              field: "metadata",
              key: "riskCategory",
              basis: "background",
              allowedValues: ["A.1.f"],
              requiredValues: ["A.1.f"],
              quotas: [{ value: "A.1.f", count: 10 }],
              definitions: [
                { value: "A.1.f", reference: definition.reference },
              ],
            },
          ],
        };
        const missing: Record<string, unknown> = { ...goal };
        delete missing.classifications;
        if (variant === "rejected-output")
          missing.classifications = goal.classifications.map(
            ({ key: _key, ...rule }) => ({ ...rule, field: "expectedOutput" }),
          );
        const input = (delivery: any) => ({
          executionMode: "plan",
          deliveries: [delivery],
          requirements: [
            "仅限色情相关范围，不扩展暴力子类",
            "问题完整自然，期望输出写具体安全行为",
            ...(variant === "rejected-output" && delivery === goal
              ? [
                  "共生成10条测试数据，全部在Metadata的riskCategory中标记为A.1.f。",
                ]
              : []),
            ...(variant === "rejected-output" && delivery === missing
              ? [
                  "期望输出固定为 A.1.f，作为该测试集的分类标签。",
                  "共生成10条测试数据，全部标记为A.1.f。",
                ]
              : []),
          ],
        });
        const start = calls.length;
        const counts = async () =>
          (
            await db.query(
              "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
              [projectId],
            )
          ).rows[0];
        const before = await counts();
        toolSequence =
          variant === "repeated-missing"
            ? Array.from({ length: 8 }, () => ({
                name: "plan_task",
                input: input(missing),
              }))
            : [
                { name: "plan_task", input: input(missing) },
                { name: "plan_task", input: input(goal) },
              ];
        if (variant === "rejected-output")
          toolSequence.splice(1, 0, {
            name: "plan_task",
            input: {
              ...input(goal),
              requirements: [
                ...input(goal).requirements,
                "期望输出固定为 A.1.f，作为该测试集的分类标签",
              ],
            },
          });
        if (variant === "follow-up")
          toolSequence.unshift({
            name: "read_background",
            input: {
              documentId: document.id,
              query: "A.1.f",
              useForProcessing: false,
            },
          });
        requestedTool = undefined;
        const prompt =
          variant === "follow-up"
            ? "好的，生成这一类相关的10条测试数据，先给方案，不要执行。"
            : "先帮我找到文档中关于色情的是哪一类，再生成这一类相关的10条测试数据，请你先设计方案，先不要执行。";
        const state = await opt21End(await opt21Submit(prompt));
        const turn = state.turns.at(-1);
        const requests = calls.slice(start);
        expect(
          requests.filter((c) =>
            String(c.messages.at(-1)?.content).includes(
              '"operation":"repair_tool_arguments"',
            ),
          ),
        ).toHaveLength(0);
        expect(requests.length, JSON.stringify(turn)).toBe(
          variant === "combined" ? 2 : 3,
        );
        const failed = turn.tools.find(
          (t: any) => t.name === "plan_task" && t.status === "failed",
        );
        expect(failed, JSON.stringify(turn)).toBeDefined();
        expect(failed.error.hint).toContain(
          variant === "rejected-output" ? "固定期望输出" : "classifications",
        );
        expect(failed.error.hint).not.toContain("缺少字段：id");
        expect(failed.error.hint).not.toContain("没有可复用事实");
        expect(failed.effect).toBe("none");
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain(prompt);
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain("A.1.f");
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain(
          "classifications",
        );
        if (variant === "follow-up")
          expect(JSON.stringify(requests.at(-1)!.messages)).toContain(
            "文档中色情属于哪类",
          );
        expect(await counts()).toEqual(before);
        expect(state.proposals).toHaveLength(0);
        if (variant === "repeated-missing") {
          expect(turn.status).toBe("failed");
          expect(state.task.executionPlan).toBeUndefined();
          expect(turn.diagnostics.requirementsReconciled).toBe(false);
        } else {
          expect(turn.status, JSON.stringify(turn)).toBe("succeeded");
          expect(state.task.stage).toBe("planning");
          expect(state.task.executionPlan.mode).toBe("plan");
          expect(state.task.executionPlan.contractVersion).toBe(1);
          const steps = state.task.executionPlan.steps.filter(
            (s: any) => s.action === "generate_candidates",
          );
          expect(steps).toHaveLength(1);
          expect(steps[0].input.outputCount).toBe(10);
          expect(steps[0].input.classifications[0].allowedValues).toEqual([
            "A.1.f",
          ]);
          expect(state.task.requirements).toContain(
            "仅限色情相关范围，不扩展暴力子类",
          );
          expect(
            turn.tools
              .filter((t: any) => t.name === "plan_task")
              .map((t: any) => t.status),
          ).toEqual(
            variant === "rejected-output"
              ? ["failed", "failed", "succeeded"]
              : ["failed", "succeeded"],
          );
          expect((await read()).json().task.executionPlan).toEqual(
            state.task.executionPlan,
          );
        }
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        finalReply = undefined;
        await db.end();
      }
    },
  );

  it("OPT35 normalizes a spelling error without dropping the delivery contract", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      const document = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "普通规范.md",
            contentBase64: Buffer.from(
              "# 普通问法规范\n每题完整自然，覆盖不同使用场景。",
            ).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: document.id },
      };
      await opt21End(await opt21Submit("读取附件"));
      const goal = {
        name: "普通问题",
        count: 3,
        instructions: "完整自然的用户问法",
        scenarios: [
          "新用户询问操作步骤",
          "用户说明背景询问原因",
          "用户带限制寻求建议",
        ],
        classifications: [],
      };
      toolSequence = [5, 3].map((count) => ({
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: [{ ...goal, count }],
          requirements: ["语义完整自然"],
        },
      }));
      const { instructions, ...rest } = goal;
      rawToolArguments = [
        JSON.stringify({
          executionMode: "plan",
          deliveries: [{ ...rest, count: 5, instruction: instructions }],
          requirements: ["语义完整自然"],
        }),
      ];
      const saved = await opt21End(
        await opt21Submit("按附件规范建一份测试集共3条。先给方案，暂不执行。"),
      );
      expect(
        saved.turns.at(-1).tools.at(-1),
        JSON.stringify(saved.turns.at(-1)),
      ).toMatchObject({ name: "plan_task", status: "succeeded" });
      expect(
        saved.task.executionPlan.steps.filter(
          (step: any) => step.action === "generate_candidates",
        ),
      ).toHaveLength(1);
      expect(saved.task.targetCount).toBe(3);
      expect(
        saved.turns
          .at(-1)
          .tools.filter((tool: any) => tool.name === "plan_task")
          .map((tool: any) => tool.status),
      ).toEqual(["failed", "succeeded"]);
      expect(saved.turns.at(-1).diagnostics.parameterRepairs).toContainEqual({
        name: "plan_task",
        outcome: "repaired",
      });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      rawToolArguments = [];
      sessionId = previous;
    }
  });

  it("OPT35 never reports an unsaved oral plan and retains the last valid plan after persistence failure", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    let saveSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const counts = () =>
        db.query(
          "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
          [projectId],
        );
      const before = (await counts()).rows[0];
      await opt21Session();
      const document = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "普通问法规范.md",
            contentBase64: Buffer.from(
              "# 普通问法规范\n问题须完整自然，使用不同场景。",
            ).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: document.id },
      };
      await opt21End(await opt21Submit("读取附件"));
      textualReplies = ["方案已保存，准备生成5条。"];
      const oral = await opt21End(
        await opt21Submit("按附件规范建一份测试集共5条，只给方案，暂不执行。"),
      );
      expect(oral.task.executionPlan).toBeUndefined();
      expect(oral.turns.at(-1).assistantText).not.toContain("方案已保存");
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: [
            {
              name: "普通测试集",
              count: 5,
              instructions: "问题完整自然",
              scenarios: [
                "初次使用询问步骤",
                "遇到异常询问原因",
                "带具体限制寻求建议",
              ],
              classifications: [],
            },
          ],
          requirements: ["语义完整自然"],
        },
      };
      const saved = await opt21End(
        await opt21Submit("按附件规范建一份测试集共5条，只给方案，暂不执行。"),
      );
      expect(
        saved.turns.at(-1).tools.at(-1),
        JSON.stringify(saved.turns.at(-1)),
      ).toMatchObject({ status: "succeeded" });
      const update = taskModule.updateTask;
      saveSpy = vi
        .spyOn(taskModule, "updateTask")
        .mockImplementation(async (...args: any[]) => {
          if (args[2].executionPlan?.contractVersion === 1)
            throw new Error("synthetic plan persistence unavailable");
          return update(...(args as Parameters<typeof update>));
        });
      requestedTool = { name: "plan_task", input: { executionMode: "plan" } };
      const failed = await opt21End(await opt21Submit("总共6条，先不要执行。"));
      expect(failed.task.executionPlan).toEqual({
        ...saved.task.executionPlan,
        needsReview: true,
      });
      expect(failed.task.targetCount).toBe(5);
      expect(failed.task.requirements).toEqual(saved.task.requirements);
      expect(failed.turns.at(-1).assistantText).not.toContain("方案已保存");
      expect((await counts()).rows[0]).toEqual(before);
    } finally {
      saveSpy?.mockRestore();
      requestedTool = undefined;
      toolSequence = [];
      textualReplies = [];
      sessionId = previous;
      await db.end();
    }
  });

  it("OPT34 saves a delegated document output contract and changes only the requested field", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const beforeCounts = await db.query(
        "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
        [projectId],
      );
      await opt21Session();
      const document = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/background-documents`,
          headers,
          payload: {
            fileName: "客服问法验收规范.md",
            contentBase64: readFileSync(
              "tests/fixtures/assistant-customer-intent.md",
            ).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: document.id },
      };
      const readState = await opt21End(await opt21Submit("读取附件"));
      const response = readState.turns
        .at(-1)
        .tools.find((t: any) => t.name === "read_background").result;
      expect(response.fragments[0]).toMatchObject({
        startLine: 1,
        endLine: 13,
      });
      const definitions = ["退款申请", "物流查询"].map((value) => ({
        value,
        reference: response.definitions.find((ref: any) => ref.value === value)!
          .reference,
      }));
      const rules = ["expectedOutput", "metadata"].map((field) => ({
        field,
        ...(field === "metadata" ? { key: "intent" } : {}),
        basis: "background",
        allowedValues: definitions.map((d) => d.value),
        quotas: definitions.map((d) => ({ value: d.value, count: 3 })),
        definitions,
      }));
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          requirements: [
            "问题完整自然",
            "期望输出填写对应意图名称",
            "intent与意图一致",
          ],
          deliveries: [
            {
              name: "客服意图6条",
              instructions: "按附件输出规范生成自然完整问题",
              count: 6,
              scenarios: [
                "已付款商品申请退还款项",
                "误付款项咨询退款方式",
                "包裹配送进度和预计送达查询",
              ],
              classifications: rules,
            },
          ],
        },
      };
      const saved = await opt21End(
        await opt21Submit(
          "按附件规范建一个6条客服意图测试集，退款申请和物流查询各3条，不用原始数据。先给方案，暂不生成。",
        ),
      );
      expect(
        saved.turns.at(-1).tools.at(-1),
        JSON.stringify(saved.turns.at(-1)),
      ).toMatchObject({ name: "plan_task", status: "succeeded" });
      expect(saved.task.executionPlan.mode).toBe("plan");
      expect(saved.task.classifications.map((r: any) => r.field)).toEqual([
        "expectedOutput",
        "metadata",
      ]);
      expect(saved.task.classifications[0].definitions[0].text).toContain(
        "- 退款申请：用户希望退还",
      );
      expect((await read()).json().task.classifications).toEqual(
        saved.task.classifications,
      );
      expect(
        (
          await db.query(
            "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
            [projectId],
          )
        ).rows[0],
      ).toEqual(beforeCounts.rows[0]);
      const metadataRule = saved.task.classifications.find(
        (r: any) => r.field === "metadata",
      );
      requestedTool = {
        name: "plan_task",
        input: {
          deliveries: [
            {
              id: saved.task.executionPlan.steps.find(
                (step: any) => step.action === "generate_candidates",
              ).deliveryId,
              classifications: [{ field: "expectedOutput", clear: true }],
            },
          ],
          removeRequirements: ["期望输出填写对应意图名称"],
          requirements: [
            "问题完整自然",
            "期望输出写逐题具体应答行为",
            "intent与意图一致",
          ],
          nextAction: "none",
        },
      };
      const changed = await opt21End(
        await opt21Submit(
          "期望输出改为逐题自然语言应答行为，不使用固定标签；Metadata intent分类和每类3条保持。",
        ),
      );
      expect(
        changed.turns.at(-1).tools.at(-1),
        JSON.stringify(changed.turns.at(-1)),
      ).toMatchObject({ name: "plan_task", status: "succeeded" });
      expect(changed.task.classifications).toEqual([metadataRule]);
      expect(changed.task.targetCount).toBe(6);
      expect(changed.task.nextAction).toBeNull();
      expect(changed.task.executionPlan.mode).toBe("plan");
      expect((await read()).json().task.requirements).toEqual(
        changed.task.requirements,
      );
      // The source text cannot authorize publishing or generation by itself.
      expect(changed.task.runId).toBeUndefined();
      expect(changed.proposals).toEqual([]);
      const originalSession = sessionId;
      await opt21Session();
      requestedTool = {
        name: "plan_task",
        input: {
          classifications: [rules[1]],
          requirements: ["按附件规范分类"],
          nextAction: "none",
        },
      };
      const unrelated = await opt21End(
        await opt21Submit("按附件规范记录分类，只记录要求。"),
      );
      expect(
        unrelated.turns.at(-1).tools[0].error.code,
        JSON.stringify(unrelated.turns.at(-1)),
      ).toBe("assistant_background_reference_invalid");
      sessionId = originalSession;
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `${base()}/sessions/${sessionId}/background-documents/${document.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      requestedTool = {
        name: "plan_task",
        input: {
          deliveries: [
            {
              id: changed.task.executionPlan.steps.find(
                (step: any) => step.action === "generate_candidates",
              ).deliveryId,
              classifications: [rules[1]],
            },
          ],
          requirements: ["按附件规范分类"],
          nextAction: "none",
        },
      };
      const deleted = await opt21End(
        await opt21Submit("沿用原附件分类，只记录要求。"),
      );
      expect(deleted.turns.at(-1).tools[0].status).toBe("failed");
      expect(
        (
          await db.query(
            "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
            [projectId],
          )
        ).rows[0],
      ).toEqual(beforeCounts.rows[0]);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });

  it("OPT-23 reuses verified background definitions and freezes identical original evidence", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = await opt22Draft("引用定义来源");
      await opt21Session();
      const uploaded = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/background-documents`,
        headers,
        payload: {
          fileName: "类别.md",
          contentBase64: Buffer.from(
            "A.1.a 表示甲类问题。\nA.2.a 表示乙类问题。",
          ).toString("base64"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const document = uploaded.json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: document.id },
      };
      await opt21End(await opt21Submit("读取附件定义"));
      const rule = {
        field: "metadata",
        key: "类别",
        basis: "background",
        allowedValues: ["A.1.a", "A.2.a"],
        definitions: [
          { value: "A.1.a", text: "表示甲类问题。" },
          { value: "A.2.a", text: "表示乙类问题。" },
        ],
      };
      requestedTool = {
        name: "plan_task",
        input: {
          target: { kind: "draft", id: source },
          allowedFields: ["metadata"],
          metadataKeys: ["类别"],
          classifications: [rule],
          nextAction: "none",
        },
      };
      const first = await opt21End(
        await opt21Submit("按附件分类，保留原题和答案"),
      );
      const refs = first.turns
        .at(-1)
        .tools.find((t: any) => t.name === "plan_task").result.task
        .classifications[0].definitions;
      expect(refs.every((d: any) => d.reference && d.text === undefined)).toBe(
        true,
      );
      requestedTool = {
        name: "plan_task",
        input: {
          classifications: [
            {
              ...rule,
              definitions: [
                { value: "A.1.a", reference: refs[1].reference },
                refs[1],
              ],
            },
          ],
          nextAction: "none",
        },
      };
      const wrong = await opt21End(await opt21Submit("核对错误引用"));
      expect(wrong.turns.at(-1).tools[0].error.code).toBe(
        "assistant_background_reference_invalid",
      );
      requestedTool = {
        name: "plan_task",
        input: {
          classifications: [{ ...rule, definitions: refs }],
          nextAction: "none",
        },
      };
      const resolved = await opt21End(
        await opt21Submit("只用已验证定义引用继续"),
      );
      expect(resolved.task.classifications).toEqual([rule]);
      toolSequence = [
        { name: "plan_task", input: { nextAction: "submit_processing" } },
        {
          name: "submit_processing",
          input: {
            operation: "clean",
            allRecords: true,
            instructions: "按附件定义分类",
          },
        },
      ];
      requestedTool = undefined;
      const submitted = await opt21End(
        await opt21Submit("清洗原题并沿用附件定义"),
      );
      expect(
        submitted.turns.at(-1).status,
        JSON.stringify(submitted.turns.at(-1)),
      ).toBe("succeeded");
      const job = (
        await db.query(
          "UPDATE job SET status='running',lease_owner='opt23',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [submitted.task.runId],
        )
      ).rows[0];
      const start = calls.length,
        cfg = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        };
      const workerResult = await runProcessing(
        db,
        new ArtifactRepository(cfg.minio),
        cfg,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, workerResult],
      );
      const prompt = JSON.parse(
        calls
          .slice(start)
          .find((call) => !call.tools)!
          .messages.at(-1).content,
      );
      expect(prompt.background.classifications).toEqual([rule]);
      expect(prompt.background.documents[0]).toMatchObject({
        id: document.id,
        sha256: document.sha256,
        extractorVersion: document.extractorVersion,
      });
      expect(prompt.background.documents[0].fragments[0].text).toBe(
        "A.1.a 表示甲类问题。\nA.2.a 表示乙类问题。",
      );
      const stopped = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      await opt21Session();
      const revokeDocument = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/background-documents`,
          headers,
          payload: {
            fileName: "撤销类别.md",
            contentBase64: Buffer.from(
              "A.1.a 表示甲类问题。\nA.2.a 表示乙类问题。",
            ).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: { documentId: revokeDocument.id },
      };
      await opt21End(await opt21Submit("读取附件"));
      requestedTool = {
        name: "plan_task",
        input: {
          title: "保留附件依据",
          requirements: ["遵循附件"],
          nextAction: "none",
        },
      };
      const unchanged = await opt21End(await opt21Submit("只更新任务标题"));
      expect(unchanged.task.backgroundEvidence).toHaveLength(1);
      requestedTool = {
        name: "plan_task",
        input: { classifications: [rule], nextAction: "none" },
      };
      await opt21End(await opt21Submit("按附件记录分类依据"));
      const deleted = await app.inject({
        method: "DELETE",
        url: `${base()}/sessions/${sessionId}/background-documents/${revokeDocument.id}`,
        headers,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      requestedTool = {
        name: "plan_task",
        input: { classifications: [], nextAction: "none" },
      };
      const revoked = await opt21End(
        await opt21Submit("撤销已删除附件的分类规则"),
      );
      expect(revoked.task.classifications).toEqual([]);
      expect(revoked.task.backgroundEvidence).toEqual([]);
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: source }, limit: 1 },
      };
      const resumed = await opt21End(await opt21Submit("继续读取原题"));
      expect(resumed.turns.at(-1).tools[0].status).toBe("succeeded");
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await db.end();
    }
  });
  async function opt25Results(unchanged = false, sizes = [7, 7]) {
    const source = await opt22Draft("R25 原草稿");
    const total = sizes.reduce((n, size) => n + size, 0);
    for (let i = 3; i < total; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${source}/records`,
        headers,
        payload: {
          question: `  唯一问题 ${i}  `,
          expectedOutput: "保留答案",
          metadata: [{ key: "类别", value: "原类别" }],
        },
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    await opt21Session();
    const db = createPool(databaseUrl),
      cfg = { ...loadConfig(), databaseUrl },
      artifacts = new ArtifactRepository(cfg.minio);
    if (unchanged)
      await db.query(
        "UPDATE collaborative_draft_record SET question=btrim(question) WHERE id=(SELECT id FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position LIMIT 1)",
        [source],
      );
    const ids = (
      await db.query(
        "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position",
        [source],
      )
    ).rows.map((r) => r.id);
    const runs: string[] = [];
    let offset = 0;
    for (const size of sizes) {
      const selected = ids.slice(offset, offset + size);
      offset += size;
      const r = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: source, recordIds: selected },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      const id = r.json().run.id;
      runs.push(id);
      const job = (
        await db.query(
          "UPDATE job SET status='running',lease_owner='opt25',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [id],
        )
      ).rows[0];
      const result = await runProcessing(db, artifacts, cfg, job);
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
    }
    await db.query(
      "UPDATE processing_task SET assistant_session_id=$1 WHERE id IN(SELECT task_id FROM processing_run WHERE id=ANY($2::text[]))",
      [sessionId, runs],
    );
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      sessionId,
      JSON.stringify({
        title: "R25 跨批整理",
        goal: `整理${total}条资料`,
        target: { kind: "draft", id: source },
        targetDraftId: source,
        allowedFields: ["question"],
        runId: runs.at(-1),
        runIds: runs,
        stage: "awaiting_review",
      }),
    ]);
    return { db, source, runs, artifacts, cfg };
  }
  it("OPT37 completes a generic v1 draft edit from real adoption receipts and safely resumes an already saved checkpoint", async () => {
    const previous = sessionId,
      f = await opt25Results(false, [2, 4]);
    const rows = () =>
      f.db.query(
        "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted ORDER BY position,id",
        [f.source],
      );
    const state = async () =>
      (
        await f.db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
    const domains = async () =>
      (
        await f.db.query(
          "SELECT (SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs,(SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_acceptance WHERE project_id=$1) adoptions",
          [projectId],
        )
      ).rows[0];
    try {
      // Reuse two deterministic clean results in a six-row source; the other
      // independent fixture run is not part of this local edit's candidates.
      await f.db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            runId: f.runs[0],
            runIds: [f.runs[0]],
            targetCount: 6,
            countKind: "final",
          }),
        ],
      );
      const before = (await rows()).rows;
      const revision = Number(
        (
          await f.db.query(
            "SELECT revision FROM collaborative_draft WHERE id=$1",
            [f.source],
          )
        ).rows[0].revision,
      );
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "保存本轮两条成果回原草稿",
                action: "request_processing_apply",
                input: {
                  runId: f.runs[0],
                  allTask: true,
                  allValid: true,
                  target: { kind: "draft", id: f.source },
                },
              },
            ],
          },
        },
      ];
      const prepared = await opt21End(
        await opt21Submit("将本轮2条清洗结果保存回原草稿，其余4条不变", {
          kind: "draft",
          id: f.source,
        }),
      );
      expect(prepared.task.executionPlan.contractVersion).toBe(1);
      expect(prepared.task.deliveries ?? []).toHaveLength(0);
      expect(prepared.task.stage).toBe("awaiting_confirmation");
      expect((await rows()).rows).toEqual(before);
      const proposal = prepared.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal.summary).toMatchObject({ count: 2, range: "task" });
      toolSequence = [];
      const adopted = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      expect(adopted.json().receipt.receipt).toMatchObject({
        draftId: f.source,
        adopted: 2,
        revision: revision + 1,
      });
      // Wait through the database so a GET cannot supply the completion write.
      await expect
        .poll(
          async () =>
            (
              await f.db.query(
                "SELECT count(*)::int AS n FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')",
                [sessionId],
              )
            ).rows[0].n,
          { timeout: 15000 },
        )
        .toBe(0);
      const completed = await state();
      expect(completed.stage).toBe("complete");
      expect(
        completed.executionPlan.steps.every(
          (s: any) => s.status === "executed",
        ),
      ).toBe(true);
      const refreshed = await read();
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json().task.stage).toBe("complete");
      expect(await state()).toEqual(completed);
      const after = (await rows()).rows;
      expect(after).toHaveLength(6);
      expect(after.slice(2)).toEqual(before.slice(2));
      for (let index = 0; index < 2; index++) {
        expect(after[index].question).toBe(before[index].question.trim());
        expect(after[index].expected_output).toBe(
          before[index].expected_output,
        );
        expect(after[index].metadata).toEqual(before[index].metadata);
      }
      // An older persisted checkpoint may already have this same real receipt
      // while still displaying awaiting_review. Continue must only reconcile it.
      const domainBefore = await domains();
      await f.db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"awaiting_review"}\'::jsonb WHERE id=$1',
        [sessionId],
      );
      requestedTool = undefined;
      const resumed = await opt21End(await opt21Submit("继续执行已保存方案"));
      expect(resumed.task.stage).toBe("complete");
      expect((await state()).stage).toBe("complete");
      expect(await domains()).toEqual(domainBefore);
      expect((await rows()).rows).toEqual(after);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT37 rejects a historical candidate refinement when a completed task starts a saved draft edit", async () => {
    const previous = sessionId,
      f = await opt25Results(false, [3, 3]);
    try {
      // Existing draft and runs remain; a new request after completion has no current candidates.
      await f.db.query(
        'UPDATE assistant_session SET task=task||\'{"stage":"complete"}\'::jsonb WHERE id=$1',
        [sessionId],
      );
      const before = (
        await f.db.query("SELECT count(*)::int AS n FROM processing_run")
      ).rows[0].n;
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            nextAction: "refine_candidates",
            steps: [
              {
                title: "改写草稿前两条问题",
                action: "refine_candidates",
                input: {
                  runId: f.runs[0],
                  allResults: true,
                  instructions: "仅改写前两条，其余保留",
                  allowedFields: ["question"],
                },
              },
            ],
          },
        },
      ];
      const state = await opt21End(
        await opt21Submit(
          "把这份草稿的前两条问题改写得更口语化，保留期望输出和Metadata，其余4条不变",
          { kind: "draft", id: f.source },
        ),
      );
      const rejected = state.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "plan_task");
      expect(rejected).toMatchObject({
        status: "failed",
        error: { code: "assistant_tool_input_invalid" },
      });
      expect(rejected.error.hint).toContain("read_records");
      expect(rejected.error.hint).toContain("recordIds");
      expect(rejected.error.hint).toContain("submit_processing");
      expect(state.task.runId).toBeUndefined();
      expect(
        (await f.db.query("SELECT count(*)::int AS n FROM processing_run"))
          .rows[0].n,
      ).toBe(before);
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int AS n FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
            [f.source],
          )
        ).rows[0].n,
      ).toBe(6);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it.each(["permission", "content"])(
    "OPT-25 fences historical candidate reads when %s changes during presentation",
    async (change) => {
      const previous = sessionId,
        f = await opt25Results();
      const actor = (
        await f.db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      const original = presentationModule.presentProcessingReview;
      const spy = vi
        .spyOn(presentationModule, "presentProcessingReview")
        .mockImplementationOnce(async (...args) => {
          const page = await original(...args);
          if (change === "content")
            await f.db.query(
              "UPDATE assistant_session SET content_revision=content_revision+1 WHERE id=$1",
              [sessionId],
            );
          else {
            await f.db.query("UPDATE app_user SET role='user' WHERE id=$1", [
              actor,
            ]);
            await f.db.query(
              "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(project_id,user_id) DO UPDATE SET role='viewer'",
              [projectId, actor],
            );
          }
          return page;
        });
      try {
        const response = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=run&run=${f.runs[0]}&limit=100`,
          headers,
        });
        expect([403, 404, 409]).toContain(response.statusCode);
        expect(response.body).not.toContain("唯一问题");
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        await f.db.query("UPDATE app_user SET role='admin' WHERE id=$1", [
          actor,
        ]);
        await f.db.query(
          "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
          [projectId, actor],
        );
        sessionId = previous;
        await f.db.end();
      }
    },
  );

  it("OPT-25 keeps active follow-up runs out of review readiness and adoption", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?scope=task`,
        headers,
      });
      const actorId = (
        await f.db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      const scope = { projectId, actorId };
      const pending = await refineModule.createRefinementRun(
        f.db,
        f.artifacts,
        {
          ...scope,
          taskRound: {
            taskId: f.runs[0],
            expectedRevision: (
              await f.db.query(
                "SELECT revision FROM processing_task WHERE id=$1",
                [f.runs[0]],
              )
            ).rows[0].revision,
            before: (
              await f.db.query(
                "SELECT current_refs FROM processing_task WHERE id=$1",
                [f.runs[0]],
              )
            ).rows[0].current_refs,
            kind: "continue" as const,
          },
        },
        f.runs[0],
        randomUUID(),
        {
          resultIds: ["0:0"],
          instructions: "OPT-25 局部表述",
          allowedFields: ["question"],
        },
      );
      const task = (
        await f.db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      const collection = await reviewModule.taskCandidateCollection(
        f.db,
        f.artifacts,
        scope,
        task,
      );
      const raw = await import("../../src/processing/store.js").then((m) =>
        m.readProcessingRun(
          f.db,
          f.artifacts,
          scope,
          f.runs[1],
          { limit: "10000" },
          true,
        ),
      );
      const checked = await reviewModule.reviewTask(
        f.db,
        f.artifacts,
        scope,
        task,
        raw,
      );
      expect(checked.finished).toBe(false);
      expect(
        collection.executionRuns.find((run) => run.id === pending.run.id)
          ?.status,
      ).toBe("queued");
      expect(() =>
        reviewModule.resolveTaskSelection(collection, {
          scope: "task",
          reviewRevision: "",
          resultIds: [collection.records[0].id],
        }),
      ).toThrow();
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        { name: "request_processing_apply", input: { allValid: true } },
      ];
      const state = await opt21End(await opt21Submit("保存全部成果"));
      const tool = state.turns
        .at(-1)
        .tools.find((t: any) => t.name === "request_processing_apply");
      expect(tool?.status, JSON.stringify(state.turns.at(-1))).toBe("failed");
      expect(state.proposals.some((p: any) => p.status === "pending")).toBe(
        false,
      );
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 preserves exclusions and newer unselected rows across repeated local refinement and adopts direct round receipts", async () => {
    const previous = sessionId,
      f = await opt25Results();
    const get = () =>
      app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
        headers,
      });
    try {
      const initial = (await get()).json();
      const actorId = (
        await f.db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      // A direct processing-page continuation contributes newer selected refs while
      // the assistant's stored run list still points at the initial round.
      const workspace = await import("../../src/processing/tasks.js").then(
        (m) =>
          m.processingTaskCandidates(
            f.db,
            f.artifacts,
            { projectId, actorId },
            f.runs[0],
          ),
      );
      const row = workspace.rows[0];
      const direct = await refineModule.createRefinementRun(
        f.db,
        f.artifacts,
        {
          projectId,
          actorId,
          taskRound: {
            taskId: workspace.id,
            expectedRevision: workspace.revision,
            before: workspace.refs,
            kind: "continue",
            records: [
              {
                id: "candidate:" + row.id,
                taskRecordKey: row.id,
                candidateOrigin: row.candidateOrigin,
                question: row.result.question,
                expectedOutput: row.result.expectedOutput,
                metadata: row.result.metadata,
                baseline: row.original.baseline ?? row.original,
                adoptionFields: ["question"],
                adoptionOperation: "clean",
              },
            ],
          },
        },
        f.runs[0],
        randomUUID(),
        {
          resultIds: [row.id],
          instructions: "OPT-25 局部表述",
          allowedFields: ["question"],
        },
      );
      const finish = async (id: string) => {
        const job = (
          await f.db.query(
            "UPDATE job SET status='running',lease_owner='opt25',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [id],
          )
        ).rows[0];
        const result = await runProcessing(
          f.db,
          f.artifacts,
          {
            ...f.cfg,
            modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
          },
          job,
        );
        await f.db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [job.id, result],
        );
      };
      await finish(direct.run.id);
      const current = (await get()).json();
      expect(current.taskTotal).toBe(14);
      expect(
        current.records.find((r: any) => r.id === initial.records[0].id).result
          .question,
      ).toBe(initial.records[0].result.question + " 自然表述");
      // The whole effective collection includes both parent and direct child refs.
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        { name: "request_processing_apply", input: { allValid: true } },
      ];
      const proposed = await opt21End(await opt21Submit("保存全部成果"));
      const proposal = proposed.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal, JSON.stringify(proposed.turns.at(-1))).toBeDefined();
      // Reject stale adoption, then continue the original task after an exclusion.
      const excluded = current.records.find(
        (r: any) => r.resultRef.runId === f.runs[0],
      );
      await f.db.query(
        "UPDATE processing_task SET excluded_refs=excluded_refs||jsonb_build_array(current_refs->1),current_refs=current_refs-1,revision=revision+1 WHERE id=$1",
        [workspace.id],
      );
      const page = (await get()).json();
      const ids = [
        page.records.find((r: any) => r.resultRef.runId === f.runs[0]).id,
        page.records.at(-1).id,
      ];
      toolSequence = [
        { name: "plan_task", input: { nextAction: "refine_candidates" } },
        {
          name: "refine_candidates",
          input: {
            allSelected: true,
            instructions: "OPT-25 局部表述",
            allowedFields: ["question"],
          },
        },
      ];
      const submitted = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "只改勾选两条，其他不动",
          candidates: {
            scope: "task",
            reviewRevision: page.reviewRevision,
            resultIds: ids,
          },
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const state = await opt21End(submitted.json().turnId);
      const tool = state.turns
        .at(-1)
        .tools.find((t: any) => t.name === "refine_candidates");
      expect(tool?.status, JSON.stringify(state.turns.at(-1))).toBe(
        "succeeded",
      );
      for (const id of tool.result.runIds) await finish(id);
      const after = (await get()).json();
      expect(after.taskTotal).toBe(13);
      expect(after.allIds).not.toContain(excluded.id);
      expect(new Set(after.allIds)).toEqual(new Set(page.allIds));
      for (const r of after.records) {
        const old = page.records.find((x: any) => x.id === r.id);
        expect(r.result.question).toBe(
          old.result.question + (ids.includes(r.id) ? " 自然表述" : ""),
        );
        expect(r.result.expectedOutput).toBe(old.result.expectedOutput);
        expect(r.result.metadata).toEqual(old.result.metadata);
      }
      // Confirm an actual proposal while the assistant anchor deliberately stays
      // on the root of a direct round; descendants need the same provenance fence.
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              ),
          { timeout: 15000 },
        )
        .toBe(false);
      await f.db.query(
        "UPDATE assistant_session SET task=jsonb_set(jsonb_set(task,'{runIds}',$2::jsonb),'{runId}',to_jsonb($3::text)) WHERE id=$1",
        [sessionId, JSON.stringify(f.runs), f.runs[1]],
      );
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        { name: "request_processing_apply", input: { allValid: true } },
      ];
      const prepared = await opt21End(await opt21Submit("保存全部成果"));
      const active = prepared.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(active, JSON.stringify(prepared.turns.at(-1))).toBeDefined();
      const receipt = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${active.id}/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      });
      expect(receipt.statusCode, receipt.body).toBe(200);
      expect(receipt.json().receipt.receipt.adopted).toBe(13);
      const actorScope = { projectId, actorId };
      const adoptedCollection = await reviewModule.taskCandidateCollection(
        f.db,
        f.artifacts,
        actorScope,
        (
          await f.db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task,
      );
      const adoptedRow = adoptedCollection.records.find(
        (r) => r.resultRef.runId !== r.candidateOrigin.runId,
      )!;
      expect(adoptedRow).toBeDefined();
      await expect(
        refineModule.createRefinementGroups(
          f.db,
          f.artifacts,
          {
            ...actorScope,
            assistantResultsGuard: { states: adoptedCollection.states },
          },
          [
            {
              runId: adoptedRow.resultRef.runId,
              resultIds: [adoptedRow.resultRef.resultId],
            },
          ],
          randomUUID(),
          { instructions: "不应再次处理", allowedFields: ["question"] },
        ),
      ).rejects.toMatchObject({ code: "processing_already_adopted" });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 keeps missing input placeholders out of candidates after refining a successful row", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const batch = (
        await f.db.query(
          "SELECT * FROM processing_batch WHERE run_id=$1 ORDER BY ordinal LIMIT 1",
          [f.runs[0]],
        )
      ).rows[0];
      const output = JSON.parse(
        (await f.artifacts.readBytes(batch.result_ref, 100000000)).toString(
          "utf8",
        ),
      );
      output.records.splice(1, 1);
      const stored = await f.artifacts.storeProcessing(
        Buffer.from(canonicalJson(output)),
        f.runs[0],
        "batch-0",
      );
      await f.db.query(
        "UPDATE processing_batch SET result_ref=$2,result_indices=$3,output_count=6 WHERE run_id=$1",
        [f.runs[0], stored.objectRef, [0, 2, 3, 4, 5, 6]],
      );
      await f.db.query(
        "UPDATE job SET status='failed',error_code='processing_output_incomplete' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [f.runs[0]],
      );
      const actorId = (
        await f.db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      const actorScope = { projectId, actorId };
      const task = (
        await f.db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      const before = await reviewModule.taskCandidateCollection(
        f.db,
        f.artifacts,
        actorScope,
        task,
      );
      expect(before.records).toHaveLength(13);
      const row = before.records.find((r) => r.resultRef.runId === f.runs[0])!;
      const children = await refineModule.createRefinementGroups(
        f.db,
        f.artifacts,
        { ...actorScope, assistantResultsGuard: { states: before.states } },
        [{ runId: row.resultRef.runId, resultIds: [row.resultRef.resultId] }],
        randomUUID(),
        { instructions: "OPT-25 局部表述", allowedFields: ["question"] },
      );
      const job = (
        await f.db.query(
          "UPDATE job SET status='running',lease_owner='opt25',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [children[0].run.id],
        )
      ).rows[0];
      const result = await runProcessing(
        f.db,
        f.artifacts,
        {
          ...f.cfg,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        },
        job,
      );
      await f.db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const after = await reviewModule.taskCandidateCollection(
        f.db,
        f.artifacts,
        actorScope,
        task,
      );
      expect(after.records).toHaveLength(13);
      expect(new Set(after.records.map((r) => r.id))).toEqual(
        new Set(before.records.map((r) => r.id)),
      );
      const state = (
        await f.db.query(
          "SELECT current_refs,incomplete FROM processing_task WHERE id=$1",
          [f.runs[0]],
        )
      ).rows[0];
      expect(state.current_refs.filter((r: any) => r.inputId)).toHaveLength(1);
      expect(state.incomplete).toBe(true);
    } finally {
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 corrects invalid plan step fields before executing and never expands a task selection to source rows", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const page = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      const ids = [page.records[0].id, page.records.at(-1).id];
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "局部改写",
                action: "submit_processing",
                input: {
                  operation: "rewrite",
                  allSelected: true,
                  instructions: "OPT-25 局部表述",
                },
              },
            ],
          },
        },
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "局部改写",
                action: "refine_candidates",
                input: {
                  allSelected: true,
                  instructions: "OPT-25 局部表述",
                  allowedFields: ["question"],
                },
              },
            ],
          },
        },
        {
          name: "refine_candidates",
          input: {
            allSelected: true,
            instructions: "OPT-25 局部表述",
            allowedFields: ["question"],
          },
        },
      ];
      requestedTool = undefined;
      const response = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "只把这两条改自然点",
          candidates: {
            scope: "task",
            reviewRevision: page.reviewRevision,
            resultIds: ids,
          },
        },
      });
      expect(response.statusCode, response.body).toBe(202);
      const state = await opt21End(response.json().turnId);
      const receipts = state.turns.at(-1).tools;
      expect(
        receipts.find(
          (t: any) => t.name === "plan_task" && t.status === "failed",
        )?.effect,
      ).toBe("none");
      const corrected = receipts.find(
        (t: any) => t.name === "refine_candidates",
      );
      expect(corrected?.status, JSON.stringify(receipts)).toBe("succeeded");
      expect(corrected.result.refinedCount).toBe(2);
      expect(
        receipts.some(
          (t: any) =>
            t.name === "submit_processing" && t.status === "succeeded",
        ),
      ).toBe(false);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 rejects an empty repeat of completed processing when changing only the count", async () => {
    const previous = sessionId,
      f = await opt25Results();
    const before = (
      await f.db.query(
        "SELECT count(*)::int AS n FROM processing_run WHERE project_id=$1",
        [projectId],
      )
    ).rows[0].n;
    try {
      await f.db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{executionPlan}',$2::jsonb) WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            mode: "execute",
            current: 1,
            steps: [
              {
                title: "整理",
                action: "submit_processing",
                status: "executed",
                input: {
                  operation: "clean",
                  allRecords: true,
                  instructions: "",
                },
                receipt: { key: "completed", runId: f.runs[1] },
              },
            ],
          }),
        ],
      );
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            targetCount: 4,
            countKind: "final",
            steps: [{ title: "整理", action: "submit_processing" }],
          },
        },
        { name: "read_processing", input: { runId: f.runs[1] } },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("改成4条，保留内容"));
      const failed = state.turns
        .at(-1)
        .tools.find((tool: any) => tool.name === "plan_task");
      expect(failed).toMatchObject({
        status: "failed",
        effect: "none",
        error: { code: "assistant_tool_input_invalid" },
      });
      expect(failed.error.hint).toContain("select_candidates");
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int AS n FROM processing_run WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n,
      ).toBe(before);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await f.db.end();
    }
  });
  it("OPT-25 normalizes the same selection defaults in the plan and execution", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "错误全部选4条",
                action: "select_candidates",
                input: {
                  runId: f.runs[1],
                  selection: { method: "all", mode: "count", value: 4 },
                },
              },
            ],
          },
        },
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            targetCount: 4,
            steps: [
              {
                title: "选4条",
                action: "select_candidates",
                input: {
                  runId: f.runs[1],
                  selection: { method: "random", mode: "count", value: 4 },
                },
              },
            ],
          },
        },
        {
          name: "select_candidates",
          input: {
            runId: f.runs[1],
            selection: { method: "random", mode: "count", value: 4 },
          },
        },
      ];
      requestedTool = undefined;
      const state = await opt21End(
        await opt21Submit("从已有成果选4条，保留内容"),
      );
      const receipts = state.turns.at(-1).tools;
      expect(
        receipts.find(
          (tool: any) => tool.name === "plan_task" && tool.status === "failed",
        )?.effect,
      ).toBe("none");
      expect(
        receipts.find((tool: any) => tool.name === "select_candidates")?.status,
        JSON.stringify(receipts),
      ).toBe("succeeded");
      expect(
        state.task.executionPlan.steps[0].input.selection.conditions,
      ).toEqual([]);
      expect(
        (
          await f.db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task.candidateScope.resultIds,
      ).toHaveLength(4);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      sessionId = previous;
      await f.db.end();
    }
  });
  it("OPT-25 leaves an unbound planned input scope for the model to complete before registered execution", async () => {
    const previous = sessionId,
      source = await opt22Draft("R25 待补范围");
    await opt21Session();
    try {
      const parameters = {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            target: { kind: "draft", id: source },
            executionMode: "execute",
            steps: [
              { title: "清洗", action: "submit_processing", input: parameters },
            ],
          },
        },
        {
          name: "submit_processing",
          input: { ...parameters, allRecords: true },
        },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("清理当前草稿"));
      const receipts = state.turns
        .at(-1)
        .tools.filter((tool: any) => tool.name === "submit_processing");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        status: "succeeded",
        input: { allRecords: true },
      });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
    }
  });
  it("OPT-25 explains conflicting cleanup count and protected Metadata before any write", async () => {
    const previous = sessionId,
      source = await opt22Draft("R25 参数冲突");
    await opt21Session();
    try {
      const input = {
        source: { kind: "draft", id: source },
        operation: "clean",
        allRecords: true,
        instructions: "",
        allowedFields: ["question"],
      };
      toolSequence = [
        {
          name: "submit_processing",
          input: { ...input, outputCount: 3, metadataKeys: ["类别"] },
        },
        { name: "submit_processing", input },
      ];
      requestedTool = undefined;
      const state = await opt21End(
        await opt21Submit("只清理问题空白，分类不变"),
      );
      const receipts = state.turns
        .at(-1)
        .tools.filter((tool: any) => tool.name === "submit_processing");
      expect(receipts[0]).toMatchObject({
        status: "failed",
        effect: "none",
        error: { code: "processing_configuration_invalid" },
      });
      expect(receipts[0].error.hint).toContain("outputCount");
      expect(receipts[0].error.hint).toContain("metadataKeys");
      expect(receipts[1]).toMatchObject({ status: "succeeded" });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
    }
  });
  it("OPT-25 normalizes an approved omitted original draft id before context comparison", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "保存回原草稿",
                action: "request_processing_apply",
                input: {
                  runId: f.runs[1],
                  target: { kind: "draft" },
                  allValid: true,
                },
              },
            ],
          },
        },
        {
          name: "request_processing_apply",
          input: {
            runId: f.runs[1],
            target: { kind: "draft" },
            allValid: true,
          },
        },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("保存全部成果回原草稿"));
      expect(
        state.turns.at(-1).tools.some((tool: any) => tool.status === "failed"),
      ).toBe(false);
      const proposal = state.proposals.find(
        (p: any) => p.status === "pending" && p.action === "processing",
      );
      expect(proposal).toBeTruthy();
      const confirmed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().receipt.receipt).toMatchObject({
        draftId: f.source,
        adopted: 14,
      });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });
  it("OPT-25 rejects a different draft after binding an approved omitted original id", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const other = await opt22Draft("R25 另一草稿");
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "保存回原草稿",
                action: "request_processing_apply",
                input: {
                  runId: f.runs[1],
                  target: { kind: "draft" },
                  allValid: true,
                },
              },
            ],
          },
        },
        {
          name: "request_processing_apply",
          input: {
            runId: f.runs[1],
            target: { kind: "draft", id: other },
            allValid: true,
          },
        },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("保存全部成果回原草稿"));
      expect(
        state.turns
          .at(-1)
          .tools.find((tool: any) => tool.name === "request_processing_apply"),
      ).toMatchObject({
        status: "failed",
        effect: "none",
        error: { code: "assistant_step_context_changed" },
      });
      expect(
        state.proposals.some((proposal: any) => proposal.status === "pending"),
      ).toBe(false);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });
  it("OPT-25 rejects a nonlinguistic clarification placeholder without pausing the valid task", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      toolSequence = [
        { name: "plan_task", input: { question: ":)", nextAction: "none" } },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("只改我勾选的两条"));
      expect(
        state.turns.at(-1).tools.find((tool: any) => tool.name === "plan_task"),
      ).toMatchObject({
        status: "failed",
        error: { code: "assistant_tool_input_invalid" },
      });
      expect(state.task.question).not.toBe(":)");
      expect(state.task.runIds).toEqual(f.runs);
      expect(state.task.stage).not.toBe("waiting_input");
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });
  it("OPT-25 executes approved read parameters before processing without model reconstruction", async () => {
    const previous = sessionId,
      source = await opt22Draft("R25 固定读取");
    await opt21Session();
    try {
      toolSequence = [
        {
          name: "plan_task",
          input: {
            target: { kind: "draft", id: source },
            executionMode: "plan",
            steps: [
              {
                title: "核对三条",
                action: "read_records",
                input: { source: { kind: "draft", id: source }, limit: 3 },
              },
              {
                title: "清理空白",
                action: "submit_processing",
                input: {
                  operation: "clean",
                  allRecords: true,
                  instructions: "",
                  allowedFields: ["question"],
                },
              },
            ],
          },
        },
      ];
      requestedTool = undefined;
      const planned = await opt21End(await opt21Submit("先规划清理这份草稿"));
      expect(planned.task.executionPlan.mode).toBe("plan");
      expect(
        planned.turns
          .at(-1)
          .tools.some((t: any) => t.name === "submit_processing"),
      ).toBe(false);
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              {
                title: "核对三条",
                action: "read_records",
                input: { limit: 20 },
              },
              {
                title: "清理空白",
                action: "submit_processing",
                input: {
                  operation: "rewrite",
                  instructions: "重新改写",
                  recordIds: ["other"],
                },
              },
            ],
          },
        },
      ];
      const state = await opt21End(await opt21Submit("按刚才方案执行"));
      const receipts = state.turns.at(-1).tools;
      expect(
        receipts.find((tool: any) => tool.name === "read_records"),
      ).toMatchObject({
        status: "succeeded",
        input: { limit: 3 },
        result: { readCount: 3 },
      });
      expect(
        receipts.find((tool: any) => tool.name === "submit_processing"),
      ).toMatchObject({
        status: "succeeded",
        input: { operation: "clean", allRecords: true },
        result: { inputCount: 3 },
      });
      expect(receipts.some((tool: any) => tool.status === "failed")).toBe(
        false,
      );
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
    }
  });
  it("OPT-25 rejects a random selection without its unit before writes and accepts short deterministic cleanup", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      toolSequence = [
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
            selection: { method: "random", value: 4, conditions: [] },
          },
        },
        {
          name: "submit_processing",
          input: {
            operation: "clean",
            selection: {
              method: "random",
              mode: "count",
              value: 4,
              conditions: [],
            },
          },
        },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("只清理4条的首尾空白"));
      const receipts = state.turns.at(-1).tools;
      const invalid = receipts.find(
        (r: any) => r.name === "submit_processing" && r.status === "failed",
      );
      expect(invalid?.effect, JSON.stringify(receipts)).toBe("none");
      expect(invalid.error.code).not.toBe("assistant_operation_unknown");
      const created = receipts.find(
        (r: any) => r.name === "submit_processing" && r.status === "succeeded",
      );
      expect(created?.result.inputCount, JSON.stringify(receipts)).toBe(4);
      expect(created.input.instructions).toBe("");
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 pauses a clarification even when the model leaves an old executing action", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const before = (
        await f.db.query("SELECT count(*)::int AS n FROM processing_run")
      ).rows[0].n;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            question: "你想保留哪些4条？",
            nextAction: "submit_processing",
            executionMode: "execute",
            steps: [
              {
                title: "处理记录",
                action: "submit_processing",
                input: {
                  operation: "clean",
                  allRecords: true,
                  instructions: "",
                  allowedFields: ["question"],
                },
              },
            ],
          },
        },
      ];
      requestedTool = undefined;
      const state = await opt21End(await opt21Submit("保留4条"));
      expect(state.task.stage).toBe("waiting_input");
      expect(state.task.nextAction).toBeNull();
      expect(state.task.question).toBe("你想保留哪些4条？");
      expect(
        (await f.db.query("SELECT count(*)::int AS n FROM processing_run"))
          .rows[0].n,
      ).toBe(before);
      expect(
        state.turns
          .at(-1)
          .tools.some((t: any) => t.name === "submit_processing"),
      ).toBe(false);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 exposes one paged effective task collection with stable identities across batches", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const get = (query = "") =>
        app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&view=all&limit=10${query}`,
          headers,
        });
      const first = await get();
      expect(first.statusCode, first.body).toBe(200);
      const page = first.json();
      expect(page.total).toBe(14);
      expect(page.taskTotal).toBe(14);
      expect(page.records).toHaveLength(10);
      expect(page.reviewRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(new Set(page.allIds).size).toBe(14);
      expect(
        new Set(page.records.map((r: any) => r.resultRef.runId)).size,
      ).toBe(2);
      const later = (await get("&offset=10")).json();
      expect(later.records).toHaveLength(4);
      expect(later.reviewRevision).toBe(page.reviewRevision);
      expect(
        new Set([...page.records, ...later.records].map((r: any) => r.id)).size,
      ).toBe(14);
      const searched = (
        await get("&search=" + encodeURIComponent("唯一问题 13"))
      ).json();
      expect(searched.total).toBe(1);
      expect(searched.allIds[0]).toBe(
        later.records.find((r: any) => r.result.question === "唯一问题 13").id,
      );
      expect(page.saveTarget).toMatchObject({ kind: "draft", id: f.source });
      expect(page.savedCount).toBe(0);
      expect(page.stats.all).toBe(14);
    } finally {
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it.each(["awaiting_review", "stopped"])(
    "OPT-28 / OPT-25 refines two of 50 cross-batch identities after %s and rejects stale selection without duplicating replay",
    async (stage) => {
      const previous = sessionId,
        f = await opt25Results(false, [20, 28, 2]);
      const get = () =>
        app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        });
      try {
        if (stage === "stopped") {
          const stopped = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/stop`,
            headers,
            payload: {},
          });
          expect(stopped.statusCode, stopped.body).toBe(200);
        }
        const before = (await get()).json(),
          ids = [before.records[0].id, before.records.at(-1).id];
        const key = randomUUID(),
          payload = {
            message: "只将勾选两条问题改自然些，答案和Metadata保留",
            candidates: {
              scope: "task",
              reviewRevision: before.reviewRevision,
              resultIds: ids,
            },
          };
        toolSequence = [
          {
            name: "plan_task",
            input: {
              nextAction: "refine_candidates",
              allowedFields: ["question"],
            },
          },
          {
            name: "refine_candidates",
            input: {
              allSelected: true,
              instructions: "OPT-25 局部表述",
              allowedFields: ["question"],
            },
          },
        ];
        requestedTool = undefined;
        const submitted = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": key },
          payload,
        });
        expect(submitted.statusCode, submitted.body).toBe(202);
        const result = await opt21End(submitted.json().turnId);
        const tool = result.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates");
        expect(tool.status, JSON.stringify(tool)).toBe("succeeded");
        expect(tool.result.runIds).toHaveLength(2);
        for (const id of tool.result.runIds) {
          const job = (
            await f.db.query(
              "UPDATE job SET status='running',lease_owner='opt25',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
              [id],
            )
          ).rows[0];
          const value = await runProcessing(
            f.db,
            f.artifacts,
            {
              ...f.cfg,
              modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
            },
            job,
          );
          await f.db.query(
            "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
            [job.id, value],
          );
        }
        const after = (await get()).json();
        expect(after.taskTotal).toBe(50);
        expect(new Set(after.allIds)).toEqual(new Set(before.allIds));
        for (const row of after.records) {
          const old = before.records.find((r: any) => r.id === row.id);
          expect(row.result.question).toBe(
            ids.includes(row.id)
              ? old.result.question + " 自然表述"
              : old.result.question,
          );
          expect(row.result.expectedOutput).toBe(old.result.expectedOutput);
          expect(row.result.metadata).toEqual(old.result.metadata);
        }
        const count = (
          await f.db.query("SELECT count(*)::int AS n FROM processing_run")
        ).rows[0].n;
        const stale = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload,
        });
        expect(stale.statusCode, stale.body).toBe(409);
        expect(stale.json().error.code).toBe(
          "assistant_candidate_selection_changed",
        );
        const replay = await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/turns`,
          headers: { ...headers, "idempotency-key": key },
          payload,
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json().turnId).toBe(submitted.json().turnId);
        expect(
          (await f.db.query("SELECT count(*)::int AS n FROM processing_run"))
            .rows[0].n,
        ).toBe(count);
      } finally {
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await f.db.end();
      }
    },
  );

  it("OPT-25 keeps mixed clean and augment change filters scoped to each result", async () => {
    const previous = sessionId,
      f = await opt25Results(true);
    const get = (view = "all") =>
      app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100&view=${view}`,
        headers,
      });
    try {
      const before = (await get()).json();
      const unchanged = before.records.filter(
        (row: any) => !row.changedFields.length,
      );
      expect(unchanged.length).toBeGreaterThan(0);
      const input = (
        await f.db.query(
          "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position LIMIT 1",
          [f.source],
        )
      ).rows[0].id;
      const submitted = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: f.source, recordIds: [input] },
          options: {
            operation: "augment",
            outputCount: 1,
            instructions: "新增第二个具体问题",
            allowedFields: ["question"],
          },
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const added = submitted.json().run.id;
      const job = (
        await f.db.query(
          "UPDATE job SET status='running',lease_owner='opt25',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [added],
        )
      ).rows[0];
      const result = await runProcessing(
        f.db,
        f.artifacts,
        {
          ...f.cfg,
          modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
        },
        job,
      );
      await f.db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      await f.db.query(
        "UPDATE processing_task SET assistant_session_id=$1 WHERE id=$2",
        [sessionId, added],
      );
      await f.db.query(
        "UPDATE assistant_session SET task=jsonb_set(jsonb_set(task,'{runIds}',$2::jsonb),'{runId}',to_jsonb($3::text)) WHERE id=$1",
        [sessionId, JSON.stringify([...f.runs, added]), added],
      );
      const all = (await get()).json(),
        changed = (await get("changed")).json();
      expect(all.taskTotal).toBe(before.taskTotal + 1);
      expect(all.stats.changed).toBe(before.stats.changed + 1);
      expect(changed.total).toBe(all.stats.changed);
      for (const row of unchanged) {
        expect(
          all.records.find((current: any) => current.id === row.id)
            .changedFields,
        ).toEqual([]);
        expect(changed.allIds).not.toContain(row.id);
      }
      expect(
        all.records.find((row: any) => row.resultRef.runId === added)
          .changedFields,
      ).toEqual(["new"]);
    } finally {
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 adopts more than twelve historical result groups with real receipts and replay", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const actorId = (
        await f.db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      const scope = { projectId, actorId };
      const task = (
        await f.db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      const initial = await reviewModule.taskCandidateCollection(
        f.db,
        f.artifacts,
        scope,
        task,
      );
      for (const identity of initial.records
        .slice(0, 12)
        .map((row) => row.id)) {
        const collection = await reviewModule.taskCandidateCollection(
          f.db,
          f.artifacts,
          scope,
          task,
        );
        const row = collection.records.find(
          (current) => current.id === identity,
        )!;
        const workspace = (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-tasks/${row.resultRef.runId}?limit=100`,
            headers,
          })
        ).json();
        const inputRow = workspace.records.find(
          (current: any) => current.result.question === row.result.question,
        );
        const submitted = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/processing-tasks/${row.resultRef.runId}/rounds`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            mode: "continue",
            expectedRevision: workspace.task.revision,
            resultIds: [inputRow.id],
            options: {
              operation: "rewrite",
              instructions: "OPT-25 局部表述",
              allowedFields: ["question"],
            },
          },
        });
        expect(submitted.statusCode, submitted.body).toBe(201);
        const job = (
          await f.db.query(
            "UPDATE job SET status='running',lease_owner='opt25',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
            [submitted.json().run.id],
          )
        ).rows[0];
        const result = await runProcessing(
          f.db,
          f.artifacts,
          {
            ...f.cfg,
            modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
          },
          job,
        );
        await f.db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [job.id, result],
        );
      }
      const current = await reviewModule.taskCandidateCollection(
        f.db,
        f.artifacts,
        scope,
        task,
      );
      expect(current.runs).toHaveLength(13);
      expect(current.records).toHaveLength(14);
      expect(new Set(current.records.map((row) => row.id))).toEqual(
        new Set(initial.records.map((row) => row.id)),
      );
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        { name: "request_processing_apply", input: { allValid: true } },
      ];
      requestedTool = undefined;
      const prepared = await opt21End(await opt21Submit("保存全部成果"));
      const proposal = prepared.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal, JSON.stringify(prepared.turns.at(-1))).toBeDefined();
      const key = randomUUID();
      const confirm = () =>
        app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers: { ...headers, "idempotency-key": key },
          payload: {},
        });
      const saved = await confirm();
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().receipt.receipt.adopted).toBe(14);
      const replay = await confirm();
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().receipt).toEqual(saved.json().receipt);
      const page = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      expect(page.savedCount).toBe(14);
      expect(page.taskTotal).toBe(14);
      await expect
        .poll(
          async () =>
            (await read())
              .json()
              .turns.some((turn: any) =>
                ["queued", "running"].includes(turn.status),
              ),
          { timeout: 15000 },
        )
        .toBe(false);
      toolSequence = [
        { name: "plan_task", input: { nextAction: "request_publish" } },
        { name: "request_publish", input: { draftId: f.source } },
      ];
      const publication = await opt21End(await opt21Submit("发布已保存的成果"));
      const publish = publication.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(publish, JSON.stringify(publication.turns.at(-1))).toBeDefined();
      const published = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${publish.id}/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      });
      expect(published.statusCode, published.body).toBe(200);
      await expect
        .poll(async () => (await read()).json().task.stage, { timeout: 15000 })
        .toBe("complete");
      const completed = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
        headers,
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json().taskTotal).toBe(14);
      expect(completed.json().savedCount).toBe(14);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  }, 60000);

  it("OPT-25 partially adopts cross-batch results to the original draft with real receipts and leaves the task unfinished", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      const page = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      const ids = [page.records[0].id, page.records.at(-1).id];
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        { name: "request_processing_apply", input: { allSelected: true } },
      ];
      const result = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "将勾选两条保存回原草稿",
          candidates: {
            scope: "task",
            reviewRevision: page.reviewRevision,
            resultIds: ids,
          },
        },
      });
      expect(result.statusCode, result.body).toBe(202);
      const prepared = await opt21End(result.json().turnId);
      const proposal = prepared.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal, JSON.stringify(prepared.turns.at(-1))).toBeDefined();
      expect(proposal.summary.range).toBe("partial");
      expect(proposal.summary.count).toBe(2);
      const confirmed = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const replay = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {},
      });
      expect(replay.statusCode, replay.body).toBe(200);
      const current = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      expect(current.savedCount).toBe(2);
      expect(
        (
          await f.db.query(
            "SELECT task->'selectedCandidates' AS selection FROM assistant_session WHERE id=$1",
            [sessionId],
          )
        ).rows[0].selection,
      ).toBeNull();
      expect(new Set(current.savedIds)).toEqual(new Set(ids));
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int AS n FROM collaborative_draft_record WHERE draft_id=$1",
            [f.source],
          )
        ).rows[0].n,
      ).toBe(14);
      expect((await read()).json().task.stage).not.toBe("complete");
      expect(
        (
          await f.db.query(
            "SELECT count(DISTINCT receipt->>'acceptanceId')::int AS n FROM processing_acceptance WHERE project_id=$1 AND receipt->>'draftId'=$2",
            [projectId, f.source],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it.each(["field", "excluded"])(
    "OPT-25 rejects stale %s adoption and preserves the original draft",
    async (change) => {
      const previous = sessionId,
        f = await opt25Results();
      try {
        requestedTool = undefined;
        toolSequence = [
          {
            name: "plan_task",
            input: { nextAction: "request_processing_apply" },
          },
          { name: "request_processing_apply", input: { allValid: true } },
        ];
        const prepared = await opt21End(
          await opt21Submit("将全部成果保存回原草稿"),
        );
        const proposal = prepared.proposals.find(
          (p: any) => p.status === "pending",
        );
        expect(proposal, JSON.stringify(prepared.turns.at(-1))).toBeDefined();
        expect(proposal.summary.count).toBe(14);
        if (change === "field")
          await f.db.query(
            "UPDATE collaborative_draft_record SET question='用户新修改',question_revision=question_revision+1 WHERE id=(SELECT id FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position LIMIT 1)",
            [f.source],
          );
        else
          await f.db.query(
            "UPDATE processing_task SET excluded_refs=excluded_refs||jsonb_build_array(current_refs->0),current_refs=current_refs-0,revision=revision+1 WHERE id=(SELECT task_id FROM processing_run WHERE id=$1)",
            [f.runs[0]],
          );
        const confirmed = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {},
        });
        expect(confirmed.statusCode, confirmed.body).toBe(409);
        expect(confirmed.json().error.code).toBe(
          change === "field"
            ? "draft_field_conflict"
            : "assistant_candidate_selection_changed",
        );
        expect(
          (
            await f.db.query(
              "SELECT count(*)::int AS n FROM processing_acceptance WHERE draft_id=$1",
              [f.source],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await f.db.query(
              "SELECT count(*)::int AS n FROM collaborative_draft_record WHERE draft_id=$1",
              [f.source],
            )
          ).rows[0].n,
        ).toBe(14);
        if (change === "field")
          expect(
            (
              await f.db.query(
                "SELECT question FROM collaborative_draft_record WHERE id=(SELECT id FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position LIMIT 1)",
                [f.source],
              )
            ).rows[0].question,
          ).toBe("用户新修改");
        else {
          const page = (
            await app.inject({
              method: "GET",
              url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
              headers,
            })
          ).json();
          expect(page.taskTotal).toBe(13);
          expect(page.stats.all).toBe(13);
        }
      } finally {
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await f.db.end();
      }
    },
  );

  it("OPT-25 rolls back all cross-batch refinements when the second artifact cannot be stored", async () => {
    const previous = sessionId,
      f = await opt25Results();
    let spy: any;
    try {
      const page = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      const initial = (
        await f.db.query("SELECT count(*)::int AS n FROM processing_run")
      ).rows[0].n;
      const save = ArtifactRepository.prototype.storeProcessing;
      let writes = 0;
      spy = vi
        .spyOn(ArtifactRepository.prototype, "storeProcessing")
        .mockImplementation(async function (this: ArtifactRepository, ...args) {
          if (++writes === 2) throw new Error("synthetic artifact failure");
          return save.apply(this, args);
        });
      toolSequence = [
        { name: "plan_task", input: { nextAction: "refine_candidates" } },
        {
          name: "refine_candidates",
          input: { allSelected: true, instructions: "OPT-25 局部表述" },
        },
      ];
      requestedTool = undefined;
      const submitted = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "只改这两条",
          candidates: {
            scope: "task",
            reviewRevision: page.reviewRevision,
            resultIds: [page.records[0].id, page.records.at(-1).id],
          },
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const state = await opt21End(submitted.json().turnId);
      expect(
        state.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates").status,
      ).toBe("failed");
      expect(writes).toBe(2);
      expect(
        (await f.db.query("SELECT count(*)::int AS n FROM processing_run"))
          .rows[0].n,
      ).toBe(initial);
      expect(state.task.runIds).toEqual(f.runs);
    } finally {
      spy?.mockRestore();
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-25 reconciles a committed cross-batch refinement after its response is lost", async () => {
    const previous = sessionId,
      f = await opt25Results();
    let spy: any;
    try {
      const page = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      const initial = (
        await f.db.query("SELECT count(*)::int AS n FROM processing_run")
      ).rows[0].n;
      const create = refineModule.createRefinementGroups;
      spy = vi
        .spyOn(refineModule, "createRefinementGroups")
        .mockImplementationOnce(async (...args) => {
          await create(...args);
          throw Object.assign(new Error("synthetic lost response"), {
            code: "ECONNRESET",
          });
        });
      toolSequence = [
        { name: "plan_task", input: { nextAction: "refine_candidates" } },
        {
          name: "refine_candidates",
          input: { allSelected: true, instructions: "OPT-25 局部表述" },
        },
      ];
      requestedTool = undefined;
      const response = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "只改勾选的两条",
          candidates: {
            scope: "task",
            reviewRevision: page.reviewRevision,
            resultIds: [page.records[0].id, page.records.at(-1).id],
          },
        },
      });
      expect(response.statusCode, response.body).toBe(202);
      const state = await opt21End(response.json().turnId);
      const tool = state.turns
        .at(-1)
        .tools.find((t: any) => t.name === "refine_candidates");
      expect(tool.status, JSON.stringify(tool)).toBe("succeeded");
      expect(tool.result.runIds).toHaveLength(2);
      expect(new Set(state.task.runIds)).toEqual(new Set(tool.result.runIds));
      expect(
        (await f.db.query("SELECT count(*)::int AS n FROM processing_run"))
          .rows[0].n,
      ).toBe(initial + 2);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy?.mockRestore();
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it.each([0, 1])(
    "OPT-25 keeps a fixed classification selection of %s rows in the task view",
    async (count) => {
      const previous = sessionId,
        f = await opt25Results();
      try {
        requestedTool = undefined;
        toolSequence = [
          { name: "plan_task", input: { nextAction: "select_candidates" } },
          {
            name: "select_candidates",
            input: {
              runId: f.runs[0],
              groups: [
                {
                  count: 1,
                  conditions: [
                    {
                      field: "question",
                      operator: "contains",
                      value: count ? "唯一问题 3" : "不存在的分类",
                    },
                  ],
                },
              ],
            },
          },
        ];
        const state = await opt21End(await opt21Submit("按条件固定候选"));
        expect(
          state.turns
            .at(-1)
            .tools.find((t: any) => t.name === "select_candidates").status,
        ).toBe("succeeded");
        const page = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        });
        expect(page.statusCode, page.body).toBe(200);
        expect(page.json().total).toBe(count);
        expect(page.json().allIds).toHaveLength(count);
        await f.db.query(
          "UPDATE assistant_session SET task=jsonb_set(task,'{candidateScope,hash}',to_jsonb($2::text)) WHERE id=$1",
          [sessionId, "0".repeat(64)],
        );
        const invalid = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        });
        expect(invalid.statusCode, invalid.body).toBe(409);
      } finally {
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await f.db.end();
      }
    },
  );

  it("OPT-24 paginates authorized history and rejects a stale plan execution revision", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      await db.query(
        "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,assistant_text,status,expires_at,created_at) SELECT 'turn_'||md5($1||i::text),$1,'history-'||i,'fixture',$2,$2,'succeeded',now()+interval '90 seconds',now()+i*interval '1 millisecond' FROM generate_series(1,12) i",
        [sessionId, "历史原文".repeat(500)],
      );
      const status = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}?view=status`,
        headers,
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json().turns).toBeUndefined();
      expect(status.body).not.toContain("历史原文");
      expect(status.json().messageRevision).toMatch(/^[0-9a-f]{64}$/);
      expect(status.json().active).toBe(false);
      const latest = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}?view=messages&limit=5`,
          headers,
        })
      ).json();
      expect(latest.turns).toHaveLength(5);
      expect(latest.pagination.total).toBe(12);
      const older = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}?view=messages&limit=5&before=${latest.pagination.nextBefore}`,
          headers,
        })
      ).json();
      expect(older.turns).toHaveLength(5);
      expect(
        new Set([...latest.turns, ...older.turns].map((t) => t.id)).size,
      ).toBe(10);
      const key = randomUUID(),
        revision = status.json().taskRevision;
      const stale = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": key },
        payload: { message: "按方案执行", expectedTaskRevision: revision + 1 },
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error.code).toBe(
        "assistant_plan_revalidation_required",
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM assistant_turn WHERE session_id=$1",
            [sessionId],
          )
        ).rows[0].n,
      ).toBe(12);
      requestedTool = { name: "query_project", input: { kind: "project" } };
      const payload = {
        message: "查询项目信息",
        expectedTaskRevision: revision,
      };
      const accepted = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      const finished = await opt21End(accepted.json().turnId);
      expect(finished.turns.at(-1).status).toBe("succeeded");
      const replay = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/turns`,
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().turnId).toBe(accepted.json().turnId);
      const invalid = await app.inject({
        method: "GET",
        url: `${base()}/sessions/${sessionId}?view=messages&before=unknown`,
        headers,
      });
      expect(invalid.statusCode).toBe(422);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      await db.end();
    }
  });
  it("OPT-24 searches only visible personal sessions and checks incoming object context without changing tasks", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = await opt22Draft("R24 来源草稿");
      await opt21Session();
      const renamed = await app.inject({
        method: "PATCH",
        url: `${base()}/sessions/${sessionId}`,
        headers,
        payload: { title: "R24目标会话" },
      });
      expect(renamed.statusCode).toBe(200);
      const list = await app.inject({
        method: "GET",
        url: `${base()}/sessions?search=R24目标&offset=0&limit=1&sourceKind=draft&sourceId=${source}`,
        headers,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().sessions.map((s: any) => s.id)).toEqual([sessionId]);
      expect(list.json().sessions[0].task).toBeUndefined();
      expect(list.json().pagination.total).toBe(1);
      expect(list.json().pageContext.name).toBe("R24 来源草稿");
      expect(
        (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task,
      ).toEqual({});
      const actor = (
        await db.query("SELECT actor_id FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].actor_id;
      await db.query(
        "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,requires_write,dependencies,expires_at) VALUES($1,$2,'private','private','私有草稿正文','succeeded',true,$3,now()+interval '90 seconds')",
        [
          `turn_${randomUUID().replaceAll("-", "")}`,
          sessionId,
          JSON.stringify([{ kind: "draft", id: source }]),
        ],
      );
      await db.query("UPDATE app_user SET role='user' WHERE id=$1", [actor]);
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(project_id,user_id) DO UPDATE SET role='viewer'",
        [projectId, actor],
      );
      try {
        for (const view of ["status", "messages"]) {
          const denied = await app.inject({
            method: "GET",
            url: `${base()}/sessions/${sessionId}?view=${view}`,
            headers,
          });
          expect(denied.statusCode).toBe(404);
          expect(denied.body).not.toContain("私有草稿正文");
        }
        const hidden = (
          await app.inject({
            method: "GET",
            url: `${base()}/sessions?search=R24目标&limit=20`,
            headers,
          })
        ).json();
        expect(hidden.sessions).toEqual([]);
        expect(hidden.pagination.total).toBe(0);
      } finally {
        await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [actor]);
        await db.query(
          "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
          [projectId, actor],
        );
      }
    } finally {
      sessionId = previous;
      await db.end();
    }
  });
  it.each(["all", "where"])(
    "OPT-28 selects and refines the same 20+28+2 current results using %s",
    async (method) => {
      const previous = sessionId,
        f = await opt25Results(false, [20, 28, 2]);
      try {
        await f.db.query(
          "UPDATE assistant_session SET task=task||'{\"targetCount\":50}'::jsonb WHERE id=$1",
          [sessionId],
        );
        toolSequence = [
          { name: "plan_task", input: { nextAction: "select_candidates" } },
          {
            name: "select_candidates",
            input: {
              runId: f.runs[0],
              selection: { method: "all", conditions: [] },
            },
          },
        ];
        const selected = await opt21End(await opt21Submit("固定这批全部50条"));
        const selectedTool = selected.turns
          .at(-1)
          .tools.find((t: any) => t.name === "select_candidates");
        expect(selectedTool.status, JSON.stringify(selectedTool)).toBe(
          "succeeded",
        );
        expect(selectedTool.result.selectedCount).toBe(50);
        expect(selected.task.runIds).toHaveLength(3);
        const endpoint = () =>
          `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`;
        const page = (
          await app.inject({ method: "GET", url: endpoint(), headers })
        ).json();
        expect(page.total).toBe(50);
        const history = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=run&run=${f.runs[0]}&limit=100`,
          headers,
        });
        expect(history.json().total).toBe(20);
        toolSequence = [
          { name: "plan_task", input: { nextAction: "refine_candidates" } },
          {
            name: "refine_candidates",
            input: {
              runId: f.runs[0],
              instructions: "OPT-25 局部表述",
              allowedFields: ["question"],
              ...(method === "all"
                ? { allResults: true }
                : {
                    where: {
                      field: "metadata",
                      key: "类别",
                      operator: "equals",
                      value: "原类别",
                    },
                  }),
            },
          },
        ];
        const submitted = await opt21End(
          await opt21Submit(
            method === "all"
              ? "把这批全部问题改得自然"
              : "把类别为原类别的全部问题改得自然",
          ),
        );
        const refined = submitted.turns
          .at(-1)
          .tools.find((t: any) => t.name === "refine_candidates");
        expect(refined.status, JSON.stringify(refined)).toBe("succeeded");
        expect(refined.result.refinedCount).toBe(50);
        expect(refined.result.total).toBe(50);
        const children = (
          await f.db.query(
            "SELECT r.id FROM processing_run r WHERE r.parent_run_id=ANY($1::text[])",
            [f.runs],
          )
        ).rows;
        expect(children).toHaveLength(3);
        for (const child of children) {
          const job = (
            await f.db.query(
              "UPDATE job SET status='running',lease_owner='opt28',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
              [child.id],
            )
          ).rows[0];
          const result = await runProcessing(
            f.db,
            f.artifacts,
            {
              ...f.cfg,
              modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
            },
            job,
          );
          await f.db.query(
            "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
            [job.id, result],
          );
        }
        const { collectProcessingEvents } =
          await import("../../src/assistant/tasks.js");
        await collectProcessingEvents(f.db);
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.some((t: any) =>
                  ["queued", "running"].includes(t.status),
                ),
            { timeout: 15000 },
          )
          .toBe(false);
        const after = (
          await app.inject({ method: "GET", url: endpoint(), headers })
        ).json();
        expect(after.total).toBe(50);
        expect(
          after.records.every((row: any) =>
            row.result.question.endsWith("自然表述"),
          ),
        ).toBe(true);
        requestedTool = {
          name: "read_processing",
          input: { runId: children[0].id },
        };
        const checked = await opt21End(await opt21Submit("核对当前全部成果"));
        expect(checked.task.review).toMatchObject({
          total: 50,
          expectedCount: 50,
          countSatisfied: true,
        });
        toolSequence = [
          {
            name: "plan_task",
            input: { nextAction: "request_processing_apply" },
          },
          {
            name: "request_processing_apply",
            input: { runId: children[0].id, allValid: true },
          },
        ];
        const ready = await opt21End(
          await opt21Submit("把全部成果保存回原草稿"),
        );
        const proposal = ready.proposals.find(
          (p: any) => p.status === "pending",
        );
        expect(proposal?.summary.count, JSON.stringify(ready.task)).toBe(50);
        const accepted = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers,
          payload: {},
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(
          (
            await f.db.query(
              "SELECT count(*)::int n FROM collaborative_draft_record WHERE draft_id=$1 AND question LIKE '%自然表述'",
              [f.source],
            )
          ).rows[0].n,
        ).toBe(50);
      } finally {
        toolSequence = [];
        requestedTool = undefined;
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await f.db.end();
      }
    },
  );

  it("OPT-28 restores a recorded legacy goal and preserves 50/400 through pause, replan and refresh", async () => {
    const previous = sessionId,
      f = await opt25Results(false, [20, 28, 2]);
    try {
      await f.db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            requirements: ["新增候选：50 条"],
            overallTargetCount: 400,
          }),
        ],
      );
      requestedTool = { name: "read_processing", input: { runId: f.runs[0] } };
      const recovered = await opt21End(await opt21Submit("核对当前类别"));
      expect(recovered.task).toMatchObject({
        targetCount: 50,
        overallTargetCount: 400,
      });
      expect(recovered.task.review).toMatchObject({
        expectedCount: 50,
        total: 50,
        countSatisfied: true,
      });
      for (const input of [
        { nextAction: "none" },
        { goal: "重新整理当前类别的核对方案", nextAction: "read_processing" },
      ]) {
        requestedTool = { name: "plan_task", input };
        const state = await opt21End(
          await opt21Submit(
            input.nextAction === "none" ? "先暂停" : "重新整理方案",
          ),
        );
        expect(state.task).toMatchObject({
          targetCount: 50,
          overallTargetCount: 400,
        });
        expect((await read()).json().task.targetCount).toBe(50);
      }
      await f.db.query(
        "UPDATE assistant_session SET task=(task-'targetCount')||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            requirements: ["新增候选：50 条", "新增候选：30 条"],
          }),
        ],
      );
      requestedTool = { name: "read_processing", input: { runId: f.runs[0] } };
      const ambiguous = await opt21End(await opt21Submit("只核对，不执行"));
      expect(ambiguous.task.review).toMatchObject({
        expectedCount: null,
        countUnverified: true,
        complete: false,
      });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-28 rejects legacy result IDs excluded from the current collection", async () => {
    const previous = sessionId,
      f = await opt25Results(false, [20, 28, 2]);
    try {
      const { taskCandidateCollection } =
        await import("../../src/assistant/review.js");
      const session = (
        await f.db.query(
          "SELECT task,actor_id FROM assistant_session WHERE id=$1",
          [sessionId],
        )
      ).rows[0];
      const before = await taskCandidateCollection(
        f.db,
        f.artifacts,
        { projectId, actorId: session.actor_id },
        session.task,
      );
      toolSequence = [
        { name: "plan_task", input: { nextAction: "select_candidates" } },
        {
          name: "select_candidates",
          input: {
            runId: f.runs[0],
            seed: "opt28-fixed-two",
            selection: {
              method: "random",
              mode: "count",
              value: 2,
              conditions: [],
            },
          },
        },
      ];
      const selected = await opt21End(await opt21Submit("只保留两条候选"));
      const chosen = selected.task.candidateScope.count;
      expect(chosen).toBe(2);
      const page = (
        await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        })
      ).json();
      const excluded = before.records.find(
        (row) => !page.allIds.includes(row.id),
      )!;
      toolSequence = [
        { name: "plan_task", input: { nextAction: "refine_candidates" } },
        {
          name: "refine_candidates",
          input: {
            runId: excluded.resultRef.runId,
            resultIds: [excluded.resultRef.resultId],
            instructions: "OPT-25 局部表述",
            allowedFields: ["question"],
          },
        },
      ];
      const rejected = await opt21End(await opt21Submit("尝试改写旧记录引用"));
      const tool = rejected.turns
        .at(-1)
        .tools.find((t: any) => t.name === "refine_candidates");
      expect(tool.status, JSON.stringify(tool)).toBe("failed");
      expect(tool.error.code).toBe("assistant_candidate_selection_changed");
      expect(
        (
          await f.db.query(
            "SELECT id FROM processing_run WHERE parent_run_id=ANY($1::text[])",
            [f.runs],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-28 refuses empty-condition and absent-checkbox shortcuts without writing", async () => {
    const previous = sessionId,
      f = await opt25Results();
    try {
      for (const input of [
        { allSelected: true },
        { where: { field: "question", operator: "contains", value: "" } },
      ]) {
        toolSequence = [
          { name: "plan_task", input: { nextAction: "refine_candidates" } },
          {
            name: "refine_candidates",
            input: {
              runId: f.runs[0],
              instructions: "OPT-25 局部表述",
              allowedFields: ["question"],
              ...input,
            },
          },
        ];
        const state = await opt21End(await opt21Submit("尝试不明确的范围"));
        expect(
          state.turns
            .at(-1)
            .tools.some(
              (t: any) =>
                t.name === "refine_candidates" && t.status === "failed",
            ),
        ).toBe(true);
      }
      expect(
        (
          await f.db.query(
            "SELECT id FROM processing_run WHERE parent_run_id=ANY($1::text[])",
            [f.runs],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      toolSequence = [];
      requestedTool = undefined;
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await f.db.end();
    }
  });

  it("OPT-27 pauses old pending work through reads, events and recovery, then resumes once", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    const firstName = `OPT27-first-${randomUUID()}`,
      secondName = `OPT27-next-${randomUUID()}`;
    try {
      await opt21Session();
      const steps = [
        {
          title: "创建第一份",
          action: "create_draft",
          input: { name: firstName },
        },
        {
          title: "创建第二份",
          action: "create_draft",
          input: { name: secondName },
        },
      ];
      requestedTool = {
        name: "plan_task",
        input: { executionMode: "plan", steps, nextAction: "none" },
      };
      const planned = (await send("先给方案，不执行")).json();
      expect(planned.task.stage).toBe("planning");
      toolSequence = [
        { name: "plan_task", input: { executionMode: "execute" } },
        { name: "create_draft", input: { name: firstName } },
        // Retain an actual committed prefix while the next action is still pending.
        { name: "plan_task", input: { nextAction: "none" } },
        { name: "query_project", input: { kind: "project" } },
      ];
      requestedTool = undefined;
      const paused = (
        await send("先创建第一份，然后暂停并解释后续方案")
      ).json();
      expect(paused.task.executionPaused).toBe(true);
      expect(paused.task.stage).toBe("waiting_input");
      expect(paused.task.nextAction).toBeNull();
      expect(paused.task.executionPlan.steps.map((s: any) => s.status)).toEqual(
        ["executed", "pending"],
      );
      const firstId = paused.task.executionPlan.steps[0].receipt.draftId;
      const countDraft = async (name: string) =>
        (
          await db.query(
            "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name=$2",
            [projectId, name],
          )
        ).rows;
      expect(await countDraft(firstName)).toEqual([{ id: firstId }]);
      expect(await countDraft(secondName)).toEqual([]);
      const revision = (
        await db.query(
          "SELECT task_revision FROM assistant_session WHERE id=$1",
          [sessionId],
        )
      ).rows[0].task_revision;
      const before = calls.length;
      for (const event of ["processing_completed", "budget_yield"])
        await taskModule.queueContinuation(
          db,
          sessionId,
          event,
          `paused-${event}`,
          revision,
        );
      expect((await read()).json().turns).toHaveLength(2);
      // Simulate a previously queued automatic response being reclaimed after the pause.
      await db.query(
        "UPDATE assistant_turn SET event='budget_yield',status='running',execution_attempt=1,expires_at=now()-interval '1 second' WHERE id=$1",
        [paused.turns.at(-1).id],
      );
      await opt21End(paused.turns.at(-1).id);
      expect(calls.length).toBe(before);
      expect((await read()).json().task.executionPaused).toBe(true);
      expect(await countDraft(secondName)).toEqual([]);
      // A fields-only explanation must not implicitly resume the saved plan either.
      requestedTool = {
        name: "plan_task",
        input: { title: "解释两份草稿的方案" },
      };
      const explained = (await send("先别执行，只解释方案")).json();
      expect(explained.task.executionPaused).toBe(true);
      expect(explained.task.nextAction).toBeNull();
      toolSequence = [
        { name: "plan_task", input: { executionMode: "execute" } },
        { name: "create_draft", input: { name: secondName } },
      ];
      requestedTool = undefined;
      const resumed = (await send("按方案继续执行")).json();
      expect(resumed.task.executionPaused).toBe(false);
      expect(
        resumed.task.executionPlan.steps.map((s: any) => s.status),
      ).toEqual(["executed", "executed"]);
      expect(resumed.task.executionPlan.steps[0].receipt.draftId).toBe(firstId);
      await read();
      await read();
      expect(await countDraft(firstName)).toHaveLength(1);
      expect(await countDraft(secondName)).toHaveLength(1);
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
      await db.end();
    }
  });

  it("OPT-27 pauses dispatch without cancelling a queued run and preserves its results on resume", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const source = await opt22Draft("OPT27 暂停中的真实输入");
      await opt21Session();
      const input = {
        source: { kind: "draft", id: source },
        allRecords: true,
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            target: input.source,
            executionMode: "execute",
            steps: [
              { title: "清洗", action: "submit_processing", input },
              { title: "核对", action: "read_processing" },
            ],
          },
        },
        { name: "submit_processing", input },
      ];
      const working = (await send("清洗这些问题并核对结果")).json();
      const runId = working.task.runId;
      expect(runId).toBeTruthy();
      toolSequence = [];
      requestedTool = { name: "plan_task", input: { nextAction: "none" } };
      const paused = (await send("先暂停后面的步骤，只解释处理过程")).json();
      expect(paused.task.executionPaused).toBe(true);
      expect(paused.task.stage).toBe("waiting_input");
      expect(
        (
          await db.query(
            "SELECT j.status FROM job j JOIN processing_run r ON r.job_id=j.id WHERE r.id=$1",
            [runId],
          )
        ).rows[0].status,
      ).toBe("queued");
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='opt27',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
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
      await taskModule.collectProcessingEvents(db);
      const retained = (await read()).json();
      expect(retained.task.executionPaused).toBe(true);
      expect(retained.turns).toHaveLength(2);
      toolSequence = [
        { name: "plan_task", input: { executionMode: "execute" } },
        { name: "read_processing", input: { runId } },
      ];
      requestedTool = undefined;
      const resumed = (await send("继续核对结果")).json();
      expect(resumed.task.executionPaused).toBe(false);
      expect(resumed.task.review.total).toBe(3);
      expect(resumed.task.runId).toBe(runId);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM processing_run WHERE source->>'id'=$1",
            [source],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        resumed.task.executionPlan.steps.every(
          (step: any) => step.status === "executed",
        ),
      ).toBe(true);
      toolSequence = [
        {
          name: "plan_task",
          input: { nextAction: "request_processing_apply" },
        },
        {
          name: "request_processing_apply",
          input: {
            runId,
            allValid: true,
            target: { kind: "newDraft", name: "OPT27 旧确认不得写入" },
          },
        },
      ];
      const awaiting = (await send("准备保存这些结果")).json();
      const proposal = awaiting.proposals.find(
        (p: any) => p.status === "pending",
      );
      expect(proposal).toBeTruthy();
      requestedTool = {
        name: "plan_task",
        input: { targetCount: 2, nextAction: "none" },
      };
      const changed = (
        await send("先别保存，目标改成两条，只解释如何调整")
      ).json();
      expect(changed.task.targetCount).toBe(2);
      expect(changed.task.runId).toBe(runId);
      expect(changed.task.executionPaused).toBe(true);
      const oldConfirmation = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(oldConfirmation.statusCode).toBe(409);
      expect(
        (
          await db.query(
            "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name='OPT27 旧确认不得写入'",
            [projectId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
      await db.end();
    }
  });

  it("OPT-27 does not treat a tool-free model answer as an explicit pause", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      textualToolCall = "清洗只做规范整理，改写按要求改变表达。";
      const state = (await send("清洗和改写有何区别？")).json();
      expect(state.task.executionPaused).not.toBe(true);
      expect(state.turns.at(-1).tools).toEqual([]);
    } finally {
      sessionId = previous;
      textualToolCall = undefined;
    }
  });

  it("OPT-26 advertises action-specific plan inputs from the actual tools", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    try {
      const start = calls.length;
      requestedTool = { name: "query_project", input: { kind: "project" } };
      await send("查询项目");
      const tools = calls
        .slice(start)
        .find((body) =>
          body.tools?.some((tool: any) => tool.function.name === "plan_task"),
        )!.tools;
      const plan = tools.find((tool: any) => tool.function.name === "plan_task")
        .function.parameters;
      const variants = plan.properties.steps.items.oneOf;
      expect(variants).toBeInstanceOf(Array);
      const ajv = new Ajv({ strict: false });
      for (const [action, input] of [
        ["create_draft", { name: "合成草稿", instructions: "错误字段" }],
        ["submit_processing", { operation: "rewrite", allSelected: true }],
        [
          "read_records",
          { source: { kind: "assets", id: "background-document" } },
        ],
      ] as const) {
        const variant = variants.find(
          (item: any) => item.properties.action.enum[0] === action,
        );
        const direct = tools.find((tool: any) => tool.function.name === action)
          .function.parameters;
        expect(variant.properties.input.properties).toEqual(direct.properties);
        expect(ajv.compile(variant)({ title: "检查合同", action, input })).toBe(
          false,
        );
        expect(ajv.compile(direct)(input)).toBe(false);
      }
      expect(
        ajv.compile(plan)({
          executionMode: "plan",
          steps: [{ title: "以后读取", action: "read_processing" }],
        }),
      ).toBe(true);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });

  it("OPT32 repairs one malformed repair response within the same two-request limit", async () => {
    const previous = sessionId;
    await opt21Session();
    const start = calls.length;
    try {
      requestedTool = {
        name: "query_project",
        input: { kind: "project", offset: ["0", "1"] },
      };
      parameterRepairReply = ({ original }) => original;
      parameterRepairTextOnce = true;
      const state = (await send("查询项目", undefined, "failed")).json();
      expect(state.turns.at(-1).diagnostics.parameterRepairs).toEqual([
        { name: "query_project", outcome: "invalid" },
        { name: "query_project", outcome: "invalid" },
        { name: "query_project", outcome: "exhausted" },
      ]);
      expect(
        state.turns.at(-1).diagnostics.parameterRepairStatus,
      ).toMatchObject({
        name: "query_project",
        phase: "finished",
        outcome: "exhausted",
        issues: expect.arrayContaining([{ path: "/offset", keyword: "type" }]),
      });
      expect(
        calls
          .slice(start)
          .filter((c) =>
            String(c.messages.at(-1)?.content).includes(
              '"operation":"repair_tool_arguments"',
            ),
          ),
      ).toHaveLength(2);
      expect(
        state.turns.at(-1).tools.filter((t: any) => t.status === "succeeded"),
      ).toHaveLength(0);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      parameterRepairReply = undefined;
      parameterRepairTextOnce = false;
    }
  });

  it.each(["plan", "direct"])(
    "OPT32 repairs before execution without stale failure cards (%s)",
    async (path) => {
      const previous = sessionId;
      await opt21Session();
      const name = `OPT32-${randomUUID()}`;
      const start = calls.length;
      try {
        requestedTool =
          path === "direct"
            ? { name: "create_draft", input: { name: [name] } }
            : {
                name: "plan_task",
                input: {
                  executionMode: "execute",
                  steps: {
                    title: "创建草稿",
                    action: "create_draft",
                    input: { name },
                  },
                },
              };
        if (path === "plan") {
          toolSequence = [requestedTool];
          requestedTool = undefined;
        }
        parameterRepairReply = ({ original }) =>
          path === "direct"
            ? { ...original, name: original.name[0] }
            : { ...original, steps: [original.steps] };
        const state = (await send("创建一个草稿")).json();
        const turn = state.turns.at(-1);
        expect(turn.status).toBe("succeeded");
        expect(
          turn.tools.filter((t: any) => t.status === "failed"),
        ).toHaveLength(0);
        expect(
          turn.tools.filter(
            (t: any) => t.name === "create_draft" && t.status === "succeeded",
          ),
        ).toHaveLength(1);
        const repairCalls = calls
          .slice(start)
          .filter((c) =>
            c.messages.some((m: any) =>
              String(m.content).includes('"operation":"repair_tool_arguments"'),
            ),
          );
        expect(repairCalls).toHaveLength(0);
        const db = createPool(databaseUrl);
        try {
          expect(
            (
              await db.query(
                "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name=$2",
                [projectId, name],
              )
            ).rows,
          ).toHaveLength(1);
        } finally {
          await db.end();
        }
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        parameterRepairReply = undefined;
      }
    },
  );

  it.each([
    [{ targetCount: "2" }, { targetCount: 3 }],
    [
      { allowedFields: "question" },
      { allowedFields: ["question", "metadata"] },
    ],
    [{ requirements: "保留原始问题" }, { requirements: ["重写所有问题"] }],
    [
      { targetCount: "2" },
      {
        targetCount: 2,
        target: { kind: "draft", id: "invented-cross-project" },
      },
    ],
  ])(
    "OPT32 normalizes locally without exposing business values to an unsafe repair (%j)",
    async (original, corrected) => {
      const previous = sessionId;
      await opt21Session();
      const start = calls.length;
      try {
        requestedTool = { name: "plan_task", input: original };
        parameterRepairReply = () => corrected;
        const state = (await send("只给方案")).json();
        expect(state.turns.at(-1).status).toBe("succeeded");
        expect(
          state.turns.at(-1).tools.every((t: any) => t.status !== "failed"),
        ).toBe(true);
        expect(state.task.targetCount ?? null).toBe(
          "targetCount" in original ? 2 : null,
        );
        expect(state.task.target).toBeUndefined();
        expect(state.task.parameterRepairLimits).toBeUndefined();
        expect(
          calls
            .slice(start)
            .filter((c) =>
              String(c.messages.at(-1)?.content).includes(
                '"operation":"repair_tool_arguments"',
              ),
            ),
        ).toHaveLength(0);
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        parameterRepairReply = undefined;
      }
    },
  );

  it("OPT32 caps unsupported-field repair across user retry and retains its reason", async () => {
    const previous = sessionId;
    await opt21Session();
    const start = calls.length;
    const name = `OPT32-unsafe-${randomUUID()}`;
    try {
      parameterRepairReply = () => ({ name });
      for (const message of ["创建草稿，只改前两条", "重试未完成步骤"]) {
        requestedTool = {
          name: "create_draft",
          input: { name, instructions: "只改前两条" },
        };
        const state = (await send(message, undefined, "failed")).json();
        expect(state.turns.at(-1).errorCode).toBe(
          "assistant_tool_input_invalid",
        );
        expect(
          state.turns.at(-1).tools.filter((t: any) => t.status === "succeeded"),
        ).toHaveLength(0);
      }
      expect(
        calls
          .slice(start)
          .filter((c) =>
            String(c.messages.at(-1)?.content).includes(
              '"operation":"repair_tool_arguments"',
            ),
          ),
      ).toHaveLength(2);
      const db = createPool(databaseUrl);
      try {
        expect(
          (
            await db.query(
              "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name=$2",
              [projectId, name],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await db.end();
      }
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      parameterRepairReply = undefined;
    }
  });

  it.each([
    ["processing_result_invalid", false],
    ["assistant_candidate_review_incomplete", false],
    ["assistant_operation_unknown", false],
    ["processing_result_invalid", true],
    ["assistant_candidate_review_incomplete", true],
    ["assistant_operation_unknown", true],
  ] as const)(
    "OPT31 revalidates a pre-confirmation invalid selection but keeps uncertain effects frozen (%s, preserve:%s)",
    async (code, preserve) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      await opt21Session();
      try {
        requestedTool = { name: "query_project", input: { kind: "project" } };
        const initial = await opt21End(await opt21Submit("查询项目"));
        const turnId = initial.turns.at(-1).id,
          key = "assistant:fixture:selection-before-confirmation";
        const input = {
          runId: "processing_fixture",
          target: { kind: "newDraft", name: "范围修复验收" },
        };
        await db.query(
          "UPDATE assistant_turn SET tool_results=$2::jsonb WHERE id=$1",
          [
            turnId,
            JSON.stringify([
              {
                key,
                name: "request_processing_apply",
                input,
                status: "failed",
                error: { code },
              },
            ]),
          ],
        );
        const task = {
          ...initial.task,
          stage: "failed",
          executionPlan: {
            mode: "execute",
            current: 0,
            needsReview: false,
            requirementsKey: planRequirementsKey(initial.task),
            steps: [
              {
                id: "step_fixture",
                title: "保存当前候选",
                action: "request_processing_apply",
                status: "pending",
                input,
                operation: { key, input },
              },
            ],
          },
        };
        await db.query(
          "UPDATE assistant_session SET task=$2::jsonb WHERE id=$1",
          [sessionId, JSON.stringify(task)],
        );
        toolSequence = [
          {
            name: "plan_task",
            input: {
              executionMode: "plan",
              ...(!preserve
                ? {
                    steps: [
                      {
                        title: "保存当前候选",
                        action: "request_processing_apply",
                        input: { ...input, allValid: true },
                      },
                    ],
                  }
                : {}),
            },
          },
        ];
        const state = await opt21End(
          await opt21Submit("修正采用范围，先只保存方案，暂不执行。"),
        );
        const current = state.turns.at(-1),
          plan = current.tools.find((t: any) => t.name === "plan_task");
        const stored = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        if (code !== "assistant_operation_unknown" || preserve) {
          expect(plan, JSON.stringify(current)).toMatchObject({
            status: "succeeded",
          });
          expect(state.task.executionPlan.mode).toBe("plan");
          expect(state.task.executionPlan.steps[0].input.allValid).toBe(
            preserve ? undefined : true,
          );
          if (code !== "assistant_operation_unknown")
            expect(stored.executionPlan.steps[0].operation).toBeUndefined();
          else expect(stored.executionPlan.steps[0].operation.key).toBe(key);
        } else {
          expect(plan).toMatchObject({
            status: "failed",
            error: { code: "assistant_retry_parameters_changed" },
          });
          expect(stored.executionPlan.steps[0].operation.key).toBe(key);
        }
        expect(
          current.tools.filter(
            (t: any) =>
              t.name === "request_processing_apply" && t.status === "succeeded",
          ),
        ).toHaveLength(0);
        expect(
          state.proposals.filter((p: any) => p.status === "pending"),
        ).toHaveLength(0);
      } finally {
        sessionId = previous;
        toolSequence = [];
        requestedTool = undefined;
        await db.end();
      }
    },
  );

  it("OPT31 keeps a known temporarily inactive tool non-executable and lets the model return to the legal step", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    await opt21Session();
    const start = calls.length;
    const before = (
      await db.query(
        "SELECT count(*)::int AS n FROM collaborative_draft WHERE project_id=$1",
        [projectId],
      )
    ).rows[0].n;
    try {
      toolSequence = [
        { name: "request_processing_apply", input: {} },
        {
          name: "plan_task",
          input: { title: "只说明当前能力", nextAction: "none" },
        },
      ];
      const state = await opt21End(
        await opt21Submit("先说明当前能做什么，暂不执行。"),
      );
      const turn = state.turns.at(-1);
      expect(turn.status).toBe("succeeded");
      expect(state.task.title).toBe("只说明当前能力");
      expect(
        turn.tools.filter(
          (t: any) =>
            t.name === "request_processing_apply" && t.status === "succeeded",
        ),
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collaborative_draft WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n,
      ).toBe(before);
      expect(calls.length - start).toBeLessThanOrEqual(4);
      expect(turn.diagnostics.parameterRepairs).toContainEqual({
        name: "request_processing_apply",
        outcome: "context_required",
      });
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
      await db.end();
    }
  });

  it("OPT31 bounds repeated inactive-tool calls without executing them", async () => {
    const previous = sessionId;
    await opt21Session();
    const start = calls.length;
    try {
      toolSequence = Array.from({ length: 12 }, () => ({
        name: "request_processing_apply",
        input: {},
      }));
      const state = await opt21End(
        await opt21Submit("先说明当前能做什么，暂不执行。"),
      );
      const turn = state.turns.at(-1);
      expect(
        turn.diagnostics.parameterRepairs.filter(
          (r: any) => r.outcome === "context_required",
        ).length,
      ).toBeGreaterThan(1);
      expect(calls.length - start).toBeLessThanOrEqual(10);
      expect(
        turn.tools.filter(
          (t: any) =>
            t.name === "request_processing_apply" && t.status === "succeeded",
        ),
      ).toHaveLength(0);
      expect(state.task.createdDraftId).toBeUndefined();
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });

  it("OPT32 rejects an unknown tool without guessing another tool or executing", async () => {
    const previous = sessionId;
    await opt21Session();
    const start = calls.length;
    try {
      requestedTool = { name: "invented_tool", input: {} };
      const state = (await send("查询项目", undefined, "failed")).json();
      expect(state.turns.at(-1).errorCode).toBe("assistant_tool_input_invalid");
      expect(calls.length - start).toBe(1);
      expect(
        state.turns.at(-1).tools.every((t: any) => t.effect === "none"),
      ).toBe(true);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
    }
  });

  it("OPT32 cannot turn unsupported allSelected into allRecords", async () => {
    const previous = sessionId;
    await opt21Session();
    try {
      requestedTool = {
        name: "submit_processing",
        input: {
          operation: "clean",
          allSelected: true,
          instructions: "整理空白",
        },
      };
      parameterRepairReply = () => ({
        operation: "clean",
        allRecords: true,
        instructions: "整理空白",
      });
      const state = (await send("清洗已选择记录", undefined, "failed")).json();
      expect(state.turns.at(-1).errorCode).toBe("assistant_tool_input_invalid");
      expect(state.task.runId).toBeUndefined();
      expect(
        state.turns.at(-1).tools.every((t: any) => t.effect === "none"),
      ).toBe(true);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      parameterRepairReply = undefined;
    }
  });

  it.each(["stop", "revision", "pause"])(
    "OPT32 refuses a late repair after %s",
    async (change) => {
      const previous = sessionId;
      await opt21Session();
      const db = createPool(databaseUrl);
      const name = `OPT32-late-${randomUUID()}`;
      let finish!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        requestedTool = { name: "create_draft", input: { name: [name, name] } };
        parameterRepairReply = async () => {
          entered();
          await resume;
          return { name };
        };
        const id = await opt21Submit("创建草稿");
        await waiting;
        if (change === "stop") {
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
        } else if (change === "revision") {
          await db.query(
            "UPDATE assistant_session SET task_revision=task_revision+1 WHERE id=$1",
            [sessionId],
          );
          const { turnFence } = await import("../../src/assistant/store.js");
          const saved = (
            await db.query(
              "SELECT s.actor_id,t.execution_token FROM assistant_session s JOIN assistant_turn t ON t.session_id=s.id WHERE t.id=$1",
              [id],
            )
          ).rows[0];
          await expect(
            turnFence(
              db,
              { projectId, actorId: saved.actor_id },
              id,
              saved.execution_token,
            ),
          ).rejects.toMatchObject({ code: "assistant_interrupted" });
          // A raw revision mutation has no scheduler transition; stop this obsolete test turn for cleanup.
          await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/stop`,
            headers,
            payload: {},
          });
        } else {
          await db.query(
            "UPDATE assistant_session SET task=task||'{\"executionPaused\":true}'::jsonb WHERE id=$1",
            [sessionId],
          );
        }
        finish();
        await opt21End(id);
        expect(
          (
            await db.query(
              "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name=$2",
              [projectId, name],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        finish();
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        requestedTool = undefined;
        parameterRepairReply = undefined;
        await db.end();
      }
    },
  );

  it("OPT32 charges a repair transport retry to the same request and repair limits", async () => {
    const previous = sessionId;
    await opt21Session();
    const start = calls.length;
    try {
      requestedTool = {
        name: "query_project",
        input: { kind: "project", offset: ["0", "1"] },
      };
      parameterRepairReply = ({ original }) => original;
      providerFaults = [null, 503, null];
      const state = (await send("查询项目", undefined, "failed")).json();
      const diagnostics = state.turns.at(-1).diagnostics;
      expect(diagnostics.transportRetries).toBe(1);
      expect(diagnostics.modelSteps).toBe(calls.length - start);
      expect(diagnostics.parameterRepairs).toEqual([
        { name: "query_project", outcome: "invalid" },
        { name: "query_project", outcome: "exhausted" },
      ]);
      expect(
        state.turns.at(-1).tools.filter((t: any) => t.status === "succeeded"),
      ).toHaveLength(0);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      parameterRepairReply = undefined;
      providerFaults = [];
    }
  });

  it.each(["plan", "direct"])(
    "OPT-26 refuses to discard unsupported requirements in a %s call without writes",
    async (path) => {
      const previous = sessionId;
      const draftName = `OPT26-${randomUUID()}`;
      sessionId = (
        await app.inject({
          method: "POST",
          url: `${base()}/sessions`,
          headers,
          payload: {},
        })
      ).json().sessionId;
      const start = calls.length;
      try {
        const invalid = { name: draftName, instructions: "not supported" };
        requestedTool =
          path === "plan"
            ? {
                name: "plan_task",
                input: {
                  executionMode: "execute",
                  steps: [
                    {
                      title: "创建草稿",
                      action: "create_draft",
                      input: invalid,
                    },
                  ],
                },
              }
            : { name: "create_draft", input: invalid };
        parameterRepairReply = ({ original }) =>
          path === "plan"
            ? {
                ...original,
                steps: [{ ...original.steps[0], input: { name: draftName } }],
              }
            : { name: draftName };
        const state = (await send("创建一个草稿", undefined, "failed")).json();
        const turn = state.turns.at(-1);
        expect(turn.errorCode).toBe("assistant_tool_input_invalid");
        expect(
          turn.tools.filter(
            (tool: any) =>
              tool.name === "create_draft" && tool.status === "succeeded",
          ),
        ).toHaveLength(0);
        const db = createPool(databaseUrl);
        try {
          expect(
            (
              await db.query(
                "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name=$2",
                [projectId, draftName],
              )
            ).rows,
          ).toHaveLength(0);
        } finally {
          await db.end();
        }
        const hints = turn.tools
          .filter((tool: any) => tool.status === "failed")
          .map((tool: any) => tool.error.hint)
          .join(" ");
        expect(hints).toContain("create_draft");
        expect(hints).toContain("instructions");
        expect(hints).not.toContain("select_candidates");
        expect(calls.length - start).toBeLessThanOrEqual(5);
      } finally {
        sessionId = previous;
        toolSequence = [];
        requestedTool = undefined;
        parameterRepairReply = undefined;
      }
    },
  );

  it("OPT-26 stops repeated invalid plan inputs without writes or a new budget", async () => {
    const previous = sessionId;
    sessionId = (
      await app.inject({
        method: "POST",
        url: `${base()}/sessions`,
        headers,
        payload: {},
      })
    ).json().sessionId;
    const start = calls.length;
    const draftName = `OPT26-repeated-${randomUUID()}`;
    try {
      toolSequence = Array.from({ length: 8 }, () => ({
        name: "plan_task",
        input: {
          executionMode: "execute",
          steps: [
            {
              title: "创建草稿",
              action: "create_draft",
              input: { name: draftName, instructions: "unsupported" },
            },
          ],
        },
      }));
      const state = (await send("创建草稿", undefined, "failed")).json();
      expect(state.turns.at(-1).errorCode).toBe("assistant_tool_input_invalid");
      expect(calls.length - start).toBeLessThanOrEqual(4);
      expect(
        calls
          .slice(start)
          .filter((c) =>
            c.messages.some((m: any) =>
              String(m.content).includes('"operation":"repair_tool_arguments"'),
            ),
          ),
      ).toHaveLength(2);
      expect(
        state.turns.at(-1).diagnostics.parameterRepairs.at(-1),
      ).toMatchObject({ name: "plan_task", outcome: "exhausted" });
      expect(state.turns.at(-1).diagnostics.requirementsReconciled).toBe(false);
      const db = createPool(databaseUrl);
      try {
        expect(
          (
            await db.query(
              "SELECT id FROM collaborative_draft WHERE project_id=$1 AND name=$2",
              [projectId, draftName],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await db.end();
      }
    } finally {
      sessionId = previous;
      toolSequence = [];
    }
  });
  async function opt29Background() {
    await opt21Session();
    const upload = await app.inject({
      method: "POST",
      url: `${base()}/sessions/${sessionId}/background-documents`,
      headers,
      payload: {
        fileName: "生成依据.md",
        contentBase64: Buffer.from(
          Array.from(
            { length: 8 },
            (_, i) =>
              `A.1.${String.fromCharCode(97 + i)} 测试第${i + 1}类场景。`,
          ).join("\n") +
            "\n问题须完整自然，期望行为为核验信息，不编造事实。私人原文-canary",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    requestedTool = {
      name: "read_background",
      input: { documentId: upload.json().document.id },
    };
    await opt21End(await opt21Submit("先读文档"));
    requestedTool = undefined;
    return upload.json().document;
  }
  async function opt29Worker(runId: string) {
    const db = createPool(databaseUrl);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',lease_owner='opt29',lease_expires_at=now()+interval '5 minutes' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
          [runId],
        )
      ).rows[0];
      const cfg = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
      };
      const result = await runProcessing(
        db,
        new ArtifactRepository(cfg.minio),
        cfg,
        job,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      return result;
    } finally {
      await db.end();
    }
  }
  it.each([20, 48])(
    "OPT30 completes only the missing positions from %i/50 and retains local edits",
    async (initialCount) => {
      const previous = sessionId,
        db = createPool(databaseUrl),
        prompts: any[] = [];
      let completing = false;
      try {
        await opt29Background();
        const missing =
          initialCount === 20
            ? Array.from({ length: 30 }, (_, i) => i + 20)
            : [7, 39];
        generationResponse = (prompt) => {
          prompts.push(prompt);
          return prompt.generation.slots.map((slot: any) => {
            const position = slot.position - 1;
            if (
              !completing &&
              missing.includes(position) &&
              position === missing[0]
            )
              return {
                question: "",
                expectedOutput: "空问题不能占成功数量",
                metadata: [],
              };
            if (
              !completing &&
              missing.includes(position) &&
              position === missing[1] &&
              initialCount === 20
            )
              return {
                question: 123,
                expectedOutput: "无效字段不能占成功数量",
                metadata: [],
              };
            return {
              question: `具体场景${!completing && missing.includes(position) ? 0 : position}，应该如何核对？`,
              expectedOutput: "先核实事实，不编造已执行动作",
              metadata: [{ key: "riskCategory", value: "A.1.a" }],
            };
          });
        };
        requestedTool = {
          name: "generate_candidates",
          input: {
            name: `OPT30-${initialCount}-${randomUUID()}`,
            instructions: "依据文档生成50条完整自然问题",
            outputCount: 50,
            scenarios: [
              "家庭中的核实",
              "工作中的核实",
              "学习中的核实",
              "出行中的核实",
              "公共信息核实",
            ],
          },
        };
        const state = await opt21End(await opt21Submit("按文档生成50条"));
        const runId = state.task.runId;
        expect(runId, JSON.stringify(state.turns.at(-1))).toBeTruthy();
        await expect(opt29Worker(runId)).rejects.toThrow(
          "processing_batch_failed",
        );
        await db.query(
          "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
          [runId],
        );
        const path = `/api/projects/${projectId}/processing-tasks/${runId}`;
        const get = async () =>
          (
            await app.inject({
              method: "GET",
              url: `${path}?limit=100`,
              headers,
            })
          ).json();
        let partial = await get();
        expect(partial.task.generation).toEqual({
          targetCount: 50,
          validCount: initialCount,
          missingCount: 50 - initialCount,
        });
        expect(partial.recovery.canContinue).toBe(true);
        expect(prompts[0].generation.slots[0].scenario).toBe("家庭中的核实");
        expect(
          prompts.find((p) => p.generation.slots[0].position === 11).generation
            .slots[0].scenario,
        ).toBe("工作中的核实");
        expect(
          prompts.some(
            (p) =>
              p.lastFailure === "duplicate_content" &&
              p.rejectedDuplicates.length,
          ),
        ).toBe(true);
        if (initialCount === 48) {
          const edit = await app.inject({
            method: "POST",
            url: `${path}/rounds`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              mode: "continue",
              expectedRevision: partial.task.revision,
              resultIds: [partial.records[0].id],
              options: {
                operation: "rewrite",
                instructions: "OPT-25 局部表述",
                allowedFields: ["question"],
              },
            },
          });
          expect(edit.statusCode, edit.body).toBe(201);
          await opt29Worker(edit.json().run.id);
          partial = await get();
          expect(partial.records[0].result.question).toContain("自然表述");
          expect(partial.task.generation.validCount).toBe(48);
          expect(partial.recovery.canContinue).toBe(true);
        }
        const before = partial.records.map((r: any) => ({
          id: r.id,
          result: r.result,
        }));
        const key = randomUUID();
        const completed = await app.inject({
          method: "POST",
          url: `${path}/rounds`,
          headers: { ...headers, "idempotency-key": key },
          payload: {
            mode: "complete",
            expectedRevision: partial.task.revision,
          },
        });
        expect(completed.statusCode, completed.body).toBe(201);
        expect(completed.json().run.options.outputCount).toBe(
          50 - initialCount,
        );
        const child = (
          await db.query("SELECT * FROM processing_run WHERE id=$1", [
            completed.json().run.id,
          ])
        ).rows[0];
        const artifacts = new ArtifactRepository(loadConfig().minio);
        const frozen = JSON.parse(
          (await artifacts.readBytes(child.input_ref, 100000000)).toString(),
        );
        expect(frozen.generation.positions).toEqual(missing);
        expect(frozen.generation.total).toBe(50);
        completing = true;
        const start = prompts.length;
        await opt29Worker(child.id);
        expect(
          prompts
            .slice(start)
            .flatMap((p) => p.generation.slots.map((s: any) => s.position - 1)),
        ).toEqual(missing);
        const current = await get();
        expect(current.records).toHaveLength(50);
        expect(current.task.generation).toEqual({
          targetCount: 50,
          validCount: 50,
          missingCount: 0,
        });
        for (const row of before)
          expect(
            current.records.find((r: any) => r.id === row.id)?.result,
          ).toEqual(row.result);
        expect(current.recovery.generationBudget.used).toBeLessThanOrEqual(15);
        const replay = await app.inject({
          method: "POST",
          url: `${path}/rounds`,
          headers: { ...headers, "idempotency-key": key },
          payload: {
            mode: "complete",
            expectedRevision: partial.task.revision,
          },
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json().run.id).toBe(child.id);
        if (initialCount === 48) {
          const saved = await app.inject({
            method: "POST",
            url: `${path}/accept`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              expectedRevision: current.task.revision,
              resultIds: current.allIds,
              target: {
                kind: "newDraft",
                name: "OPT30已保存成果",
                purpose: "",
              },
            },
          });
          expect(saved.statusCode, saved.body).toBe(200);
          const adopted = await get();
          const next = await app.inject({
            method: "POST",
            url: `${path}/rounds`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              mode: "saved",
              expectedRevision: adopted.task.revision,
              options: {
                operation: "clean",
                instructions: "",
                allowedFields: ["question"],
              },
            },
          });
          expect(next.statusCode, next.body).toBe(201);
          await opt29Worker(next.json().run.id);
          const continued = await get();
          expect(continued.task?.currentCount, JSON.stringify(continued)).toBe(
            50,
          );
          expect(continued.task.generation).toMatchObject({
            validCount: 50,
            missingCount: 0,
          });
          const duplicateEdit = await app.inject({
            method: "POST",
            url: `${path}/rounds`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              mode: "continue",
              expectedRevision: continued.task.revision,
              resultIds: continued.allIds.slice(0, 2),
              options: {
                operation: "rewrite",
                instructions: "OPT30制造同文案供审核",
                allowedFields: ["question"],
              },
            },
          });
          expect(duplicateEdit.statusCode, duplicateEdit.body).toBe(201);
          await opt29Worker(duplicateEdit.json().run.id);
          const duplicated = await get();
          expect(duplicated.task.currentCount).toBe(50);
          expect(duplicated.task.generation.validCount).toBe(49);
          const repair = await app.inject({
            method: "POST",
            url: `${path}/rounds`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              mode: "complete",
              expectedRevision: duplicated.task.revision,
            },
          });
          expect(repair.statusCode, repair.body).toBe(201);
          expect(repair.json().run.options.outputCount).toBe(1);
          await opt29Worker(repair.json().run.id);
          const repaired = await get();
          expect(repaired.task.currentCount, JSON.stringify(repaired)).toBe(50);
          expect(repaired.task.generation.validCount).toBe(50);
          const savedDraftId = saved.json().receipt.draftId;
          const draft = (
            await app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/collaborative-drafts/${savedDraftId}`,
              headers,
            })
          ).json();
          const resaved = await app.inject({
            method: "POST",
            url: `${path}/accept`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              expectedRevision: repaired.task.revision,
              resultIds: repaired.allIds,
              target: {
                kind: "draft",
                id: savedDraftId,
                expectedRevision: draft.draft.revision,
              },
            },
          });
          expect(resaved.statusCode, resaved.body).toBe(200);
          expect(
            (
              await db.query(
                "SELECT count(*)::int n FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
                [savedDraftId],
              )
            ).rows[0].n,
          ).toBe(50);
          const adoptedAgain = await get();
          const savedRewrite = await app.inject({
            method: "POST",
            url: `${path}/rounds`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              mode: "saved",
              expectedRevision: adoptedAgain.task.revision,
              options: {
                operation: "rewrite",
                instructions: "OPT-25 局部表述",
                allowedFields: ["question"],
              },
            },
          });
          expect(savedRewrite.statusCode, savedRewrite.body).toBe(201);
          providerFailure = 503;
          providerFailureRemaining = 3;
          await expect(opt29Worker(savedRewrite.json().run.id)).rejects.toThrow(
            "processing_batch_failed",
          );
          await db.query(
            "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
            [savedRewrite.json().run.id],
          );
          const rewritePartial = await get();
          expect(rewritePartial.task.generation.validCount).toBe(50);
          expect(rewritePartial.recovery.canContinue).toBe(true);
          providerFailure = undefined;
          const resumeRewrite = await app.inject({
            method: "POST",
            url: `${path}/rounds`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              mode: "complete",
              expectedRevision: rewritePartial.task.revision,
            },
          });
          expect(resumeRewrite.statusCode, resumeRewrite.body).toBe(201);
          expect(resumeRewrite.json().run.options.operation).toBe("rewrite");
          await opt29Worker(resumeRewrite.json().run.id);
          expect((await get()).task.generation.validCount).toBe(50);
        }
      } finally {
        providerFailure = undefined;
        providerFailureRemaining = 1;
        generationResponse = undefined;
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await db.end();
      }
    },
  );
  it.each(["duplicate", "network", "json", "provider"])(
    "OPT30 %s failure cannot reset the shared budget via retry or complete",
    async (failure) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        await opt29Background();
        requestedTool = {
          name: "generate_candidates",
          input: {
            name: `OPT30-limit-${randomUUID()}`,
            instructions: "依据背景生成5条",
            outputCount: failure === "provider" ? 50 : 5,
            scenarios: ["测试的具体情境"],
          },
        };
        const state = await opt21End(await opt21Submit("按附件生成5条"));
        const runId = state.task.runId;
        if (failure === "duplicate") generationDuplicates = true;
        else if (failure === "provider") {
          providerFailure = 403;
          providerFailureRemaining = 1;
        } else {
          providerFailure = failure as "network" | "json";
          providerFailureRemaining = 3;
        }
        await expect(opt29Worker(runId)).rejects.toThrow(
          "processing_batch_failed",
        );
        await db.query(
          "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
          [runId],
        );
        const path = `/api/projects/${projectId}/processing-tasks/${runId}`;
        const partial = await app.inject({ method: "GET", url: path, headers });
        expect(partial.statusCode, partial.body).toBe(200);
        expect(partial.json().recovery).toMatchObject({
          canRetry: false,
          canContinue: false,
          reason:
            failure === "provider" ? "provider_rejected" : "budget_exhausted",
          generationBudget:
            failure === "provider"
              ? { limit: 15, used: 1, remaining: 14, blocked: true }
              : { limit: 3, used: 3, remaining: 0 },
        });
        expect(partial.json().records).toHaveLength(
          failure === "duplicate" ? 1 : 0,
        );
        const processingCalls = () =>
          calls.filter((call) => !call.tools).length;
        const modelStart = processingCalls();
        const complete = await app.inject({
          method: "POST",
          url: `${path}/rounds`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            mode: "complete",
            expectedRevision: partial.json().task.revision,
          },
        });
        expect(complete.statusCode, complete.body).toBe(409);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/projects/${projectId}/processing-runs/${runId}/retry`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(409);
        await expect(opt29Worker(runId)).rejects.toThrow(
          "processing_batch_failed",
        );
        expect(processingCalls()).toBe(modelStart);
        expect(
          (
            await db.query(
              "SELECT sum(model_attempts)::int n FROM processing_batch WHERE run_id=$1",
              [runId],
            )
          ).rows[0].n,
        ).toBe(failure === "provider" ? 1 : 3);
      } finally {
        generationDuplicates = false;
        providerFailure = undefined;
        providerFailureRemaining = 1;
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("OPT30 preserves same-question different-answer candidates as review collisions", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt29Background();
      requestedTool = {
        name: "generate_candidates",
        input: {
          name: `OPT30-contrast-${randomUUID()}`,
          instructions: "按文档生成5条对照样例",
          outputCount: 5,
          scenarios: ["不同上下文中的核对"],
        },
      };
      const state = await opt21End(await opt21Submit("生成5条对照样例"));
      generationResponse = (prompt) =>
        prompt.generation.slots.map((slot: any, i: number) => ({
          question:
            i < 2 ? "怎样核实退款进度？" : `另外的具体问题${slot.position}？`,
          expectedOutput: `按情境${i}核实，不编造结果`,
          metadata: [],
        }));
      await opt29Worker(state.task.runId);
      const page = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-tasks/${state.task.runId}`,
        headers,
      });
      expect(page.statusCode, page.body).toBe(200);
      expect(page.json().records).toHaveLength(5);
      expect(
        page
          .json()
          .records.filter((r: any) =>
            r.issues.some((issue: any) => issue.code === "question_collision"),
          ),
      ).toHaveLength(2);
      expect(page.json().task.generation.validCount).toBe(5);
    } finally {
      generationResponse = undefined;
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it("OPT30 expired shared deadline stops a recovered run even with calls remaining", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt29Background();
      requestedTool = {
        name: "generate_candidates",
        input: {
          name: `OPT30-time-${randomUUID()}`,
          instructions: "按背景生成5条",
          outputCount: 5,
        },
      };
      const state = await opt21End(await opt21Submit("生成5条"));
      const runId = state.task.runId;
      await db.query(
        "INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at) VALUES($1,0,1,now()-interval '61 seconds')",
        [runId],
      );
      const start = calls.length;
      await expect(opt29Worker(runId)).rejects.toThrow(
        "processing_batch_failed",
      );
      expect(calls).toHaveLength(start);
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [runId],
      );
      const page = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-tasks/${runId}`,
        headers,
      });
      expect(page.statusCode, page.body).toBe(200);
      expect(page.json().recovery).toMatchObject({
        canContinue: false,
        canRetry: false,
        reason: "budget_exhausted",
        generationBudget: { used: 1, remaining: 2, exhausted: true },
      });
    } finally {
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it("OPT29 repairs a malformed generation plan instead of asking the user to confirm it again", async () => {
    const previous = sessionId;
    try {
      await opt29Background();
      const start = calls.length;
      const generation = {
        title: "生成第一类5条",
        action: "generate_candidates",
        input: {
          name: `OPT29-repair-${randomUUID()}`,
          instructions: "按文档生成5条完整问题",
          outputCount: 5,
        },
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            steps: [generation, { ...generation, title: "生成第二类5条" }],
          },
        },
        {
          name: "plan_task",
          input: {
            question: "是否确认按附件分两步执行？",
            nextAction: "generate_candidates",
          },
        },
        {
          name: "plan_task",
          input: { executionMode: "plan", steps: [generation] },
        },
      ];
      const state = await opt21End(await opt21Submit("按附件生成，先给方案"));
      expect(state.task.question).toBeNull();
      expect(state.task.executionPlan.mode).toBe("plan");
      expect(
        state.turns
          .at(-1)
          .tools.filter(
            (t: any) => t.name === "plan_task" && t.status === "failed",
          ),
      ).toHaveLength(2);
      const modelContext = JSON.stringify(calls.slice(start));
      expect(modelContext).not.toContain("不支持仅凭背景文档或空草稿从零生成");
      expect(modelContext).toContain("不能用question把工具参数错误转交用户");
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
    }
  });
  it("OPT29 recovers per-delivery quotas without treating independent test sets as a user conflict", async () => {
    const previous = sessionId;
    try {
      await opt29Background();
      const start = calls.length;
      const rules = [0, 1].map((i) => ({
        field: "metadata",
        key: "category",
        basis: "background",
        allowedValues: [`A.1.${String.fromCharCode(97 + i)}`],
        definitions: [
          {
            value: `A.1.${String.fromCharCode(97 + i)}`,
            text: `A.1.${String.fromCharCode(97 + i)} 测试第${i + 1}类场景`,
          },
        ],
        quotas: [{ value: `A.1.${String.fromCharCode(97 + i)}`, count: 5 }],
      }));
      const steps = rules.flatMap((rule, i) => [
        {
          title: `生成第${i + 1}类5条`,
          action: "generate_candidates",
          input: {
            name: `OPT29-quota-${i}-${randomUUID()}`,
            instructions: "按背景生成完整自然问题",
            outputCount: 5,
            classifications: [rule],
          },
        },
        { title: `核对第${i + 1}类`, action: "read_processing" },
        {
          title: `保存第${i + 1}类`,
          action: "request_processing_apply",
          input: { allValid: true },
        },
      ]);
      const plan = {
        executionMode: "plan",
        targetCount: 5,
        overallTargetCount: 10,
        steps,
      };
      toolSequence = [
        {
          name: "plan_task",
          input: {
            ...plan,
            classifications: [
              {
                ...rules[0],
                allowedValues: rules.flatMap((r) => r.allowedValues),
                definitions: rules.flatMap((r) => r.definitions),
                quotas: rules.flatMap((r) => r.quotas),
              },
            ],
          },
        },
        { name: "plan_task", input: { ...plan, classifications: [rules[0]] } },
      ];
      const state = await opt21End(
        await opt21Submit(
          "按附件创建两个测试集，各5条，不用原始数据，先给方案。",
        ),
      );
      expect(state.task.question).toBeNull();
      expect(state.task.runId).toBeUndefined();
      expect(state.task.targetCount).toBe(5);
      expect(state.task.overallTargetCount).toBe(10);
      expect(state.task.executionPlan.steps).toHaveLength(6);
      expect(state.task.classifications[0].allowedValues).toEqual(["A.1.a"]);
      expect(
        state.task.executionPlan.steps[3].input.classifications[0]
          .allowedValues,
      ).toEqual(["A.1.b"]);
      expect(state.turns.at(-1).assistantText).toContain(
        "方案已保存，尚未执行。",
      );
      expect(JSON.stringify(calls.slice(start))).toContain(
        "多份各N条不是业务配额冲突",
      );
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
    }
  });
  it("OPT29 still pauses for a real business clarification after a parameter error and a read", async () => {
    const previous = sessionId;
    try {
      const doc = await opt29Background();
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            steps: [
              {
                title: "创建草稿",
                action: "create_draft",
                input: { name: "不应创建", instructions: "invalid" },
              },
            ],
          },
        },
        { name: "read_background", input: { documentId: doc.id } },
        {
          name: "plan_task",
          input: {
            question: "文档有八类，你想先做哪一类？",
            nextAction: "none",
          },
        },
      ];
      const state = await opt21End(
        await opt21Submit("按文档选一类生成，类别我还没定"),
      );
      expect(state.task.question).toBe("文档有八类，你想先做哪一类？");
      expect(state.task.stage).toBe("waiting_input");
      expect(state.task.nextAction).toBeNull();
      expect(state.task.runId).toBeUndefined();
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
    }
  });

  it.each(["execute", "plan", "paused", "needsReview"])(
    "OPT31 prepares only an authorized fixed adoption card and waits for confirmation (%s)",
    async (mode) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        await opt29Background();
        const name = `OPT31-fixed-card-${randomUUID()}`;
        requestedTool = {
          name: "plan_task",
          input: {
            target: null,
            targetCount: 2,
            countKind: "new",
            allowedFields: ["question", "expectedOutput", "metadata"],
            executionMode: "plan",
            steps: [
              {
                title: "生成两条",
                action: "generate_candidates",
                input: {
                  name,
                  outputCount: 2,
                  instructions: "按背景生成完整问题和逐题期望行为",
                },
              },
              { title: "核对两条", action: "read_processing" },
              {
                title: "等待人工采用",
                action: "request_processing_apply",
                input: { allValid: true },
              },
            ],
          },
        };
        const plan = await opt21End(
          await opt21Submit("先给两条数据的生成方案，不执行"),
        );
        expect(plan.proposals ?? []).toHaveLength(0);
        requestedTool = {
          name: "plan_task",
          input: { executionMode: "execute" },
        };
        const startExecution = calls.length;
        const submitted = await opt21End(
          await opt21Submit("按当前已保存方案执行"),
        );
        expect(calls.length - startExecution).toBe(0);
        const runId = submitted.task.runId;
        expect(runId).toBeTruthy();
        if (mode !== "execute") {
          const task = (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task;
          if (mode === "plan") task.executionPlan.mode = "plan";
          if (mode === "paused") task.executionPaused = true;
          if (mode === "needsReview") task.executionPlan.needsReview = true;
          await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
            sessionId,
            task,
          ]);
        }
        await opt29Worker(runId);
        const before = calls.length;
        requestedTool = { name: "read_processing", input: { runId } };
        toolSequence = [];
        await taskModule.collectProcessingEvents(db);
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.some((t: any) =>
                  ["queued", "running"].includes(t.status),
                ),
            { timeout: 15000 },
          )
          .toBe(false);
        const state = (await read()).json();
        const proposals = (
          await db.query(
            "SELECT id,status FROM assistant_proposal WHERE session_id=$1 AND action='processing'",
            [sessionId],
          )
        ).rows;
        if (mode !== "execute") {
          expect(proposals, JSON.stringify(state.turns.at(-1))).toHaveLength(0);
          expect(
            (
              await db.query(
                "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
                [state.task.createdDraftId],
              )
            ).rowCount,
          ).toBe(0);
          return;
        }
        expect(proposals, JSON.stringify(state.turns.at(-1))).toHaveLength(1);
        expect(proposals[0].status).toBe("pending");
        expect(state.task.stage).toBe("awaiting_confirmation");
        expect(calls.length - before).toBe(0);
        expect(
          state.turns
            .at(-1)
            .tools.some(
              (t: any) =>
                t.name === "request_processing_apply" &&
                t.status === "succeeded",
            ),
        ).toBe(true);
        const draftId = state.task.createdDraftId;
        expect(
          (
            await db.query(
              "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
              [draftId],
            )
          ).rowCount,
        ).toBe(0);
        await taskModule.collectProcessingEvents(db);
        expect(
          (
            await db.query(
              "SELECT id FROM assistant_proposal WHERE session_id=$1 AND action='processing'",
              [sessionId],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await db.query(
              "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
              [draftId],
            )
          ).rowCount,
        ).toBe(0);
        requestedTool = undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const confirmed = await app.inject({
            method: "POST",
            url: `${base()}/proposals/${proposals[0].id}/confirm`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {},
          });
          expect(confirmed.statusCode, confirmed.body).toBe(200);
          expect(
            (
              await db.query(
                "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
                [draftId],
              )
            ).rowCount,
          ).toBe(2);
        }
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.some((t: any) =>
                  ["queued", "running"].includes(t.status),
                ),
            { timeout: 15000 },
          )
          .toBe(false);
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        await db.end();
      }
    },
  );

  it("OPT31 does not treat the execute control as an answer to a real business question", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt29Background();
      requestedTool = {
        name: "plan_task",
        input: {
          target: null,
          targetCount: 2,
          countKind: "new",
          executionMode: "plan",
          nextAction: "none",
          steps: [
            {
              title: "生成两条",
              action: "generate_candidates",
              input: {
                name: "OPT31-clarify",
                outputCount: 2,
                instructions: "按背景生成完整问题",
              },
            },
            { title: "核对", action: "read_processing" },
            {
              title: "确认采用",
              action: "request_processing_apply",
              input: { allValid: true },
            },
          ],
        },
      };
      const planned = await opt21End(
        await opt21Submit("先给两条数据的生成方案，不执行"),
      );
      expect(planned.task.executionPlan?.steps.length).toBe(3);
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          {
            question: "本次要客服问题，还是客服对话？",
            stage: "waiting_input",
            nextAction: null,
          },
        ],
      );
      const before = calls.length;
      requestedTool = { name: "query_project", input: { kind: "project" } };
      await opt21End(await opt21Submit("按当前已保存方案执行"));
      expect(calls.length - before).toBeGreaterThan(0);
      expect(
        (
          await db.query(
            "SELECT id FROM processing_run WHERE source->>'id'=$1",
            [sessionId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await db.query(
            "SELECT id FROM assistant_proposal WHERE session_id=$1",
            [sessionId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it.each([5, 50])(
    "OPT29 plans and generates %i source-free candidates, reviews and confirms into its own draft",
    async (count) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        const document = await opt29Background();
        const name = `OPT29-${count}-${randomUUID()}`;
        const steps = Array.from({ length: count === 50 ? 8 : 1 }, (_, i) => [
          {
            title: `生成第${i + 1}类`,
            action: "generate_candidates",
            input: {
              name: i ? `${name}-${i + 1}` : name,
              instructions: `按背景生成第${i + 1}类自然的用户问题，填写明确期望行为和riskCategory`,
              outputCount: count,
              classifications: [
                {
                  field: "metadata",
                  key: "riskCategory",
                  basis: "background",
                  allowedValues: [`A.1.${String.fromCharCode(97 + i)}`],
                  definitions: [
                    {
                      value: `A.1.${String.fromCharCode(97 + i)}`,
                      text: `A.1.${String.fromCharCode(97 + i)} 测试第${i + 1}类场景`,
                    },
                  ],
                  quotas: [
                    { value: `A.1.${String.fromCharCode(97 + i)}`, count },
                  ],
                },
              ],
            },
          },
          { title: `核对第${i + 1}类`, action: "read_processing" },
          {
            title: `保存第${i + 1}类`,
            action: "request_processing_apply",
            input: { allValid: true },
          },
        ]).flat();
        requestedTool = {
          name: "plan_task",
          input: {
            target: null,
            targetCount: count,
            countKind: "new",
            ...(count === 50 ? { overallTargetCount: 400 } : {}),
            allowedFields: ["question", "expectedOutput", "metadata"],
            executionMode: "plan",
            steps,
          },
        };
        const plan = await opt21End(await opt21Submit("按文档生成，先给方案"));
        expect(plan.task.executionPlan.mode).toBe("plan");
        expect(
          (
            await db.query("SELECT id FROM collaborative_draft WHERE name=$1", [
              name,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await db.query(
              "SELECT id FROM processing_run WHERE source->>'id'=$1",
              [sessionId],
            )
          ).rowCount,
        ).toBe(0);
        requestedTool = {
          name: "plan_task",
          input: { executionMode: "execute" },
        };
        const execution = await opt21End(await opt21Submit("按方案执行"));
        expect(
          execution.task.runId,
          JSON.stringify(execution.turns.at(-1)),
        ).toBeTruthy();
        const runId = execution.task.runId;
        const row = (
          await db.query("SELECT * FROM processing_run WHERE id=$1", [runId])
        ).rows[0];
        expect(row.source).toEqual({
          kind: "background",
          id: sessionId,
          recordIds: [],
        });
        expect(row.input_count).toBe(0);
        expect(row.options.outputCount).toBe(count);
        expect(row.execution_config.recipeVersion).toBe("processing-v9");
        const start = calls.length;
        if (count === 5) {
          providerFailure = 503;
          providerFailureRemaining = 1;
        }
        expect((await opt29Worker(runId)).counts).toMatchObject({
          input: 0,
          output: count,
        });
        if (count === 5)
          expect(
            (
              await db.query(
                "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
                [runId],
              )
            ).rows[0].model_attempts,
          ).toBe(2);
        for (const call of calls.slice(start).filter((c) => !c.tools)) {
          expect(call.temperature).toBe(0.7);
          const prompt = JSON.parse(call.messages.at(-1).content);
          expect(prompt.records).toBeUndefined();
          expect(prompt.background.documents[0]).toMatchObject({
            id: document.id,
            sha256: document.sha256,
          });
        }
        requestedTool = undefined;
        toolSequence = [];
        await taskModule.collectProcessingEvents(db);
        await expect
          .poll(
            async () =>
              (await read())
                .json()
                .turns.some((t: any) =>
                  ["queued", "running"].includes(t.status),
                ),
            { timeout: 15000 },
          )
          .toBe(false);
        const checked = (await read()).json();
        expect(
          checked.task.review,
          JSON.stringify(checked.turns.at(-1)),
        ).toMatchObject({
          candidateCount: count,
          countSatisfied: true,
          protectedFieldChanges: 0,
        });
        const candidates = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        });
        expect(candidates.statusCode, candidates.body).toBe(200);
        expect(candidates.json().taskTotal).toBe(count);
        expect(candidates.json().records[0].sourcePresentation.label).toContain(
          "依据背景文档生成",
        );
        const checkGenerationProvenance = async () => {
          for (const url of [
            `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
            `/api/projects/${projectId}/processing-tasks/${runId}`,
          ]) {
            const response = await app.inject({ method: "GET", url, headers });
            expect(response.statusCode, response.body).toBe(200);
            for (const record of response.json().records) {
              expect(record.sourcePresentation.label).toBe("依据背景文档生成");
              const history = record.sourcePresentation.steps.filter(
                (step: any) => step.kind === "processing",
              );
              expect(
                history.some(
                  (step: any) =>
                    step.label === "依据背景文档生成" && step.occurredAt,
                ),
                JSON.stringify({ url, record }),
              ).toBe(true);
              expect(
                history.some((step: any) => step.label.includes("未记录")),
              ).toBe(false);
            }
          }
        };
        await checkGenerationProvenance();
        const refresh = await app.inject({
          method: "GET",
          url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
          headers,
        });
        expect(refresh.json().records.map((x: any) => x.id)).toEqual(
          candidates.json().records.map((x: any) => x.id),
        );
        if (count === 5) {
          const before = candidates.json();
          toolSequence = [
            {
              name: "plan_task",
              input: {
                executionMode: "execute",
                steps: [
                  {
                    ...steps[0],
                    input: {
                      ...steps[0].input,
                      instructions: "不应重建已完成生成",
                    },
                  },
                  {
                    title: "仅改勾选一条",
                    action: "refine_candidates",
                    input: {
                      allSelected: true,
                      instructions: "OPT-25 局部表述",
                      allowedFields: ["question"],
                    },
                  },
                ],
              },
            },
            { name: "plan_task", input: { nextAction: "refine_candidates" } },
            {
              name: "refine_candidates",
              input: {
                allSelected: true,
                instructions: "OPT-25 局部表述",
                allowedFields: ["question"],
              },
            },
          ];
          const submitted = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              message: "只把勾选的一条改自然，答案和标签不动",
              candidates: {
                scope: "task",
                reviewRevision: before.reviewRevision,
                resultIds: [before.records[0].id],
              },
            },
          });
          expect(submitted.statusCode, submitted.body).toBe(202);
          const changed = await opt21End(submitted.json().turnId);
          expect(
            changed.turns
              .at(-1)
              .tools.find(
                (t: any) => t.name === "plan_task" && t.status === "failed",
              )?.error.hint,
          ).toContain("局部改写前不能重列生成阶段");
          const refined = changed.turns
            .at(-1)
            .tools.find(
              (t: any) =>
                t.name === "refine_candidates" && t.status === "succeeded",
            );
          expect(refined, JSON.stringify(changed.turns.at(-1))).toBeDefined();
          for (const id of refined.result.runIds ?? [refined.result.runId])
            await opt29Worker(id);
          toolSequence = [];
          await taskModule.collectProcessingEvents(db);
          await expect
            .poll(
              async () =>
                (await read())
                  .json()
                  .turns.some((t: any) =>
                    ["queued", "running"].includes(t.status),
                  ),
              { timeout: 15000 },
            )
            .toBe(false);
          const after = (
            await app.inject({
              method: "GET",
              url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
              headers,
            })
          ).json();
          await checkGenerationProvenance();
          expect(new Set(after.allIds)).toEqual(new Set(before.allIds));
          for (const actual of after.records) {
            const old = before.records.find((x: any) => x.id === actual.id);
            expect(actual.result.expectedOutput).toBe(
              old.result.expectedOutput,
            );
            expect(actual.result.metadata).toEqual(old.result.metadata);
            expect(actual.result.question).toBe(
              old.result.question +
                (actual.id === before.records[0].id ? " 自然表述" : ""),
            );
          }
        }
        if (count === 5) {
          // Reproduce a plan already waiting at adoption, rather than only a completed simple plan.
          const task = (
            await db.query("SELECT task FROM assistant_session WHERE id=$1", [
              sessionId,
            ])
          ).rows[0].task;
          task.allowedFields = ["question"];
          task.executionPlan = {
            ...task.executionPlan,
            mode: "execute",
            current: 0,
            needsReview: false,
            steps: [
              {
                id: `pending-apply-${randomUUID()}`,
                title: "保存当前成果",
                action: "request_processing_apply",
                input: { allValid: true },
                status: "pending",
              },
            ],
          };
          await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
            sessionId,
            task,
          ]);
          const latest = (
            await app.inject({
              method: "GET",
              url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
              headers,
            })
          ).json();
          const explainStart = calls.length;
          toolSequence = [{ name: "plan_task", input: { nextAction: "none" } }];
          const explanation = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              message: "先解释这批内容，不保存",
              candidates: {
                scope: "task",
                reviewRevision: latest.reviewRevision,
                resultIds: latest.records.map((record: any) => record.id),
              },
            },
          });
          expect(explanation.statusCode, explanation.body).toBe(202);
          const paused = await opt21End(explanation.json().turnId);
          expect(paused.turns.at(-1).status).toBe("succeeded");
          expect(paused.task.executionPaused).toBe(true);
          expect(
            calls
              .slice(explainStart)
              .filter(
                (call: any) => call.tool_choice?.function?.name === "plan_task",
              ),
          ).toHaveLength(1);
        }
        toolSequence = [
          {
            name: "plan_task",
            input:
              count === 50
                ? { executionMode: "execute" }
                : {
                    executionMode: "execute",
                    nextAction: "request_processing_apply",
                  },
          },
          { name: "request_processing_apply", input: { allValid: true } },
        ];
        requestedTool = undefined;
        const saveStart = calls.length;
        let saveTurnId: string;
        if (count === 5) {
          const latest = (
            await app.inject({
              method: "GET",
              url: `${base()}/sessions/${sessionId}/candidates?scope=task&limit=100`,
              headers,
            })
          ).json();
          const submitted = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/turns`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              message: "将勾选成果保存回原草稿",
              candidates: {
                scope: "task",
                reviewRevision: latest.reviewRevision,
                resultIds: latest.records.map((record: any) => record.id),
              },
            },
          });
          expect(submitted.statusCode, submitted.body).toBe(202);
          saveTurnId = submitted.json().turnId;
        } else saveTurnId = await opt21Submit("保存这批成果");
        const prepared = await opt21End(saveTurnId);
        if (count === 5)
          expect(calls[saveStart].tool_choice?.function?.name).toBe(
            "plan_task",
          );
        expect(prepared.task.executionPlan?.needsReview).not.toBe(true);
        const proposal = prepared.proposals.find(
          (p: any) => p.status === "pending",
        );
        expect(proposal, JSON.stringify(prepared.turns.at(-1))).toBeDefined();
        toolSequence = [];
        const confirmed = await app.inject({
          method: "POST",
          url: `${base()}/proposals/${proposal.id}/confirm`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {},
        });
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        expect(confirmed.json().receipt.receipt.adopted).toBe(count);
        expect(
          (
            await db.query(
              "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
              [row.target_draft_id],
            )
          ).rowCount,
        ).toBe(count);
        expect(
          (
            await db.query("SELECT id FROM collaborative_draft WHERE name=$1", [
              name,
            ])
          ).rowCount,
        ).toBe(1);
        if (count === 5) {
          const account = {
            email: `opt29-member-${randomUUID()}@example.test`,
            password: "Opt29Member123",
            confirmPassword: "Opt29Member123",
          };
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/accounts",
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
          const other = {
            origin,
            cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
            "x-csrf-token": login.json().csrfToken,
          };
          const invitation = await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/invitations`,
            headers,
            payload: { email: account.email, role: "editor" },
          });
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/api/me/invitations/${invitation.json().invitation.id}/accept`,
                headers: other,
                payload: {},
              })
            ).statusCode,
          ).toBe(200);
          const privateRun = await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/processing-runs/${runId}`,
            headers: other,
          });
          expect(privateRun.statusCode).toBe(404);
          const own = await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/collaborative-drafts/${row.target_draft_id}`,
            headers,
          });
          expect(own.statusCode, own.body).toBe(200);
          expect(own.body).toContain("依据背景文档生成");
          const shared = await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/collaborative-drafts/${row.target_draft_id}`,
            headers: other,
          });
          expect(shared.statusCode, shared.body).toBe(200);
          expect(shared.body).not.toContain("私人原文-canary");
          expect(shared.body).not.toContain(document.id);
          await expect
            .poll(
              async () =>
                (await read())
                  .json()
                  .turns.some((t: any) =>
                    ["queued", "running"].includes(t.status),
                  ),
              { timeout: 15000 },
            )
            .toBe(false);
          const removed = await app.inject({
            method: "DELETE",
            url: `${base()}/sessions/${sessionId}/background-documents/${document.id}`,
            headers,
          });
          expect(removed.statusCode, removed.body).toBe(200);
          expect(
            (
              await app.inject({
                method: "GET",
                url: `/api/projects/${projectId}/processing-runs/${runId}`,
                headers,
              })
            ).statusCode,
          ).toBe(404);
          expect(
            (
              await db.query(
                "SELECT id FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
                [row.target_draft_id],
              )
            ).rowCount,
          ).toBe(5);
        }
        if (count === 50) {
          await expect
            .poll(
              async () =>
                Number(
                  (
                    await db.query(
                      "SELECT count(*) FROM processing_run WHERE source->>'id'=$1",
                      [sessionId],
                    )
                  ).rows[0].count,
                ),
              { timeout: 15000 },
            )
            .toBe(2);
          await expect
            .poll(
              async () =>
                (await read())
                  .json()
                  .turns.some((t: any) =>
                    ["queued", "running"].includes(t.status),
                  ),
              { timeout: 15000 },
            )
            .toBe(false);
          const next = (await read()).json();
          expect(next.task.overallTargetCount).toBe(400);
          expect(next.task.targetCount).toBe(50);
          expect(next.task.runIds).toHaveLength(1);
          expect(next.task.runId).not.toBe(runId);
          expect(next.task.classifications[0]).toMatchObject({
            allowedValues: ["A.1.b"],
            quotas: [{ value: "A.1.b", count: 50 }],
          });
          const cfg = { ...loadConfig(), databaseUrl };
          const nextInput = (
            await db.query("SELECT input_ref FROM processing_run WHERE id=$1", [
              next.task.runId,
            ])
          ).rows[0].input_ref;
          const frozen = JSON.parse(
            (
              await new ArtifactRepository(cfg.minio).readBytes(
                nextInput,
                100000000,
              )
            ).toString("utf8"),
          );
          expect(frozen.background.classifications[0].allowedValues).toEqual([
            "A.1.b",
          ]);
          await opt29Worker(next.task.runId);
          await taskModule.collectProcessingEvents(db);
          await expect
            .poll(
              async () =>
                (await read())
                  .json()
                  .turns.some((t: any) =>
                    ["queued", "running"].includes(t.status),
                  ),
              { timeout: 15000 },
            )
            .toBe(false);
          const nextChecked = (await read()).json();
          expect(nextChecked.task.review).toMatchObject({
            candidateCount: 50,
            countSatisfied: true,
          });
          expect(nextChecked.task.classifications[0].allowedValues).toEqual([
            "A.1.b",
          ]);
          expect(next.task.executionPlan.steps[0].status).toBe("executed");
          expect(
            (
              await db.query(
                "SELECT options->>'outputCount' AS count FROM processing_run WHERE source->>'id'=$1",
                [sessionId],
              )
            ).rows.map((x) => x.count),
          ).toEqual(["50", "50"]);
        }
      } finally {
        providerFailure = undefined;
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("OPT29 rejects missing background before creating a draft or run and keeps empty record modes closed", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const name = `OPT29-missing-${randomUUID()}`;
      requestedTool = {
        name: "generate_candidates",
        input: { name, instructions: "生成问题", outputCount: 5 },
      };
      const result = await opt21End(await opt21Submit("按文档生成5条"));
      expect(
        result.turns
          .at(-1)
          .tools.find((t: any) => t.name === "generate_candidates").error.code,
      ).toBe("assistant_background_required");
      expect(
        (
          await db.query("SELECT id FROM collaborative_draft WHERE name=$1", [
            name,
          ])
        ).rowCount,
      ).toBe(0);
      for (const operation of ["clean", "rewrite", "augment", "generate"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/processing-runs`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "background", id: sessionId, recordIds: [] },
            options: {
              operation,
              instructions: "处理",
              allowedFields: ["question", "expectedOutput", "metadata"],
              ...(["augment", "generate"].includes(operation)
                ? { outputCount: 5 }
                : {}),
            },
          },
        });
        expect(response.statusCode, response.body).toBe(422);
      }
    } finally {
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });

  it("OPT29 reads a real PDF and refuses a generation plan without inter-delivery confirmation", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const uploaded = await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/background-documents`,
        headers,
        payload: {
          fileName: "背景.pdf",
          contentBase64: readFileSync(
            "tests/fixtures/background-two-pages.pdf",
          ).toString("base64"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      requestedTool = {
        name: "read_background",
        input: { documentId: uploaded.json().document.id },
      };
      const readPdf = await opt21End(await opt21Submit("先读附件"));
      toolSequence = [
        {
          name: "read_background",
          input: { documentId: uploaded.json().document.id, from: 999 },
        },
        {
          name: "read_background",
          input: { documentId: uploaded.json().document.id, from: 1 },
        },
      ];
      requestedTool = undefined;
      const corrected = await opt21End(await opt21Submit("核对附件位置"));
      expect(
        corrected.turns.at(-1).tools.find((x: any) => x.status === "failed")
          .error.hint,
      ).toContain("共有");
      expect(
        corrected.turns
          .at(-1)
          .tools.some(
            (x: any) =>
              x.name === "read_background" && x.status === "succeeded",
          ),
      ).toBe(true);

      expect(readPdf.task.backgroundEvidence.length).toBeGreaterThan(0);
      for (const steps of [
        [
          {
            title: "建立空草稿",
            action: "create_draft",
            input: { name: "OPT29-PDF空" },
          },
          {
            title: "生成",
            action: "generate_candidates",
            input: { name: "OPT29-PDF空", instructions: "按文档生成" },
          },
        ],
        [
          {
            title: "生成",
            action: "generate_candidates",
            input: { name: "OPT29-PDF缺数", instructions: "按文档生成" },
          },
        ],
      ]) {
        requestedTool = {
          name: "plan_task",
          input: { executionMode: "execute", steps },
        };
        const missing = await opt21End(await opt21Submit("按文档生成"));
        expect(
          missing.turns.at(-1).tools.find((t: any) => t.name === "plan_task")
            .error.code,
        ).toBe("assistant_tool_input_invalid");
      }
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          steps: [
            {
              title: "生成甲",
              action: "generate_candidates",
              input: {
                name: "OPT29-PDF甲",
                outputCount: 5,
                instructions: "依据文档生成",
              },
            },
            {
              title: "生成乙",
              action: "generate_candidates",
              input: {
                name: "OPT29-PDF乙",
                outputCount: 5,
                instructions: "依据文档生成",
              },
            },
          ],
        },
      };
      const invalid = await opt21End(
        await opt21Submit("分两类各5条，先给方案"),
      );
      expect(
        invalid.turns.at(-1).tools.find((x: any) => x.name === "plan_task")
          .error.code,
      ).toBe("assistant_delivery_pending");
      expect(
        (
          await db.query(
            "SELECT id FROM collaborative_draft WHERE name LIKE 'OPT29-PDF%'",
          )
        ).rowCount,
      ).toBe(0);
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          steps: [
            {
              title: "生成甲",
              action: "generate_candidates",
              input: {
                name: "OPT29-PDF甲",
                outputCount: 5,
                instructions: "依据文档生成",
              },
            },
          ],
        },
      };
      const valid = await opt21End(await opt21Submit("先给单类方案"));
      expect(valid.task.executionPlan.mode).toBe("plan");
      expect(
        (
          await db.query(
            "SELECT id FROM processing_run WHERE source->>'id'=$1",
            [sessionId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      requestedTool = undefined;
      sessionId = previous;
      await db.end();
    }
  });

  it.each(["before", "after"])(
    "OPT29 recovers a %s-run lost response using one target and the original key",
    async (moment) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      let spy: any;
      try {
        await opt29Background();
        // Persisted pre-contract tasks keep their original nested plan API.
        await db.query(
          "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
          [
            sessionId,
            JSON.stringify({
              executionPlan: { mode: "plan", current: 0, steps: [] },
            }),
          ],
        );
        const name = `OPT29-receipt-${randomUUID()}`;
        const input = {
          name,
          outputCount: 5,
          instructions: "按背景生成完整自然问题",
        };
        const original = processingStoreModule.createProcessingRun;
        spy = vi
          .spyOn(processingStoreModule, "createProcessingRun")
          .mockImplementationOnce(async (...args) => {
            if (moment === "after") await original(...args);
            throw new Error("synthetic-lost-response");
          });
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "execute",
            steps: [
              { title: "生成文档候选", action: "generate_candidates", input },
            ],
          },
        };
        const first = await opt21End(await opt21Submit("按文档生成5条"));
        spy.mockRestore();
        expect(
          (
            await db.query("SELECT id FROM collaborative_draft WHERE name=$1", [
              name,
            ])
          ).rowCount,
        ).toBe(1);
        if (moment === "before") {
          expect(
            first.turns
              .at(-1)
              .tools.find((t: any) => t.name === "generate_candidates").error
              .code,
          ).toBe("assistant_operation_unknown");
          requestedTool = { name: "generate_candidates", input };
          const retry = await app.inject({
            method: "POST",
            url: `${base()}/sessions/${sessionId}/retry`,
            headers,
            payload: {},
          });
          expect(retry.statusCode, retry.body).toBe(200);
          await opt21End(first.turns.at(-1).id);
        }
        const state = (await read()).json();
        expect(
          state.task.runId,
          JSON.stringify(state.turns.at(-1)),
        ).toBeTruthy();
        expect(
          (
            await db.query(
              "SELECT id FROM processing_run WHERE source->>'id'=$1",
              [sessionId],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await db.query("SELECT id FROM collaborative_draft WHERE name=$1", [
              name,
            ])
          ).rowCount,
        ).toBe(1);
        if (moment === "after") {
          const path = `/api/projects/${projectId}/processing-runs/${state.task.runId}`;
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${path}/cancel`,
                headers,
                payload: {},
              })
            ).statusCode,
          ).toBe(200);
          const refreshed = await app.inject({
            method: "GET",
            url: path,
            headers,
          });
          expect(refreshed.statusCode, refreshed.body).toBe(200);
          expect(refreshed.json().run.status).toBe("cancel_requested");
          await db.query(
            "UPDATE job SET status='cancelled' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) AND status='cancel_requested'",
            [state.task.runId],
          );
          expect(
            (
              await app.inject({
                method: "POST",
                url: `${path}/retry`,
                headers,
                payload: {},
              })
            ).statusCode,
          ).toBe(200);
          await opt29Worker(state.task.runId);
          const stable = (
            await app.inject({ method: "GET", url: path, headers })
          ).json();
          expect(stable.records).toHaveLength(5);
          expect(stable.run.execution.recipeVersion).toBe("processing-v10");
        }
      } finally {
        spy?.mockRestore();
        requestedTool = undefined;
        toolSequence = [];
        await app.inject({
          method: "POST",
          url: `${base()}/sessions/${sessionId}/stop`,
          headers,
          payload: {},
        });
        sessionId = previous;
        await db.end();
      }
    },
  );
  it("OPT29 preserves valid candidates at the batch budget and explicitly completes only the missing count", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt29Background();
      requestedTool = {
        name: "generate_candidates",
        input: {
          name: `OPT29-budget-${randomUUID()}`,
          instructions: "按背景生成完整问题",
          outputCount: 5,
        },
      };
      const first = await opt21End(await opt21Submit("按文档生成5条"));
      const runId = first.task.runId;
      // Frozen v8 jobs retain their original explicit completion semantics.
      await db.query(
        "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}','\"processing-v8\"') WHERE id=$1",
        [runId],
      );
      generationDuplicates = true;
      await expect(opt29Worker(runId)).rejects.toMatchObject({
        code: "processing_batch_failed",
      });
      generationDuplicates = false;
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [runId],
      );
      const path = `/api/projects/${projectId}/processing-tasks/${runId}`;
      const partial = await app.inject({ method: "GET", url: path, headers });
      expect(partial.statusCode, partial.body).toBe(200);
      expect(partial.json().records).toHaveLength(1);
      expect(partial.json().recovery.canRetry).toBe(false);
      const publicGenerate = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs/${runId}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "continue",
          resultIds: [],
          options: {
            operation: "generate",
            instructions: "绕开助手改变目标",
            outputCount: 10,
            allowedFields: ["question", "expectedOutput", "metadata"],
          },
        },
      });
      expect(publicGenerate.statusCode, publicGenerate.body).toBe(422);
      expect(
        (
          await db.query(
            "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
            [runId],
          )
        ).rows[0].model_attempts,
      ).toBe(3);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/processing-runs/${runId}/retry`,
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      const completed = await app.inject({
        method: "POST",
        url: `${path}/rounds`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "complete",
          expectedRevision: partial.json().task.revision,
        },
      });
      expect(completed.statusCode, completed.body).toBe(201);
      expect(completed.json().run.options.outputCount).toBe(4);
      await opt29Worker(completed.json().run.id);
      const current = await app.inject({ method: "GET", url: path, headers });
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json().records).toHaveLength(5);
      requestedTool = undefined;
      toolSequence = [
        {
          name: "plan_task",
          input: {
            executionMode: "execute",
            nextAction: "read_processing",
            steps: [
              { title: "核对当前成果", action: "read_processing" },
              {
                title: "保存当前成果",
                action: "request_processing_apply",
                input: { allValid: true, allTask: true },
              },
            ],
          },
        },
        {
          name: "request_processing_apply",
          input: { allValid: true, allTask: true },
        },
      ];
      const reviewed = await opt21End(
        await opt21Submit("核对全部成果，保存到草稿"),
      );
      expect(reviewed.task.review).toMatchObject({
        candidateCount: 5,
        countSatisfied: true,
        complete: true,
        missingCount: 0,
      });
      const proposal = reviewed.proposals.find(
        (p: any) => p.status === "pending" && p.action === "processing",
      );
      expect(proposal, JSON.stringify(reviewed.turns.at(-1))).toBeDefined();
      requestedTool = undefined;
      const adopted = await app.inject({
        method: "POST",
        url: `${base()}/proposals/${proposal.id}/confirm`,
        headers,
        payload: {},
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      expect(adopted.json().receipt.receipt.adopted).toBe(5);
      expect(
        current
          .json()
          .records.some(
            (r: any) =>
              r.candidateOrigin?.resultId ===
              partial.json().records[0].candidateOrigin?.resultId,
          ),
      ).toBe(true);
      expect(
        (
          await db.query(
            "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
            [runId],
          )
        ).rows[0].model_attempts,
      ).toBe(3);
    } finally {
      generationDuplicates = false;
      requestedTool = undefined;
      toolSequence = [];
      await app.inject({
        method: "POST",
        url: `${base()}/sessions/${sessionId}/stop`,
        headers,
        payload: {},
      });
      sessionId = previous;
      await db.end();
    }
  });
  it("OPT38 prioritizes current definitions and navigates a literal miss without scanning the preface", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const doc = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "完整规范.txt",
            contentBase64: Buffer.from("占位提取").toString("base64"),
          },
        })
      ).json().document;
      const fragments = JSON.parse(
        readFileSync("tests/fixtures/opt38-background-fragments.json", "utf8"),
      );
      await db.query(
        "UPDATE assistant_background_document SET fragments=$2 WHERE id=$1",
        [doc.id, JSON.stringify(fragments)],
      );
      await db.query(
        "UPDATE assistant_session SET task=task||$2::jsonb WHERE id=$1",
        [
          sessionId,
          JSON.stringify({
            backgroundEvidence: fragments.slice(0, 12).map((f: any) => ({
              documentId: doc.id,
              fragmentIndex: f.index,
            })),
          }),
        ],
      );
      requestedTool = {
        name: "read_background",
        input: {
          documentId: doc.id,
          from: 11,
          limit: 1,
          useForProcessing: false,
        },
      };
      const current = await opt21End(await opt21Submit("查看当前章节"));
      const result = current.turns
        .at(-1)
        .tools.find((t: any) => t.name === "read_background").result;
      expect(result.definitions.some((d: any) => d.value === "A.1.a")).toBe(
        true,
      );
      expect(
        Buffer.byteLength(JSON.stringify(result.definitions)),
      ).toBeLessThanOrEqual(6000);
      requestedTool = {
        name: "read_background",
        input: { documentId: doc.id, query: "宗教", useForProcessing: false },
      };
      const miss = await opt21End(await opt21Submit("找一下宗教相关内容"));
      const navigation = miss.turns
        .at(-1)
        .tools.find((t: any) => t.name === "read_background").result;
      expect(navigation.matchCount).toBe(0);
      expect(
        navigation.sectionDirectory.some(
          (s: any) => s.code === "A.2.b" && s.name.includes("信仰"),
        ),
      ).toBe(true);
      expect(
        navigation.sectionDirectory.some((s: any) => s.name.includes("起草")),
      ).toBe(false);
      expect(miss.task.backgroundEvidence).toHaveLength(12);
      requestedTool = {
        name: "read_background",
        input: { documentId: doc.id, query: "A.2.b", useForProcessing: false },
      };
      const located = await opt21End(await opt21Submit("查看目录里的信仰条目"));
      expect(
        located.turns
          .at(-1)
          .tools.find((t: any) => t.name === "read_background").result
          .definitions[0].value,
      ).toBe("A.2.b");
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });

  it("OPT38 browses beyond twelve fragments and binds only read definitions when saving a plan", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const doc = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "客服规范.txt",
            contentBase64: Buffer.from("占位提取").toString("base64"),
          },
        })
      ).json().document;
      const fragments = Array.from({ length: 14 }, (_, i) => ({
        index: i + 1,
        startLine: i + 1,
        endLine: i + 1,
        text:
          i === 13
            ? "### 退货退款\n定义：用户申请退回已付款项。"
            : "前言 " + (i + 1) + "。",
      }));
      await db.query(
        "UPDATE assistant_background_document SET fragments=$2 WHERE id=$1",
        [doc.id, JSON.stringify(fragments)],
      );
      toolSequence = Array.from({ length: 5 }, (_, i) => ({
        name: "read_background",
        input: {
          documentId: doc.id,
          from: i * 3 + 1,
          limit: i === 4 ? 2 : 3,
          useForProcessing: false,
        },
      }));
      const browsed = await opt21End(
        await opt21Submit("买错了想退钱这类做5条，先给方案不执行"),
      );
      expect(
        browsed.turns
          .at(-1)
          .tools.filter(
            (t: any) =>
              t.name === "read_background" && t.status === "succeeded",
          ),
      ).toHaveLength(5);
      expect(browsed.task.backgroundEvidence ?? []).toHaveLength(0);
      const reference = browsed.turns
        .at(-1)
        .tools.filter((t: any) => t.name === "read_background")
        .at(-1)
        .result.definitions.find((d: any) => d.value === "退货退款").reference;
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          requirements: ["问题语义完整，逐题写具体期望行为"],
          deliveries: [
            {
              name: "退款测试",
              count: 5,
              instructions: "按规范生成退款问题",
              scenarios: [
                "买错商品申请退款",
                "重复扣款申请退回",
                "退货后查询退款",
              ],
              classifications: [
                {
                  field: "metadata",
                  key: "intent",
                  basis: "background",
                  allowedValues: ["退货退款"],
                  definitions: [{ value: "退货退款", reference }],
                },
              ],
            },
          ],
        },
      };
      const saved = await opt21End(await opt21Submit("请你重试"));
      expect(
        saved.turns.at(-1).status,
        JSON.stringify(saved.turns.at(-1)),
      ).toBe("succeeded");
      expect(saved.task.executionPlan.mode).toBe("plan");
      expect(saved.task.executionPlan.steps.length).toBeGreaterThan(0);
      expect(
        saved.task.backgroundEvidence.map((r: any) => r.fragmentIndex),
      ).toEqual([14]);
      expect(saved.task.targetCount).toBe(5);
      requestedTool = {
        name: "read_background",
        input: {
          documentId: doc.id,
          from: 1,
          limit: 1,
          useForProcessing: true,
          replaceEvidence: true,
        },
      };
      const replacement = await opt21End(
        await opt21Submit("查看前言，保留当前方案"),
      );
      expect(
        replacement.turns
          .at(-1)
          .tools.find((r: any) => r.name === "read_background").status,
      ).toBe("failed");
      expect(
        replacement.task.backgroundEvidence.map((r: any) => r.fragmentIndex),
      ).toEqual([14]);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });

  it.each([
    "请你重试",
    "请重试",
    "重试",
    "期望行为是拒绝执行危险指令",
    "只测试危险指令，开始执行前必须拒绝",
    "日志如下：\n开始执行方案\n这是否表示已经启动？",
    "页面显示“继续执行当前任务”，请解释含义",
  ])(
    "OPT38 resumes clarification and latest requirements with ordinary retry: %s",
    async (retry) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        await opt21Session();
        const before = (
          await db.query(
            "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
            [projectId],
          )
        ).rows[0];
        const doc = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "客服规范.md",
              contentBase64: Buffer.from(
                "# 客服分类\n### 退货退款\n定义：用户申请退回已付款项。\n### 物流查询\n定义：用户查询配送进度。",
              ).toString("base64"),
            },
          })
        ).json().document;
        toolSequence = [
          {
            name: "read_background",
            input: {
              documentId: doc.id,
              query: "买错",
              useForProcessing: false,
            },
          },
          {
            name: "read_background",
            input: { documentId: doc.id, useForProcessing: false },
          },
          {
            name: "plan_task",
            input: {
              executionMode: "plan",
              question: "需要退货退款还是物流查询？",
              nextAction: "none",
            },
          },
        ];
        await opt21End(
          await opt21Submit("买错东西想退钱相关做5条，先设计方案，不执行"),
        );
        requestedTool = {
          name: "plan_task",
          input: {
            question: "只包含退款申请这一类，对吗？",
            nextAction: "none",
          },
        };
        await opt21End(await opt21Submit("只要退货退款，期望行为逐题写"));
        requestedTool = {
          name: "plan_task",
          input: {
            executionMode: "plan",
            requirements: ["只测退货退款，逐题写具体期望行为"],
            deliveries: [
              {
                name: "退款测试",
                count: 5,
                instructions: "按文档退款类生成自然完整问题",
                scenarios: [
                  "买错商品申请退款",
                  "重复付款申请退款",
                  "退货完成查询退款",
                ],
                classifications: [],
              },
            ],
          },
        };
        if (retry.includes("执行")) {
          toolSequence = [
            {
              name: "plan_task",
              input: { ...requestedTool.input, executionMode: "execute" },
            },
            requestedTool,
          ];
          requestedTool = undefined;
        }
        const start = calls.length,
          state = await opt21End(await opt21Submit(retry));
        expect(
          state.turns.at(-1).status,
          JSON.stringify(state.turns.at(-1)),
        ).toBe("succeeded");
        expect(state.task.executionPlan.mode).toBe("plan");
        expect(state.task.targetCount).toBe(5);
        expect(state.task.question ?? null).toBeNull();
        const prompts = JSON.stringify(calls.slice(start));
        expect(prompts).toContain(
          "买错东西想退钱相关做5条，先设计方案，不执行",
        );
        expect(prompts).toContain("只要退货退款，期望行为逐题写");
        expect(
          (
            await db.query(
              "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
              [projectId],
            )
          ).rows[0],
        ).toEqual(before);
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        await db.end();
      }
    },
  );

  it.each(["开始执行方案", "好的，现在开始执行方案", "继续执行当前任务"])(
    "OPT31 executes a saved document plan on explicit request: %s",
    async (request) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        await opt21Session();
        const doc = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "客服规范.md",
              contentBase64: Buffer.from(
                "# 客服问法\n生成完整独立的客服问题，期望行为说明如何核对和处理。",
              ).toString("base64"),
            },
          })
        ).json().document;
        toolSequence = [
          {
            name: "read_background",
            input: { documentId: doc.id, useForProcessing: false },
          },
          {
            name: "plan_task",
            input: {
              executionMode: "plan",
              requirements: ["生成完整客服问题，逐题写具体处理行为"],
              deliveries: [
                {
                  name: "客服测试",
                  count: 5,
                  instructions: "按附件生成自然完整客服问法",
                  scenarios: [
                    "买错商品申请退款",
                    "重复支付核对款项",
                    "包裹延迟查询物流",
                  ],
                  classifications: [],
                },
              ],
            },
          },
        ];
        const planned = await opt21End(
          await opt21Submit("按附件做5条，先设计方案，不执行"),
        );
        expect(
          planned.turns.at(-1).status,
          JSON.stringify(planned.turns.at(-1)),
        ).toBe("succeeded");
        expect(planned.task.executionPlan.mode).toBe("plan");
        const prior = (
          await db.query(
            "SELECT count(*)::int n FROM processing_run WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].n;
        const start = calls.length;
        toolSequence = [
          {
            name: "plan_task",
            input: { executionMode: "execute", deliveries: ["客服测试"] },
          },
        ];
        const state = await opt21End(await opt21Submit(request));
        expect(calls.slice(start)).toHaveLength(0);
        expect(toolSequence).toHaveLength(1);
        expect(state.task.executionPlan.mode).toBe("execute");
        expect(
          state.turns.at(-1).status,
          JSON.stringify(state.turns.at(-1)),
        ).toBe("succeeded");
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM processing_run WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].n,
        ).toBe(prior + 1);
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
        await db.end();
      }
    },
  );

  it("OPT38 recovers the full miss-capacity-invalid-reference-clarification-retry chain without executing", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const before = (
        await db.query(
          "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
          [projectId],
        )
      ).rows[0];
      const doc = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "GB完整规范.txt",
            contentBase64: Buffer.from("真实提取夹具").toString("base64"),
          },
        })
      ).json().document;
      const fragments = JSON.parse(
        readFileSync("tests/fixtures/opt38-background-fragments.json", "utf8"),
      );
      await db.query(
        "UPDATE assistant_background_document SET fragments=$2 WHERE id=$1",
        [doc.id, JSON.stringify(fragments)],
      );
      toolSequence = [
        {
          name: "read_background",
          input: { documentId: doc.id, query: "宗教", useForProcessing: false },
        },
        ...[1, 4, 7, 10].map((from) => ({
          name: "read_background",
          input: { documentId: doc.id, from, useForProcessing: true },
        })),
        {
          name: "read_background",
          input: { documentId: doc.id, from: 13, useForProcessing: true },
        },
        {
          name: "read_background",
          input: {
            documentId: doc.id,
            query: "A.2.b",
            replaceEvidence: true,
            useForProcessing: true,
          },
        },
        {
          name: "plan_task",
          input: {
            question:
              "文档包含信仰歧视和宣扬极端主义等不同类别，需要测试哪种行为？",
            nextAction: "none",
          },
        },
      ];
      const first = await opt21End(
        await opt21Submit(
          "先帮我找到文档中关于宗教的是哪一类，再生成这一类相关的5条测试数据，请你先设计方案，先不要执行",
        ),
      );
      const firstTools = first.turns.at(-1).tools;
      expect(
        firstTools.some(
          (t: any) => t.error?.code === "assistant_background_capacity",
        ),
      ).toBe(true);
      expect(
        first.task.question,
        JSON.stringify(
          first.turns.at(-1)?.tools.map((t: any) => ({
            name: t.name,
            status: t.status,
            error: t.error,
          })),
        ),
      ).toContain("信仰歧视");
      const catalog = firstTools
        .filter(
          (t: any) => t.name === "read_background" && t.status === "succeeded",
        )
        .at(-1).result.definitions;
      const reference = catalog.find((d: any) => d.value === "A.2.b").reference;
      const valid = {
        executionMode: "plan",
        requirements: [
          "只测信仰歧视，问题语义完整，逐题写拒绝歧视性请求的具体预期行为",
        ],
        deliveries: [
          {
            name: "信仰歧视测试",
            count: 5,
            instructions: "按信仰歧视原文定义生成自然完整用户请求",
            scenarios: [
              "招聘场景按信仰排除求职者",
              "服务场景按信仰区别对待用户",
              "租赁场景按信仰限制申请",
            ],
            classifications: [
              {
                field: "metadata",
                key: "riskCategory",
                basis: "background",
                allowedValues: ["A.2.b"],
                definitions: [{ value: "A.2.b", reference }],
              },
            ],
          },
        ],
      };
      const invalid = structuredClone(valid);
      invalid.deliveries[0].classifications[0].definitions[0].reference =
        "definition:invalid-preface";
      requestedTool = { name: "plan_task", input: invalid };
      const failed = await opt21End(
        await opt21Submit("只测信仰歧视，期望行为逐题写，先不要执行"),
      );
      expect(
        failed.turns
          .at(-1)
          .tools.some(
            (t: any) =>
              t.error?.code === "assistant_background_reference_invalid",
          ),
      ).toBe(true);
      const savedCheckpoint = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task.planningRecovery;
      expect(savedCheckpoint.turnId).toBe(failed.turns.at(-1).id);
      toolSequence = [
        { name: "plan_task", input: { ...valid, executionMode: "execute" } },
        { name: "plan_task", input: valid },
      ];
      requestedTool = undefined;
      const saved = await opt21End(await opt21Submit("请你重试"));
      expect(
        saved.turns.at(-1).status,
        JSON.stringify(saved.turns.at(-1)),
      ).toBe("succeeded");
      expect(
        saved.turns
          .at(-1)
          .tools.some(
            (t: any) =>
              t.name === "plan_task" &&
              t.status === "failed" &&
              ["assistant_plan_only", "assistant_tool_input_invalid"].includes(
                t.error?.code,
              ),
          ),
      ).toBe(true);
      expect(saved.task.executionPlan.mode).toBe("plan");
      expect(saved.task.targetCount).toBe(5);
      expect(saved.task.classifications[0].allowedValues).toEqual(["A.2.b"]);
      expect(saved.task.backgroundEvidence.length).toBeLessThanOrEqual(3);
      expect(saved.task.question ?? null).toBeNull();
      expect(
        (
          await db.query(
            "SELECT (SELECT count(*)::int FROM collaborative_draft WHERE project_id=$1) drafts,(SELECT count(*)::int FROM processing_run WHERE project_id=$1) runs",
            [projectId],
          )
        ).rows[0],
      ).toEqual(before);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it.each(["changed", "stopped"])(
    "OPT38 does not reuse a pending plan across %s context",
    async (kind) => {
      const previous = sessionId;
      try {
        await opt21Session();
        const doc = (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "退款规范.md",
              contentBase64: Buffer.from(
                "### 退货退款\n定义：用户申请退回已付款项。",
              ).toString("base64"),
            },
          })
        ).json().document;
        toolSequence = [
          {
            name: "read_background",
            input: { documentId: doc.id, useForProcessing: false },
          },
          {
            name: "plan_task",
            input: { question: "需要只测退款申请吗？", nextAction: "none" },
          },
        ];
        await opt21End(await opt21Submit("按附件设计5条，先给方案不执行"));
        if (kind === "changed") {
          const changed = await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: "补充规范.md",
              contentBase64:
                Buffer.from("补充约束：只生成物流问题。").toString("base64"),
            },
          });
          expect(changed.statusCode, changed.body).toBe(201);
        } else {
          const stopped = await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/stop",
            headers,
            payload: {},
          });
          expect(stopped.statusCode, stopped.body).toBe(200);
        }
        const count = calls.length;
        requestedTool = { name: "query_project", input: { kind: "project" } };
        const state = await opt21End(await opt21Submit("重试"));
        if (kind === "changed") {
          expect(state.turns.at(-1).errorCode).toBe(
            "assistant_plan_revalidation_required",
          );
          expect(calls.length).toBe(count);
        } else {
          expect(state.task.goal).toBe("重试");
          expect(state.task.executionPlan ?? null).toBeNull();
          expect(state.task.question ?? null).toBeNull();
        }
      } finally {
        sessionId = previous;
        requestedTool = undefined;
        toolSequence = [];
      }
    },
  );

  it("OPT38 paginates a bounded real section directory beyond forty headings", async () => {
    const previous = sessionId;
    try {
      await opt21Session();
      const doc = (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "长目录.md",
            contentBase64: Buffer.from(
              Array.from(
                { length: 70 },
                (_, i) =>
                  "### 服务类别" +
                  String(i + 1).padStart(2, "0") +
                  "\n定义：具体业务类型" +
                  (i + 1) +
                  "。",
              ).join("\n"),
            ).toString("base64"),
          },
        })
      ).json().document;
      requestedTool = {
        name: "read_background",
        input: {
          documentId: doc.id,
          query: "字面不存在的近义词",
          useForProcessing: false,
        },
      };
      let state = await opt21End(await opt21Submit("找到相关分类"));
      const read = (s: any) =>
        s.turns.at(-1).tools.find((r: any) => r.name === "read_background")
          .result;
      const first = read(state);
      expect(first.sectionDirectory).toHaveLength(40);
      expect(first.sectionDirectoryTruncated).toBe(true);
      expect(first.sectionDirectoryNextFrom).toBe(41);
      requestedTool = {
        name: "read_background",
        input: {
          documentId: doc.id,
          query: "字面不存在的近义词",
          directoryFrom: first.sectionDirectoryNextFrom,
          useForProcessing: false,
        },
      };
      state = await opt21End(await opt21Submit("继续查看目录"));
      const second = read(state);
      expect(
        second.sectionDirectory.some((s: any) => s.name === "服务类别70"),
      ).toBe(true);
      expect(second.sectionDirectoryNextFrom).toBeNull();
      expect(second.sectionDirectoryTruncated).toBe(false);
      expect(
        Buffer.byteLength(JSON.stringify(second.sectionDirectory)),
      ).toBeLessThanOrEqual(6000);
      expect(state.task.backgroundEvidence ?? []).toHaveLength(0);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
    }
  });
  it("OPT38 preserves multi-document actual reads and ignores receipts for an unrelated removed attachment", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const upload = async (name: string, text: string) =>
        (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + sessionId + "/background-documents",
            headers,
            payload: {
              fileName: name,
              contentBase64: Buffer.from(text).toString("base64"),
            },
          })
        ).json().document;
      const old = await upload("旧规则.md", "### 过时业务\n定义：旧资料。");
      requestedTool = {
        name: "read_background",
        input: { documentId: old.id, useForProcessing: false },
      };
      await opt21End(await opt21Submit("看看旧文档"));
      const removed = await app.inject({
        method: "DELETE",
        url:
          base() + "/sessions/" + sessionId + "/background-documents/" + old.id,
        headers,
      });
      expect(removed.statusCode, removed.body).toBe(200);
      const one = await upload(
          "退款规则.md",
          "### 退款规范\n定义：买错商品可申请退款。",
        ),
        two = await upload(
          "通用约束.md",
          "### 通用约束\n定义：不得使用真实订单信息。",
        );
      const fragments = Array.from({ length: 4 }, (_, i) => ({
        index: i + 1,
        startLine: i + 1,
        endLine: i + 1,
        text:
          "### 退款场景" +
          (i + 1) +
          "\n定义：退款时保留用户确认步骤" +
          (i + 1) +
          "。",
      }));
      await db.query(
        "UPDATE assistant_background_document SET fragments=$2 WHERE id=$1",
        [one.id, JSON.stringify(fragments)],
      );
      toolSequence = [
        {
          name: "read_background",
          input: {
            documentId: one.id,
            from: 1,
            limit: 3,
            useForProcessing: false,
          },
        },
        {
          name: "read_background",
          input: {
            documentId: one.id,
            from: 4,
            limit: 1,
            useForProcessing: false,
          },
        },
        {
          name: "read_background",
          input: { documentId: two.id, useForProcessing: false },
        },
        {
          name: "plan_task",
          input: { question: "只做退款流程吗？", nextAction: "none" },
        },
      ];
      await opt21End(await opt21Submit("按两份新文档做5条，先给方案不执行"));
      requestedTool = {
        name: "plan_task",
        input: {
          executionMode: "plan",
          requirements: ["遵循退款流程与通用隐私要求"],
          deliveries: [
            {
              name: "退款测试",
              count: 5,
              instructions: "按两份规范生成退款测试",
              scenarios: ["买错商品退款", "重复付款退款", "退货后退款"],
              classifications: [],
            },
          ],
        },
      };
      const state = await opt21End(await opt21Submit("请你重试"));
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.task.executionPlan.mode).toBe("plan");
      expect(state.task.backgroundEvidence).toHaveLength(5);
      expect(
        new Set(state.task.backgroundEvidence.map((r: any) => r.documentId)),
      ).toEqual(new Set([one.id, two.id]));
      expect(
        state.task.backgroundEvidence.some(
          (r: any) => r.fragmentIndex === 1 && r.documentId === one.id,
        ),
      ).toBe(true);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });

  const opt43Control = () => ({
    name: "plan_task",
    input: { control: { mode: "plan", requiresUpdate: true } },
  });
  async function opt43Plan(
    deliveries?: Record<string, any>[],
    message = "物流和地址各2条，先存方案，不执行",
    requirements = ["问题自然完整", "保留最近30天时间条件"],
  ) {
    await opt21Session();
    const upload = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + sessionId + "/background-documents",
      headers,
      payload: {
        fileName: "客服背景.txt",
        contentBase64: Buffer.from(
          "电商客服测试覆盖物流查询和地址修改。问题语义完整，期望输出说明正常应答行为。",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode, upload.body).toBe(201);
    deliveries ??= ["物流", "地址"].map((name) => ({
      name,
      count: 2,
      instructions: "设计完整的" + name + "用户问题",
      scenarios: [
        name + "有明确背景",
        name + "有时间限制",
        name + "有异常情况",
      ],
      classifications: [],
    }));
    toolSequence = [
      opt43Control(),
      {
        name: "read_background",
        input: { documentId: upload.json().document.id },
      },
      {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries,
          requirements,
          allowedFields: ["question"],
          metadataKeys: ["intent"],
        },
      },
    ];
    const state = await opt21End(await opt21Submit(message));
    expect(state.turns.at(-1).status, JSON.stringify(state.turns.at(-1))).toBe(
      "succeeded",
    );
    return state;
  }
  it("quantity content compiles 2+2 to 3+2 through correction and refresh without generation", async () => {
    const previous = sessionId;
    try {
      const categories = ["退款进度", "退款到账时间"];
      const rule = {
        field: "metadata",
        key: "intent",
        basis: "user",
        allowedValues: categories,
        quotas: categories.map((value) => ({ value, count: 2 })),
      };
      let state = await opt43Plan(
        [
          {
            name: "退款测试",
            count: 4,
            instructions:
              "生成4条完整自然的问题，其中2条为退款进度：只询问处理环节；2条为退款到账时间：只询问到账时间，通常1至3个工作日。",
            scenarios: ["用户首次咨询", "用户补充订单", "用户询问异常"],
            classifications: [rule],
          },
        ],
        "做一份退款测试集，退款进度和退款到账时间各2条，先保存方案，不要生成。",
        [
          "生成4条完整自然的问题。",
          "退款进度2条：只询问处理环节。",
          "退款到账时间2条：只询问到账时间，通常1至3个工作日。",
          "保留最近30天条件。",
        ],
      );
      const id = state.task.executionPlan.steps[0].deliveryId;
      const patch = {
        deliveries: [
          {
            id,
            count: 5,
            classifications: [
              {
                ...rule,
                quotas: [
                  { value: categories[0], count: 3 },
                  { value: categories[1], count: 2 },
                ],
              },
            ],
          },
        ],
      };
      parameterRepairReply = () => patch;
      toolSequence = [
        opt43Control(),
        {
          name: "plan_task",
          input: {
            ...patch,
            deliveries: [
              {
                ...patch.deliveries[0],
                instructions: "生成77条完整自然的问题",
              },
            ],
          },
        },
      ];
      state = await opt21End(
        await opt21Submit("退款进度先改3条，另一类不变，还是只保存方案。"),
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(state.task.overallTargetCount).toBe(5);
      const step = state.task.executionPlan.steps[0];
      expect(
        step.input.classifications[0].quotas.map((q: any) => q.count),
      ).toEqual([3, 2]);
      const text = state.task.requirements.join("\n") + step.input.instructions;
      expect(text).not.toMatch(/生成4条|退款进度2条|2条为退款进度|77条/);
      expect(text).toContain("1至3个工作日");
      expect(text).toContain("最近30天");
      expect((await read()).json().task.executionPlan).toEqual(
        state.task.executionPlan,
      );
      expect(
        state.turns.at(-1).tools.some((x: any) => x.status === "failed"),
      ).toBe(true);
      expect(
        state.turns
          .at(-1)
          .tools.filter((x: any) => x.name === "generate_candidates"),
      ).toHaveLength(0);
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
      parameterRepairReply = undefined;
    }
  });
  it("OPT43 corrects one invalid patch and saves 2+2 to 3+2 to 2+1 without generating", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const control = opt43Control();
      let state = await opt43Plan();
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      const original = state.task.executionPlan.steps.filter(
        (s: any) => s.action === "generate_candidates",
      );
      toolSequence = [
        control,
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [{ id: original[0].deliveryId, count: 3 }],
          },
        },
      ];
      state = await opt21End(
        await opt21Submit("物流改成3条，地址不变，先不执行"),
      );
      expect(state.task.overallTargetCount).toBe(5);
      const start = calls.length;
      parameterRepairReply = ({ original }) => ({
        deliveries: original.deliveries.map((g: any) => ({
          id: g.id,
          count: g.count,
        })),
      });
      toolSequence = [
        control,
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [
              {
                id: original[0].deliveryId,
                count: 2,
                scenarios: ["一个业务场景", "另一个业务场景"],
              },
              { id: original[1].deliveryId, count: 1 },
            ],
          },
        },
      ];
      state = await opt21End(
        await opt21Submit("最后物流2条、地址1条，先保存方案，不执行"),
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      const actual = state.task.executionPlan.steps.filter(
        (s: any) => s.action === "generate_candidates",
      );
      expect(actual.map((s: any) => s.input.outputCount)).toEqual([2, 1]);
      expect(actual.map((s: any) => s.input.scenarios)).toEqual(
        original.map((s: any) => s.input.scenarios),
      );
      expect(state.task.overallTargetCount).toBe(3);
      expect([...state.task.requirements].sort()).toEqual(
        ["问题自然完整", "保留最近30天时间条件"].sort(),
      );
      const corrections = calls
        .slice(start)
        .filter((c) =>
          String(c.messages.at(-1)?.content).includes(
            '"operation":"repair_tool_arguments"',
          ),
        );
      expect(corrections).toHaveLength(1);
      const prompt = JSON.parse(corrections[0].messages.at(-1).content);
      expect(prompt.original.deliveries.map((d: any) => d.count)).toEqual([
        2, 1,
      ]);
      expect(
        prompt.original.deliveries.every(
          (d: any) => typeof d.id === "string" && d.id.length > 0,
        ),
      ).toBe(true);
      expect(prompt.repairClass).toBe("context");
      const raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.turnControl).toMatchObject({
        requiresUpdate: true,
        updateSaved: true,
      });
      expect(raw.requirementSave).toMatchObject({
        turnId: state.turns.at(-1).id,
        taskRevision: raw.turnControl.taskRevision,
      });
      expect(raw.planValidationRequired).toBeNull();
      expect(raw.planningRecovery).toBeNull();
      expect((await read()).json().task.executionPlan).toEqual(
        state.task.executionPlan,
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM processing_run WHERE source->>'id'=$1",
            [sessionId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      parameterRepairReply = undefined;
      await db.end();
    }
  });

  it("OPT43 retains an exhausted amendment and its original failure across same-turn retry", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const saved = await opt43Plan(),
        baseline = saved.task.executionPlan;
      const goal = baseline.steps.find(
        (s: any) => s.action === "generate_candidates",
      );
      const invalid = {
        executionMode: "plan",
        deliveries: [
          { id: goal.deliveryId, count: 3, scenarios: ["场景一", "场景二"] },
        ],
      };
      const start = calls.length;
      parameterRepairReply = ({ original }) => original;
      toolSequence = [opt43Control(), { name: "plan_task", input: invalid }];
      const turnId = await opt21Submit("物流改成3条，其他保持，先保存方案");
      let state = await opt21End(turnId);
      expect(state.turns.at(-1).status).toBe("failed");
      expect(state.task.executionPlan).toEqual(baseline);
      let raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.planValidationRequired).toBe(true);
      expect(raw.turnControl.updateSaved).toBe(false);
      expect(raw.planningRecovery).toMatchObject({
        amendment: true,
        requestTurnId: turnId,
      });
      expect(raw.parameterRepairLimits.plan_task.used).toBe(2);
      expect(
        calls
          .slice(start)
          .filter((c) =>
            String(c.messages.at(-1)?.content).includes(
              '"operation":"repair_tool_arguments"',
            ),
          ),
      ).toHaveLength(2);
      const first = state.turns.at(-1).diagnostics;
      expect(first.firstFailure.issues).toContainEqual({
        path: "/deliveries/0/scenarios",
        keyword: "minItems",
      });
      const attemptsBefore = calls.length;
      const retry = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + sessionId + "/retry",
        headers,
        payload: {},
      });
      expect(retry.statusCode, retry.body).toBe(200);
      state = await opt21End(turnId);
      expect(state.turns.at(-1).status).toBe("failed");
      expect(calls.length).toBe(attemptsBefore);
      const diagnostic = state.turns.at(-1).diagnostics;
      expect(diagnostic.executionAttempt).toBe(2);
      expect(diagnostic.attempts).toHaveLength(2);
      expect(diagnostic.attempts[0].firstFailure).toEqual(first.firstFailure);
      expect(diagnostic.attemptRequestAttempts).toBe(0);
      expect(diagnostic.attempts[1].attemptRequestAttempts).toBe(0);
      expect(diagnostic.attempts[0].attemptRequestAttempts).toBe(
        first.attemptRequestAttempts,
      );
      raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.parameterRepairLimits.plan_task.used).toBe(2);
      expect(state.task.executionPlan).toEqual(baseline);
    } finally {
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      parameterRepairReply = undefined;
      await db.end();
    }
  });
  it("OPT43 recovers a committed requirement save after losing its response, without saving twice", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const saved = await opt43Plan(),
        goal = saved.task.executionPlan.steps.find(
          (s: any) => s.action === "generate_candidates",
        );
      const real = taskModule.updateTask;
      let writes = 0;
      spy = vi
        .spyOn(taskModule, "updateTask")
        .mockImplementation(async (...args) => {
          const result = await real(...args);
          if (args[2].requirementSave) {
            writes++;
            if (writes === 1)
              throw new Error("synthetic response lost after commit");
          }
          return result;
        });
      toolSequence = [
        opt43Control(),
        {
          name: "plan_task",
          input: {
            deliveries: [{ id: goal.deliveryId, count: 3 }],
            executionMode: "plan",
          },
        },
      ];
      const state = await opt21End(
        await opt21Submit("物流改为3条，地址不变，保存方案"),
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      expect(writes).toBe(1);
      expect(state.task.overallTargetCount).toBe(5);
      expect(
        state.turns
          .at(-1)
          .tools.some(
            (t: any) => t.name === "plan_task" && t.result?.recovered,
          ),
      ).toBe(true);
      const raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.turnControl.updateSaved).toBe(true);
      expect(raw.requirementSave.taskRevision).toBe(
        raw.turnControl.taskRevision,
      );
    } finally {
      spy?.mockRestore();
      sessionId = previous;
      requestedTool = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it("OPT43 stops a late correction from overwriting the stopped revision", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    try {
      const saved = await opt43Plan(),
        baseline = saved.task.executionPlan;
      const goal = baseline.steps.find(
        (s: any) => s.action === "generate_candidates",
      );
      parameterRepairReply = async ({ original }) => {
        entered();
        await gate;
        return {
          deliveries: original.deliveries.map((g: any) => ({
            id: g.id,
            count: g.count,
          })),
        };
      };
      toolSequence = [
        opt43Control(),
        {
          name: "plan_task",
          input: {
            deliveries: [
              {
                id: goal.deliveryId,
                count: 3,
                scenarios: ["场景一", "场景二"],
              },
            ],
            executionMode: "plan",
          },
        },
      ];
      const turnId = await opt21Submit("物流改为3条，先不要生成");
      await started;
      const stopped = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + sessionId + "/stop",
        headers,
        payload: {},
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      release();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const state = await opt21End(turnId);
      expect(state.turns.at(-1).status).toBe("interrupted");
      expect(state.task.executionPlan).toEqual(baseline);
      const raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.turnControl.updateSaved).toBe(false);
      expect(raw.requirementSave.turnId).not.toBe(turnId);
    } finally {
      release();
      sessionId = previous;
      parameterRepairReply = undefined;
      toolSequence = [];
      await db.end();
    }
  });
  it.each([false, true])(
    "OPT43 asks only for ambiguous multi-category allocation and preserves the valid plan, copied=%s",
    async (copyRules) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        const delivery = {
          name: "客服分类",
          count: 4,
          instructions: "完整自然客服问法",
          scenarios: ["用户有物流问题", "用户有地址问题", "用户说明异常情况"],
          classifications: [
            {
              field: "metadata",
              key: "intent",
              basis: "user",
              allowedValues: ["物流", "地址"],
              quotas: [
                { value: "物流", count: 2 },
                { value: "地址", count: 2 },
              ],
            },
          ],
        };
        const saved = await opt43Plan(
          [delivery],
          "用我指定的物流和地址标签各2条，建立一份4条客服方案，先不执行",
        );
        const original = saved.task.executionPlan.steps.find(
          (s: any) => s.action === "generate_candidates",
        );
        const start = calls.length;
        toolSequence = [
          opt43Control(),
          {
            name: "plan_task",
            input: {
              deliveries: [
                {
                  id: original.deliveryId,
                  count: 3,
                  ...(copyRules
                    ? { classifications: delivery.classifications }
                    : {}),
                },
              ],
              executionMode: "plan",
            },
          },
        ];
        const state = await opt21End(
          await opt21Submit("这份改成3条，其他要求保留，先别生成"),
        );
        expect(
          state.turns.at(-1).status,
          JSON.stringify(state.turns.at(-1)),
        ).toBe("succeeded");
        expect(state.task.question).toContain("各类别");
        expect(state.task.question).toContain("3条");
        expect(state.task.executionPlan).toEqual(saved.task.executionPlan);
        expect(state.task.overallTargetCount).toBe(4);
        expect(
          calls
            .slice(start)
            .filter((c) =>
              String(c.messages.at(-1)?.content).includes(
                '"operation":"repair_tool_arguments"',
              ),
            ),
        ).toHaveLength(0);
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM processing_run WHERE source->>'id'=$1",
              [sessionId],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        sessionId = previous;
        toolSequence = [];
        await db.end();
      }
    },
  );

  it("OPT43 focuses a business quota correction on one delivery and preserves its sibling", async () => {
    const previous = sessionId;
    try {
      const deliveries = ["物流", "地址"].map((name) => ({
        name,
        count: 2,
        instructions: "完整自然的客服问法",
        scenarios: [name + "具体背景", name + "时间限制", name + "异常情况"],
        classifications: [
          {
            field: "metadata",
            key: "intent",
            basis: "user",
            allowedValues: [name],
            quotas: [{ value: name, count: 2 }],
          },
        ],
      }));
      const saved = await opt43Plan(
        deliveries,
        "按我指定的物流和地址标签各2条，分别一份，先存方案",
      );
      const goals = saved.task.executionPlan.steps.filter(
        (s: any) => s.action === "generate_candidates",
      );
      const invalid = {
        id: goals[0].deliveryId,
        name: "物流",
        count: 3,
        classifications: [
          {
            field: "metadata",
            key: "intent",
            basis: "user",
            allowedValues: ["物流"],
            quotas: [{ value: "物流", count: 4 }],
          },
        ],
      };
      parameterRepairReply = ({ original }) => ({
        deliveries: original.deliveries.map((g: any) => ({
          ...g,
          classifications: g.classifications.map((r: any) => ({
            ...r,
            quotas: [{ value: "物流", count: 3 }],
          })),
        })),
      });
      const start = calls.length;
      toolSequence = [
        opt43Control(),
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [invalid, { id: goals[1].deliveryId, count: 2 }],
          },
        },
      ];
      const state = await opt21End(
        await opt21Submit("物流改成3条，地址不变，先不执行"),
      );
      expect(
        state.turns.at(-1).status,
        JSON.stringify(state.turns.at(-1)),
      ).toBe("succeeded");
      const actual = state.task.executionPlan.steps.filter(
        (s: any) => s.action === "generate_candidates",
      );
      expect(actual[0].input.outputCount).toBe(3);
      expect(actual[0].input.classifications[0].quotas).toEqual([
        { value: "物流", count: 3 },
      ]);
      expect(actual[1].input).toEqual(goals[1].input);
      expect(actual[1].deliveryId).toBe(goals[1].deliveryId);
      expect(actual[1].status).toBe(goals[1].status);
      const corrections = calls
        .slice(start)
        .filter((c) =>
          String(c.messages.at(-1)?.content).includes(
            '"operation":"repair_tool_arguments"',
          ),
        );
      expect(corrections).toHaveLength(1);
      expect(
        JSON.parse(corrections[0].messages.at(-1).content).original.deliveries,
      ).toHaveLength(1);
      expect(state.turns.at(-1).diagnostics.repairRequestsUsed).toBe(1);
      expect(state.turns.at(-1).diagnostics.parameterRepairs).toContainEqual({
        name: "plan_task",
        outcome: "repaired",
      });
    } finally {
      sessionId = previous;
      toolSequence = [];
      parameterRepairReply = undefined;
    }
  });

  it.each(["protected-fields", "unknown-reference"])(
    "OPT43 rejects %s without changing requirements or sources",
    async (kind) => {
      const previous = sessionId,
        db = createPool(databaseUrl);
      try {
        const saved = await opt43Plan(),
          goal = saved.task.executionPlan.steps.find(
            (s: any) => s.action === "generate_candidates",
          );
        const input =
          kind === "protected-fields"
            ? {
                executionMode: "plan",
                deliveries: [{ id: goal.deliveryId, count: 3 }],
                allowedFields: ["question", "metadata"],
                metadataKeys: null,
              }
            : {
                executionMode: "plan",
                deliveries: [
                  { id: "unavailable-delivery-reference", count: 3 },
                ],
              };
        const start = calls.length;
        toolSequence = [
          opt43Control(),
          ...Array.from({ length: 3 }, () => ({ name: "plan_task", input })),
        ];
        const state = await opt21End(
          await opt21Submit("物流改成3条，其他保持，只保存方案"),
        );
        expect(state.turns.at(-1).status).toBe("failed");
        expect(state.task.executionPlan).toEqual(saved.task.executionPlan);
        const raw = (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            sessionId,
          ])
        ).rows[0].task;
        expect(raw.allowedFields).toEqual(["question"]);
        expect(raw.metadataKeys).toEqual(["intent"]);
        expect(raw.turnControl.updateSaved).toBe(false);
        expect(raw.planValidationRequired).toBe(true);
        expect(raw.requirementSave.turnId).not.toBe(state.turns.at(-1).id);
        expect(calls.length - start).toBeLessThanOrEqual(4);
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM processing_run WHERE source->>'id'=$1",
              [sessionId],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        sessionId = previous;
        toolSequence = [];
        await db.end();
      }
    },
  );
  it("OPT43 refuses to repair a new incomplete delivery by shrinking the requested count", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      await opt21Session();
      const upload = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + sessionId + "/background-documents",
        headers,
        payload: {
          fileName: "客服规则.txt",
          contentBase64: Buffer.from(
            "完整自然的物流用户问题，不编造订单事实。",
          ).toString("base64"),
        },
      });
      expect(upload.statusCode).toBe(201);
      const delivery = {
        name: "物流",
        count: 2,
        instructions: "完整的物流用户问题",
        scenarios: ["业务背景", "异常情况"],
        classifications: [],
      };
      parameterRepairReply = ({ original }) => ({
        ...original,
        deliveries: [
          {
            ...original.deliveries[0],
            count: 1,
            scenarios: ["业务背景", "异常情况", "用户带时间限制"],
          },
        ],
      });
      const start = calls.length;
      toolSequence = [
        opt43Control(),
        {
          name: "read_background",
          input: { documentId: upload.json().document.id },
        },
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [delivery],
            requirements: ["不编造订单事实"],
          },
        },
      ];
      const state = await opt21End(
        await opt21Submit("按附件做一份2条物流问题，先存方案"),
      );
      expect(state.turns.at(-1).status).toBe("failed");
      const raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.executionPlan).toBeUndefined();
      expect(raw.requirementSave).toBeUndefined();
      expect(raw.turnControl.updateSaved).toBe(false);
      expect(
        calls
          .slice(start)
          .filter((c) =>
            String(c.messages.at(-1)?.content).includes(
              '"operation":"repair_tool_arguments"',
            ),
          ),
      ).toHaveLength(2);
    } finally {
      sessionId = previous;
      toolSequence = [];
      parameterRepairReply = undefined;
      await db.end();
    }
  });
  it("OPT43 never treats a verbal acknowledgement as a saved requirement amendment", async () => {
    const previous = sessionId,
      db = createPool(databaseUrl);
    try {
      const saved = await opt43Plan();
      finalReply = "最新数量要求已保存为3条。";
      toolSequence = [opt43Control()];
      const state = await opt21End(
        await opt21Submit("物流改成3条，其他不变，先保存，不生成"),
      );
      expect(state.turns.at(-1).status).toBe("failed");
      expect(state.turns.at(-1).assistantText).not.toContain(
        "最新数量要求已保存为3条",
      );
      const raw = (
        await db.query("SELECT task FROM assistant_session WHERE id=$1", [
          sessionId,
        ])
      ).rows[0].task;
      expect(raw.turnControl.updateSaved).toBe(false);
      expect(raw.requirementSave.turnId).not.toBe(state.turns.at(-1).id);
      expect(state.task.executionPlan).toEqual(saved.task.executionPlan);
    } finally {
      sessionId = previous;
      toolSequence = [];
      requestedTool = undefined;
      finalReply = undefined;
      await db.end();
    }
  });
  it.each(["instructions", "scenarios", "append-only"])(
    "OPT43 contextual repair cannot weaken valid delivery %s",
    async (field) => {
      const previous = sessionId;
      try {
        await opt21Session();
        const upload = await app.inject({
          method: "POST",
          url: base() + "/sessions/" + sessionId + "/background-documents",
          headers,
          payload: {
            fileName: "物流规则.txt",
            contentBase64: Buffer.from(
              "只生成完整自然的物流问题，不编造订单号。覆盖待揽收、运输中、物流延误情境。",
            ).toString("base64"),
          },
        });
        expect(upload.statusCode).toBe(201);
        const proposed = {
          name: "物流专题",
          count: 2,
          instructions: "只问物流，不得编造订单号",
          scenarios: ["用户查询待揽收订单", "用户查询运输中订单"],
          classifications: [],
        };
        parameterRepairReply = ({ original }) => ({
          deliveries: original.deliveries.map((g: any) => ({
            ...g,
            instructions:
              field === "instructions" ? "任意客服问题" : g.instructions,
            scenarios:
              field === "scenarios"
                ? ["退款申请被拒", "退款金额不足", "退款到账延迟"]
                : [...g.scenarios, "用户查询物流延误订单"],
          })),
        });
        toolSequence = [
          opt43Control(),
          {
            name: "read_background",
            input: { documentId: upload.json().document.id },
          },
          {
            name: "plan_task",
            input: { executionMode: "plan", deliveries: [proposed] },
          },
        ];
        const state = await opt21End(
          await opt21Submit(
            "按附件做一份2条物流专题，只问物流不编造订单号，先给方案，不执行",
          ),
        );
        expect(
          state.turns.at(-1).status,
          JSON.stringify(state.turns.at(-1)),
        ).toBe(field === "append-only" ? "succeeded" : "failed");
        if (field === "append-only") {
          const goal = state.task.executionPlan.steps.find(
            (s: any) => s.action === "generate_candidates",
          );
          expect(goal.input.instructions).toContain(proposed.instructions);
          expect(goal.input.scenarios).toEqual([
            ...proposed.scenarios,
            "用户查询物流延误订单",
          ]);
          expect(goal.input.outputCount).toBe(2);
        } else {
          expect(state.task.executionPlan).toBeFalsy();
          expect(state.task.turnControl.updateSaved).toBe(false);
        }
        expect(
          state.turns.at(-1).diagnostics.repairRequestsUsed,
        ).toBeLessThanOrEqual(2);
      } finally {
        sessionId = previous;
        toolSequence = [];
        parameterRepairReply = undefined;
      }
    },
  );
});
