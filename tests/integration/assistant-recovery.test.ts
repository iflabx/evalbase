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
  name = "opt44_" + randomUUID().replaceAll("-", ""),
  databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + name),
  origin = "http://127.0.0.1:4217";
describe("OPT44 persisted recovery public flow", () => {
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
      email: "opt44@example.test",
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
        payload: { name: "OPT44隔离测试" },
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
  const goals = ["物流", "地址"].map((name) => ({
    name,
    count: 2,
    instructions: "自然完整的用户问题，不编造订单信息",
    scenarios: [name + "正常咨询", name + "信息不足", name + "异常情况"],
    classifications: [],
  }));
  async function fixture(remaining = -1) {
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
        fileName: "客服规范.txt",
        contentBase64: Buffer.from(
          "客服问题覆盖查物流与改地址，问题为完整自然问法，逐题说明处理行为，不编造订单信息。",
        ).toString("base64"),
      },
    });
    expect(upload.statusCode).toBe(201);
    script = [
      { name: "plan_task", input: { control: { mode: "plan" } } },
      {
        name: "read_background",
        input: { documentId: upload.json().document.id },
      },
      {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: goals,
          requirements: ["保持最近30天时间条件"],
        },
      },
    ];
    dispatch = true;
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + id + "/turns",
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            message: "根据附件做两份客服测试集，各2条，先给方案，不执行",
          },
        })
      ).statusCode,
    ).toBe(202);
    const initial = await finish(id);
    expect(initial.latestTurn.status).toBe("succeeded");
    dispatch = false;
    const row = (
      await db.query("SELECT * FROM assistant_session WHERE id=$1", [id])
    ).rows[0];
    const parent = (
      await db.query(
        "SELECT * FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    const task = row.task,
      now = Date.now(),
      original = structuredClone(task.executionPlan);
    task.stage = "failed";
    task.error = "assistant_model_failed";
    task.turnControl = {
      ...task.turnControl,
      mode: "plan",
      requiresUpdate: true,
      updateSaved: false,
    };
    task.planValidationRequired = true;
    const docs = (
      await db.query(
        'SELECT id,sha256,extractor_version AS "extractorVersion" FROM assistant_background_document WHERE session_id=$1',
        [id],
      )
    ).rows;
    task.planningRecovery = {
      amendment: true,
      turnId: parent.id,
      requestTurnId: parent.id,
      taskRevision: row.task_revision,
      documentsKey: backgroundVersion(docs),
      planKey: task.executionPlan.requirementsKey,
      evidenceKey: "preserved",
    };
    // Use the current authoritative key, not the initial compile key's stale input snapshot.
    const { planRequirementsKey } = await import("../../src/assistant/plan.js");
    task.planningRecovery.planKey = planRequirementsKey(task);
    task.turnBudget = {
      ...task.turnBudget,
      startedAt: now + remaining - 80000,
      deadlineAt: now + remaining,
      attemptStartedAt: null,
      attemptToken: null,
    };
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      id,
      JSON.stringify(task),
    ]);
    await db.query(
      "UPDATE assistant_turn SET status='failed',execution_token=NULL,error_code='assistant_model_failed',user_text=$2 WHERE id=$1",
      [parent.id, "物流改成3条，地址不变，先保存方案，不执行"],
    );
    const raw = async () =>
      (await db.query("SELECT * FROM assistant_session WHERE id=$1", [id]))
        .rows[0];
    return { id, parent, task, original, raw };
  }
  it.each([5000, 10000, -1])(
    "read and retry agree at %s ms without dispatching an ineligible same-segment request",
    async (ms) => {
      const f = await fixture(ms);
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{autoCount}','12') WHERE id=$1",
        [f.id],
      );
      const start = calls.length,
        s = await read(f.id),
        r = await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        });
      if (ms === 10000) {
        expect(
          s.task.recoveryDecision.action === "retry_turn" ||
            s.task.recoveryDecision.action === null,
        ).toBe(true);
      } else {
        expect(s.task.canRetryTurn).toBe(false);
        expect(r.statusCode).toBe(409);
      }
      expect(calls.length).toBe(start);
    },
  );
  it("ordinary continue planning creates one linked segment, saves the pending count and never generates", async () => {
    const f = await fixture();
    const before = f.task.executionBudget,
      count = calls.length;
    const goal = f.task.executionPlan.steps.find(
      (s: any) => s.action === "generate_candidates",
    );
    script = [
      {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: [{ id: goal.deliveryId, count: 3 }],
        },
      },
    ];
    const offered = await read(f.id);
    expect(offered.task.recoveryDecision.action).toBe("continue_plan");
    const sent = await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/turns",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { message: "继续规划，先不要生成" },
    });
    expect([200, 202], sent.body).toContain(sent.statusCode);
    const queued = await f.raw();
    expect(queued.task.turnBudget.turnId).not.toBe(f.parent.id);
    expect(queued.task.budgetSegments.at(-1).startedAt).toBe(
      f.task.turnBudget.startedAt,
    );
    expect(queued.task.budgetSegments.at(-1).deadlineAt).toBe(
      f.task.turnBudget.deadlineAt,
    );
    expect(
      queued.task.turnBudget.deadlineAt - queued.task.turnBudget.startedAt,
    ).toBeLessThanOrEqual(80000);
    expect(queued.task.recoverySegment).toMatchObject({
      rootTurnId: f.parent.id,
      parentTurnId: f.parent.id,
      attemptsBefore: 1,
    });
    dispatch = true;
    const done = await finish(f.id);
    expect(done.latestTurn.status, JSON.stringify(done)).toBe("succeeded");
    const raw = (await f.raw()).task;
    expect(raw.overallTargetCount).toBe(5);
    expect(raw.turnControl.updateSaved).toBe(true);
    expect(raw.executionPlan.mode).toBe("plan");
    expect(raw.executionBudget.modelSteps).toBeGreaterThan(before.modelSteps);
    expect(raw.executionBudget.activeMs - before.activeMs).toBeLessThan(10000);
    expect(raw.autoCount).toBe(1);
    expect(raw.requirements).toContain("保持最近30天时间条件");
    expect(
      (await db.query("SELECT count(*)::int n FROM processing_run")).rows[0].n,
    ).toBe(0);
    expect(calls.length - count).toBeLessThanOrEqual(3);
  });

  it.each([
    "继续规划，先不要生成",
    "继续规划\n先不要生成",
    "继续规划，暂时不要生成",
  ])(
    "OPT45 planning-only continuation rejects an exhausted amendment before any model call: %s",
    async (message) => {
      const f = await fixture();
      const { sha256, canonicalJson } =
        await import("../../src/package/contract.js");
      const identity = sha256(canonicalJson({ requestTurnId: f.parent.id }));
      await db.query(
        "UPDATE assistant_session SET task=jsonb_set(task,'{parameterRepairLimits}',$2::jsonb) WHERE id=$1",
        [
          f.id,
          JSON.stringify({ plan_task: { identity, version: 2, used: 2 } }),
        ],
      );
      const before = calls.length;
      const sent = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/turns",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { message },
      });
      expect(sent.statusCode).toBe(409);
      expect(calls.length).toBe(before);
      expect((await f.raw()).task.parameterRepairLimits.plan_task.used).toBe(2);
    },
  );

  it("double recovery claims create one segment and preserve consumed repair and transport limits", async () => {
    const f = await fixture();
    f.task.parameterRepairLimits = {
      other: { identity: "frozen", used: 1, version: 2 },
    };
    f.task.turnBudget.transportRetries = 2;
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      JSON.stringify(f.task),
    ]);
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const raw = (await f.raw()).task;
    expect(raw.parameterRepairLimits).toEqual(f.task.parameterRepairLimits);
    expect(raw.recoverySegment.transportRetriesBefore).toBe(2);
    expect(raw.autoCount).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("rechecks time again at claim and makes no request after the queued retry expires", async () => {
    const f = await fixture(50000);
    expect((await read(f.id)).task.recoveryDecision.action).toBe("retry_turn");
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await db.query(
      "UPDATE assistant_session SET task=jsonb_set(jsonb_set(task,'{turnBudget,deadlineAt}',to_jsonb($2::double precision)),'{autoCount}','12') WHERE id=$1",
      [f.id, Date.now() - 1],
    );
    const before = calls.length;
    expect(await realClaim(db)).toBeUndefined();
    expect(calls.length).toBe(before);
    expect((await read(f.id)).task.canRetryTurn).toBe(false);
  });
  it.each([
    "stopped",
    "new-revision",
    "background",
    "budget",
    "attempts",
    "missing-evidence",
  ])(
    "invalidates recovery for %s without touching saved results",
    async (kind) => {
      const f = await fixture(),
        before = calls.length;
      if (kind === "stopped")
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/stop",
          headers,
          payload: {},
        });
      if (kind === "new-revision")
        await db.query(
          "UPDATE assistant_session SET task_revision=task_revision+1 WHERE id=$1",
          [f.id],
        );
      if (kind === "background")
        await db.query(
          "UPDATE assistant_background_document SET sha256=$2 WHERE session_id=$1",
          [f.id, "f".repeat(64)],
        );
      if (kind === "budget")
        await db.query(
          "UPDATE assistant_session SET task=jsonb_set(task,'{executionBudget,activeMs}','1040000') WHERE id=$1",
          [f.id],
        );
      if (kind === "attempts")
        await db.query(
          "UPDATE assistant_turn SET execution_attempt=3 WHERE id=$1",
          [f.parent.id],
        );
      if (kind === "missing-evidence")
        await db.query(
          "UPDATE assistant_session SET task=task-'turnBudget' WHERE id=$1",
          [f.id],
        );
      expect((await read(f.id)).task.canRetryTurn).toBe(false);
      const r = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/retry",
        headers,
        payload: {},
      });
      expect(r.statusCode).toBe(409);
      expect(calls.length).toBe(before);
      expect((await f.raw()).task.executionPlan).toEqual(f.original);
    },
  );
  it("same-segment retry keeps the deadline and charges only the new execution interval", async () => {
    const f = await fixture(50000),
      before = f.task.executionBudget;
    const goal = f.task.executionPlan.steps.find(
      (s: any) => s.action === "generate_candidates",
    );
    script = [
      {
        name: "plan_task",
        input: {
          executionMode: "plan",
          deliveries: [{ id: goal.deliveryId, count: 3 }],
        },
      },
    ];
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.raw()).task.turnBudget.deadlineAt).toBe(
      f.task.turnBudget.deadlineAt,
    );
    dispatch = true;
    const done = await finish(f.id);
    expect(done.latestTurn.status, JSON.stringify(done)).toBe("succeeded");
    const raw = (await f.raw()).task;
    expect(raw.overallTargetCount).toBe(5);
    expect(raw.turnBudget.startedAt).toBe(f.task.turnBudget.startedAt);
    expect(raw.turnBudget.deadlineAt).toBe(f.task.turnBudget.deadlineAt);
    expect(raw.executionBudget.activeMs - before.activeMs).toBeLessThan(10000);
    const saved = JSON.stringify(raw.executionBudget);
    for (let n = 0; n < 3; n++) await read(f.id);
    expect(JSON.stringify((await f.raw()).task.executionBudget)).toBe(saved);
  });
  it("a smaller frozen active budget bounds a new segment without changing old counters", async () => {
    const f = await fixture();
    f.task.executionBudget.limits = {
      activeMs: f.task.executionBudget.activeMs + 15000,
    };
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      JSON.stringify(f.task),
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const raw = (await f.raw()).task;
    expect(
      raw.turnBudget.deadlineAt - raw.turnBudget.startedAt,
    ).toBeLessThanOrEqual(15000);
    expect(raw.executionBudget).toEqual(f.task.executionBudget);
  });
  it.each(["no-progress", "repair-limit"])(
    "does not resume %s through a new turn",
    async (kind) => {
      const f = await fixture(),
        before = calls.length;
      if (kind === "no-progress")
        await db.query(
          "UPDATE assistant_turn SET error_code='assistant_no_progress' WHERE id=$1",
          [f.parent.id],
        );
      else {
        const { sha256, canonicalJson } =
          await import("../../src/package/contract.js");
        f.task.parameterRepairLimits = {
          plan_task: {
            identity: sha256(canonicalJson({ requestTurnId: f.parent.id })),
            used: 2,
            version: 2,
          },
        };
        await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
          f.id,
          JSON.stringify(f.task),
        ]);
      }
      expect((await read(f.id)).task.canRetryTurn).toBe(false);
      expect(
        (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + f.id + "/turns",
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: { message: "继续规划" },
          })
        ).statusCode,
      ).toBe(409);
      expect(calls.length).toBe(before);
    },
  );
  it.each(["saved", "response-lost"])(
    "continues only the remaining step after a %s draft receipt",
    async (kind) => {
      const f = await fixture(kind === "saved" ? 50000 : -1);
      const { createSharedDraft } = await import("../../src/drafts/create.js");
      const { revisePlan, advancePlan, planRequirementsKey } =
        await import("../../src/assistant/plan.js");
      const row = await f.raw(),
        scope = { projectId, actorId: row.actor_id },
        key = "assistant:" + f.parent.id + ":first-draft";
      const input = {
        name: "已保存第一份-" + f.parent.id,
        purpose: "恢复回归",
      };
      const created = await createSharedDraft(db, scope, input, key);
      let plan = revisePlan(
        undefined,
        {
          executionMode: "execute",
          steps: [
            { title: "建立第一份", action: "create_draft", input },
            {
              title: "建立第二份",
              action: "create_draft",
              input: {
                name: "仅创建剩余第二份-" + f.parent.id,
                purpose: "恢复回归",
              },
            },
          ],
        },
        row.task_revision,
        undefined,
        planRequirementsKey(f.task),
      );
      const firstId = plan!.steps[0].id,
        result = {
          draftId: created.draft.id,
          name: created.draft.name,
          revision: created.draft.revision,
        };
      plan = advancePlan(
        plan,
        "create_draft",
        result,
        key,
        row.task_revision,
        input,
      );
      const task = {
        ...f.task,
        executionPlan: plan,
        planningRecovery: null,
        planValidationRequired: null,
        requirementProblem: null,
        createdDraftId: created.draft.id,
        nextAction: "create_draft",
        executionPaused: false,
        turnControl: {
          ...f.task.turnControl,
          mode: "execute",
          requiresUpdate: false,
          updateSaved: true,
        },
      };
      await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
        f.id,
        JSON.stringify(task),
      ]);
      const records = [
        {
          key,
          name: "create_draft",
          status: kind === "saved" ? "succeeded" : "started",
          input,
          binding: {
            revision: row.task_revision,
            stepId: firstId,
            deliveryId: null,
          },
          ...(kind === "saved" ? { result } : {}),
        },
      ];
      await db.query(
        "UPDATE assistant_turn SET user_text='按现有方案执行两份草稿',tool_results=$2 WHERE id=$1",
        [f.parent.id, JSON.stringify(records)],
      );
      if (kind === "response-lost") await read(f.id);
      expect((await read(f.id)).task.recoveryDecision.action).toBe(
        kind === "saved" ? "retry_turn" : "continue_execution",
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + f.id + "/retry",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      dispatch = true;
      const done = await finish(f.id);
      expect(done.latestTurn.status, JSON.stringify(done)).toBe("succeeded");
      const drafts = (
        await db.query(
          "SELECT id,name FROM collaborative_draft WHERE project_id=$1 AND name=ANY($2::text[])",
          [
            projectId,
            ["已保存第一份-" + f.parent.id, "仅创建剩余第二份-" + f.parent.id],
          ],
        )
      ).rows;
      expect(
        drafts.filter((d) => d.name === "已保存第一份-" + f.parent.id),
      ).toHaveLength(1);
      expect(
        drafts.filter((d) => d.name === "仅创建剩余第二份-" + f.parent.id),
      ).toHaveLength(1);
      expect((await f.raw()).task.executionPlan.steps[0].receipt.draftId).toBe(
        created.draft.id,
      );
    },
  );
  it.each(["stop", "background"])(
    "late correction cannot save after %s invalidates the segment",
    async (kind) => {
      const f = await fixture(),
        goal = f.task.executionPlan.steps.find(
          (s: any) => s.action === "generate_candidates",
        );
      let started!: () => void;
      const ready = new Promise<void>((r) => (started = r));
      entered = started;
      script = [
        {
          name: "plan_task",
          hold: true,
          input: {
            executionMode: "plan",
            deliveries: [{ id: goal.deliveryId, count: 3 }],
          },
        },
      ];
      expect(
        (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + f.id + "/retry",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      dispatch = true;
      await ready;
      if (kind === "stop")
        expect(
          (
            await app.inject({
              method: "POST",
              url: base() + "/sessions/" + f.id + "/stop",
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
      else
        await db.query(
          "UPDATE assistant_background_document SET sha256=$2 WHERE session_id=$1",
          [f.id, "e".repeat(64)],
        );
      release?.();
      dispatch = false;
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT status FROM assistant_turn WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
                [f.id],
              )
            ).rows[0].status,
          { timeout: 10000 },
        )
        .toMatch(/failed|interrupted/);
      const raw = (await f.raw()).task;
      expect(raw.overallTargetCount).toBe(4);
      expect(raw.executionPlan).toEqual(f.original);
      expect(raw.turnControl.updateSaved).toBe(false);
    },
  );
  it("revoking write permission invalidates the queued recovery without a model request", async () => {
    const f = await fixture(),
      row = await f.raw(),
      before = calls.length;
    try {
      await db.query("UPDATE app_user SET role='user' WHERE id=$1", [
        row.actor_id,
      ]);
      await db.query(
        "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [projectId, row.actor_id],
      );
      expect([403, 404]).toContain(
        (
          await app.inject({
            method: "POST",
            url: base() + "/sessions/" + f.id + "/retry",
            headers,
            payload: {},
          })
        ).statusCode,
      );
      expect([403, 404]).toContain(
        (
          await app.inject({
            method: "GET",
            url: base() + "/sessions/" + f.id + "?view=status",
            headers,
          })
        ).statusCode,
      );
      expect(calls.length).toBe(before);
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
  it("invalid background revokes both read and structured execution capabilities", async () => {
    const f = await fixture();
    await app.inject({
      method: "POST",
      url: base() + "/sessions/" + f.id + "/retry",
      headers,
      payload: {},
    });
    const row = await f.raw();
    row.task.planValidationRequired = false;
    delete row.task.planningRecovery;
    delete row.task.requirementProblem;
    row.task.executionPlan.needsReview = false;
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      JSON.stringify(row.task),
    ]);
    await db.query(
      "UPDATE assistant_background_document SET sha256=$2 WHERE session_id=$1",
      [f.id, "e".repeat(64)],
    );
    const before = calls.length,
      count = (
        await db.query(
          "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
          [f.id],
        )
      ).rows[0].n;
    expect((await read(f.id)).task.canContinueExecution).toBe(false);
    for (const operation of ["execute_plan", "resume"]) {
      const r = await app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/turns",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          message: "继续",
          operation,
          expectedTaskRevision: row.task_revision,
        },
      });
      expect(r.statusCode, r.body).toBe(409);
    }
    expect(calls.length).toBe(before);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(count);
  });
  it("receipt pruning is not progress after a linked segment fails without work", async () => {
    const f = await fixture(),
      before = calls.length;
    expect(
      f.parent.tool_results.some(
        (r: any) => r.name === "read_background" && r.status === "succeeded",
      ),
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const row = await f.raw(),
      id = row.task.turnBudget.turnId;
    await db.query(
      "UPDATE assistant_turn SET status='failed',execution_attempt=1,error_code='assistant_model_failed' WHERE id=$1",
      [id],
    );
    await db.query(
      "UPDATE assistant_session SET task=jsonb_set(task,'{turnBudget,deadlineAt}',to_jsonb($2::double precision)) WHERE id=$1",
      [f.id, Date.now() - 1],
    );
    const state = await read(f.id);
    expect(state.task.recoveryDecision).toMatchObject({
      action: null,
      reason: "no_progress",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/retry",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(calls.length).toBe(before);
  });
  it.each([-1, 50000])(
    "ordinary continuation keeps revision and completed replay fences at %s",
    async (remaining) => {
      const f = await fixture(remaining),
        row = await f.raw(),
        before = calls.length;
      const send = (
        key: string,
        message = "继续规划",
        revision = row.task_revision,
      ) =>
        app.inject({
          method: "POST",
          url: base() + "/sessions/" + f.id + "/turns",
          headers: { ...headers, "idempotency-key": key },
          payload: { message, expectedTaskRevision: revision },
        });
      expect(
        (await send(randomUUID(), "继续规划", row.task_revision - 1))
          .statusCode,
      ).toBe(409);
      expect(calls.length).toBe(before);
      const key = randomUUID(),
        goal = f.task.executionPlan.steps.find(
          (s: any) => s.action === "generate_candidates",
        );
      script = [
        {
          name: "plan_task",
          input: {
            executionMode: "plan",
            deliveries: [{ id: goal.deliveryId, count: 3 }],
          },
        },
      ];
      const first = await send(key);
      expect(first.statusCode, first.body).toBe(202);
      dispatch = true;
      expect((await finish(f.id)).latestTurn.status).toBe("succeeded");
      dispatch = false;
      const callsBefore = calls.length,
        saved = await f.raw();
      const replay = await send(key);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({
        turnId: first.json().turnId,
        replayed: true,
      });
      expect((await send(key, "继续执行")).statusCode).toBe(409);
      expect(calls.length).toBe(callsBefore);
      expect((await f.raw()).task.executionBudget).toEqual(
        saved.task.executionBudget,
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1",
            [f.id],
          )
        ).rows[0].n,
      ).toBe(remaining === -1 ? 2 : 1);
    },
  );
  it("a real Worker completion resumes the authorized read once with cumulative budget intact", async () => {
    const f = await fixture(),
      row = await f.raw(),
      scope = { projectId, actorId: row.actor_id };
    const draft = (
      await app.inject({
        method: "POST",
        url: "/api/projects/" + projectId + "/collaborative-drafts",
        headers,
        payload: { name: "后台续段-" + f.parent.id },
      })
    ).json().draft;
    const added = await app.inject({
      method: "POST",
      url:
        "/api/projects/" +
        projectId +
        "/collaborative-drafts/" +
        draft.id +
        "/records",
      headers,
      payload: {
        question: "  如何查物流？  ",
        expectedOutput: "查询物流",
        metadata: [{ key: "topic", value: "物流" }],
      },
    });
    expect(added.statusCode, added.body).toBe(201);
    const { ArtifactRepository } =
        await import("../../src/storage/artifacts.js"),
      { createProcessingRun } = await import("../../src/processing/store.js"),
      { runProcessing } = await import("../../src/processing/execute.js"),
      { revisePlan, advancePlan, planRequirementsKey } =
        await import("../../src/assistant/plan.js");
    const config = { ...loadConfig(), databaseUrl },
      artifacts = new ArtifactRepository(config.minio);
    const created = await createProcessingRun(
      db,
      artifacts,
      scope,
      randomUUID(),
      {
        source: {
          kind: "draft",
          id: draft.id,
          recordIds: [added.json().record.id],
        },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    );
    const runId = created.run.id;
    const job = (
      await db.query(
        "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt44-worker',lease_expires_at=now()+interval '30 seconds' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
        [runId],
      )
    ).rows[0];
    const result = await runProcessing(db, artifacts, config, job);
    await db.query(
      "UPDATE job SET status='succeeded',result=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [job.id, result],
    );
    const task = {
      ...row.task,
      goal: "清洗完成后核对候选供审核",
      stage: "processing",
      runId,
      runIds: [runId],
      executionPaused: false,
      planValidationRequired: false,
      planningRecovery: null,
      error: null,
      turnControl: {
        ...row.task.turnControl,
        mode: "execute",
        requiresUpdate: false,
        updateSaved: true,
      },
    };
    let plan = revisePlan(
      undefined,
      {
        executionMode: "execute",
        steps: [
          {
            title: "提交清洗",
            action: "submit_processing",
            input: {
              source: { kind: "draft", id: draft.id },
              allRecords: true,
              operation: "clean",
              instructions: "",
              allowedFields: ["question"],
            },
          },
          { title: "核对结果", action: "read_processing", input: { runId } },
        ],
      },
      row.task_revision,
      undefined,
      planRequirementsKey(task),
    );
    const firstId = plan!.steps[0].id,
      receipt = { runId };
    plan = advancePlan(
      plan,
      "submit_processing",
      receipt,
      "actual:" + runId,
      row.task_revision,
      plan!.steps[0].input,
    );
    task.executionPlan = plan;
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      JSON.stringify(task),
    ]);
    await db.query(
      "UPDATE assistant_turn SET status='succeeded',error_code=NULL,tool_results=$2 WHERE id=$1",
      [
        f.parent.id,
        JSON.stringify([
          ...f.parent.tool_results,
          {
            name: "submit_processing",
            key: "actual:" + runId,
            status: "succeeded",
            result: receipt,
            binding: { stepId: firstId },
          },
        ]),
      ],
    );
    script = [{ name: "read_processing", input: { runId } }];
    await tasks.collectProcessingEvents(db);
    const queued = (
      await db.query(
        "SELECT * FROM assistant_turn WHERE session_id=$1 AND event='processing_completed'",
        [f.id],
      )
    ).rows;
    expect(queued).toHaveLength(1);
    const queuedTask = (await f.raw()).task;
    expect(queuedTask.executionBudget).toEqual(task.executionBudget);
    expect(queuedTask.budgetSegments.at(-1).deadlineAt).toBe(
      task.turnBudget.deadlineAt,
    );
    dispatch = true;
    const done = await finish(f.id);
    expect(done.latestTurn.status, JSON.stringify(done)).toBe("succeeded");
    dispatch = false;
    await tasks.collectProcessingEvents(db);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_turn WHERE session_id=$1 AND event='processing_completed'",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const final = (await f.raw()).task;
    expect(final.executionBudget.modelSteps).toBeGreaterThan(
      task.executionBudget.modelSteps,
    );
    expect(final.stage).toBe("awaiting_review");
    expect(
      (
        await db.query("SELECT tool_results FROM assistant_turn WHERE id=$1", [
          queued[0].id,
        ])
      ).rows[0].tool_results,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "read_processing",
          status: "succeeded",
        }),
      ]),
    );
  });
  it("OPT45 recovery rejects a stale displayed revision or action before queueing", async () => {
    const f = await fixture(),
      row = await f.raw(),
      n = calls.length;
    const send = (
      expectedTaskRevision: number,
      expectedRecoveryAction: string,
    ) =>
      app.inject({
        method: "POST",
        url: base() + "/sessions/" + f.id + "/retry",
        headers,
        payload: { expectedTaskRevision, expectedRecoveryAction },
      });
    expect(
      (await send(row.task_revision - 1, "continue_plan")).statusCode,
    ).toBe(409);
    expect((await send(row.task_revision, "retry_turn")).statusCode).toBe(409);
    expect(calls.length).toBe(n);
    expect((await send(row.task_revision, "continue_plan")).statusCode).toBe(
      200,
    );
  });
  it("OPT45 preserves the actual saved plan when only its reply summary fails", async () => {
    const f = await fixture(50000),
      row = await f.raw();
    row.task.planningRecovery = null;
    row.task.planValidationRequired = false;
    row.task.turnControl.requiresUpdate = false;
    row.task.turnControl.updateSaved = true;
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      JSON.stringify(row.task),
    ]);
    const state = await read(f.id);
    expect(state.task.feedback).toMatchObject({
      kind: "plan",
      requirementsSaved: true,
      summaryFailed: true,
      planReady: true,
    });
    expect(state.task.feedback.message).toContain("总结未完成");
    expect(state.task.executionPlan.steps.length).toBeGreaterThan(0);
  });
  it("OPT45 read exposes a validated business conflict rather than claiming a ready saved plan", async () => {
    const f = await fixture(50000),
      row = await f.raw();
    Object.assign(row.task, {
      planValidationRequired: false,
      planningRecovery: null,
      question: null,
      targetCount: 3,
      executionPlan: { mode: "plan", current: 0, steps: [] },
      classifications: [
        { field: "expectedOutput", quotas: [{ value: "物流", count: 4 }] },
      ],
    });
    row.task.turnControl = { requiresUpdate: false, updateSaved: true };
    await db.query("UPDATE assistant_session SET task=$2 WHERE id=$1", [
      f.id,
      JSON.stringify(row.task),
    ]);
    const state = await read(f.id);
    expect(state.task.feedback.kind).toBe("input");
    expect(state.task.feedback.message).toContain("配额合计4条");
    expect(state.task.feedback.planReady).toBe(false);
  });
});
