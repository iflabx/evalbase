import { test, expect } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("keeps signed-out login fields through a temporary session read failure", async ({ page }) => {
  let failing = false,
    failedReads = 0;
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session") {
      if (failing) failedReads++;
      return route.fulfill({
        status: failing ? 500 : 401,
        json: { error: { code: "authentication_required" } },
      });
    }
    if (await mockAccountRoute(route)) return;
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/");
  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');
  await email.fill("typing@example.test");
  await password.fill("TypedPassword123");
  failing = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect(email).toHaveValue("typing@example.test");
  await expect(password).toHaveValue("TypedPassword123");
});

test("pages compact history on the server and stops polling idle tasks", async ({ page }) => {
  const requests: URL[] = [];
  let failure = false;
  let sessionFailure = false;
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/session" && sessionFailure)
      return route.fulfill({ status: 500, json: { error: { code: "internal_error" } } });
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/processing-runs")) {
      requests.push(url);
      if (failure)
        return route.fulfill({ status: 500, json: { error: { code: "internal_error" } } });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return route.fulfill({
        json: {
          runs: Array.from({ length: Math.min(20, 25 - offset) }, (_, i) => ({
            id: `task-${offset + i}`,
            source: { kind: "assets" },
            options: { operation: "clean", instructions: "整理空白" },
            sourceSummary: { name: `任务 ${offset + i + 1}`, kindLabel: "原始数据", files: [] },
            inputCount: 1,
            status: "succeeded",
            executionComplete: true,
            progress: 100,
            createdAt: "2026-10-12T00:00:00Z",
            errorCode: null,
          })),
          pagination: { total: 25, limit: 20, offset },
          hasActive: false,
        },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing");
  await expect(page.getByText("任务 1 · 清洗", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("任务 21 · 清洗", { exact: true })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("20");
  const count = requests.length;
  await page.waitForTimeout(5500);
  expect(requests).toHaveLength(count);
  await page.getByRole("button", { name: "刷新处理任务", exact: true }).click();
  await expect.poll(() => requests.length).toBe(count + 1);
  failure = true;
  await page.getByRole("button", { name: "刷新处理任务", exact: true }).click();
  await expect(page.getByText("读取失败，已保留上次结果。", { exact: true })).toBeVisible();
  await expect(page.getByText("任务 21 · 清洗", { exact: true })).toBeVisible();
  failure = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("读取失败，已保留上次结果。", { exact: true })).toHaveCount(0);
  const beforeReconnect = requests.length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => requests.length).toBeGreaterThan(beforeReconnect);
  sessionFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("button", { name: "连接暂时中断，重试", exact: true })).toBeVisible();
  await expect(page.getByText("任务 21 · 清洗", { exact: true })).toBeVisible();
});

test("updates active tasks and stops periodic reads after completion", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/processing-runs")) {
      reads++;
      const active = reads === 1;
      return route.fulfill({
        json: {
          runs: [
            {
              id: "active",
              source: { kind: "assets" },
              options: { operation: "clean", instructions: "整理空白" },
              sourceSummary: { name: "活跃任务", kindLabel: "原始数据", files: [] },
              inputCount: 1,
              status: active ? "running" : "succeeded",
              executionComplete: !active,
              progress: active ? 50 : 100,
              createdAt: "2026-10-12T00:00:00Z",
              errorCode: null,
            },
          ],
          pagination: { total: 1, limit: 20, offset: 0 },
          hasActive: active,
        },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing");
  await expect(page.getByText("处理中", { exact: true })).toBeVisible();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible({ timeout: 8000 });
  const completed = reads;
  await page.waitForTimeout(5500);
  expect(reads).toBe(completed);
});

test("keeps table headings during loading, debounces Chinese input and clears revoked data", async ({
  page,
}, info) => {
  let release: () => void = () => undefined;
  const firstRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const names: string[] = [];
  let failure = 0;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/collections")) {
      names.push(url.searchParams.get("name") ?? "");
      if (names.length === 1) await firstRead;
      if (failure)
        return route.fulfill({ status: failure, json: { error: { code: "project_not_found" } } });
      return route.fulfill({
        json: {
          collections: [
            {
              id: "raw",
              name: "中文资料",
              description: "",
              fileCount: 1,
              unifiedRecordCount: 1,
              updatedAt: "2026-10-12",
              isUnfiled: false,
            },
          ],
          pagination: { total: 1 },
        },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/datasets");
  await expect(page.getByRole("columnheader", { name: "统一记录数", exact: true })).toBeVisible();
  await expect(page.getByLabel("加载中", { exact: true })).toBeVisible();
  release();
  await expect(page.getByText("中文资料", { exact: true })).toBeVisible();
  const search = page.getByRole("textbox", { name: "搜索原始数据", exact: true });
  await search.dispatchEvent("compositionstart");
  await search.fill("中文");
  const before = names.length;
  await page.waitForTimeout(450);
  expect(names).toHaveLength(before);
  await search.dispatchEvent("compositionend", { data: "中文" });
  await expect.poll(() => names.at(-1)).toBe("中文");
  await search.fill("");
  await expect(search).toHaveValue("");
  await search.pressSequentially("abcdef", { delay: 30 });
  await expect.poll(() => names.at(-1)).toBe("abcdef");
  expect(names.filter((name) => /^[a-f]+$/.test(name))).toEqual(["abcdef"]);
  for (const width of [1440, 480]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`loading-${width}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".content-enter")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  failure = 403;
  await search.fill("撤权");
  await expect(page.getByText("操作失败", { exact: true })).toBeVisible();
  await expect(page.getByText("中文资料", { exact: true })).toHaveCount(0);
});

test("reports first-read failure without claiming a retained test-set result", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/solo-test-sets"))
      return route.fulfill({ status: 500, json: { error: { code: "internal_error" } } });
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/test-sets");
  await expect(page.getByText("操作失败", { exact: true })).toBeVisible();
  await expect(page.getByText("读取失败，已保留上次结果。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("还没有测试集", { exact: true })).toHaveCount(0);
});

test("isolates cached project names and profile during same-page account switching", async ({
  page,
}) => {
  let actor = "old",
    expired = false;
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      if (route.request().method() === "POST") {
        actor = "new";
        expired = false;
        return route.fulfill({ json: { csrfToken: "csrf", actor: { id: actor, role: "admin" } } });
      }
      return route.fulfill(
        expired
          ? { status: 401, json: { error: { code: "authentication_required" } } }
          : { json: { csrfToken: "csrf", actor: { id: actor, role: "admin" } } },
      );
    }
    if (url.pathname === "/api/me") {
      const captured = actor;
      if (captured === "new") await pending;
      return route.fulfill({
        json: {
          account: {
            id: captured,
            displayName: captured === "old" ? "旧账号" : "新账号",
            avatarColor: "#6366f1",
            role: "admin",
          },
        },
      });
    }
    if (url.pathname === "/api/projects") {
      const captured = actor;
      if (captured === "new") await pending;
      return route.fulfill({
        json: {
          projects: [
            {
              id: "p",
              name: captured === "old" ? "旧账号私有项目" : "新账号项目",
              description: "",
            },
          ],
          pagination: { total: 1 },
        },
      });
    }
    if (await mockAccountRoute(route)) return;
    return route.fulfill({ json: { collections: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/datasets");
  await expect(page.getByRole("button", { name: "切换项目", exact: true })).toContainText(
    "旧账号私有项目",
  );
  expired = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "登录 EvalBase", exact: true })).toBeVisible();
  await page.locator('input[type="email"]').fill("new@example.test");
  await page.locator('input[type="password"]').fill("NewPassword123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "登出", exact: true })).toBeVisible();
  await expect(page.getByText("旧账号私有项目", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(/旧账号/)).toHaveCount(0);
  release();
  await expect(page.getByRole("button", { name: "切换项目", exact: true })).toContainText(
    "新账号项目",
  );
});
