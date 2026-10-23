import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const base = "/api/projects/opt50/assistant";
const url = "/projects/opt50/assistant/session-a";
const limits = {
  modelSteps: 10,
  toolCalls: 12,
  transportRetries: 2,
  requestAttempts: 12,
  activeMs: 80_000,
};
function initial() {
  return {
    sessionId: "session-a",
    title: "退款方案",
    taskRevision: 4,
    messageRevision: "v4",
    active: false,
    latestTurn: { id: "turn-current", status: "failed" },
    task: {
      taskId: "task-current",
      taskContractVersion: 2,
      title: "退款方案",
      goal: "退款进度与到账时间",
      stage: "waiting_input",
      feedback: {
        kind: "blocked",
        message: "本次修改尚未保存；本次任务已达到执行限额，已有成果保留。",
        requirementsSaved: false,
        requirementsVerified: false,
        planReady: false,
      },
      recoveryDecision: {
        action: null,
        reason: "task_budget_exhausted",
        revision: 4,
        validUntil: null,
        canExecutePlan: false,
        grantOffers: {
          continue: {
            id: "offer-a",
            taskId: "task-current",
            actorId: "actor",
            revision: 4,
            purpose: "continue",
            validUntil: Date.now() + 300_000,
            limits,
          },
          repair: null,
        },
      },
      budget: {
        version: 1,
        used: { ...limits, activeMs: 30_000 },
        authorized: limits,
        activeRemaining: { ...limits, modelSteps: 0 },
        grantCount: 1,
      },
      executionPlan: {
        mode: "plan",
        current: 0,
        steps: [
          {
            id: "step-a",
            title: "退款方案",
            action: "generate_candidates",
            status: "pending",
          },
        ],
      },
      requirementSummary: ["只保存方案", "退款进度3条、到账时间2条"],
    } as Json,
    turns: [] as Json[],
    proposals: [] as Json[],
    backgroundDocuments: [],
  };
}
async function fixture(page: Page) {
  let state = initial();
  let messages: Json[] = [
    {
      id: "turn-current",
      taskId: "task-current",
      userText: "修改为3+2，先不生成",
      assistantText: "",
      status: "failed",
      errorCode: "assistant_tool_input_invalid",
      tools: [],
    },
  ];
  const sent: { path: string; body: Json; key: string | undefined }[] = [];
  let onPost:
    | ((route: Route, path: string, body: Json) => Promise<void>)
    | undefined;
  await page.context().route("**/api/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      path = u.pathname;
    const ok = (json: unknown) => route.fulfill({ json });
    if (req.method() === "POST" && path.startsWith(base)) {
      const body = req.postDataJSON() as Json;
      sent.push({ path, body, key: req.headers()["idempotency-key"] });
      if (onPost) return onPost(route, path, body);
      return ok({ accepted: true, turnId: "turn-new" });
    }
    if (path === "/api/installation") return ok({ needsAdministrator: false });
    if (path === "/api/session")
      return ok({ csrfToken: "test", actor: { id: "actor", role: "admin" } });
    if (path === "/api/me")
      return ok({
        account: {
          id: "actor",
          email: "fixture@example.test",
          displayName: "测试",
          avatarColor: "#2563eb",
          role: "admin",
        },
      });
    if (path === "/api/me/invitations") return ok({ invitations: [] });
    if (path === "/api/projects/opt50/access")
      return ok({
        access: {
          role: "admin",
          capabilities: { read: true, write: true, export: true, manage: true },
        },
      });
    if (path.endsWith("/presence")) return ok({ users: [] });
    if (path === "/api/projects")
      return ok({
        projects: [
          {
            id: "opt50",
            name: "续接测试",
            description: "",
            datasetCount: 0,
            testSetCount: 0,
            updatedAt: "2026-10-23",
          },
        ],
        pagination: { total: 1 },
      });
    if (path === base + "/sessions")
      return ok({
        sessions: [{ id: "session-a", title: "退款方案", ordinal: 1 }],
        pagination: { total: 1 },
      });
    if (path === base + "/sessions/session-a/tasks/task-old")
      return ok({
        active: false,
        taskId: "task-old",
        taskRevision: 2,
        savedAt: "2026-10-22T00:00:00Z",
        task: {
          taskId: "task-old",
          title: "旧退款方案",
          goal: "旧退款方案",
          stage: "planning",
          budget: state.task.budget,
          requirementSummary: ["旧要求"],
          executionPlan: {
            mode: "plan",
            current: 0,
            steps: [
              {
                title: "旧计划",
                action: "generate_candidates",
                status: "pending",
              },
            ],
          },
        },
      });
    if (path === base + "/sessions/session-a") {
      if (u.searchParams.get("view") === "messages")
        return ok({
          ...state,
          turns: messages,
          pagination: {
            total: 125,
            nextBefore: u.searchParams.has("before") ? null : "earlier",
          },
        });
      return ok(state);
    }
    return ok({});
  });
  return {
    get state() {
      return state;
    },
    set state(v) {
      state = v;
    },
    get messages() {
      return messages;
    },
    set messages(v) {
      messages = v;
    },
    sent,
    set post(fn: typeof onPost) {
      onPost = fn;
    },
    open: () => page.goto(url),
  };
}

test("OPT50 bounded grant requires explicit confirmation and posts only the frozen offer", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await expect(
    page.getByRole("button", { name: "查看继续额度", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "继续规划", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "向项目助手发送消息" })
    .fill("稍后再改");
  await page.getByRole("button", { name: "查看继续额度", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("最多再执行一段");
  await expect(dialog).toContainText("80 秒");
  await expect(dialog).toContainText("退款方案");
  expect(f.sent).toHaveLength(0);
  f.post = async (route) => {
    f.state = {
      ...f.state,
      taskRevision: 4,
      messageRevision: "v5",
      task: {
        ...f.state.task,
        recoveryDecision: {
          action: null,
          reason: "waiting",
          revision: 4,
          validUntil: null,
          canExecutePlan: false,
        },
        feedback: {
          kind: "processing",
          message: "正在原授权内继续",
          requirementsSaved: false,
        },
      },
    };
    await route.fulfill({ json: { accepted: true } });
  };
  await dialog
    .getByRole("button", { name: "确认授权并继续", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({
    path: base + "/sessions/session-a/grant",
    body: {
      expectedTaskRevision: 4,
      offerId: "offer-a",
      purpose: "continue",
      accept: true,
    },
  });
  expect(f.sent[0].key).toBeTruthy();
  expect(Object.keys(f.sent[0].body)).toHaveLength(4);
  await expect(
    page.getByRole("textbox", { name: "向项目助手发送消息" }),
  ).toHaveValue("稍后再改");
});

test("OPT50 repair grant names a new bounded repair attempt, never an ordinary retry", async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.task.recoveryDecision = {
    action: null,
    reason: "repair_limit",
    revision: 4,
    validUntil: null,
    canExecutePlan: false,
    grantOffers: {
      continue: null,
      repair: {
        id: "repair-offer",
        taskId: "task-current",
        actorId: "actor",
        revision: 4,
        purpose: "repair",
        validUntil: Date.now() + 300_000,
        limits,
      },
    },
  };
  await f.open();
  await expect(
    page.getByRole("button", { name: "查看继续额度", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查看修复额度", exact: true }).click();
  const d = page.getByRole("dialog");
  await expect(d).toContainText("未保存修改");
  await expect(d).toContainText("旧消耗和失败记录保留");
  await d.getByRole("button", { name: "暂不授权", exact: true }).click();
  expect(f.sent).toHaveLength(0);
});

test("OPT50 stale grant refreshes authority without losing input or silently accepting a new offer", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page
    .getByRole("textbox", { name: "向项目助手发送消息" })
    .fill("我还没有发出的要求");
  await page.getByRole("button", { name: "查看继续额度", exact: true }).click();
  f.post = async (route) => {
    f.state = {
      ...f.state,
      taskRevision: 5,
      messageRevision: "v5",
      task: {
        ...f.state.task,
        recoveryDecision: {
          action: null,
          reason: "permission_denied",
          revision: 5,
          validUntil: null,
          canExecutePlan: false,
        },
        feedback: {
          kind: "blocked",
          message: "当前权限已变化，请核对访问权限。",
          requirementsSaved: false,
        },
      },
    };
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: "assistant_retry_unavailable",
          reason: "permission_denied",
          recoveryMessage: "当前权限已变化，请核对访问权限。",
        },
      },
    });
  };
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认授权并继续", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("额度信息已更新");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "确认授权并继续", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "暂不授权", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "向项目助手发送消息" }),
  ).toHaveValue("我还没有发出的要求");
  await expect(
    page.getByText("当前权限已变化，请核对访问权限。").first(),
  ).toBeVisible();
  expect(f.sent).toHaveLength(1);
});

test("OPT50 grant expiration disables confirmation and refetches current capability", async ({
  page,
}) => {
  await page.clock.install();
  const f = await fixture(page);
  f.state.task.recoveryDecision = {
    action: null,
    reason: "task_budget_exhausted",
    revision: 4,
    validUntil: null,
    canExecutePlan: false,
    grantOffers: {
      continue: {
        id: "short-offer",
        taskId: "task-current",
        actorId: "actor",
        revision: 4,
        purpose: "continue",
        validUntil: Date.now() + 3000,
        limits,
      },
      repair: null,
    },
  };
  await f.open();
  await page.getByRole("button", { name: "查看继续额度", exact: true }).click();
  await page.clock.fastForward(4000);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "确认授权并继续", exact: true }),
  ).toBeDisabled();
  expect(f.sent).toHaveLength(0);
});

test("OPT50 rejected message uses current server reason and preserves unsent text", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  const input = page.getByRole("textbox", { name: "向项目助手发送消息" });
  await input.fill("继续保存方案，先不要执行");
  f.post = (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "assistant_retry_unavailable",
          reason: "task_budget_exhausted",
          recoveryMessage: "本次任务已达到执行限额，已有成果保留。",
        },
      },
    });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(input).toHaveValue("继续保存方案，先不要执行");
  await expect(
    page.getByRole("alert").filter({ hasText: "本次任务已达到执行限额" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新提交这条", exact: true }),
  ).toHaveCount(0);
  expect(f.sent).toHaveLength(1);
});

test("OPT50 historical task is read-only, and its pending confirmation never acts on the current task", async ({
  page,
}) => {
  const f = await fixture(page);
  f.messages = [
    {
      id: "old-turn",
      taskId: "task-old",
      userText: "旧任务",
      assistantText: "旧方案已保存",
      status: "succeeded",
      errorCode: null,
      tools: [],
    },
    ...f.messages,
  ];
  f.state.proposals = [
    {
      id: "old-proposal",
      turn_id: "old-turn",
      status: "pending",
      action: "processing",
      summary: { title: "旧任务采用", target: "旧草稿", count: 2 },
      expires_at: new Date(Date.now() + 300000).toISOString(),
    },
  ];
  await f.open();
  await expect(
    page.getByRole("button", { name: "确认采用", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "查看历史任务", exact: true }).click();
  const d = page.getByRole("dialog");
  await expect(d).toContainText("旧退款方案");
  await expect(d).toContainText("旧要求");
  expect(f.sent).toHaveLength(0);
  await d.getByRole("button", { name: "填入恢复请求", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "向项目助手发送消息" }),
  ).toHaveValue("恢复任务“旧退款方案”");
  expect(f.sent).toHaveLength(0);
});

test("OPT50 480px keyboard flow and long history keep completed facts ahead of old errors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 850 });
  const f = await fixture(page);
  f.state.task = {
    ...f.state.task,
    stage: "complete",
    feedback: {
      kind: "complete",
      message: "当前目标已完成，已保存成果可在工作区查看。",
      requirementsSaved: true,
    },
    recoveryDecision: {
      action: null,
      reason: "complete",
      revision: 4,
      validUntil: null,
      canExecutePlan: false,
    },
  };
  await f.open();
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "加载更早消息", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("当前目标已完成，已保存成果可在工作区查看。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /继续规划|重试本轮|查看继续额度/ }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "向项目助手发送消息" }).focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole("log")).toContainText("本轮诊断");
});

test("OPT50 automatic segment polling advances three checkpoints without another user prompt", async ({
  page,
}) => {
  const f = await fixture(page);
  f.messages = [
    {
      id: "segment-1",
      taskId: "task-current",
      userText: "按已保存方案执行",
      assistantText: "",
      status: "running",
      errorCode: null,
      tools: [],
    },
  ];
  f.state = {
    ...f.state,
    active: true,
    messageRevision: "segment-1",
    task: {
      ...f.state.task,
      stage: "yielding",
      feedback: { kind: "idle", message: "", requirementsSaved: true },
      recoveryDecision: {
        action: null,
        reason: "busy",
        revision: 4,
        validUntil: null,
        canExecutePlan: false,
      },
    },
  };
  await f.open();
  await expect(page.getByRole("log")).toContainText("正在处理");
  for (let n = 2; n <= 3; n++) {
    f.messages = [
      {
        id: "segment-" + n,
        taskId: "task-current",
        userText: "",
        assistantText: "检查点" + n,
        status: "running",
        event: "continuation",
        errorCode: null,
        tools: [],
      },
    ];
    f.state = { ...f.state, messageRevision: "segment-" + n };
    await expect(page.getByRole("log")).toContainText("检查点" + n);
  }
  f.messages = [
    {
      id: "done",
      taskId: "task-current",
      userText: "",
      assistantText: "已完成",
      status: "succeeded",
      event: "continuation",
      errorCode: null,
      tools: [],
    },
  ];
  f.state = {
    ...f.state,
    active: false,
    messageRevision: "done",
    task: {
      ...f.state.task,
      stage: "complete",
      feedback: {
        kind: "complete",
        message: "当前目标已完成，已保存成果可在工作区查看。",
        requirementsSaved: true,
      },
      recoveryDecision: {
        action: null,
        reason: "complete",
        revision: 4,
        validUntil: null,
        canExecutePlan: false,
      },
    },
  };
  await expect(
    page.getByText("当前目标已完成，已保存成果可在工作区查看。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("log")).toContainText("已完成");
  expect(f.sent).toHaveLength(0);
});

test("OPT50 task switch ignores a late historical running turn and historical action", async ({
  page,
}) => {
  const f = await fixture(page);
  f.messages = [
    {
      id: "late-old",
      taskId: "task-old",
      userText: "旧目标",
      assistantText: "迟到回执",
      status: "running",
      errorCode: null,
      tools: [],
    },
    ...f.messages,
  ];
  f.state.task = {
    ...f.state.task,
    feedback: {
      kind: "plan",
      message: "方案已保存，尚未执行。",
      requirementsSaved: true,
      planReady: true,
    },
    recoveryDecision: {
      action: null,
      reason: "complete",
      revision: 4,
      validUntil: null,
      canExecutePlan: false,
    },
  };
  await f.open();
  await page
    .getByRole("textbox", { name: "向项目助手发送消息" })
    .fill("新的要求");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("方案已保存，尚未执行。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看历史任务", exact: true }),
  ).toBeVisible();
  expect(f.sent).toHaveLength(0);
});

test("OPT50 two tabs keep one accepted grant and refresh the rejected stale tab", async ({
  page,
  context,
}) => {
  const f = await fixture(page);
  await f.open();
  const other = await context.newPage();
  await other.goto(url);
  for (const p of [page, other])
    await p.getByRole("button", { name: "查看继续额度", exact: true }).click();
  let grants = 0;
  f.post = async (route) => {
    if (grants) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "assistant_retry_unavailable",
            recoveryMessage: "额度已由另一标签页使用，请查看当前进度。",
          },
        },
      });
      return;
    }
    grants++;
    f.state = {
      ...f.state,
      task: {
        ...f.state.task,
        recoveryDecision: {
          action: null,
          reason: "busy",
          revision: 4,
          validUntil: null,
          canExecutePlan: false,
        },
        feedback: {
          kind: "processing",
          message: "已受理继续",
          requirementsSaved: true,
        },
      },
    };
    await route.fulfill({ json: { accepted: true } });
  };
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认授权并继续", exact: true })
    .click();
  await other
    .getByRole("dialog")
    .getByRole("button", { name: "确认授权并继续", exact: true })
    .click();
  await expect(
    other
      .getByRole("dialog")
      .getByRole("button", { name: "确认授权并继续", exact: true }),
  ).toBeDisabled();
  expect(grants).toBe(1);
  expect(f.sent).toHaveLength(2);
});

test("OPT50 initial status hydration preserves the pending idempotency identity after refresh", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "evalbase:assistant:actor:opt50:session-a",
      JSON.stringify({
        message: "先保存方案",
        pending: {
          message: "先保存方案",
          key: "persisted-key",
          sessionId: "session-a",
          taskId: "task-current",
          expectedTaskRevision: 4,
          status: "failed",
        },
      }),
    ),
  );
  const f = await fixture(page);
  await f.open();
  await expect(
    page.getByText("本次修改尚未保存；本次任务已达到执行限额，已有成果保留。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新提交这条", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新提交这条", exact: true }).click();
  expect(f.sent[0]?.key).toBe("persisted-key");
});

test("OPT50 long grant dialog stays operable by keyboard at 480px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 850 });
  const f = await fixture(page);
  f.state.task = {
    ...f.state.task,
    requirementSummary: Array.from(
      { length: 9 },
      (_, i) => "要求" + i + "保留必要事实。".repeat(60),
    ),
    continuation: {
      pendingRequest: "修改要求".repeat(180),
      remainingSteps: Array.from({ length: 20 }, (_, i) => "核对步骤" + i),
    },
  };
  await f.open();
  await page.getByRole("button", { name: "查看继续额度", exact: true }).click();
  const d = page.getByRole("dialog");
  await expect(d).toBeVisible();
  const box = await d.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(850);
  const cancel = d.getByRole("button", { name: "暂不授权", exact: true });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(d).toHaveCount(0);
  expect(f.sent).toHaveLength(0);
});

test("OPT50 historical restore binds the chosen identity even when titles are duplicated", async ({
  page,
}) => {
  const f = await fixture(page);
  f.messages = [
    {
      id: "old-turn",
      taskId: "task-old",
      userText: "旧目标",
      assistantText: "旧方案",
      status: "succeeded",
      errorCode: null,
      tools: [],
    },
    ...f.messages,
  ];
  await f.open();
  await page.getByRole("button", { name: "查看历史任务", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "填入恢复请求", exact: true })
    .click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect(f.sent[0]?.body).toMatchObject({
    restoreTaskId: "task-old",
    expectedTaskRevision: 4,
  });
  expect(f.sent[0]?.body).not.toHaveProperty("operation");
});
