import { test, expect } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("keeps the assistant conversation across close/reload and submits only an explicit bound confirmation", async ({
  page,
}) => {
  const base = "/api/projects/assistant_project/assistant";
  let session = false,
    sent = false,
    confirmed = false,
    confirmCount = 0;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (method === "POST")
      expect(route.request().headers()["content-type"]).toBe("application/json");
    if (path === "/api/projects")
      return route.fulfill({
        json: {
          projects: [
            { id: "assistant_project", name: "助手验收项目", datasetCount: 0, testSetCount: 0 },
          ],
          pagination: { total: 1 },
        },
      });
    if (path.endsWith("/test-sets"))
      return route.fulfill({ json: { testSets: [], pagination: { total: 0 } } });
    if (path === `${base}/sessions`) {
      if (method === "POST") {
        session = true;
        return route.fulfill({ status: 201, json: { sessionId: "session" } });
      }
      return route.fulfill({
        json: { sessions: session ? [{ id: "session", updated_at: "2026-10-04T08:00:00Z" }] : [] },
      });
    }
    if (path === `${base}/sessions/session/turns`) {
      expect(route.request().postDataJSON()).toEqual({ message: "请发布这个草稿" });
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      sent = true;
      return route.fulfill({ status: 202, json: { turnId: "turn", status: "running" } });
    }
    if (path === `${base}/sessions/session`)
      return route.fulfill({
        json: {
          sessionId: "session",
          turns: sent
            ? [
                {
                  id: "turn",
                  userText: "请发布这个草稿",
                  assistantText: "已准备发布确认，请核对。",
                  status: "succeeded",
                  tools: [],
                  errorCode: null,
                },
              ]
            : [],
          proposals: sent
            ? [
                {
                  id: "proposal",
                  turn_id: "turn",
                  action: "publish",
                  summary: {
                    title: "发布正式版本",
                    target: "意图识别测试集",
                    count: 20,
                    revision: 4,
                    url: "/projects/assistant_project/test-sets/drafts/draft",
                  },
                  status: confirmed ? "succeeded" : "pending",
                  expires_at: "2099-01-01T00:00:00Z",
                },
              ]
            : [],
        },
      });
    if (path === `${base}/proposals/proposal/confirm`) {
      expect(route.request().postDataJSON()).toEqual({});
      confirmed = true;
      confirmCount++;
      return route.fulfill({ json: { receipt: { version: { id: "version" } }, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });
  await page.goto("/projects/assistant_project/test-sets");
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByRole("heading", { name: "项目助手", exact: true })).toBeVisible();
  await page.getByLabel("向项目助手发送消息").fill("请发布这个草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("意图识别测试集 · 20 条记录 · 草稿修订 4")).toBeVisible();
  expect(confirmCount).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByRole("button", { name: "确认发布" })).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/assistant-confirm-narrow.png", fullPage: true });
  await page.getByRole("button", { name: "确认发布" }).click();
  await expect.poll(() => confirmCount).toBe(1);
  await expect(page.getByRole("button", { name: "确认发布" })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  expect(confirmCount).toBe(1);
});
