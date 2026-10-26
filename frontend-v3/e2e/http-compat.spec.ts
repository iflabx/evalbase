import { expect, test, type Page } from "@playwright/test";

const project = "project_http";
const base = `/api/projects/${project}/assistant`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(page: Page, failFirstTurn = false) {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let created = false;
  let task: Record<string, unknown> | undefined;
  const turns: { message: string; key: string; operation?: string }[] = [];
  const grants: { key: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const ok = (json: unknown) => route.fulfill({ json });
    if (path === "/api/installation") return ok({ needsAdministrator: false });
    if (path === "/api/session")
      return ok({ csrfToken: "csrf", actor: { id: "actor", role: "admin" } });
    if (path === "/api/me")
      return ok({
        account: {
          id: "actor",
          role: "admin",
          displayName: "测试",
          email: "http@example.test",
          avatarColor: "#2563eb",
        },
      });
    if (path === "/api/me/invitations") return ok({ invitations: [] });
    if (path.endsWith("/access"))
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
            id: project,
            name: "HTTP 回归",
            datasetCount: 0,
            testSetCount: 0,
            updatedAt: "2026-10-26",
          },
        ],
        pagination: { total: 1 },
      });
    if (path === base + "/sessions") {
      if (req.method() === "POST") {
        created = true;
        return ok({ sessionId: "session-http" });
      }
      return ok({
        sessions: created ? [{ id: "session-http", title: "HTTP 回归", ordinal: 1 }] : [],
        pagination: { total: created ? 1 : 0 },
      });
    }
    if (path === base + "/sessions/session-http/turns") {
      const body = req.postDataJSON();
      turns.push({
        message: body.message,
        key: req.headers()["idempotency-key"]!,
        ...(body.operation ? { operation: body.operation } : {}),
      });
      if (failFirstTurn && turns.length === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "infrastructure_unavailable" } },
        });
      return ok({ turnId: "turn-http" });
    }
    if (path === base + "/sessions/session-http")
      return ok({
        sessionId: "session-http",
        active: false,
        taskRevision: 1,
        task,
        turns: [],
        proposals: [],
        backgroundDocuments: [],
        pagination: { total: 0 },
      });
    if (path === base + "/sessions/session-http/grant") {
      grants.push({ key: req.headers()["idempotency-key"]!, body: req.postDataJSON() });
      return ok({ accepted: true });
    }
    if (path.endsWith("/processing-tasks"))
      return ok({ runs: [], pagination: { total: 0 }, hasActive: false });
    if (path.endsWith("/processing-inputs"))
      return ok({
        records: [
          { id: "record-http", question: "HTTP 问题", expectedAnswer: "HTTP 答案", metadata: [] },
        ],
        allIds: ["record-http"],
        total: 1,
        sourceRevision: "revision-http",
      });
    return ok({});
  });
  await page.goto(`/projects/${project}/assistant`);
  await expect(page.getByRole("textbox", { name: "向项目助手发送消息" })).toBeVisible();
  return {
    turns,
    errors,
    grants,
    setTask: (value: Record<string, unknown>) => {
      task = value;
    },
  };
}

test("sends a first assistant message without randomUUID over HTTP", async ({ page }) => {
  const f = await fixture(page);
  const input = page.getByRole("textbox", { name: "向项目助手发送消息" });
  await input.fill("你好");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => f.turns.length).toBe(1);
  expect(f.turns[0]).toEqual({ message: "你好", key: expect.stringMatching(uuid) });
  await expect(input).toHaveValue("");
  await input.fill("下一条");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  expect(f.errors).toEqual([]);
});

test("keeps a failed message and reuses its idempotency key on retry over HTTP", async ({
  page,
}) => {
  const f = await fixture(page, true);
  const input = page.getByRole("textbox", { name: "向项目助手发送消息" });
  await input.fill("保留这条消息");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const retry = page.getByRole("button", { name: "重新提交这条", exact: true });
  await expect(retry).toBeEnabled();
  await expect(input).toHaveValue("保留这条消息");
  await retry.click();
  await expect.poll(() => f.turns.length).toBe(2);
  expect(f.turns[0]!.key).toMatch(uuid);
  expect(f.turns[1]).toEqual(f.turns[0]);
  expect(f.errors).toEqual([]);
});

test("restores the send button when submission preparation fails", async ({ page }) => {
  const f = await fixture(page);
  const input = page.getByRole("textbox", { name: "向项目助手发送消息" });
  await input.fill("输入应当保留");
  await page.evaluate(() => {
    crypto.getRandomValues = () => {
      throw new Error("entropy unavailable");
    };
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("操作未完成，请重试。输入已保留。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await expect(input).toHaveValue("输入应当保留");
  expect(f.turns).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test("executes an existing plan over HTTP without randomUUID", async ({ page }) => {
  const f = await fixture(page);
  f.setTask({
    taskId: "task-http",
    stage: "planning",
    executionPlan: { mode: "plan", current: 0, steps: [] },
    recoveryDecision: { canExecutePlan: true },
  });
  await page.goto(`/projects/${project}/assistant/session-http`);
  await page.getByRole("button", { name: "按方案执行", exact: true }).click();
  await expect.poll(() => f.turns.length).toBe(1);
  expect(f.turns[0]).toMatchObject({ operation: "execute_plan", key: expect.stringMatching(uuid) });
  expect(f.errors).toEqual([]);
});

test("confirms only the offered bounded grant over HTTP without randomUUID", async ({ page }) => {
  const f = await fixture(page);
  const limits = {
    modelSteps: 10,
    toolCalls: 12,
    requestAttempts: 12,
    transportRetries: 2,
    activeMs: 80000,
  };
  const offer = {
    id: "offer-http",
    taskId: "task-http",
    revision: 1,
    purpose: "continue",
    validUntil: Date.now() + 300000,
    limits,
  };
  f.setTask({
    taskId: "task-http",
    stage: "waiting_input",
    title: "HTTP 方案",
    recoveryDecision: { revision: 1, grantOffers: { continue: offer } },
  });
  await page.goto(`/projects/${project}/assistant/session-http`);
  await page.getByRole("button", { name: "查看继续额度", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(f.grants).toHaveLength(0);
  await dialog.getByRole("button", { name: "确认授权并继续", exact: true }).click();
  await expect.poll(() => f.grants.length).toBe(1);
  expect(f.grants[0]!.key).toMatch(uuid);
  expect(f.grants[0]!.body).toEqual({
    expectedTaskRevision: 1,
    offerId: "offer-http",
    purpose: "continue",
    accept: true,
  });
  expect(f.errors).toEqual([]);
});

test("opens and edits the processing form over HTTP without randomUUID", async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/projects/${project}/processing?source=assets&sourceId=asset-http`);
  await expect(page.getByRole("heading", { name: "选择输入记录", exact: true })).toBeVisible();
  await expect(page.locator("summary").filter({ hasText: /^HTTP 问题$/ })).toBeVisible();
  const rewrite = page
    .getByRole("group", { name: "处理方式", exact: true })
    .getByRole("button", { name: "改写", exact: true });
  await rewrite.click();
  await expect(rewrite).toHaveAttribute("aria-pressed", "true");
  expect(f.errors).toEqual([]);
});
