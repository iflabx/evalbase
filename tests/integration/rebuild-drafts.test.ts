import { chromium, expect as browserExpect } from "@playwright/test";
import * as draftModule from "../../src/drafts/operations.js";
import { draftTools } from "../../src/assistant-rebuild/draft-tools.js";

import { ArtifactRepository } from "../../src/storage/artifacts.js";

import { sendFormalCompletion } from "../support/formal-completion.js";
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

import { rebuildSchema } from "../../src/assistant-rebuild/schema.js";
vi.mock("../../src/assistant/agent.js", () => ({
  executeAssistantTurn: () => {
    throw Error("legacy_dispatch_disabled");
  },
}));
let origin = "http://127.0.0.1:4217";
const base = loadConfig(),
  databaseName = "r06_drafts_" + randomUUID().replaceAll("-", ""),
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
let outputs: any[] = [];
const omitUsage = false;
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
        name:
          name === "update_requirements" &&
          args &&
          typeof args === "object" &&
          (args as any).expectedRevision === 0 &&
          (args as any).changes?.deliveries?.some((d: any) => !d.deliveryId)
            ? "create_requirements"
            : name,
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

describe("REBUILD-06 draft/selection/version public flows", () => {
  beforeAll(async () => {
    const root = createPool(base.databaseUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    origin = "http://127.0.0.1:" + port;
    config.appOrigin = origin;
    app = await buildApp(config, {
      disableLegacyTestBootstrap: true,
      disableAssistantRuntimeDispatch: true,
    });
    await app.listen({ host: "127.0.0.1", port });
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
        await sendFormalCompletion(res, body, message, omitUsage);
      } catch (error) {
        console.error(error);
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

  it("R06 automatic HTTP dispatch creates, edits and publishes a real two-record draft with one fixed confirmation", async () => {
    const id = await fresh(),
      name = "R06自动闭环" + randomUUID(),
      draftPath = "/api/projects/" + projectId + "/collaborative-drafts/";
    const latest = async () =>
      (
        await db.query(
          "SELECT * FROM collaborative_draft WHERE project_id=$1 AND name=$2",
          [projectId, name],
        )
      ).rows[0];
    outputs = [
      call("create_draft", { name, purpose: "R06自动派发" }),
      async () =>
        call("add_draft_record", {
          draftId: (await latest()).id,
          source: { assetId, ordinal: 1 },
        }),
      async () =>
        call("add_draft_record", {
          draftId: (await latest()).id,
          source: { assetId, ordinal: 2 },
        }),
      async () => {
        const d = await latest(),
          r = (
            await db.query(
              "SELECT * FROM collaborative_draft_record WHERE draft_id=$1 ORDER BY position LIMIT 1",
              [d.id],
            )
          ).rows[0];
        return call("update_draft_record", {
          draftId: d.id,
          recordId: r.id,
          field: "question",
          value: "第一条新问法",
          expectedFieldRevision: r.question_revision,
        });
      },
      async () => {
        const d = await latest();
        return call("request_publish", { draftId: d.id, revision: d.revision });
      },
    ];
    const accepted = await submit(
      id,
      "用这份资料前2条建一个" +
        name +
        "草稿，第一条改成“第一条新问法”，然后发布",
      { context: { kind: "assets", assetIds: [assetId] } },
    );
    const worker = await buildApp(config, { disableLegacyTestBootstrap: true });
    try {
      await worker.ready();
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT status FROM assistant_runtime_execution WHERE session_id=$1",
                [id],
              )
            ).rows[0]?.status,
          { timeout: 20000 },
        )
        .toBe("confirmation");
      const d = await latest(),
        read = (await api("GET", draftPath + d.id)).json();
      expect(read.records).toHaveLength(2);
      expect(read.records[0].question).toBe("第一条新问法");
      expect(read.records[0].expectedOutput).toBe("答案1");
      const card = (await api("GET", route(id)))
        .json()
        .confirmations.find(
          (c: any) => c.action === "publish" && c.status === "pending",
        );
      expect(card.payload.revision).toBe(Number(d.revision));
      outputs = [{ role: "assistant", content: "已按服务端回执发布" }];
      const confirmed = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().receipt.versionId).toBeTruthy();
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT status FROM assistant_runtime_execution WHERE session_id=$1",
                [id],
              )
            ).rows[0].status,
          { timeout: 10000 },
        )
        .toBe("completed");
      const replay = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(replay.json().receipt.versionId).toBe(
        confirmed.json().receipt.versionId,
      );
      const versionId = confirmed.json().receipt.versionId,
        testSetId = confirmed.json().receipt.testSetId;
      const formal = await api(
        "GET",
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${versionId}/records`,
      );
      expect(formal.statusCode, formal.body).toBe(200);
      expect(formal.json().records).toHaveLength(2);
      const csv = await api(
        "GET",
        `/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${versionId}/data.csv`,
      );
      expect(csv.statusCode, csv.body).toBe(200);
      expect(csv.body).toContain("第一条新问法");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM test_set_version WHERE test_set_id=$1",
            [testSetId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await db.query("SELECT count(*)::int n FROM processing_run")).rows[0]
          .n,
      ).toBe(0);
      const view = (await api("GET", route(id))).json();
      expect(view.receipts.some((r: any) => r.versionId === versionId)).toBe(
        true,
      );
      expect(
        view.turns.find((t: any) => t.id === accepted.json().turnId).status,
      ).toBe("succeeded");
    } catch (error) {
      console.error(
        "R06_DIAGNOSTIC",
        JSON.stringify({
          task: (
            await db.query(
              "SELECT status,reason,requests,no_progress FROM assistant_runtime_execution WHERE session_id=$1",
              [id],
            )
          ).rows,
          events: (
            await db.query(
              "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind IN('tool_error','correction_rejected','execution_error','tool_result') ORDER BY id",
              [id],
            )
          ).rows,
        }),
      );
      throw error;
    } finally {
      await worker.close();
    }
  });

  async function newDraft(name = "R06边界" + randomUUID()) {
    const made = await api(
      "POST",
      "/api/projects/" + projectId + "/collaborative-drafts",
      { name, purpose: "" },
    );
    expect(made.statusCode, made.body).toBe(201);
    return made.json().draft;
  }
  const draftUrl = (id: string) =>
    "/api/projects/" + projectId + "/collaborative-drafts/" + id;
  it("R06 SDK keeps a fixed selection on paging and adopts exactly the confirmed identities once", async () => {
    const d = await newDraft(),
      id = await fresh();
    await run(id, "看看可选资料，先不要加入", [
      call("preview_selection", {
        draftId: d.id,
        assetIds: [assetId],
        method: "all",
        conditions: [],
      }),
    ]);
    const preview = (
      await db.query(
        "SELECT * FROM selection_preview WHERE draft_id=$1 ORDER BY created_at DESC LIMIT 1",
        [d.id],
      )
    ).rows[0];
    const page1 = (
        await api(
          "GET",
          draftUrl(d.id) +
            "/selection-previews/" +
            preview.id +
            "?limit=1&offset=0",
        )
      ).json(),
      page2 = (
        await api(
          "GET",
          draftUrl(d.id) +
            "/selection-previews/" +
            preview.id +
            "?limit=1&offset=1",
        )
      ).json();
    expect(page1.records[0].id).not.toBe(page2.records[0].id);
    const ids = [page1.records[0].id, page2.records[0].id];
    const state = await run(id, "就用前两条，加入草稿", [
      call("request_selection_apply", {
        draftId: d.id,
        previewId: preview.id,
        selectedIds: ids,
        expectedRevision: 0,
      }),
    ]);
    const card = state.confirmations.find(
      (c: any) => c.action === "selection" && c.status === "pending",
    );
    expect(card).toBeTruthy();
    const accepted = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().receipt.added).toBe(2);
    const repeated = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(repeated.json().receipt.added).toBe(2);
    const data = (await api("GET", draftUrl(d.id))).json();
    expect(data.records).toHaveLength(2);
    expect(data.records.map((r: any) => r.source.ordinal)).toEqual([1, 2]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM selection_preview WHERE draft_id=$1",
          [d.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const history = (
      await api("GET", draftUrl(d.id) + "/selection-history")
    ).json();
    expect(history.history).toHaveLength(1);
  });
  it("R06 shared preview rejects changed parameters, oversized file scope and rows outside the fixed candidate set", async () => {
    const d = await newDraft(),
      ids = Array.from({ length: 6 }, (_, i) => "fake" + i);
    expect(
      (
        await api("POST", draftUrl(d.id) + "/selection-previews", {
          assetIds: ids,
          method: "all",
          conditions: [],
        })
      ).statusCode,
    ).toBe(422);
    const a = (
      await api("POST", draftUrl(d.id) + "/selection-previews", {
        assetIds: [assetId],
        method: "all",
        conditions: [],
      })
    ).json().preview;
    const first = (
      await api("GET", draftUrl(d.id) + "/selection-previews/" + a.id)
    ).json().records[0].id;
    const b = (
      await api("POST", draftUrl(d.id) + "/selection-previews", {
        assetIds: [assetId],
        method: "random",
        mode: "count",
        value: 1,
        seed: "R06-new-seed",
        conditions: [],
      })
    ).json().preview;
    expect(
      (
        await api(
          "POST",
          draftUrl(d.id) + "/selection-previews/" + a.id + "/apply",
          { selectedIds: [first], expectedRevision: 0 },
        )
      ).json().error.code,
    ).toBe("selection_preview_expired");
    expect(
      (
        await api(
          "POST",
          draftUrl(d.id) + "/selection-previews/" + b.id + "/apply",
          { selectedIds: ["invented"], expectedRevision: 0 },
        )
      ).statusCode,
    ).toBe(422);
    expect((await api("GET", draftUrl(d.id))).json().records).toHaveLength(0);
  });
  it("R06 SDK propagates a page-selected input subset into the fixed preview without widening", async () => {
    const d = await newDraft(),
      id = await fresh();
    outputs = [
      call("preview_selection", {
        draftId: d.id,
        assetIds: [assetId],
        method: "all",
        conditions: [],
      }),
    ];
    const accepted = await submit(id, "只用选中的两条", {
      context: {
        kind: "assets",
        assetIds: [assetId],
        recordIds: [assetId + ":1", assetId + ":2"],
      },
    });
    await host.runPending(scope(), id, accepted.json().turnId);
    const preview = (
      await db.query(
        "SELECT candidate_ids FROM selection_preview WHERE draft_id=$1",
        [d.id],
      )
    ).rows[0];
    expect(preview.candidate_ids).toEqual([
      JSON.stringify([assetId, 1]),
      JSON.stringify([assetId, 2]),
    ]);
  });
  it("R06 SDK ends a field conflict without changing revision to overwrite the other editor; a new explicit edit preserves other fields", async () => {
    const d = await newDraft(),
      made = (
        await api("POST", draftUrl(d.id) + "/records", {
          question: "原问题",
          expectedOutput: "保持答案",
          metadata: [{ key: "类型", value: "A" }],
        })
      ).json().record;
    const other = await api(
      "PATCH",
      draftUrl(d.id) + "/records/" + made.id,
      { field: "question", value: "另一个编辑者", expectedFieldRevision: 0 },
      "editor",
    );
    expect(other.statusCode, other.body).toBe(200);
    const id = await fresh(),
      before = requests.length;
    const failed = await run(id, "问题改成我的输入", [
      call("update_draft_record", {
        draftId: d.id,
        recordId: made.id,
        field: "question",
        value: "我的输入",
        expectedFieldRevision: 0,
      }),
    ]);
    expect(failed.execution.status).toBe("failed");
    expect(failed.execution.reason).toBe("draft_conflict");
    expect(requests.length - before).toBe(1);
    const unchanged = (await api("GET", draftUrl(d.id))).json().records[0];
    expect(unchanged.question).toBe("另一个编辑者");
    expect(unchanged.expectedOutput).toBe("保持答案");
    await run(id, "我核对过了，现在确认仍用我的输入", [
      call("update_draft_record", {
        draftId: d.id,
        recordId: made.id,
        field: "question",
        value: "我的输入",
        expectedFieldRevision: unchanged.questionRevision,
      }),
    ]);
    const final = (await api("GET", draftUrl(d.id))).json().records[0];
    expect(final.question).toBe("我的输入");
    expect(final.metadata).toEqual([{ key: "类型", value: "A" }]);
    expect(final.expectedOutputRevision).toBe(0);
  });
  it("R06 fixed publication rejects an intervening edit and reconciles a lost business response into one version", async () => {
    const d = await newDraft();
    await api("POST", draftUrl(d.id) + "/records", {
      question: "发布题",
      expectedOutput: "答案",
      metadata: [],
    });
    const id = await fresh(),
      state = await run(id, "发布草稿", [
        call("request_publish", { draftId: d.id, revision: 1 }),
      ]);
    const stale = state.confirmations.find((c: any) => c.action === "publish");
    await api(
      "PATCH",
      draftUrl(d.id),
      { field: "purpose", value: "并发新用途", expectedFieldRevision: 0 },
      "editor",
    );
    const rejected = await api(
      "POST",
      route(id) + "/confirmations/" + stale.id,
      { accept: true },
    );
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(
      (
        await db.query(
          "SELECT published_version_id FROM collaborative_draft WHERE id=$1",
          [d.id],
        )
      ).rows[0].published_version_id,
    ).toBeNull();
    const clean = await fresh(),
      ready = await run(clean, "已核对最新用途，发布", [
        call("request_publish", { draftId: d.id, revision: 2 }),
      ]),
      card = ready.confirmations.find((c: any) => c.action === "publish");
    const real = draftModule.draftOperations;
    let lost = false;
    const spy = vi
      .spyOn(draftModule, "draftOperations")
      .mockImplementation((...args) => {
        const domain = real(...args);
        return {
          ...domain,
          publishDraft: async (
            ...p: Parameters<typeof domain.publishDraft>
          ) => {
            const result = await domain.publishDraft(...p);
            if (!lost) {
              lost = true;
              throw Error("R06_response_lost_after_commit");
            }
            return result;
          },
        };
      });
    try {
      const first = await api(
        "POST",
        route(clean) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(first.statusCode, first.body).toBe(200);
      expect(lost).toBe(true);
      const second = await api(
        "POST",
        route(clean) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(second.json().receipt.versionId).toBe(
        first.json().receipt.versionId,
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM test_set_version WHERE test_set_id=$1",
            [first.json().receipt.testSetId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("R06 viewer tools exclude drafts and Web prevents cross-project and published-record writes", async () => {
    const id = await fresh("viewer"),
      accepted = await submit(id, "看看版本", {}, "viewer"),
      proof = await host.store.claim(
        scope("viewer"),
        id,
        accepted.json().turnId,
      );
    const tools = draftTools(
      host.store,
      host.execution,
      proof,
      new ArtifactRepository(config.minio),
      false,
      async () => {},
    ).tools;
    expect(
      tools.some(
        (t) =>
          t.name === "read_draft" ||
          t.name === "update_draft" ||
          t.name === "request_publish",
      ),
    ).toBe(false);
    expect(tools.some((t) => t.name === "read_version_records")).toBe(true);
    const d = await newDraft();
    expect(
      (await api("GET", draftUrl(d.id), undefined, "viewer")).statusCode,
    ).toBe(404);
    expect(
      (
        await api(
          "PATCH",
          `/api/projects/${otherProject}/collaborative-drafts/${d.id}`,
          { field: "name", value: "越权", expectedFieldRevision: 0 },
        )
      ).statusCode,
    ).toBe(404);
  });
  it("R06 committed create and field writes survive lost checkpoints without repeating mutations", async () => {
    const id = await fresh(),
      accepted = await submit(id, "建草稿"),
      proof = await host.execution.claim(scope(), id, accepted.json().turnId),
      tools = draftTools(
        host.store,
        host.execution,
        proof,
        new ArtifactRepository(config.minio),
        true,
        async () => {},
      ).tools;
    const create = tools.find((t) => t.name === "create_draft")!,
      name = "checkpoint" + randomUUID(),
      a: any = await create.invoke({ name, purpose: "原用途" }),
      b: any = await create.invoke({ name, purpose: "原用途" });
    expect(a.draft.id).toBe(b.draft.id);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM collaborative_draft WHERE name=$1",
          [name],
        )
      ).rows[0].n,
    ).toBe(1);
    const edit = tools.find((t) => t.name === "update_draft")!,
      payload = {
        draftId: a.draft.id,
        field: "purpose",
        value: "新用途",
        expectedFieldRevision: 0,
      };
    await edit.invoke(payload);
    await edit.invoke(payload);
    const d = (await api("GET", draftUrl(a.draft.id))).json().draft;
    expect(d.purpose).toBe("新用途");
    expect(d.purposeRevision).toBe(1);
    await host.store.finish(proof, "已保存");
  });
  it("R06 row removal checks a fixed row revision and discarding a synthetic draft cleans its runtime reference", async () => {
    const d = await newDraft(),
      row = (
        await api("POST", draftUrl(d.id) + "/records", {
          question: "待删除",
          metadata: [],
        })
      ).json().record;
    const sid = await fresh(),
      pending = await run(sid, "移除这条", [
        call("request_remove_record", {
          draftId: d.id,
          recordId: row.id,
          expectedRowRevision: 0,
        }),
      ]),
      c = pending.confirmations.find((c: any) => c.action === "remove_record");
    await api(
      "PATCH",
      draftUrl(d.id) + "/records/" + row.id,
      { field: "question", value: "并发修改", expectedFieldRevision: 0 },
      "editor",
    );
    const stale = await api("POST", route(sid) + "/confirmations/" + c.id, {
      accept: true,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await api("GET", draftUrl(d.id))).json().records).toHaveLength(1);
    const clean = await fresh(),
      ready = await run(clean, "已核对，删除这个未发布草稿", [
        call("request_discard_draft", { draftId: d.id, revision: 2 }),
      ]),
      card = ready.confirmations.find((c: any) => c.action === "discard_draft");
    const removed = await api(
      "POST",
      route(clean) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().receipt.deleted).toBe(true);
    expect((await api("GET", draftUrl(d.id))).statusCode).toBe(404);
    expect(
      (
        await db.query(
          "SELECT invalidation_reason FROM assistant_runtime_session WHERE id=$1",
          [clean],
        )
      ).rows[0].invalidation_reason,
    ).toBeTruthy();
  });
  it("R06 a derived draft and its new version do not modify the parent or raw source", async () => {
    const d = await newDraft();
    await api("POST", draftUrl(d.id) + "/records", {
      source: { assetId, ordinal: 1 },
    });
    const pub = await api("POST", draftUrl(d.id) + "/publish", { revision: 1 });
    expect(pub.statusCode, pub.body).toBe(201);
    const { testSet, version } = pub.json();
    const parent = (
      await api(
        "GET",
        `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/records`,
      )
    ).body;
    const sid = await fresh();
    await run(sid, "从这个版本继续编辑", [
      call("create_draft", {
        testSetId: testSet.id,
        parentVersionId: version.id,
      }),
    ]);
    const child = (
      await db.query(
        "SELECT id FROM collaborative_draft WHERE parent_version_id=$1",
        [version.id],
      )
    ).rows[0];
    const read = (await api("GET", draftUrl(child.id))).json();
    expect(read.records).toHaveLength(1);
    await run(sid, "只改问题", [
      call("update_draft_record", {
        draftId: child.id,
        recordId: read.records[0].id,
        field: "question",
        value: "派生新问题",
        expectedFieldRevision: read.records[0].questionRevision,
      }),
    ]);
    const current = (await api("GET", draftUrl(child.id))).json().draft,
      ready = await run(sid, "创建新版本", [
        call("request_publish", {
          draftId: child.id,
          revision: current.revision,
        }),
      ]),
      card = ready.confirmations.find((c: any) => c.action === "publish");
    const published = await api(
      "POST",
      route(sid) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(published.statusCode, published.body).toBe(200);
    expect(
      (
        await api(
          "GET",
          `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/records`,
        )
      ).body,
    ).toBe(parent);
    expect(published.json().receipt.testSetId).toBe(testSet.id);
    expect(published.json().receipt.versionId).not.toBe(version.id);
    const original = await db.query(
      "SELECT sr.value FROM source_record sr JOIN parsed_view pv ON pv.id=sr.parsed_view_id WHERE pv.asset_id=$1 AND sr.ordinal=1",
      [assetId],
    );
    expect(original.rows[0].value.question).toBe(" 问题1 ");
  });
  async function browserPage() {
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { origin },
      }),
      cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: origin },
    ]);
    return { browser, page: await context.newPage() };
  }
  it("R06 real draft page keeps Metadata edits together and flushes a focused field before assistant navigation", async () => {
    const d = await newDraft(),
      row = (
        await api("POST", draftUrl(d.id) + "/records", {
          question: "浏览器原问题",
          expectedOutput: "原答案",
          metadata: [{ key: "原键", value: "原值" }],
        })
      ).json().record,
      { browser, page } = await browserPage();
    try {
      await page.goto(
        origin + `/projects/${projectId}/test-sets/drafts/${d.id}`,
      );
      await page
        .getByRole("cell", { name: "浏览器原问题", exact: false })
        .click();
      await browserExpect(page.locator("#draft-question")).toBeVisible();
      await page
        .getByLabel("第 1 项 Metadata 字段名", { exact: true })
        .fill("新键");
      await page.getByLabel("第 1 项 Metadata 值", { exact: true }).focus();
      expect(
        (await api("GET", draftUrl(d.id))).json().records[0].metadata,
      ).toEqual([{ key: "原键", value: "原值" }]);
      await page
        .getByLabel("第 1 项 Metadata 值", { exact: true })
        .fill("新值");
      await page.locator("#draft-question").fill("离开前的焦点输入");
      await page.getByRole("link", { name: "项目助手", exact: true }).click();
      await page.waitForURL(/\/assistant/);
      const value = (await api("GET", draftUrl(d.id)))
        .json()
        .records.find((r: any) => r.id === row.id);
      expect(value.question).toBe("离开前的焦点输入");
      expect(value.metadata).toEqual([{ key: "新键", value: "新值" }]);
      expect(value.expectedOutput).toBe("原答案");
    } finally {
      await browser.close();
    }
  }, 60000);
  it("R06 real page blocks handoff on field conflict and retains local input", async () => {
    const d = await newDraft(),
      row = (
        await api("POST", draftUrl(d.id) + "/records", {
          question: "冲突原问题",
          metadata: [],
        })
      ).json().record,
      { browser, page } = await browserPage();
    try {
      await page.goto(
        origin + `/projects/${projectId}/test-sets/drafts/${d.id}`,
      );
      await page
        .getByRole("cell", { name: "冲突原问题", exact: false })
        .click();
      await page.locator("#draft-question").fill("本地未提交输入");
      await api(
        "PATCH",
        draftUrl(d.id) + "/records/" + row.id,
        { field: "question", value: "另一用户输入", expectedFieldRevision: 0 },
        "editor",
      );
      await page.getByRole("link", { name: "项目助手", exact: true }).click();
      await browserExpect(
        page.getByRole("button", { name: "保留我的输入", exact: true }),
      ).toBeVisible();
      expect(page.url()).toContain("/test-sets/drafts/");
      await browserExpect(page.locator("#draft-question")).toHaveValue(
        "本地未提交输入",
      );
      expect(
        (await api("GET", draftUrl(d.id))).json().records[0].question,
      ).toBe("另一用户输入");
    } finally {
      await browser.close();
    }
  }, 60000);
  it("R06 draft processing handoff keeps exactly the selected rows and original draft target without starting a run", async () => {
    const d = await newDraft(),
      rows = [];
    for (let i = 0; i < 3; i++)
      rows.push(
        (
          await api("POST", draftUrl(d.id) + "/records", {
            question: "处理范围" + i,
            metadata: [],
          })
        ).json().record,
      );
    const sid = await fresh();
    await run(sid, "只处理第一条", [
      call("open_draft_processing", { draftId: d.id, recordIds: [rows[0].id] }),
    ]);
    const view = (await api("GET", route(sid))).json(),
      action = view.workspace.nativeActions.find(
        (a: any) => a.kind === "processing",
      );
    expect(action.recordIds).toEqual([rows[0].id]);
    const { browser, page } = await browserPage();
    try {
      await page.goto(origin + `/projects/${projectId}/assistant/${sid}`);
      await page
        .getByRole("button", { name: "处理草稿所选记录", exact: true })
        .click();
      await page.waitForURL(/\/processing/);
      await browserExpect(
        page.getByText("匹配 1 条 / 已选 1 条", { exact: true }),
      ).toBeVisible();
      expect(
        await page
          .getByRole("cell", { name: "处理范围1", exact: true })
          .count(),
      ).toBe(0);
      expect(
        (await db.query("SELECT count(*)::int n FROM processing_run")).rows[0]
          .n,
      ).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60000);
  it("R06 real SDK default lists and version pagination/provenance work and download registers lifecycle dependency", async () => {
    const d = await newDraft();
    await api("POST", draftUrl(d.id) + "/records", {
      source: { assetId, ordinal: 1 },
    });
    const pub = (
        await api("POST", draftUrl(d.id) + "/publish", { revision: 1 })
      ).json(),
      args = { testSetId: pub.testSet.id, versionId: pub.version.id },
      sid = await fresh();
    await run(sid, "看看测试集和正式版记录、来源，给我下载入口", [
      call("list_test_sets", {}),
      call("read_version_records", args),
      call("read_version_provenance", args),
      call("download_version", { ...args, format: "bundle" }),
    ]);
    const errors = (
      await db.query(
        "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='tool_error'",
        [sid],
      )
    ).rows;
    expect(errors).toEqual([]);
    const view = (await api("GET", route(sid))).json();
    expect(
      view.workspace.nativeActions.some(
        (a: any) =>
          a.kind === "version_download" && a.versionId === args.versionId,
      ),
    ).toBe(true);
    const onlyDownload = await fresh();
    await run(onlyDownload, "下载这个正式版本", [
      call("download_version", args),
    ]);
    expect(
      (
        await db.query(
          "SELECT resource_id FROM assistant_runtime_reference WHERE session_id=$1 AND kind='version'",
          [onlyDownload],
        )
      ).rows,
    ).toEqual([{ resource_id: args.versionId }]);
    const before = (
      await db.query(
        "SELECT requests,request_limit FROM assistant_runtime_execution WHERE session_id=$1",
        [onlyDownload],
      )
    ).rows[0];
    await db.query(
      "UPDATE test_set_version SET status='tombstoned' WHERE id=$1",
      [args.versionId],
    );
    expect(
      (
        await db.query(
          "SELECT invalidation_reason FROM assistant_runtime_session WHERE id=$1",
          [onlyDownload],
        )
      ).rows[0].invalidation_reason,
    ).toBe("source_deleted");
    expect(
      (
        await db.query(
          "SELECT requests,request_limit FROM assistant_runtime_execution WHERE session_id=$1",
          [onlyDownload],
        )
      ).rows[0],
    ).toEqual(before);
  });
  it("R06 SDK distinguishes two deliberate identical adds from replay of the same tool call", async () => {
    const d = await newDraft(),
      sid = await fresh(),
      args = {
        draftId: d.id,
        question: "有意保留的相同问题",
        expectedOutput: "相同答案",
        metadata: [],
      };
    await run(sid, "明确新增两条相同的手动记录", [
      call("add_draft_record", args, "deliberate-one"),
      call("add_draft_record", args, "deliberate-two"),
    ]);
    expect((await api("GET", draftUrl(d.id))).json().records).toHaveLength(2);
    const operations = (
      await db.query(
        "SELECT id,operation_key,receipt FROM assistant_runtime_operation WHERE session_id=$1 AND kind='draft_mutation'",
        [sid],
      )
    ).rows;
    expect(operations).toHaveLength(2);
    expect(new Set(operations.map((o: any) => o.receipt.recordId)).size).toBe(
      2,
    );
  });
  it("R06 changed preview parameters expire a displayed selection confirmation before approval", async () => {
    const d = await newDraft(),
      sid = await fresh();
    await run(sid, "先预览", [
      call("preview_selection", {
        draftId: d.id,
        assetIds: [assetId],
        method: "all",
        conditions: [],
      }),
    ]);
    const a = (
        await db.query("SELECT id FROM selection_preview WHERE draft_id=$1", [
          d.id,
        ])
      ).rows[0],
      first = (
        await api("GET", draftUrl(d.id) + "/selection-previews/" + a.id)
      ).json().records[0].id;
    const state = await run(sid, "就选第一条", [
        call("request_selection_apply", {
          draftId: d.id,
          previewId: a.id,
          selectedIds: [first],
          expectedRevision: 0,
        }),
      ]),
      card = state.confirmations.find((c: any) => c.action === "selection");
    await api("POST", draftUrl(d.id) + "/selection-previews", {
      assetIds: [assetId],
      conditions: [],
      method: "random",
      mode: "count",
      value: 1,
      seed: "different",
    });
    expect(
      (await api("GET", route(sid)))
        .json()
        .confirmations.find((c: any) => c.id === card.id).status,
    ).toBe("expired");
    const rejected = await api(
      "POST",
      route(sid) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json().error.code).toBe("selection_preview_expired");
    expect((await api("GET", draftUrl(d.id))).json().records).toHaveLength(0);
  });
  it("R06 prior v3 sessions stay read-only with their existing accounting unchanged", async () => {
    const sid = await fresh();
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='deepagents-v3' WHERE id=$1",
      [sid],
    );
    const before = (
      await db.query(
        "SELECT * FROM assistant_runtime_execution WHERE session_id=$1",
        [sid],
      )
    ).rows;
    expect((await api("GET", route(sid))).json().canWrite).toBe(false);
    expect((await submit(sid, "继续")).statusCode).toBe(409);
    expect(
      (
        await db.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=$1",
          [sid],
        )
      ).rows,
    ).toEqual(before);
  });
  it("R06 confirmation replays reject changed arguments under the same SDK call identity", async () => {
    const d = await newDraft(),
      other = await newDraft(),
      sid = await fresh(),
      accepted = await submit(sid, "发布草稿"),
      proof = await host.execution.claim(scope(), sid, accepted.json().turnId);
    const tools = draftTools(
        host.store,
        host.execution,
        proof,
        new ArtifactRepository(config.minio),
        true,
        async () => {},
      ).tools,
      publish = tools.find((t) => t.name === "request_publish")!;
    const invoke = (args: any) =>
      publish.invoke({
        type: "tool_call",
        name: "request_publish",
        id: "fixed-publish",
        args,
      });
    await invoke({ draftId: d.id, revision: 0 });
    await invoke({ draftId: d.id, revision: 0 });
    await expect(invoke({ draftId: other.id, revision: 0 })).rejects.toThrow(
      "operation_payload_conflict",
    );
    await expect(invoke({ draftId: d.id, revision: 1 })).rejects.toThrow(
      "operation_payload_conflict",
    );
    expect(
      (
        await db.query(
          "SELECT id FROM assistant_runtime_confirmation WHERE session_id=$1",
          [sid],
        )
      ).rows,
    ).toHaveLength(1);
    await host.store.finish(proof, "仅准备确认，未发布");
  });
  it("R06 C04 SDK repairs incompatible all/count options before creating a fixed preview", async () => {
    const d = await newDraft(),
      sid = await fresh(),
      before = requests.length,
      args = {
        draftId: d.id,
        assetIds: [assetId],
        method: "all",
        conditions: [],
      };
    const state = await run(sid, "前两条建草稿，我先选记录", [
      call("preview_selection", { ...args, mode: "count", value: 2 }),
      call("preview_selection", args),
    ]);
    expect(state.execution.status).toBe("completed");
    expect(
      (
        await db.query(
          "SELECT id,candidate_ids,configuration FROM selection_preview WHERE draft_id=$1",
          [d.id],
        )
      ).rows,
    ).toHaveLength(1);
    const preview = (
      await db.query(
        "SELECT candidate_ids,configuration FROM selection_preview WHERE draft_id=$1",
        [d.id],
      )
    ).rows[0];
    expect(preview.candidate_ids).toHaveLength(3);
    expect(preview.configuration).not.toHaveProperty("mode");
    expect(preview.configuration).not.toHaveProperty("value");
    const feedback = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind IN('parameter_feedback','correction_rejected') ORDER BY id",
        [sid],
      )
    ).rows;
    expect(feedback.some((e: any) => e.kind === "parameter_feedback")).toBe(
      true,
    );
    expect(feedback.some((e: any) => e.kind === "correction_rejected")).toBe(
      false,
    );
    expect(requests.length - before).toBeLessThanOrEqual(3);
    expect((await api("GET", draftUrl(d.id))).json().records).toHaveLength(0);
  });
});
