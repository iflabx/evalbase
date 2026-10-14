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
        task: state.task,
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
  await page.getByLabel("选择结果 1").click();
  await page.getByLabel("向项目助手发送消息").fill("只调整这条");
  await page.getByRole("button", { name: "资料与要求", exact: true }).click();
  await page.getByRole("button", { name: "结果", exact: true }).click();
  await expect(page.getByLabel("选择结果 1")).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("opt24-review-1440.png"), fullPage: true });
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("只调整这条");
    await overflow(page);
    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await expect(page.getByLabel("选择结果 1")).toBeChecked();
  }
  await page.screenshot({ path: testInfo.outputPath("opt24-review-420.png"), fullPage: true });
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.filter((p) => p.path.endsWith("/turns")).length).toBe(1);
  expect(state.posts.at(-1).body.candidates).toEqual({ runId: "run", resultIds: ["0:0"] });
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
