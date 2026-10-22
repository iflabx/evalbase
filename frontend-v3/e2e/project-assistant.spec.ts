import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

const base = "/api/projects/assistant_project/assistant";
const url = "/projects/assistant_project/assistant";
const turn = (id: string, text = "已有回复") => ({
  id,
  event: "user",
  userText: `要求 ${id}`,
  assistantText: text,
  status: "succeeded",
  tools: [],
});
async function fixture(
  page: Page,
  options: {
    empty?: boolean;
    task?: any;
    messages?: any[];
    docs?: any[];
    proposals?: any[];
    intercept?: (route: Route, state: any) => Promise<boolean>;
  } = {},
) {
  const state = {
    sessions: options.empty
      ? []
      : [{ id: "one", title: "整理资料", ordinal: 1, updated_at: "2026-10-14T08:00:00Z" }],
    task: options.task ?? {},
    messages: options.messages ?? [turn("t0")],
    docs: options.docs ?? [],
    proposals: options.proposals ?? [],
    revision: 7,
    active: false,
    denied: false,
    posts: [] as any[],
    reads: [] as { view: string; bytes: number; elapsed: number }[],
    candidates: 0,
    excerpts: 0,
    actor: "admin",
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      parsed = new URL(request.url()),
      path = parsed.pathname;
    const started = Date.now();
    const reply = (json: any, status = 200) => {
      if (parsed.searchParams.has("view"))
        state.reads.push({
          view: parsed.searchParams.get("view")!,
          bytes: JSON.stringify(json).length,
          elapsed: Date.now() - started,
        });
      return route.fulfill({ status, json });
    };
    if (options.intercept && (await options.intercept(route, state))) return;
    if (path === "/api/session")
      return reply({ csrfToken: "csrf", actor: { id: state.actor, role: "admin" } });
    if (await mockAccountRoute(route)) return;
    if (path === "/api/projects")
      return reply({
        projects: [{ id: "assistant_project", name: "助手验收项目" }],
        pagination: { total: 1 },
      });
    if (path === `${base}/sessions`) {
      if (request.method() === "POST") {
        state.posts.push({ path, body: request.postDataJSON() });
        state.sessions.push({
          id: "new",
          title: "新会话",
          ordinal: 2,
          updated_at: "2026-10-14T09:00:00Z",
        });
        state.messages = [];
        return reply({ sessionId: "new" }, 201);
      }
      const matches = state.sessions.filter((s) =>
        s.title.includes(parsed.searchParams.get("search") ?? ""),
      );
      const source = parsed.searchParams.get("sourceId");
      return reply({
        sessions: matches,
        pagination: { total: matches.length },
        ...(source ? { pageContext: { name: `资料 ${source}` } } : {}),
      });
    }
    if (/\/sessions\/[^/]+\/status$/.test(path))
      return reply({ exists: Boolean(state.sessions.length) });
    if (/\/sessions\/[^/]+$/.test(path)) {
      const id = path.split("/").at(-1)!;
      if (request.method() === "PATCH") {
        const title = request.postDataJSON().title;
        state.sessions.find((s) => s.id === id)!.title = title;
        return reply({ sessionId: id, title });
      }
      if (request.method() === "DELETE") {
        state.posts.push({ path, method: "DELETE" });
        state.sessions = state.sessions.filter((s) => s.id !== id);
        state.messages = [];
        return reply({ deleted: true });
      }
      if (state.denied || !state.sessions.some((s) => s.id === id))
        return reply({ error: { code: "assistant_not_found" } }, 404);
      const title = state.sessions.find((s) => s.id === id)!.title;
      const status = {
        sessionId: id,
        title,
        task: state.task.recoveryDecision
          ? state.task
          : {
              ...state.task,
              recoveryDecision: {
                action: state.task.canRetryTurn ? "retry_turn" : null,
                reason: "legacy_fixture",
                revision: state.revision,
                validUntil: state.task.canRetryTurn ? Date.now() + 60000 : null,
                canExecutePlan:
                  state.task.canContinueExecution !== false &&
                  Boolean(state.task.executionPlan?.steps.length) &&
                  !state.task.executionPlan?.needsReview,
              },
            },
        taskRevision: state.revision,
        messageRevision: `${state.revision}:${state.messages.length}:${state.messages.at(-1)?.status}`,
        active: state.active,
        latestTurn: state.messages.length
          ? { id: state.messages.at(-1)!.id, status: state.messages.at(-1)!.status }
          : null,
        backgroundDocuments: state.docs,
        proposals: state.proposals,
      };
      if (parsed.searchParams.get("view") === "status") return reply(status);
      const before = parsed.searchParams.get("before"),
        end = before ? state.messages.findIndex((t) => t.id === before) : state.messages.length;
      const selected = state.messages.slice(Math.max(0, end - 20), end);
      return reply({
        ...status,
        turns: selected,
        pagination: { total: state.messages.length, nextBefore: end > 20 ? selected[0].id : null },
      });
    }
    if (path.endsWith("/turns")) {
      const body = request.postDataJSON();
      state.posts.push({ path, body, key: request.headers()["idempotency-key"] });
      state.messages.push({ ...turn("sent", "请求已记录"), userText: body.message });
      state.revision++;
      return reply({ turnId: "sent" }, 202);
    }
    if (path.endsWith("/stop") || path.endsWith("/retry")) {
      state.posts.push({ path });
      state.task = {
        ...state.task,
        stage: path.endsWith("/stop") ? "stopped" : "waiting_input",
        canRetryTurn: false,
        recoveryDecision: {
          action: null,
          reason: "not_recoverable",
          revision: state.revision,
          validUntil: null,
          canExecutePlan: false,
        },
      };
      state.active = false;
      state.messages = state.messages.map((t) => ({ ...t, status: "succeeded" }));
      return reply({ stopped: true });
    }
    if (path.includes("/background-documents/")) {
      state.excerpts++;
      return reply({
        ...state.docs[0],
        fragments: [{ index: 1, page: 13, text: "附件中的真实说明" }],
      });
    }
    if (path.endsWith("/background-documents") && request.method() === "POST") {
      state.posts.push({ path, body: request.postDataJSON() });
      state.docs.push({
        id: "doc",
        fileName: request.postDataJSON().fileName,
        format: "md",
        fileSize: 40,
        units: 1,
        fragmentCount: 1,
      });
      return reply({ document: state.docs[0] }, 201);
    }
    if (path.endsWith("/candidates")) {
      state.candidates++;
      return reply({
        scope: "task",
        reviewRevision: "a".repeat(64),
        taskTotal: 2,
        savedCount: 0,
        records: [0, 1].map((i) => ({
          id: `0:${i}`,
          result: {
            question: `候选问题 ${i + 1}`,
            expectedOutput: "保留答案",
            metadata: [{ key: "类别", value: "一般" }],
          },
          original: { question: `原问题 ${i + 1}`, expectedOutput: "保留答案", metadata: [] },
          changedFields: ["question"],
          sourceLabel: "输入资料",
        })),
        allIds: ["0:0", "0:1"],
        total: 2,
        stats: { all: 2, changed: 2, needsReview: 0 },
      });
    }
    if (path.includes("/processing-runs/") && path.endsWith("/status"))
      return reply({
        run: {
          status: "succeeded",
          inputCount: 2,
          progress: 2,
          partial: false,
          missingCount: 0,
          options: { operation: "rewrite" },
        },
        total: 2,
        recovery: { canRetry: false },
      });
    if (path.includes("/proposals/") && path.endsWith("/confirm")) {
      state.posts.push({ path });
      state.proposals[0].status = "succeeded";
      state.task.stage = "complete";
      return reply({ receipt: {} });
    }
    if (path.endsWith("/solo-test-sets") || path.endsWith("/test-sets"))
      return reply({ testSets: [], pagination: { total: 0 } });
    return reply({ error: { code: "not_found" } }, 404);
  });
  return state;
}
async function overflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("OPT-28 separates the current goal from overall delivery and explains unknown counts", async ({
  page,
}) => {
  const state = await fixture(page, {
    task: {
      goal: "当前类别50条，整体400条",
      stage: "awaiting_review",
      runId: "run",
      overallTargetCount: 400,
      requirementSummary: ["新增候选：50 条", "整体交付：400 条（当前测试集单独核对）"],
      review: {
        runId: "run",
        total: 2,
        expectedCount: null,
        countUnverified: true,
        countSatisfied: false,
        emptyQuestions: 0,
        duplicates: 0,
        protectedFieldChanges: 0,
        labels: [],
        classifications: [],
      },
    },
  });
  await page.goto(`${url}/one`);
  await page.getByRole("button", { name: /^(工作区|打开工作区)$/ }).click();
  await expect(page.getByText("目标数量待确认", { exact: false })).toBeVisible();
  await expect(page.getByText("数量达标", { exact: true })).toHaveCount(0);
  state.task.stage = "complete";
  state.task.review = {
    ...state.task.review,
    expectedCount: 50,
    countUnverified: false,
    countSatisfied: true,
    total: 50,
  };
  await page.reload();
  await expect(page.getByText("当前目标已完成", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 420, height: 900 });
  await overflow(page);
  expect(state.posts).toHaveLength(0);
});

test("OPT-25 completed tasks retain read-only results and history after refresh", async ({
  page,
}) => {
  const state = await fixture(page, {
    task: { goal: "已交付成果", stage: "complete", runId: "run", runIds: ["run"] },
    intercept: async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/candidates")) return false;
      await route.fulfill({
        json: {
          scope: "task",
          reviewRevision: "a".repeat(64),
          taskTotal: 1,
          savedCount: 1,
          savedIds: ["r1"],
          records: [
            {
              id: "r1",
              result: { question: "完成后保留的成果", expectedOutput: "保留答案", metadata: [] },
              changedFields: ["new"],
            },
          ],
          allIds: ["r1"],
          total: 1,
          stats: { all: 1, changed: 1, needsReview: 0 },
          history: [
            { runId: "run", round: 1, operation: "augment", status: "succeeded", count: 1 },
          ],
        },
      });
      return true;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByRole("button", { name: /^(工作区|打开工作区)$/ }).click();
  const results = page.getByRole("region", { name: "候选结果" });
  await expect(results).toContainText("完成后保留的成果");
  await expect(results).toContainText("已保存 1 条");
  await expect(results.getByRole("button", { name: "勾选本页", exact: true })).toBeDisabled();
  await expect(results.getByLabel("选择结果 1", { exact: true })).toBeDisabled();
  await expect(results.getByRole("button", { name: /保存所选/ })).toHaveCount(0);
  await results.getByText("处理历史", { exact: false }).click();
  await expect(results).toContainText("扩充");
  await page.reload();
  await page.getByRole("button", { name: /^(工作区|打开工作区)$/ }).click();
  await expect(results).toContainText("完成后保留的成果");
  await page.setViewportSize({ width: 420, height: 900 });
  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await expect(results).toContainText("完成后保留的成果");
  await overflow(page);
  expect(state.posts).toHaveLength(0);
});

test("OPT-25 cross-page selection survives refresh and saves the fixed task scope", async ({
  page,
}, info) => {
  let reviewRevision = "b".repeat(64);
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: `root${i < 7 ? "A" : "B"}:0:${i % 7}`,
    result: {
      question: `跨批问题 ${i + 1}`,
      expectedOutput: "保留答案",
      metadata: [{ key: "分类", value: "示例" }],
    },
    changedFields: ["question"],
  }));
  const state = await fixture(page, {
    task: {
      title: "跨批审核",
      goal: "整理资料",
      stage: "awaiting_review",
      runId: "runB",
      runIds: ["runA", "runB"],
    },
    intercept: async (route) => {
      const u = new URL(route.request().url());
      if (!u.pathname.endsWith("/candidates")) return false;
      expect(u.searchParams.get("scope")).toBe("task");
      const offset = Number(u.searchParams.get("offset") ?? 0),
        text = u.searchParams.get("search") ?? "",
        filtered = rows.filter((row) => row.result.question.includes(text));
      await route.fulfill({
        json: {
          scope: "task",
          reviewRevision,
          records: filtered.slice(offset, offset + 10),
          allIds: filtered.map((row) => row.id),
          total: filtered.length,
          taskTotal: 14,
          savedCount: 0,
          saveTarget: { kind: "draft", id: "original" },
          stats: { all: 14, changed: 14, needsReview: 0 },
          history: [
            { runId: "runA", round: 1, count: 7, operation: "clean" },
            { runId: "runB", round: 1, count: 7, operation: "clean" },
          ],
        },
      });
      return true;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("选择结果 1", { exact: true }).click();
  await page.getByRole("button", { name: "下一页候选" }).click();
  await page.getByLabel("选择结果 11").click();
  await expect(page.getByText("已选 2 条候选", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked();
  await expect(page.getByText("已选 2 条候选", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("opt25-results-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 420, height: 900 });
  await overflow(page);
  await page.screenshot({ path: info.outputPath("opt25-results-420.png"), fullPage: true });
  reviewRevision = "c".repeat(64);
  await page.reload();
  await expect(
    page.getByText("成果已更新，原勾选范围已失效。请清空选择后重新核对。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "保存所选回原草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByLabel("选择结果 1", { exact: true }).click();
  await page.getByRole("button", { name: "保存所选回原草稿" }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  expect(state.posts.at(-1).body).toMatchObject({
    message: "将勾选成果保存回原草稿",
    candidates: { scope: "task", reviewRevision, resultIds: [rows[0]!.id] },
  });
});

test("OPT-25 a rejected stale submission refreshes results and uses a new key after reselecting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  let revision = "a".repeat(64);
  const keys: string[] = [];
  const state = await fixture(page, {
    task: { goal: "整理资料", stage: "awaiting_review", runId: "run" },
    intercept: async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/candidates")) {
        await route.fulfill({
          json: {
            scope: "task",
            reviewRevision: revision,
            records: [
              {
                id: "origin:0:0",
                result: { question: "当前问题", expectedOutput: "答案", metadata: [] },
              },
            ],
            allIds: ["origin:0:0"],
            total: 1,
            stats: { all: 1, changed: 0, needsReview: 0 },
          },
        });
        return true;
      }
      if (u.pathname.endsWith("/turns")) {
        keys.push(route.request().headers()["idempotency-key"]!);
        if (keys.length === 1) {
          revision = "d".repeat(64);
          await route.fulfill({
            status: 409,
            json: { error: { code: "assistant_candidate_selection_changed" } },
          });
          return true;
        }
      }
      return false;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("选择结果 1", { exact: true }).click();
  await page.getByLabel("向项目助手发送消息").fill("只改这条");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("成果已更新，原勾选范围已失效。请清空选择后重新核对。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByLabel("选择结果 1", { exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  expect(keys[0]).not.toBe(keys[1]);
  expect(state.posts.at(-1).body.candidates.reviewRevision).toBe(revision);
});

test("OPT-25 clearing selection clears the persisted server range on the next request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const state = await fixture(page, {
    task: { goal: "整理资料", stage: "awaiting_review", runId: "run" },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("选择结果 1", { exact: true }).click();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByLabel("向项目助手发送消息").fill("只核对全部结果");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  expect(state.posts.at(-1).body.candidates).toBeNull();
});

test("OPT-24 a delayed pre-submission status cannot hide an accepted first turn", async ({
  page,
}) => {
  let first = true,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, {
    empty: true,
    messages: [],
    intercept: async (route, state) => {
      const u = new URL(route.request().url());
      if (
        u.pathname === `${base}/sessions/new` &&
        u.searchParams.get("view") === "status" &&
        first
      ) {
        first = false;
        await gate;
        await route.fulfill({
          json: {
            sessionId: "new",
            title: "新会话",
            task: {},
            taskRevision: 7,
            messageRevision: "before-send",
            active: false,
            latestTurn: null,
            proposals: [],
            backgroundDocuments: [],
          },
        });
        return true;
      }
      if (u.pathname.endsWith("/turns")) {
        state.posts.push({ path: u.pathname });
        state.active = true;
        state.revision++;
        state.task = { goal: "实际处理", stage: "processing" };
        state.messages.push({
          ...turn("accepted-first", ""),
          status: "running",
          userText: route.request().postDataJSON().message,
        });
        await route.fulfill({ status: 202, json: { turnId: "accepted-first" } });
        return true;
      }
      return false;
    },
  });
  await page.goto(url);
  await page.getByLabel("向项目助手发送消息").fill("处理资料");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  release();
  await expect(page.getByRole("status").first()).toHaveText("处理中");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  state.active = false;
  state.task.stage = "awaiting_confirmation";
  state.messages.at(-1)!.status = "succeeded";
  await expect(page.getByRole("status").first()).toHaveText("等待确认");
});

for (const code of [403, 404])
  test(`OPT-24 unavailable remembered session ${code} falls back without creating a session`, async ({
    page,
  }) => {
    const state = await fixture(page, {
      intercept: async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === `${base}/sessions/old` && u.searchParams.get("view") === "status") {
          await route.fulfill({ status: code, json: { error: { code: "assistant_not_found" } } });
          return true;
        }
        return false;
      },
    });
    await page.addInitScript(() =>
      sessionStorage.setItem("evalbase:assistant:admin:assistant_project:last", "old"),
    );
    await page.goto(url);
    await expect(page).toHaveURL(/\/assistant\/one$/);
    await expect(page.getByRole("log")).toContainText("已有回复");
    expect(state.posts).toHaveLength(0);
  });

test("OPT-24 a usable remembered session outside the first page remains the selected session", async ({
  page,
}) => {
  const state = await fixture(page, {
    intercept: async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === `${base}/sessions/older`) {
        await route.fulfill({
          json: {
            sessionId: "older",
            title: "较早的个人会话",
            task: {},
            taskRevision: 2,
            messageRevision: "older",
            active: false,
            latestTurn: { id: "old-turn", status: "succeeded" },
            backgroundDocuments: [],
            proposals: [],
            ...(u.searchParams.get("view") === "messages"
              ? {
                  turns: [turn("old-turn", "较早的回复")],
                  pagination: { total: 1, nextBefore: null },
                }
              : {}),
          },
        });
        return true;
      }
      return false;
    },
  });
  await page.addInitScript(() =>
    sessionStorage.setItem("evalbase:assistant:admin:assistant_project:last", "older"),
  );
  await page.goto(url);
  await expect(page).toHaveURL(/\/assistant\/older$/);
  await expect(page.getByRole("log")).toContainText("较早的回复");
  expect(state.posts).toHaveLength(0);
});

test("OPT-24 acknowledged messages do not keep polling after an automatic continuation reaches confirmation", async ({
  page,
}) => {
  const state = await fixture(page, {
    intercept: async (route, state) => {
      if (!route.request().url().endsWith("/turns")) return false;
      state.posts.push({ path: new URL(route.request().url()).pathname });
      state.messages.push(
        { ...turn("accepted"), userText: route.request().postDataJSON().message },
        { ...turn("continued", "结果已就绪"), event: "processing_completed", userText: null },
      );
      state.revision++;
      state.active = false;
      state.task = { stage: "awaiting_confirmation", goal: "待采用" };
      await route.fulfill({ status: 202, json: { turnId: "accepted" } });
      return true;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("向项目助手发送消息").fill("处理资料");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("结果已就绪");
  await expect(page.getByText("已受理，正在处理…", { exact: true })).toHaveCount(0);
  const reads = state.reads.filter((r) => r.view === "status").length;
  await page.waitForTimeout(2200);
  expect(state.reads.filter((r) => r.view === "status").length).toBe(reads);
});

test("OPT-24 background upload keeps unsent text without executing it", async ({ page }) => {
  const state = await fixture(page, { empty: true, messages: [] });
  await page.goto(url);
  await page.getByLabel("向项目助手发送消息").fill("先读文档，暂不执行");
  await page.getByRole("button", { name: "背景附件", exact: true }).click();
  await page.getByLabel("上传背景文档").setInputFiles({
    name: "说明.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 说明\n仅用于测试背景"),
  });
  await expect(page).toHaveURL(/\/assistant\/new/);
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("先读文档，暂不执行");
  await page.getByRole("button", { name: "背景附件", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看背景 说明.md" })).toBeVisible();
  expect(state.posts.filter((p) => p.path.endsWith("/turns"))).toHaveLength(0);
});

test("OPT-24 failed submissions preserve later text and replay the same request key", async ({
  page,
}) => {
  let attempt = 0,
    entered!: () => void,
    release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, {
    intercept: async (route, state) => {
      if (route.request().url().endsWith("/turns") && ++attempt === 1) {
        state.posts.push({
          path: new URL(route.request().url()).pathname,
          body: route.request().postDataJSON(),
          key: route.request().headers()["idempotency-key"],
        });
        entered();
        await gate;
        await route.fulfill({ status: 503, json: { error: { code: "temporary" } } });
        return true;
      }
      return false;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("向项目助手发送消息").fill("第一条要求");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await ready;
  await page.getByLabel("向项目助手发送消息").fill("稍后发送的新要求");
  release();
  await expect(page.getByRole("button", { name: "重新提交这条", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新提交这条", exact: true }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(2);
  const sends = state.posts.filter((p) => p.path.endsWith("/turns"));
  expect(sends[1].key).toBe(sends[0].key);
  expect(sends[1].body.message).toBe("第一条要求");
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("稍后发送的新要求");
});

test("OPT-24 empty page and examples create nothing; explicit first message creates one session", async ({
  page,
}, testInfo) => {
  const state = await fixture(page, { empty: true, messages: [] });
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "先帮我设计方案", exact: true }).click();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("先帮我设计方案");
  expect(state.posts).toHaveLength(0);
  await page.reload();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("先帮我设计方案");
  expect(state.candidates).toBe(0);
  expect(state.excerpts).toBe(0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page).toHaveURL(/\/assistant\/new/);
  await expect(page.getByRole("log")).toContainText("请求已记录");
  expect(state.posts.filter((p) => p.path === `${base}/sessions`)).toHaveLength(1);
  expect(state.posts.filter((p) => p.path.endsWith("/turns"))).toHaveLength(1);
  await overflow(page);
  await page.screenshot({ path: testInfo.outputPath("opt24-empty-1440.png"), fullPage: true });
});

test("OPT-24 deep links refresh and return without duplicate turns or private data on invalid links", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`${url}/one`);
  await expect(page.getByRole("log")).toContainText("已有回复");
  await page.getByLabel("向项目助手发送消息").fill("未发送要求");
  await page.goto(`${url}/missing`);
  await expect(page.getByRole("alert")).toContainText("不可访问");
  await expect(page.getByText("已有回复", { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("未发送要求");
  await page.reload();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("未发送要求");
  expect(state.posts).toHaveLength(0);
});

for (const [kind, path, source] of [
  ["draft", "/projects/assistant_project/test-sets/drafts/draft", "draft"],
  ["asset", "/projects/assistant_project/datasets/collection/files/file", "file"],
  ["version", "/projects/assistant_project/test-sets/set?version=version", "version"],
] as const)
  test(`OPT-24 ${kind} entry brings checked context only when a message is sent`, async ({
    page,
  }) => {
    const state = await fixture(page, {
      task: { goal: "已有任务", stage: "waiting_input", targetName: "原任务资料" },
    });
    await page.goto(path);
    await page.getByRole("link", { name: "打开项目助手" }).click();
    await expect(page).toHaveURL(new RegExp(`/assistant/one\\?.*sourceKind=${kind}`));
    await expect(
      page.getByText(
        `所选${kind === "draft" ? "草稿" : kind === "asset" ? "原始数据" : "版本"}：资料 ${source}`,
        { exact: true },
      ),
    ).toBeVisible();
    expect(state.posts).toHaveLength(0);
    expect(state.task.targetName).toBe("原任务资料");
    await page.getByLabel("向项目助手发送消息").fill("查询所选资料");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
    expect(state.posts.at(-1).body.context).toEqual({ kind, id: source });
  });

test("OPT-24 name search, rename failure and confirmed deletion retain the user's input", async ({
  page,
}) => {
  let rename = 0;
  const state = await fixture(page, {
    intercept: async (route) => {
      if (route.request().method() === "PATCH" && ++rename === 1) {
        await route.fulfill({ status: 503, json: { error: { code: "temporary" } } });
        return true;
      }
      return false;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("向项目助手发送消息").fill("保留此输入");
  await page.getByLabel("搜索助手会话").fill("不匹配");
  await expect(page.getByText("没有匹配会话", { exact: true })).toBeVisible();
  await page.getByLabel("搜索助手会话").fill("");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名会话" });
  await dialog.getByLabel("会话名称").fill("我的会话");
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(dialog.getByRole("alert")).toContainText("名称已保留");
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("我的会话");
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("保留此输入");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "删除会话" }).click();
  const remove = page.getByRole("alertdialog");
  await expect(remove).toContainText("已创建的资料、草稿和正式版本保留");
  await remove.getByRole("button", { name: "取消", exact: true }).click();
  expect(state.posts).toHaveLength(0);
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "删除会话" }).click();
  await remove.getByRole("button", { name: "确认删除会话" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
  expect(state.posts.filter((p) => p.method === "DELETE")).toHaveLength(1);
});

test("OPT-24 safe Markdown renders lists, code and tables without HTML, embeds or invented confirmation", async ({
  page,
}) => {
  await fixture(page, {
    messages: [
      turn(
        "markdown",
        "**结果**\n- 一项\n- 二项\n\n```js\n<script>window.bad=true</script>\n```\n\n| 名称 | 数量 |\n| --- | --- |\n| 候选 | 2 |\n\n<img src=https://invalid.example/a><iframe src=https://invalid.example></iframe>\n[执行](javascript:alert(1))\n确认采用",
      ),
    ],
  });
  await page.goto(`${url}/one`);
  const log = page.getByRole("log");
  await expect(log.locator("strong")).toHaveText("结果");
  await expect(log.getByRole("listitem")).toHaveCount(2);
  await expect(log.getByRole("table")).toContainText("候选");
  expect(await page.evaluate(() => (window as any).bad)).toBeUndefined();
  await expect(log.locator("img, iframe, script, a")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认采用", exact: true })).toHaveCount(0);
});

test("OPT-24 history is paginated and initial state reads no candidate or attachment body", async ({
  page,
}) => {
  const state = await fixture(page, {
    messages: Array.from({ length: 37 }, (_, i) => turn(`t${i}`, `回复 ${i}`)),
    docs: [
      { id: "doc", fileName: "规范.md", format: "md", fileSize: 40, units: 1, fragmentCount: 1 },
    ],
  });
  await page.goto(`${url}/one`);
  await expect(page.getByRole("log")).toContainText("回复 36");
  await expect(page.getByText("回复 0", { exact: true })).toHaveCount(0);
  expect(state.candidates).toBe(0);
  expect(state.excerpts).toBe(0);
  await page.getByRole("button", { name: "加载更早消息" }).click();
  await expect(page.getByText("回复 0", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "背景附件", exact: true }).click();
  await page.getByRole("button", { name: "查看背景 规范.md" }).click();
  await expect(page.getByRole("dialog")).toContainText("附件中的真实说明");
  expect(state.excerpts).toBe(1);
  const status = state.reads.filter((r) => r.view === "status");
  expect(status.length).toBeLessThan(4);
  expect(status[0]!.bytes).toBeLessThan(2000);
  console.log("OPT24_READ_PHASES", JSON.stringify(state.reads));
});

test("OPT-24 results and narrow tabs retain selection and input; only fixed selected identities are sent", async ({
  page,
}, testInfo) => {
  const state = await fixture(page, {
    task: {
      title: "处理结果",
      goal: "改写",
      stage: "awaiting_review",
      runId: "run",
      runIds: ["run"],
      candidateScope: { hash: "fixed", count: 2, sourceCount: 2 },
      targetName: "原资料",
      requirements: ["保留答案"],
    },
  });
  await page.goto(`${url}/one`);
  await page.getByLabel("选择结果 1", { exact: true }).click();
  await page.getByLabel("向项目助手发送消息").fill("只调整这条");
  await page.getByRole("button", { name: "资料与要求", exact: true }).click();
  await page.getByRole("button", { name: "结果", exact: true }).click();
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("opt24-review-1440.png"), fullPage: true });
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("只调整这条");
    await overflow(page);
    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked();
  }
  await page.screenshot({ path: testInfo.outputPath("opt24-review-420.png"), fullPage: true });
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  expect(state.posts.at(-1).body.candidates).toEqual({
    scope: "task",
    reviewRevision: "a".repeat(64),
    resultIds: ["0:0"],
  });
});

test("OPT-24 execute button uses current plan revision and does not substitute the selected page source", async ({
  page,
}) => {
  let first = true;
  const state = await fixture(page, {
    task: {
      goal: "规划",
      stage: "planning",
      targetName: "原方案资料",
      executionPlan: {
        mode: "plan",
        current: 0,
        steps: [{ title: "查看资料", action: "query_project", status: "pending" }],
      },
    },
    intercept: async (route, state) => {
      if (route.request().url().includes("/turns") && first) {
        first = false;
        state.posts.push({
          path: new URL(route.request().url()).pathname,
          body: route.request().postDataJSON(),
        });
        state.revision++;
        await route.fulfill({
          status: 409,
          json: { error: { code: "assistant_plan_revalidation_required" } },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto(`${url}/one?sourceKind=draft&sourceId=new-source`);
  await page.getByLabel("向项目助手发送消息").fill("稍后的新要求");
  await page.getByRole("button", { name: "按方案执行", exact: true }).click();
  await expect(page.getByRole("alert").last()).toContainText("重新核对");
  expect(state.posts[0].body.expectedTaskRevision).toBe(7);
  expect(state.posts[0].body.context).toBeUndefined();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("稍后的新要求");
  await expect.poll(() => state.reads.filter((r) => r.view === "status").length).toBeGreaterThan(1);
  await page.getByRole("button", { name: "按方案执行", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1].body.expectedTaskRevision).toBe(8);
});

test("OPT-24 running permits editing and supports stop/recovery without sending the buffered text", async ({
  page,
}) => {
  const state = await fixture(page, {
    task: { goal: "处理", stage: "processing" },
    messages: [{ ...turn("working", ""), status: "running" }],
  });
  state.active = true;
  await page.goto(`${url}/one`);
  await page.getByLabel("向项目助手发送消息").fill("稍后发送");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("已停止");
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("稍后发送");
  expect(state.posts.filter((p) => p.path.endsWith("/turns"))).toHaveLength(0);
});

test("OPT-24 terminal and hidden states stop polling; foreground checks the current state", async ({
  page,
}) => {
  const state = await fixture(page, { task: { goal: "查询", stage: "inspecting" } });
  state.active = true;
  await page.goto(`${url}/one`);
  await expect.poll(() => state.reads.filter((r) => r.view === "status").length).toBeGreaterThan(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = state.reads.filter((r) => r.view === "status").length;
  await page.waitForTimeout(2000);
  expect(state.reads.filter((r) => r.view === "status").length).toBe(hidden);
  state.active = false;
  state.task.stage = "awaiting_confirmation";
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => state.reads.filter((r) => r.view === "status").length)
    .toBeGreaterThan(hidden);
  const terminal = state.reads.filter((r) => r.view === "status").length;
  await page.waitForTimeout(2000);
  expect(state.reads.filter((r) => r.view === "status").length).toBe(terminal);
});

test("OPT-24 permission loss removes cached messages and an open attachment body", async ({
  page,
}) => {
  const state = await fixture(page, {
    task: { goal: "查看", stage: "inspecting" },
    docs: [
      {
        id: "doc",
        fileName: "私有附件.md",
        format: "md",
        fileSize: 40,
        units: 1,
        fragmentCount: 1,
      },
    ],
    messages: [turn("private", "私有会话正文")],
  });
  state.active = true;
  await page.goto(`${url}/one`);
  await page.getByRole("button", { name: "背景附件", exact: true }).click();
  await page.getByRole("button", { name: "查看背景 私有附件.md" }).click();
  await expect(page.getByRole("dialog")).toContainText("附件中的真实说明");
  state.denied = true;
  await expect(page.getByRole("alert")).toContainText("不可访问");
  await expect(page.getByText("私有会话正文", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("OPT-24 fixed confirmation cards come from server proposals and confirmation does not resubmit messages", async ({
  page,
}) => {
  const state = await fixture(page, {
    task: { goal: "采用", stage: "awaiting_confirmation" },
    proposals: [
      {
        id: "proposal",
        turn_id: "t0",
        action: "processing",
        status: "pending",
        summary: { title: "保存2条", target: "原草稿", count: 2 },
        expires_at: "2099-01-01T00:00:00Z",
      },
    ],
  });
  await page.goto(`${url}/one`);
  await page.getByRole("button", { name: "确认采用", exact: true }).click();
  await expect(page.getByText("已采用", { exact: true })).toBeVisible();
  expect(state.posts.filter((p) => p.path.endsWith("/confirm"))).toHaveLength(1);
  expect(state.posts.filter((p) => p.path.endsWith("/turns"))).toHaveLength(0);
});

test("OPT-27 keeps a paused plan visible and resumes with the current revision", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 850 });
  const state = await fixture(page, {
    task: {
      goal: "分步建立测试集",
      stage: "waiting_input",
      executionPaused: true,
      executionPlan: {
        mode: "execute",
        needsReview: false,
        current: 1,
        steps: [
          { title: "建立首份草稿", action: "create_draft", status: "executed" },
          { title: "建立下一份草稿", action: "create_draft", status: "pending" },
        ],
      },
    },
    messages: [
      {
        ...turn("paused", "后续步骤已暂停，首份草稿保留。"),
        tools: [
          {
            key: "done",
            name: "create_draft",
            status: "succeeded",
            result: { name: "首份草稿", url: "/projects/assistant_project/test-sets/drafts/first" },
          },
        ],
      },
    ],
  });
  await page.goto(`${url}/one`);
  await expect(page.getByRole("status").first()).toHaveText("已暂停");
  await page.reload();
  await expect(page.getByRole("status").first()).toHaveText("已暂停");
  expect(state.posts).toEqual([]);
  await page.getByRole("log").locator("summary", { hasText: "操作记录" }).click();
  await expect(page.getByRole("link", { name: "查看结果" })).toBeVisible();
  await page.getByLabel("向项目助手发送消息").fill("稍后再补的要求");
  const resume = page.getByRole("button", { name: "继续执行", exact: true });
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  expect(state.posts.at(-1).body).toMatchObject({
    message: "继续执行当前任务",
    expectedTaskRevision: 7,
  });
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("稍后再补的要求");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

for (const latestError of ["assistant_tool_input_invalid", "assistant_no_progress", null]) {
  test(`OPT-26 keeps internal parameter hints collapsed after latest status ${latestError}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 850 });
    const raw = "create_draft /instructions: additionalProperties; allowed: name,purpose";
    const state = await fixture(page, {
      task: { requirementProblem: raw },
      messages: [
        {
          ...turn("opt26", "已有数据已保留"),
          status: "failed",
          errorCode: "assistant_tool_input_invalid",
          tools: [
            {
              key: "failed",
              name: "create_draft",
              status: "failed",
              error: { code: "assistant_tool_input_invalid", hint: raw },
            },
            {
              key: "completed",
              name: "query_project",
              status: "succeeded",
              result: { name: "已有草稿", url: "/projects/assistant_project/test-sets" },
            },
          ],
        },
      ],
    });
    if (latestError !== "assistant_tool_input_invalid")
      state.messages.push({
        ...turn("latest"),
        status: latestError ? "failed" : "succeeded",
        errorCode: latestError,
      });
    await page.goto(`${url}/one`);
    const records = page
      .getByRole("log")
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "操作记录" }) });
    await records.locator("summary").first().click();
    await expect(records.getByText(raw, { exact: true })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "查看结果" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: raw })).toHaveCount(0);
    const diagnostic = records.getByText("技术详情", { exact: true });
    await diagnostic.focus();
    await page.keyboard.press("Enter");
    await expect(records.getByText(raw, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("OPT29 document generation reuses result review and clear source labels", async ({
  page,
}, info) => {
  await fixture(page, {
    task: {
      goal: "依据文档生成",
      stage: "awaiting_review",
      runId: "generated",
      targetCount: 50,
      overallTargetCount: 400,
      requirementSummary: ["新增候选：50 条", "整体交付：400 条（当前测试集单独核对）"],
    },
    messages: [
      {
        ...turn("generated", "已生成本类候选，请审核内容。"),
        tools: [
          {
            key: "generate",
            name: "generate_candidates",
            status: "succeeded",
            result: { runId: "generated" },
          },
        ],
      },
    ],
    intercept: async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/candidates")) return false;
      await route.fulfill({
        json: {
          scope: "task",
          rootOperation: "generate",
          reviewRevision: "a".repeat(64),
          taskTotal: 1,
          total: 1,
          allIds: ["generated:0:0"],
          savedCount: 0,
          stats: { all: 1, changed: 1, needsReview: 0 },
          records: [
            {
              id: "generated:0:0",
              result: {
                question: "如何核验这条消息是否可靠？",
                expectedOutput: "提供交叉核验方法",
                metadata: [{ key: "类别", value: "A.1.a" }],
              },
              changedFields: ["new"],
              sourcePresentation: {
                label: "依据背景文档生成",
                generated: true,
                badges: [],
                steps: [{ label: "背景.pdf · 第 2 页", kind: "reference", href: `${url}/one` }],
              },
            },
          ],
          history: [
            { runId: "generated", round: 1, operation: "generate", status: "succeeded", count: 1 },
          ],
        },
      });
      return true;
    },
  });
  await page.goto(`${url}/one`);
  await page.getByRole("button", { name: /^(工作区|打开工作区)$/ }).click();
  const results = page.getByRole("region", { name: "候选结果" });
  await expect(results).toContainText("如何核验这条消息是否可靠？");
  await expect(results).toContainText("依据背景文档生成");
  await results.getByText("处理历史", { exact: false }).click();
  await expect(results).toContainText("依据文档生成");
  await page.screenshot({ path: info.outputPath("document-generation.png"), fullPage: true });
  await page.setViewportSize({ width: 420, height: 900 });
  await overflow(page);
});

for (const [action, label] of [
  ["retry_turn", "重试本轮"],
  ["continue_plan", "继续规划"],
  ["continue_execution", "继续执行未完成步骤"],
] as const) {
  test("OPT45 server recovery action " + action, async ({ page }) => {
    const state = await fixture(page, {
      task: {
        goal: "客服测试集",
        stage: "failed",
        recoveryDecision: {
          action,
          reason: "segment_expired",
          revision: 7,
          validUntil: Date.now() + 60000,
          canExecutePlan: false,
        },
        feedback: { kind: "failed", message: "已有要求和成果已保留。", planReady: false },
      },
      messages: [{ ...turn("failed"), status: "failed", errorCode: "assistant_model_failed" }],
    });
    await page.goto(url + "/one");
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(state.posts.some((p) => p.path.endsWith("/retry"))).toBe(true);
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  });
}
test("OPT45 rejected recovery refreshes capability while retaining typed input", async ({
  page,
}) => {
  let rejected = false;
  const state = await fixture(page, {
    task: {
      goal: "客服测试集",
      stage: "failed",
      recoveryDecision: {
        action: "continue_plan",
        reason: "segment_expired",
        revision: 7,
        validUntil: Date.now() + 60000,
        canExecutePlan: false,
      },
    },
    intercept: async (route, s) => {
      if (!new URL(route.request().url()).pathname.endsWith("/retry")) return false;
      rejected = true;
      s.revision = 8;
      s.task = {
        ...s.task,
        recoveryDecision: {
          action: null,
          reason: "background_changed",
          revision: 8,
          validUntil: null,
          canExecutePlan: false,
        },
        feedback: {
          kind: "blocked",
          message: "背景文档已变化，请核对依据后继续。",
          planReady: false,
        },
      };
      await route.fulfill({
        status: 409,
        json: { error: { code: "assistant_retry_unavailable" } },
      });
      return true;
    },
  });
  await page.goto(url + "/one");
  await page.getByLabel("向项目助手发送消息").fill("补充说明请保留");
  await page.getByRole("button", { name: "继续规划", exact: true }).click();
  await expect.poll(() => rejected).toBe(true);
  await expect(page.getByRole("button", { name: "继续规划", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("补充说明请保留");
  await expect(page.getByText("背景文档已变化，请核对依据后继续。", { exact: true })).toBeVisible();
  expect(state.revision).toBe(8);
});
test("OPT45 expired recovery refreshes once and has no live stale button", async ({ page }) => {
  const state = await fixture(page, {
    task: {
      goal: "客服测试集",
      stage: "failed",
      recoveryDecision: {
        action: "retry_turn",
        reason: "same_segment",
        revision: 7,
        validUntil: Date.now() + 1500,
        canExecutePlan: false,
      },
    },
  });
  await page.goto(url + "/one");
  await expect(page.getByRole("button", { name: "重试本轮", exact: true })).toBeVisible();
  state.task = {
    ...state.task,
    recoveryDecision: {
      action: null,
      reason: "insufficient_task_time",
      revision: 7,
      validUntil: null,
      canExecutePlan: false,
    },
  };
  await expect(page.getByRole("button", { name: "重试本轮", exact: true })).toHaveCount(0, {
    timeout: 6000,
  });
  expect(state.posts).toHaveLength(0);
});
test("OPT45 missing background guidance is readable and opens existing upload by keyboard", async ({
  page,
}) => {
  const question = "请上传背景文档，或使用已有原始资料进行扩充。";
  await fixture(page, {
    task: {
      goal: "客服测试集",
      stage: "waiting_input",
      feedback: { kind: "input", message: question, action: "background", planReady: false },
      recoveryDecision: {
        action: null,
        reason: "business_input_required",
        revision: 7,
        validUntil: null,
        canExecutePlan: false,
      },
    },
  });
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto(url + "/one");
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上传背景文档", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "添加文档", exact: true })).toBeVisible();
  await overflow(page);
});

test("OPT45 a late pre-stop read cannot roll the visible task back", async ({ page }) => {
  let holdNext = false,
    release: (() => void) | undefined,
    entered: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const state = await fixture(page, {
    task: {
      goal: "暂停前任务",
      stage: "failed",
      recoveryDecision: {
        action: "retry_turn",
        reason: "same_segment",
        revision: 7,
        validUntil: Date.now() + 60000,
        canExecutePlan: false,
      },
    },
    intercept: async (route, s) => {
      if (!holdNext || !route.request().url().includes("view=status")) return false;
      holdNext = false;
      const snapshot = structuredClone({
        sessionId: "one",
        task: s.task,
        taskRevision: s.revision,
        title: "整理资料",
        active: false,
        backgroundDocuments: [],
        proposals: [],
        messageRevision: "old",
        latestTurn: { id: "t0", status: "succeeded" },
      });
      entered?.();
      await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: snapshot }).catch(() => {});
      return true;
    },
  });
  await page.goto(url + "/one");
  await page.getByLabel("向项目助手发送消息").fill("尚未发送的补充");
  holdNext = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await enteredPromise;
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("已停止");
  release?.();
  await expect(page.getByRole("button", { name: "重试本轮", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("尚未发送的补充");
  expect(state.task.stage).toBe("stopped");
});

test("OPT45 concrete business conflict stays visible with an older saved plan", async ({
  page,
}) => {
  const problem = "期望输出：当前目标3条，配额合计4条，请确认数量。";
  await fixture(page, {
    task: {
      goal: "客服",
      stage: "failed",
      requirementProblem: problem,
      requirementProblemKind: "business",
      feedback: { kind: "input", message: problem, planReady: false },
      recoveryDecision: {
        action: null,
        reason: "business_input_required",
        revision: 7,
        validUntil: null,
        canExecutePlan: false,
      },
      executionPlan: {
        mode: "plan",
        current: 0,
        steps: [{ title: "原方案", action: "query_project", status: "pending" }],
      },
    },
  });
  await page.goto(url + "/one");
  await expect(page.getByText(problem, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "按方案执行", exact: true })).toHaveCount(0);
});

test("OPT46 ordinary continue displays the server repair limit and retains the user's message", async ({
  page,
}) => {
  const message = "自动修正次数已用完，原方案保留，本次修改尚未保存。";
  let submissions = 0;
  await fixture(page, {
    task: { goal: "退款测试集", stage: "failed" },
    intercept: async (route) => {
      if (
        route.request().method() !== "POST" ||
        !new URL(route.request().url()).pathname.endsWith("/turns")
      )
        return false;
      submissions++;
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "assistant_retry_unavailable",
            reason: "repair_limit",
            recoveryMessage: message,
          },
        },
      });
      return true;
    },
  });
  await page.goto(url + "/one");
  await page.getByLabel("向项目助手发送消息").fill("继续保存方案，先不要执行");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("继续保存方案，先不要执行");
  expect(submissions).toBe(1);
  await expect(page.getByText("操作未完成，请重试。输入已保留。", { exact: true })).toHaveCount(0);
});
