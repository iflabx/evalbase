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
  let repeatRead: boolean | "progress" = false;
  let hold = false,
    release: () => void = () => undefined,
    entered: () => void = () => undefined;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push(body);
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
    if (repeatRead || (body.messages.at(-1)?.role !== "tool" && !automatic)) {
      const prompt = body.messages.findLast(
        (m: any) => m.role === "user",
      ).content;
      const action =
        (repeatRead ? "query_project" : requestedTool?.name) ??
        (prompt.includes("读取版本")
          ? "read_records"
          : prompt.includes("发布")
            ? "request_publish"
            : prompt.includes("查询")
              ? "query_project"
              : "create_draft");
      const args =
        (repeatRead ? { kind: "project" } : requestedTool?.input) ??
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
      const started = (await send("开始新的清洗任务")).json();
      expect(started.task.runId).not.toBe(id);
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
});
