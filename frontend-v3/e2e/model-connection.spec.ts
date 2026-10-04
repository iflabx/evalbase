import { test, expect } from "@playwright/test";

test("administrator saves a model connection without exposing a saved key", async ({ page }) => {
  let connection: Record<string, unknown> | null = null;
  let saves = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/installation") return route.fulfill({ json: { needsAdministrator: false } });
    if (path === "/api/session")
      return route.fulfill({ json: { csrfToken: "csrf", actor: { id: "admin", role: "admin" } } });
    if (path === "/api/projects")
      return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
    if (path === "/api/me")
      return route.fulfill({
        json: { id: "admin", displayName: "管理员", avatarColor: "#2563eb" },
      });
    if (path === "/api/me/invitations") return route.fulfill({ json: { invitations: [] } });
    if (path === "/api/settings/model-connection") {
      if (route.request().method() === "PUT") {
        const payload = route.request().postDataJSON();
        expect(payload.apiKey).toBe("synthetic-key");
        saves++;
        connection = {
          revision: 1,
          name: payload.name,
          endpoint: payload.endpoint,
          model: payload.model,
          enabled: payload.enabled,
          hasKey: true,
          testedAt: null,
          testOk: null,
          testCode: null,
        };
      }
      return route.fulfill({ json: { connection, encryptionReady: true } });
    }
    if (path.endsWith("/model-connection/test"))
      return route.fulfill({
        json: {
          connection: {
            ...connection,
            testedAt: "2026-10-04T00:00:00Z",
            testOk: true,
            testCode: null,
          },
          encryptionReady: true,
          test: { ok: true, code: null },
        },
      });
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });
  await page.goto("/settings?section=models");
  await expect(page.getByRole("heading", { name: "模型连接", exact: true })).toBeVisible();
  await page.getByLabel("连接名称").fill("测试连接");
  await page.getByLabel("服务地址").fill("https://model.example.test/v1");
  await page.getByLabel("模型名称").fill("example-model");
  await page.getByLabel("API key").fill("synthetic-key");
  await page.getByRole("button", { name: "保存连接" }).click();
  await expect.poll(() => saves).toBe(1);
  await expect(page.getByLabel("API key")).toHaveValue("");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试通过。")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveAttribute("type", "password");
  await page.setViewportSize({ width: 800, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
