import { expect, test } from "@playwright/test";

test("browses material files and records without a side panel", async ({ page }) => {
  let moved = false;
  let onlyCurrentCollection = false;
  const longQuestion = "这是一段用于验证记录行高的长问题文本。".repeat(24);
  const longExpectedOutput = "这是一段用于验证记录行高的长期望输出文本。".repeat(24);
  const files = Array.from({ length: 11 }, (_, index) => ({
    id: index === 0 ? "asset_browser" : `asset_browser_${index + 1}`,
    fileName: index === 0 ? "faq.csv" : `faq-${index + 1}.csv`,
    format: "csv",
    size: 29,
    recordCount: 1,
    uploadedAt: "2026-09-05T00:00:00.000Z",
    status: "可浏览",
  }));
  const records = files.map((file, index) => ({
    assetId: file.id,
    ordinal: 1,
    sourceFile: file.fileName,
    question: index === 0 ? longQuestion : `问题 ${index + 1}`,
    expectedOutput: index === 0 ? longExpectedOutput : `答案 ${index + 1}`,
    metadata: [
      { key: "标签", value: index === 0 ? "帮助中心" : `标签 ${index + 1}` },
      { key: "分类", value: "常见问题" },
      { key: "来源", value: "示例" },
    ],
  }));
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
      await route.fulfill({
        json: {
          projects: [
            {
              id: "project_browser",
              name: "浏览器项目",
              description: "",
              datasetCount: 2,
              testSetCount: 0,
              updatedAt: "2026-09-05T00:00:00.000Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/collections") {
      const source = {
        id: "collection_source",
        name: "客服资料",
        description: "",
        isUnfiled: false,
        fileCount: moved ? files.length - 1 : files.length,
        unifiedRecordCount: moved ? records.length - 1 : records.length,
        updatedAt: "2026-09-05T00:00:00.000Z",
      };
      await route.fulfill({
        json: {
          collections: onlyCurrentCollection
            ? [source]
            : [
                source,
                {
                  id: "collection_target",
                  name: "已整理",
                  description: "",
                  isUnfiled: false,
                  fileCount: moved ? 1 : 0,
                  unifiedRecordCount: moved ? 1 : 0,
                  updatedAt: "2026-09-05T00:00:00.000Z",
                },
              ],
          pagination: { total: 2 },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/collections/collection_source/assets") {
      const name = url.searchParams.get("name")?.toLowerCase() ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const matching = files.filter(
        (file) => (!moved || file.id !== "asset_browser") && file.fileName.includes(name),
      );
      await route.fulfill({
        json: {
          assets: matching.slice(offset, offset + limit),
          pagination: { total: matching.length },
        },
      });
      return;
    }
    if (
      url.pathname ===
      "/api/projects/project_browser/collections/collection_source/assets/asset_browser"
    ) {
      await route.fulfill({
        json: { asset: { fileName: "faq.csv", format: "csv", recordCount: 1 } },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/collections/collection_source/records") {
      const search = url.searchParams.get("search")?.toLowerCase() ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const matching = records.filter((record) =>
        [
          record.question,
          record.expectedOutput,
          ...record.metadata.flatMap(({ key, value }) => [key, value]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search),
      );
      await route.fulfill({
        json: {
          records: matching.slice(offset, offset + limit),
          pagination: { total: matching.length },
        },
      });
      return;
    }
    const detail = url.pathname.match(
      /^\/api\/projects\/project_browser\/collections\/collection_source\/assets\/(asset_browser(?:_\d+)?)\/records\/1$/,
    );
    if (detail) {
      const record = records.find((item) => item.assetId === detail[1]);
      await route.fulfill(record ? { json: { record } } : { status: 404 });
      return;
    }
    if (
      url.pathname === "/api/projects/project_browser/assets/asset_browser/collection" &&
      method === "PATCH"
    ) {
      moved = true;
      await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/assets/asset_browser/download") {
      await route.fulfill({
        json: {
          rawPreview: {
            text: "question,answer,tag\n如何重置密码？,在设置中重置。,帮助中心",
            truncated: false,
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/datasets/collection_source");
  await expect(page.getByRole("heading", { name: "客服资料" })).toBeVisible();
  await expect(page.getByRole("button", { name: "上传文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "文件 11" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全部记录 11" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "名称" })).toBeVisible();
  await expect(page.getByText("faq.csv", { exact: true })).toBeVisible();
  await expect(page.getByText("文件信息", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("按格式筛选")).toHaveCount(0);
  await expect(page.getByLabel("按状态筛选")).toHaveCount(0);

  await page.getByLabel("搜索文件").fill("faq-11");
  await expect(page.getByText("faq-11.csv", { exact: true })).toBeVisible();
  await page.getByLabel("搜索文件").fill("");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("faq-11.csv", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一页" }).click();

  await page.getByText("faq.csv", { exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/project_browser\/datasets\/collection_source$/);
  await expect(
    page.getByText("faq.csv", { exact: true }).locator("xpath=ancestor::tr"),
  ).toHaveClass(/bg-accent/);

  await page
    .getByRole("row", { name: /faq\.csv/ })
    .getByRole("link", { name: "查看" })
    .click();
  await expect(page).toHaveURL(/\/files\/asset_browser$/);
  await expect(page.getByRole("heading", { name: "faq.csv" })).toBeVisible();
  await expect(page.getByText("CSV · 共 1 条记录")).toBeVisible();
  await expect(page.getByText(longQuestion, { exact: true })).toBeVisible();
  const fileRecordSearch = page.getByLabel("搜索文件记录");
  const fileDensityButton = page.getByRole("button", { name: "行高" });
  const [fileSearchBox, fileDensityBox] = await Promise.all([
    fileRecordSearch.boundingBox(),
    fileDensityButton.boundingBox(),
  ]);
  expect(fileSearchBox).not.toBeNull();
  expect(fileDensityBox).not.toBeNull();
  expect(Math.abs(fileSearchBox!.y - fileDensityBox!.y)).toBeLessThanOrEqual(1);
  expect(fileDensityBox!.x - (fileSearchBox!.x + fileSearchBox!.width)).toBeLessThanOrEqual(8);
  await expect(page.getByText(longQuestion, { exact: true })).toHaveCSS("white-space", "nowrap");
  await fileDensityButton.click();
  await page.getByRole("menuitemradio", { name: /适中.*最多 3 行/ }).click();
  await expect(page.getByText(longQuestion, { exact: true })).toHaveCSS("-webkit-line-clamp", "3");
  await fileDensityButton.click();
  await page.getByRole("menuitemradio", { name: /紧凑.*单行显示/ }).click();
  await page.getByRole("button", { name: "查看原始内容" }).click();
  await expect(page.getByRole("heading", { name: "原始内容" })).toBeVisible();
  await expect(page.getByText("question,answer,tag", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "返回原始数据" }).click();
  await page.getByRole("button", { name: "全部记录" }).click();
  const recordSearch = page.getByLabel("搜索记录");
  const densityButton = page.getByRole("button", { name: "行高" });
  const compactQuestion = page.getByText(longQuestion, { exact: true });
  const compactExpectedOutput = page.getByText(longExpectedOutput, { exact: true });
  await expect(page.getByText("标签：帮助中心", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "+1 项" }).first()).toBeVisible();
  const [searchBox, densityBox] = await Promise.all([
    recordSearch.boundingBox(),
    densityButton.boundingBox(),
  ]);
  expect(searchBox).not.toBeNull();
  expect(densityBox).not.toBeNull();
  expect(Math.abs(searchBox!.y - densityBox!.y)).toBeLessThanOrEqual(1);
  expect(densityBox!.x - (searchBox!.x + searchBox!.width)).toBeLessThanOrEqual(8);
  await expect(compactQuestion).toHaveCSS("white-space", "nowrap");
  await expect(compactQuestion).toHaveCSS("text-overflow", "ellipsis");
  await expect(compactExpectedOutput).toHaveCSS("white-space", "nowrap");
  await densityButton.click();
  await expect(page.getByRole("menu", { name: "行高" })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /紧凑.*单行显示/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("menuitemradio", { name: /适中.*最多 3 行/ }).click();
  await expect(compactQuestion).toHaveCSS("-webkit-line-clamp", "3");
  await expect(compactExpectedOutput).toHaveCSS("-webkit-line-clamp", "3");
  await densityButton.click();
  await page.getByRole("menuitemradio", { name: /展开.*最多 6 行/ }).click();
  await expect(compactQuestion).toHaveCSS("-webkit-line-clamp", "6");
  await expect(compactExpectedOutput).toHaveCSS("-webkit-line-clamp", "6");
  await page.getByRole("button", { name: "+1 项" }).first().click();
  await expect(page.getByRole("heading", { name: "Metadata · 3 项" })).toBeVisible();
  await expect(page.getByText("标签", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("分类", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("来源", { exact: true }).last()).toBeVisible();
  await expect(
    page.evaluate(() => window.sessionStorage.getItem("agentbench-record-density")),
  ).resolves.toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "全部记录" }).click();
  await expect(page.getByText(longQuestion, { exact: true })).toHaveCSS("white-space", "nowrap");
  await page.getByRole("button", { name: "1", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "记录 1" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("搜索记录").fill("标签 11");
  await expect(page.getByText("问题 11", { exact: true })).toBeVisible();
  await page.getByLabel("搜索记录").fill("");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("问题 11", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "上一页" }).click();

  await page.getByRole("button", { name: /^文件 / }).click();
  const moveButton = page
    .getByRole("row", { name: /faq\.csv/ })
    .getByRole("button", { name: "移动" });
  const viewButton = page
    .getByRole("row", { name: /faq\.csv/ })
    .getByRole("link", { name: "查看" });
  await expect(moveButton).toHaveAttribute("title", "移动到其他原始数据");
  expect(await moveButton.getAttribute("class")).toBe(await viewButton.getAttribute("class"));
  await moveButton.click();
  await expect(page.getByRole("heading", { name: "移动文件" })).toBeVisible();
  await expect(page.getByText("只会改变文件在当前项目中的归类。", { exact: true })).toBeVisible();
  await expect(
    page.getByText("文件内容、字段映射和已创建测试集中的来源信息不会改变。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("请选择原始数据", { exact: true })).toBeVisible();
  await page.getByLabel("目标原始数据").click();
  await page.getByText("已整理", { exact: true }).last().click();
  await page.getByRole("button", { name: "移动", exact: true }).last().click();
  await expect(page.getByText("faq-2.csv", { exact: true })).toBeVisible();

  onlyCurrentCollection = true;
  await page.reload();
  const disabledMove = page
    .getByRole("row", { name: /faq-2\.csv/ })
    .getByRole("button", { name: "移动" });
  await expect(disabledMove).toBeDisabled();
  await expect(disabledMove).toHaveAttribute("title", "当前项目中没有其他原始数据");
});
