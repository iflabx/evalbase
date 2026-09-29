import { expect, test } from "@playwright/test";

test("renders the frozen test-set list information beside its view action", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/installation") {
      await route.fulfill({ json: { needsAdministrator: false, needsMigration: false } });
      return;
    }
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: { csrfToken: "csrf", actor: { id: "admin", role: "admin" } } });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/access") {
      await route.fulfill({
        json: {
          access: {
            role: "admin",
            capabilities: { read: true, write: true, export: true, manage: true },
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/collaborative-drafts") {
      await route.fulfill({ json: { drafts: [] } });
      return;
    }
    if (url.pathname === "/api/projects") {
      await route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/solo-test-sets") {
      await route.fulfill({
        json: {
          testSets: [
            {
              id: "testset_browser",
              name: "客服基础问答",
              currentVersionId: "version_v3",
              currentVersion: "v3",
              recordCount: 132,
              source: "客服常见问题_2026-08.csv、产品帮助中心.json",
              status: "已发布",
              updatedAt: "2026-08-24T09:20:00.000Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/test-sets");

  for (const header of ["名称", "当前版本", "记录数", "来源", "状态", "更新时间", "操作"])
    await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
  await expect(
    page.getByText("客服常见问题_2026-08.csv、产品帮助中心.json", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table").getByText("已发布", { exact: true })).toHaveClass(
    /text-chart-2/,
  );
  await expect(page.getByText("08-24", { exact: true })).toBeVisible();
  const view = page.getByRole("link", { name: "查看" });
  await expect(view).toHaveAttribute(
    "href",
    "/projects/project_browser/test-sets/testset_browser?version=version_v3",
  );
});
