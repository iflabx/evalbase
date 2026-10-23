import {
  createBudgetLedger,
  repairIdentity,
} from "../../src/assistant/budget-ledger.js";
import {
  revisePlan,
  advancePlan,
  planRequirementsKey,
} from "../../src/assistant/plan.js";
import { createSharedDraft } from "../../src/drafts/create.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import * as tasks from "../../src/assistant/tasks.js";
import { backgroundVersion } from "../../src/assistant/recovery.js";
const rootUrl = loadConfig().databaseUrl,
  name = "opt49_" + randomUUID().replaceAll("-", ""),
  databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + name),
  origin = "http://127.0.0.1:4217";
describe("OPT49 persisted recovery public flow", () => {
  let app: AgentBenchApp,
    db: ReturnType<typeof createPool>,
    headers: Record<string, string>,
    projectId: string,
    dispatch = false;
  const realClaim = tasks.claimAssistantTurn;
  let claimSpy: ReturnType<typeof vi.spyOn>,
    script: any[] = [],
    release: (() => void) | undefined,
    entered: (() => void) | undefined;
  const calls: any[] = [];
  const model = createServer(async (req, res) => {
    let text = "";
    for await (const p of req) text += p;
    const body = JSON.parse(text);
    calls.push(body);
    const next = script.shift();
    if (next?.hold) {
      entered?.();
      await new Promise<void>((r) => (release = r));
    }
    if (next?.error) {
      res.writeHead(next.error, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [
          {
            index: 0,
            finish_reason: next?.name ? "tool_calls" : "stop",
            message: next?.name
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: randomUUID(),
                      type: "function",
                      function: {
                        name: next.name,
                        arguments: JSON.stringify(next.input),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "当前要求和成果已保留。" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      }),
    );
  });
  const base = () => "/api/projects/" + projectId + "/assistant";
  beforeAll(async () => {
    const root = createPool(rootUrl);
    try {
      await root.query("CREATE DATABASE " + name);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    db = createPool(databaseUrl);
    claimSpy = vi
      .spyOn(tasks, "claimAssistantTurn")
      .mockImplementation((d) =>
        dispatch ? realClaim(d) : Promise.resolve(undefined),
      );
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      { disableLegacyTestBootstrap: true },
    );
    const account = {
      email: "opt49@example.test",
      password: "RecoveryTest44",
      confirmPassword: "RecoveryTest44",
      displayName: "恢复测试",
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
        payload: { name: "OPT49隔离测试" },
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
            apiKey: "synthetic-only",
            enabled: true,
          },
        })
      ).statusCode,
    ).toBe(200);
  });
  afterEach(async () => {
    dispatch = false;
    release?.();
    release = undefined;
    entered = undefined;
    script = [];
    await db.query(
      "UPDATE assistant_turn SET status='interrupted',execution_token=NULL WHERE status IN('queued','running')",
    );
  });
  afterAll(async () => {
    claimSpy?.mockRestore();
    await app?.close();
    await db?.end();
    await new Promise<void>((r) => model.close(() => r()));
    const root = createPool(rootUrl);
    try {
      await root.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
    } finally {
      await root.end();
    }
  });
  async function read(id: string) {
    const r = await app.inject({
      method: "GET",
      url: base() + "/sessions/" + id + "?view=status",
      headers,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  async function finish(id: string) {
    await expect
      .poll(
        async () => {
          const s = await read(id);
          return s.latestTurn?.status;
        },
        { timeout: 15000 },
      )
      .toMatch(/succeeded|failed/);
    return read(id);
  }
  async function fixture(count = 4, exhausted = false) {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const row = (
      await db.query("SELECT * FROM assistant_session WHERE id=$1", [id])
    ).rows[0];
    const actorId = row.actor_id,
      taskId = row.task.taskId,
      turnId = "turn_" + randomUUID();
    const now = Date.now();
    const inputs = Array.from({ length: count }, (_, i) => ({
      name: "隔离草稿-" + id + "-" + i,
      purpose: "预算回归",
    }));
    const task: any = {
      taskContractVersion: 2,
      taskId,
      goal: "按现有方案建立多份草稿",
      title: "预算续接隔离任务",
      stage: "yielding",
      autoCount: 0,
      requirements: [],
      supplements: [],
      executionPaused: false,
      turnControl: {
        turnId,
        taskRevision: 1,
        source: "model",
        mode: "execute",
        updateSaved: true,
      },
    };
    let plan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: inputs.map((input, i) => ({
          title: "建立草稿" + i,
          action: "create_draft",
          input,
        })),
      },
      1,
      undefined,
      planRequirementsKey(task),
    )!;
    const created = await createSharedDraft(
      db,
      { projectId, actorId },
      inputs[0],
      "first:" + id,
    );
    const result = {
      draftId: created.draft.id,
      name: created.draft.name,
      revision: created.draft.revision,
    };
    plan = advancePlan(
      plan,
      "create_draft",
      result,
      "first:" + id,
      1,
      inputs[0],
    )!;
    task.executionPlan = plan;
    task.nextAction = "create_draft";
    task.createdDraftId = created.draft.id;
    task.budgetLedger = createBudgetLedger(taskId, actorId, 1);
    task.budgetLedger.policy.segment.toolCalls = 2;
    task.turnBudget = {
      turnId,
      startedAt: now - 80001,
      deadlineAt: now - 1,
      accountingVersion: 2,
      activeMs: 30,
      modelSteps: 1,
      toolCalls: 1,
      transportRetries: 0,
      requestAttempts: 1,
      requests: [
        { state: "parsed", httpStatus: 200, timeToHeadersMs: 1, totalMs: 2 },
      ],
      progressStart: "start",
    };
    task.executionBudget = {
      modelSteps: 1,
      toolCalls: exhausted ? 156 : 1,
      transportRetries: 0,
      requestAttempts: 1,
      activeMs: 30,
      lastTurn: {
        turnId,
        modelSteps: 1,
        toolCalls: 1,
        transportRetries: 0,
        requestAttempts: 1,
        elapsedMs: 30,
      },
    };
    task.budgetCheckpoint = {
      turnId,
      pendingAction: "create_draft",
      progressHashes: ["committed"],
    };
    await db.query(
      "UPDATE assistant_session SET task=$2,task_revision=1 WHERE id=$1",
      [id, task],
    );
    await db.query(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at,requires_write,task_revision,task_id,tool_results,execution_attempt) VALUES($1,$2,'origin','synthetic','按已保存方案执行','succeeded',now(),true,1,$3,$4,1)",
      [
        turnId,
        id,
        taskId,
        JSON.stringify([
          {
            key: "first:" + id,
            name: "create_draft",
            status: "succeeded",
            input: inputs[0],
            result,
            binding: {
              stepId: plan.steps[0].id,
              revision: 1,
              deliveryId: null,
            },
          },
        ]),
      ],
    );
    const raw = async () =>
      (await db.query("SELECT * FROM assistant_session WHERE id=$1", [id]))
        .rows[0];
    return { id, turnId, taskId, task, raw };
  }
  it("completes more than twelve actual continuation events without duplicate drafts or lost usage", async () => {
    const f = await fixture(29);
    dispatch = true;
    const response = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/retry",
      headers,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    await expect
      .poll(async () => (await f.raw()).task.executionPlan.current, {
        timeout: 25000,
        interval: 100,
      })
      .toBe(29);
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')",
              [f.id],
            )
          ).rows[0].n,
      )
      .toBe(0);
    // Turn success precedes the executor finalizer; wait for the actual closed accounting interval.
    await expect
      .poll(async () => {
        const t = (await f.raw()).task;
        return (
          t.turnBudget.attemptStartedAt === null &&
          Boolean(
            t.budgetLedger.segments?.some(
              (s: any) => s.turnId === t.turnBudget.turnId,
            ),
          )
        );
      })
      .toBe(true);
    dispatch = false;
    const row = await f.raw();
    const drafts = (
      await db.query("SELECT id FROM collaborative_draft WHERE name LIKE $1", [
        "隔离草稿-" + f.id + "-%",
      ])
    ).rows;
    expect(drafts).toHaveLength(29);
    expect(row.task.taskId).toBe(f.taskId);
    expect(row.task.autoCount).toBeGreaterThan(12);
    const segments = row.task.budgetLedger.segments;
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(new Set(segments.map((s: any) => s.turnId)).size).toBe(
      segments.length,
    );
    expect(row.task.executionBudget.toolCalls).toBe(
      segments.reduce((n: number, s: any) => n + s.toolCalls, 0),
    );
    expect(
      segments.every((s: any) => s.deadlineAt - s.startedAt <= 80000),
    ).toBe(true);
    const before = (
      await db.query(
        "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
        [f.id],
      )
    ).rows[0].n;
    await tasks.queueContinuation(db, f.id, "budget_yield", f.turnId, 1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(before);
  });
  it("ordinary continue sends zero requests at exhaustion; one explicit grant is bounded and double-click safe", async () => {
    const f = await fixture(6, true),
      before = calls.length;
    const s = await read(f.id),
      offer = s.task.recoveryDecision.grantOffers?.continue;
    expect(offer).toBeTruthy();
    expect(s.task.budgetLedger).toBeUndefined();
    const ordinary = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "继续" },
    });
    expect(ordinary.statusCode).toBe(409);
    expect(calls.length).toBe(before);
    const key = randomUUID(),
      payload = {
        expectedTaskRevision: 1,
        purpose: "continue",
        offerId: offer.id,
        accept: true,
      };
    const grant = () =>
      app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/grant",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
    const results = await Promise.all([grant(), grant()]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    let row = await f.raw();
    expect(row.task.budgetLedger.grants).toHaveLength(2);
    expect(row.task.executionBudget.toolCalls).toBe(156);
    dispatch = true;
    await expect
      .poll(async () => (await f.raw()).task.executionBudget.toolCalls, {
        timeout: 15000,
      })
      .toBe(158);
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1 AND status IN('queued','running')",
              [f.id],
            )
          ).rows[0].n,
      )
      .toBe(0);
    dispatch = false;
    row = await f.raw();
    expect(row.task.executionPlan.current).toBe(3);
    expect(row.task.budgetLedger.grants[0].closedAtUse.toolCalls).toBe(156);
    expect(calls.length).toBe(before); // deterministic frozen steps need no model request
  });
  it.each(["stale", "spoof", "stop", "legacy", "outer-zero"])(
    "rejects %s grants without allocating a turn",
    async (kind) => {
      const f = await fixture(4, true),
        s = await read(f.id),
        offer = s.task.recoveryDecision.grantOffers.continue;
      if (kind === "stop")
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/stop",
          headers,
          payload: {},
        });
      if (kind === "legacy")
        await db.query(
          "UPDATE assistant_session SET task=task-'budgetLedger' WHERE id=$1",
          [f.id],
        );
      if (kind === "outer-zero")
        await db.query(
          "UPDATE assistant_session SET task=jsonb_set(task,'{budgetLedger,externalClosed}','true') WHERE id=$1",
          [f.id],
        );
      const response = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/grant",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          expectedTaskRevision: kind === "stale" ? 0 : 1,
          purpose: "continue",
          offerId: kind === "spoof" ? "offer:fake" : offer.id,
          accept: true,
        },
      });
      expect([403, 404, 409]).toContain(response.statusCode);
      expect((await f.raw()).task.budgetLedger?.grants.length ?? 1).toBe(1);
    },
  );
  it("settles an unknown send once and preserves old receipt, policy and spent values", async () => {
    const f = await fixture();
    const task = structuredClone(f.task);
    task.turnBudget.requests.push({
      id: "ambiguous",
      state: "reserved",
      httpStatus: null,
      timeToHeadersMs: 0,
    });
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      task,
    ]);
    let row = await f.raw();
    await tasks.closeBudget(db, row, f.turnId);
    await tasks.closeBudget(db, row, f.turnId);
    row = await f.raw();
    expect(row.task.executionBudget.requestAttempts).toBe(2);
    expect(row.task.turnBudget.requests.at(-1).state).toBe("unknown");
    expect(row.task.budgetLedger.policy).toEqual(f.task.budgetLedger.policy);
    expect(row.task.budgetLedger.grants[0]).toEqual(
      f.task.budgetLedger.grants[0],
    );
    expect(
      (
        await db.query("SELECT tool_results FROM assistant_turn WHERE id=$1", [
          f.turnId,
        ])
      ).rows[0].tool_results[0].key,
    ).toBe("first:" + f.id);
  });

  it("uses the same outbound ledger for SDK generation and transport retry", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: base() + "/sessions",
        headers,
        payload: {},
      })
    ).json().sessionId;
    const begin = calls.length;
    script = [
      { error: 503 },
      {
        name: "plan_task",
        input: { control: { mode: "query", explanation: "查询现有资料" } },
      },
    ];
    dispatch = true;
    const response = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "查询现有资料" },
    });
    expect(response.statusCode, response.body).toBe(202);
    await finish(id);
    dispatch = false;
    const row = (
      await db.query("SELECT task FROM assistant_session WHERE id=$1", [id])
    ).rows[0];
    expect(row.task.budgetLedger.version).toBe(1);
    expect(row.task.executionBudget.requestAttempts).toBe(calls.length - begin);
    expect(row.task.executionBudget.requestAttempts).toBeGreaterThanOrEqual(2);
    expect(row.task.executionBudget.transportRetries).toBe(1);
    const requests = row.task.turnBudget.requests;
    expect(requests.map((r: any) => r.state)).toContain("failed");
    expect(requests.at(-1).state).toBe("parsed");
    expect(requests.at(-1).parseMs).toBeGreaterThanOrEqual(0);
  });
  it("requires a repair-purpose grant to create a linked bounded repair attempt", async () => {
    const f = await fixture();
    const task = structuredClone(f.task);
    task.stage = "failed";
    task.planValidationRequired = true;
    task.turnControl.mode = "plan";
    task.turnControl.requiresUpdate = true;
    task.turnControl.updateSaved = false;
    task.planningRecovery = {
      amendment: true,
      turnId: f.turnId,
      requestTurnId: f.turnId,
      taskRevision: 1,
      documentsKey: backgroundVersion([]),
      planKey: planRequirementsKey(task),
    };
    task.parameterRepairLimits = {
      plan_task: {
        version: 2,
        identity: repairIdentity(task, f.turnId),
        used: 2,
        truncated: 1,
      },
    };
    task.parameterRepairStatus = {
      amendmentId: f.turnId,
      turnId: f.turnId,
      issues: [],
    };
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      task,
    ]);
    await db.query(
      "UPDATE assistant_turn SET status='failed',error_code='assistant_tool_repair_exhausted' WHERE id=$1",
      [f.turnId],
    );
    const s = await read(f.id),
      offer = s.task.recoveryDecision.grantOffers?.repair;
    expect(offer).toBeTruthy();
    expect(s.task.recoveryDecision.action).toBeNull();
    const grant = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/grant",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedTaskRevision: 1,
        purpose: "repair",
        offerId: offer.id,
        accept: true,
      },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const row = await f.raw();
    expect(row.task.parameterRepairLimits.plan_task.used).toBe(2);
    expect(row.task.parameterRepairLimits.plan_task.truncated).toBe(1);
    expect(
      Object.keys(row.task.parameterRepairLimits).some((k) =>
        k.startsWith("history:"),
      ),
    ).toBe(true);
    expect(repairIdentity(row.task, f.turnId)).not.toBe(
      task.parameterRepairLimits.plan_task.identity,
    );
    expect(row.task.recoverySegment.grantId).toBe(
      row.task.budgetLedger.activeId,
    );
  });
  it("refuses a grant after permission revocation", async () => {
    const f = await fixture(4, true),
      s = await read(f.id),
      offer = s.task.recoveryDecision.grantOffers.continue,
      row = await f.raw();
    await db.query("UPDATE app_user SET role='user' WHERE id=$1", [
      row.actor_id,
    ]);
    await db.query(
      "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [projectId, row.actor_id],
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/grant",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          expectedTaskRevision: 1,
          purpose: "continue",
          offerId: offer.id,
          accept: true,
        },
      });
      expect([403, 404]).toContain(response.statusCode);
      expect((await f.raw()).task.budgetLedger.grants).toHaveLength(1);
    } finally {
      await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [
        row.actor_id,
      ]);
      await db.query(
        "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
        [projectId, row.actor_id],
      );
    }
  });
  it("keeps frozen budget evidence after deleting a background source", async () => {
    const f = await fixture();
    const documentId = "background_" + randomUUID().replaceAll("-", "");
    const actor = (await f.raw()).actor_id;
    await db.query(
      "INSERT INTO assistant_background_document(id,session_id,project_id,actor_id,file_name,format,sha256,file_size,extractor_version,units,characters,fragments) VALUES($1,$2,$3,$4,'isolated.txt','txt','synthetic',1,'synthetic',1,1,'[]')",
      [documentId, f.id, projectId, actor],
    );
    const before = (await f.raw()).task;
    await db.query("DELETE FROM assistant_background_document WHERE id=$1", [
      documentId,
    ]);
    const after = (await f.raw()).task;
    expect(after.executionBudget).toEqual(before.executionBudget);
    expect(after.turnBudget).toEqual(before.turnBudget);
    expect(after.budgetLedger).toEqual(before.budgetLedger);
    expect(after.executionPlan).toBeUndefined();
    expect(
      (await read(f.id)).task.recoveryDecision.grantOffers,
    ).toBeUndefined();
  });
  it("settles a crashed active interval before adding a grant without rewriting its deadline", async () => {
    const f = await fixture(4, true);
    const task = structuredClone(f.task);
    task.turnBudget.attemptStartedAt = Date.now() - 100;
    task.turnBudget.attemptBaseMs = 30;
    task.turnBudget.attemptToken = "crashed";
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      task,
    ]);
    const offer = (await read(f.id)).task.recoveryDecision.grantOffers.continue;
    const response = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/grant",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedTaskRevision: 1,
        purpose: "continue",
        offerId: offer.id,
        accept: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const row = await f.raw();
    expect(row.task.executionBudget.activeMs).toBeGreaterThan(30);
    expect(row.task.budgetLedger.grants[1].startsAtUse.activeMs).toBe(
      row.task.executionBudget.activeMs,
    );
    expect(row.task.budgetLedger.segments[0].deadlineAt).toBe(
      task.turnBudget.deadlineAt,
    );
  });
  it("invalidates an old grant on new requirements and retains an actionable planning checkpoint", async () => {
    const f = await fixture(4, true),
      offer = (await read(f.id)).task.recoveryDecision.grantOffers.continue;
    const grant = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/grant",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedTaskRevision: 1,
        purpose: "continue",
        offerId: offer.id,
        accept: true,
      },
    });
    expect(grant.statusCode).toBe(200);
    // Hold the already queued continuation, as if a user superseded it before dispatch.
    await db.query(
      "UPDATE assistant_turn SET status='interrupted' WHERE session_id=$1 AND status='queued'",
      [f.id],
    );
    const callsBefore = calls.length,
      history = (await f.raw()).task.budgetLedger.grants;
    const change = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "把剩余草稿数量改成2份，先保存新方案" },
    });
    expect(change.statusCode, change.body).toBe(202);
    expect(change.json().status).toBe("failed");
    expect(calls.length).toBe(callsBefore);
    const s = await read(f.id),
      row = await f.raw();
    expect(row.task.budgetLedger.grants).toEqual(history);
    expect(s.task.recoveryDecision.reason).toBe("grant_revision_changed");
    const next = s.task.recoveryDecision.grantOffers.continue;
    expect(next.revision).toBe(2);
    const resume = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/grant",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        expectedTaskRevision: 2,
        purpose: "continue",
        offerId: next.id,
        accept: true,
      },
    });
    expect(resume.statusCode, resume.body).toBe(200);
    expect((await f.raw()).task.recoverySegment.mode).toBe("plan");
    expect(calls.length).toBe(callsBefore);
  });
});
