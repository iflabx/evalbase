import { expect, test } from "@playwright/test";

test("creates and opens a project from the project list", async ({ page }) => {
  let created = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
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
    if (url.pathname === "/api/projects") {
      if (method === "POST") {
        created = true;
        await route.fulfill({
          status: 201,
          json: {
            project: {
              id: "project_browser",
              name: "浏览器项目",
              description: "",
              datasetCount: 1,
              testSetCount: 0,
              updatedAt: "2026-09-04T00:00:00.000Z",
            },
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          projects: created
            ? [
                {
                  id: "project_browser",
                  name: "浏览器项目",
                  description: "",
                  datasetCount: 1,
                  testSetCount: 0,
                  updatedAt: "2026-09-04T00:00:00.000Z",
                },
              ]
            : [],
          pagination: { total: created ? 1 : 0 },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/collections") {
      await route.fulfill({
        json: {
          collections: [
            {
              id: "collection_unfiled",
              name: "未整理",
              description: "",
              isUnfiled: true,
              fileCount: 0,
              unifiedRecordCount: 0,
              updatedAt: "2026-09-04T00:00:00.000Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/pending-uploads") {
      await route.fulfill({
        status: 201,
        json: {
          pendingUpload: {
            id: "pending_browser",
            fileName: "faq.csv",
            format: "csv",
            size: 29,
            recordCount: 1,
            fields: [
              { path: "/question", sample: "如何重置密码？" },
              { path: "/answer", sample: "在设置中重置。" },
            ],
            issues: [],
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/pending-uploads/pending_browser/preview") {
      await route.fulfill({
        json: {
          id: "pending_browser",
          fileName: "faq.csv",
          format: "csv",
          size: 29,
          recordCount: 1,
          fields: [
            { path: "/question", sample: "如何重置密码？" },
            { path: "/answer", sample: "在设置中重置。" },
          ],
          issues: [],
          preview: [{ question: "如何重置密码？", expectedOutput: "在设置中重置。", metadata: "" }],
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "项目", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建项目" }).click();
  await expect(
    page.getByText("用一个项目把相关的原始数据和测试集放在同一个工作区。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("说明（可选）")).toBeVisible();
  await page.getByLabel("项目名称").fill("浏览器项目");
  await page.getByRole("button", { name: "创建项目" }).click();

  await expect(page).toHaveURL(/\/projects\/project_browser\/datasets$/);
  await expect(page.getByRole("heading", { name: "原始数据" })).toBeVisible();
  await expect(page.getByText("未整理", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "默认收纳区" })).toBeVisible();
  await page.getByRole("combobox", { name: "按类型筛选" }).click();
  await expect(page.getByRole("option", { name: "原始数据" })).toBeVisible();
  await expect(page.getByRole("option", { name: "默认收纳区" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("等待文件", { exact: true })).toHaveClass(/border-amber-500/);
  await expect(page.getByRole("button", { name: /更新时间 降序/ })).toHaveClass(/border/);
  await expect(page.getByText("团队测试资料库", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("当前项目", { exact: true })).toBeVisible();
  await expect(page.getByLabel("切换项目")).toBeVisible();
  await expect(page.getByRole("link", { name: "测试集" })).toBeVisible();
  const projectChildren = page.getByTestId("project-nav-children");
  await expect(projectChildren).toHaveCSS("border-left-width", "1px");
  await expect(projectChildren).toHaveCSS("margin-left", "16px");
  await expect(page.getByLabel("切换项目").locator("svg").first()).toHaveClass(/lucide-database/);
  await expect(page.getByRole("link", { name: "原始数据" }).locator("svg")).toHaveClass(
    /lucide-database/,
  );
  await expect(page.getByRole("link", { name: "测试集" }).locator("svg")).toHaveClass(
    /lucide-file-text/,
  );

  await page.getByRole("button", { name: "原始数据集合" }).click();
  await expect(
    page.getByText("用一个简单名称把同一领域或方向的文件放在一起。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("说明（可选）")).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "上传文件" }).click();
  await expect(page.getByText("选择要上传的本地文件", { exact: true })).toBeVisible();
  await expect(
    page.getByText("支持 CSV、JSON 和 JSONL，可一次选择多个文件。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("保存到", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消" }).last().locator("..")).toHaveClass(
    /justify-between/,
  );
  await expect(page.getByRole("list", { name: "上传步骤" })).toContainText("选择文件");
  await expect(page.getByRole("list", { name: "上传步骤" })).toContainText("字段映射与预览");
  await page.getByLabel("选择文件").setInputFiles({
    name: "faq.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("question,answer\n如何重置密码？,在设置中重置。\n"),
  });
  await expect(page.getByText("已选择 1 个文件", { exact: true })).toBeVisible();
  await page.getByLabel("选择文件").setInputFiles({
    name: "guide.json",
    mimeType: "application/json",
    buffer: Buffer.from('[{"question":"如何更新资料？","answer":"在设置中更新。"}]'),
  });
  await expect(page.getByText("已选择 2 个文件", { exact: true })).toBeVisible();
  await expect(page.getByText("faq.csv", { exact: true })).toBeVisible();
  await expect(page.getByText("guide.json", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "字段映射与预览" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "如何重置密码？" }).last()).toBeVisible();
  await expect(page.getByText("责任人", { exact: true })).toHaveCount(0);
});
