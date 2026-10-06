import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as contextModule from "../../src/assistant/context.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { canonicalJson, sha256 } from "../../src/package/contract.js";
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
  let toolSequence: { name: string; input: Record<string, unknown> }[] = [];
  let backgroundCheckpoint:
    | Record<string, unknown>
    | Record<string, unknown>[]
    | undefined;
  let repeatRead: boolean | "progress" | "bounded" = false;
  let textualToolCall: string | undefined;
  let textualReplies: string[] = [];
  let finalReply: string | undefined;
  let textualToolCallAfterScopeError = false;
  let hold = false,
    release: () => void = () => undefined,
    entered: () => void = () => undefined;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push(body);
    if (!body.tools) {
      let processing;
      try {
        processing = JSON.parse(body.messages.at(-1)?.content ?? "");
      } catch {
        /* Other protocol requests keep their existing fixture response. */
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
                          processing.instructions === "新增第二个具体问题" ||
                          row.question === "另一个背景约束下的具体场景问题"
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
    const checkpointRequested =
      backgroundCheckpoint && body.tool_choice?.function?.name === "plan_task";
    const scriptedTool = checkpointRequested
      ? {
          name: "plan_task",
          input: Array.isArray(backgroundCheckpoint)
            ? backgroundCheckpoint.shift()!
            : backgroundCheckpoint!,
        }
      : body.tool_choice === "none"
        ? undefined
        : toolSequence.shift();
    if (checkpointRequested) {
      if (!Array.isArray(backgroundCheckpoint) || !backgroundCheckpoint.length)
        backgroundCheckpoint = undefined;
      toolSequence = [];
    }
    if (
      scriptedTool ||
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
        scriptedTool?.input ??
        (inspectRun
          ? {
              runId: JSON.parse(
                body.messages
                  .findLast((m: any) =>
                    String(m.content).startsWith("持久任务（"),
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
      requestedTool = undefined;
      message = {
        role: "assistant",
        content: repeatRead === "progress" ? "继续统计，请稍候。" : null,
        tool_calls: [
          {
            id: `call_${calls.length}`,
            type: "function",
            function: { name: action, arguments: JSON.stringify(args) },
          },
        ],
      };
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
      .toBe(expectedStatus);
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
      calls[0].tools.some((t: any) => t.function.name === "create_draft"),
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
      expect((await read()).statusCode).toBe(404);
      const list = await app.inject({
        method: "GET",
        url: `${base()}/sessions`,
        headers,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(
        list.json().sessions.some((item: any) => item.id === originalSession),
      ).toBe(false);
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
    const created = state.turns[0].tools[0].result.draftId;
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
        if (!index) firstId = state.turns[0].tools[0].result.draftId;
      }
      requestedTool = {
        name: "create_draft",
        input: { name: "摘要边界草稿 0" },
      };
      const state = (await send("继续摘要边界草稿 0")).json();
      expect(state.turns.at(-1).tools[0].result).toMatchObject({
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
        (await send("查询当前草稿数量")).json().turns.at(-1).tools[0].result
          .items[0].recordCount,
      ).toBe(0);
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: current.pageObject.ref } },
      };
      expect(
        (await send("继续读取当前记录")).json().turns.at(-1).tools[0],
      ).toMatchObject({ status: "succeeded", result: { total: 0 } });
      requestedTool = {
        name: "read_records",
        input: { source: { kind: "draft", id: "d:unknown" } },
      };
      expect(
        (await send("未知引用应可恢复")).json().turns.at(-1).tools[0].error
          .code,
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
      requestedTool = { name, input };
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
        "assistant_source_invalid",
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
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId: submitted.runId,
          allValid: true,
          target: { kind: "newDraft" },
        },
      };
      const invalid = (await send("将结果加入新草稿")).json();
      expect(invalid.turns.at(-1).tools[0].status).toBe("failed");
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
  it("rejects impossible complete quotas before saving and corrects them in the same turn", async () => {
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
      expect(state.task.classifications[0].quotas).toEqual([
        { value: "风险", count: 155 },
        { value: "正常", count: 45 },
      ]);
      expect(state.task.stage).toBe("planning");
      expect(state.task.runId).toBeUndefined();
      expect(state.proposals).toEqual([]);
    } finally {
      toolSequence = [];
      sessionId = previous;
    }
  });
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
        expect(state.task.classifications).toEqual(corrected);
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
        "省略classifications会沿用旧配额",
      );
      expect(JSON.parse(correctionFeedback.content).error.hint).toContain(
        "重新提交classifications及修正后的quotas",
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
        expect(paused.task.executionPlan).toEqual(legacyPlan);
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
            String(message.content).startsWith("持久任务（"),
          )
          .content.split("：")
          .slice(1)
          .join("："),
      );
      expect(modelTask.requirements).toBeUndefined();
      expect(modelTask.previousRequirements).toEqual([
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
  it("continues an authorized pending step after the query budget without recreating its draft", async () => {
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
            { title: "读取资料", action: "read_records" },
          ],
        },
      },
      { name: "create_draft", input: { name: "跨轮唯一草稿" } },
      ...Array.from({ length: 10 }, (_, index) => ({
        name: "query_project",
        input: { kind: "files", search: `分类资料${index + 1}` },
      })),
      {
        name: "read_records",
        input: { source: { kind: "draft", id: source.json().draft.id } },
      },
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
        .poll(async () => (await read()).json().turns.length, {
          timeout: 15000,
        })
        .toBeGreaterThan(1);
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
      expect(state.turns[1].event).toBe("budget_yield");
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
      expect(state.turns[0].assistantText).toContain("继续");
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
      expect(stopped.task.error).toBe("assistant_no_progress");
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
      const readOnly = (await send("只查看当前方案")).json();
      expect(readOnly.turns.at(-1).tools[0].error.code).toBe(
        "assistant_plan_only",
      );
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
          "assistant_task_not_executed",
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
      expect(state.turns.at(-1).errorCode).toBe("assistant_task_not_executed");
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
        runId = (await send("按这三份来源扩充一条")).json().task.runId;
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
      requestedTool = {
        name: "request_processing_apply",
        input: {
          runId,
          allTask: true,
          allValid: true,
          target: {
            kind: "newDraft",
            name: "独立来源超限",
            purpose: "不以聚合绕过容量",
          },
        },
      };
      const state = (await send("将两批结果一起加入新草稿")).json(),
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
        { documentId: document.id, fragmentIndex: 1 },
      ]);
      requestedTool = {
        name: "plan_task",
        input: {
          title: "按规范改写",
          classifications: [
            {
              field: "metadata",
              key: "类别",
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
      expect(prompt.backgroundRule).toContain(
        "later user corrections override",
      );
      expect(prompt.background.requirements).toEqual([
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
      expect(tool.parameters.required).toContain("selection");
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
  it("bounds behavior-label previews without losing the complete task review", async () => {
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
            question: `问题${i}`,
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
      const result = state.turns
        .at(-1)
        .tools.find((t: any) => t.name === "read_processing").result;
      expect(result.review.total).toBe(13);
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
        String(m.content).startsWith("持久任务（"),
      );
      const snapshot = JSON.parse(
        taskMessage.content.split("：").slice(1).join("："),
      );
      expect(snapshot.review.labels).toHaveLength(10);
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
        { title: "按类别选取", action: "select_candidates" },
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
        const original = originals.find(
          (item) => item.question === row.result.question,
        )!;
        expect(original).toBeTruthy();
        expect(row.result.expectedOutput).toBe(original.expectedOutput);
        expect(row.result.metadata[0]).toEqual(original.metadata[0]);
      }
      expect(ready.proposals[0].summary.count).toBe(3);

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
      const refused = (await send("采用核对后的全部结果")).json();
      expect(refused.turns.at(-1).tools[0].error.code).toBe(
        "assistant_candidate_review_incomplete",
      );
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
      const outside = (await send("检查越界选择", undefined, "failed")).json();
      expect(outside.turns.at(-1).tools[0].error.code).toBe(
        "assistant_candidate_selection_changed",
      );
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
              ...steps.slice(0, 2),
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
        .toBe(4);
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
    } finally {
      requestedTool = undefined;
      toolSequence = [];
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
            requirements: ["用于意图识别", "确认发布用途后才发布"],
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
});
