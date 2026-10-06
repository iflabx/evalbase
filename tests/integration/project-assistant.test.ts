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
import { selectRecords } from "../../src/selection/index.js";

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
  let repeatRead: boolean | "progress" = false;
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
                    records: processing.records.map((row: any) => ({
                      sourceId: row.id,
                      question: "背景约束下的具体场景问题",
                      expectedOutput: row.expectedOutput,
                      metadata: row.metadata,
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
    let message: Record<string, unknown> = {
        role: "assistant",
        content: "操作结果请查看下方真实回执。",
      },
      finish = "stop";
    const automatic =
      String(body.messages.at(-1)?.content ?? "").startsWith(
        "[processing_completed]",
      ) ||
      String(body.messages.at(-1)?.content ?? "").startsWith("[confirmed]");
    const inspectRun = body.tool_choice?.function?.name === "read_processing";
    const scriptedTool = toolSequence.shift();
    if (
      scriptedTool ||
      inspectRun ||
      repeatRead ||
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
  async function send(message: string, context?: { kind: string; id: string }) {
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
      .toBe("succeeded");
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
      expect(duplicateFields.tools).toEqual([]);
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
        (await send("清洗不能增加条数")).json().turns.at(-1).tools[0].error
          .code,
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
  it.each([true, "progress"] as const)(
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
      repeatRead = repeatMode;
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
            instructions: "新增一个具体问题",
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
      const sourceRows = (
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
      const identities = sourceRows.map((row: any) => ({
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
          sourceRows.map((row: any, ordinal: number) => ({
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
            instructions: "扩充一个具体问题",
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
        const rejected = (await send("重改已采用的第一条")).json();
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
    const absent = await app.inject({
      method: "GET",
      url: `${path}?query=${encodeURIComponent("不存在的要求")}&from=1&limit=3`,
      headers,
    });
    expect(absent.statusCode).toBe(200);
    expect(absent.json().fragments).toEqual([]);
    expect(absent.json().matchCount).toBe(0);
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
      const different = (await send("清洗另一个草稿")).json();
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
      const changed = (await send("继续刚才选中的那一条")).json();
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
        .mockImplementation(async function (ref, max) {
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
});
