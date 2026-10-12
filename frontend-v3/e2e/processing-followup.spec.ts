import { test, expect } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

for (const source of ["assets", "version", "draft"])
  test(`retains a cross-page ${source} configuration and rechecks source revisions`, async ({
    page,
  }, info) => {
    let revision = "view-1";
    const ids = Array.from({ length: 45 }, (_, i) => `asset:${i + 1}`);
    await page.route("**/api/**", async (route) => {
      if (await mockAccountRoute(route)) return;
      if (new URL(route.request().url()).pathname.endsWith("/processing-inputs")) {
        const body = route.request().postDataJSON();
        return route.fulfill({
          json: {
            records: ids.slice(body.offset, body.offset + 20).map((id) => ({
              id,
              question: `问题 ${id}`,
              expectedOutput: "回答",
              metadata: [{ key: "分类", value: "A" }],
            })),
            allIds: ids,
            total: 45,
            sourceTotal: 45,
            matchedTotal: 45,
            sourceRevision: revision,
            metadataKeys: ["分类"],
            sourceSummary: {
              name: "原始问题.csv",
              kindLabel: "原始数据",
              files: [],
              href: "/projects/p/datasets/raw/files/asset",
            },
          },
        });
      }
      return route.fulfill({ json: { runs: [], projects: [], pagination: { total: 0 } } });
    });
    await page.goto(`/projects/p/processing?source=${source}&sourceId=asset`);
    await page.getByRole("checkbox", { name: "选择记录 asset:1", exact: true }).click();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择记录 asset:21", exact: true }).click();
    await page.getByRole("textbox", { name: "补充要求（选填）" }).fill("保留原意，只整理空白");
    if (source === "assets") {
      for (const width of [1440, 1280, 1024, 480]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (width >= 1280) {
          const container = page.locator("table").first().locator("..");
          expect(
            await container.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
        } else {
          await page.getByRole("button", { name: "设置处理", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "处理要求", exact: true }),
          ).toBeInViewport();
        }
        await page.screenshot({
          path: info.outputPath(`opt12-config-${width}.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.getByRole("link", { name: "返回处理任务", exact: true }).click();
    await page.goBack();
    await expect(page.getByRole("textbox", { name: "补充要求（选填）" })).toHaveValue(
      "保留原意，只整理空白",
    );
    await expect(page.getByRole("button", { name: "开始清洗 · 2 条输入" })).toBeEnabled();
    await expect(
      page.getByRole("checkbox", { name: "选择记录 asset:21", exact: true }),
    ).toBeChecked();
    await page.getByRole("link", { name: "返回处理任务", exact: true }).click();
    revision = "view-2";
    await page.goBack();
    await expect(
      page.getByText("来源修订已变化，处理要求已保留。请重新核对输入记录。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "开始清洗 · 2 条输入" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "补充要求（选填）" })).toHaveValue(
      "保留原意，只整理空白",
    );
    await page.getByRole("button", { name: "重新选择记录", exact: true }).click();
    await expect(page.getByRole("button", { name: "开始清洗 · 0 条输入" })).toBeDisabled();
  });

test("reviews across pages, keeps controls while filtering, and retains hidden selections", async ({
  page,
}) => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `0:${i}`,
    original: { question: `问题 ${i + 1}`, expectedOutput: "保留", metadata: [] },
    result: {
      question: `问题 ${i + 1}`,
      expectedOutput: "保留",
      metadata: [{ key: "分类", value: "A" }],
    },
    changedFields: ["metadata"],
    issues: [],
  }));
  let failSearch = true;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/processing-runs/review")) {
      if (url.searchParams.get("search") === "失败" && failSearch)
        return route.fulfill({ status: 500, json: { error: { code: "internal_error" } } });
      if (url.searchParams.get("search")) await new Promise((resolve) => setTimeout(resolve, 500));
      const matched = url.searchParams.get("search") ? [] : rows;
      const offset = Number(url.searchParams.get("offset"));
      return route.fulfill({
        json: {
          run: {
            id: "review",
            source: { kind: "assets" },
            status: "succeeded",
            executionComplete: true,
            inputCount: 25,
            outputCount: 25,
            options: {
              operation: "rewrite",
              instructions: "新增分类",
              allowedFields: ["metadata"],
            },
            createdAt: "2026-10-11",
            errorCode: null,
          },
          offset,
          records: matched.slice(offset, offset + 20),
          total: matched.length,
          allIds: matched.map((row) => row.id),
          stats: { all: matched.length, changed: matched.length, needsReview: 0 },
          issues: [],
          receipts: [],
        },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=review");
  await page.getByLabel("选择结果 1", { exact: true }).check();
  await page.getByRole("row", { name: "查看记录 20", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("第 20 条，共 25 条");
  await page.getByRole("button", { name: "下一条", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("第 21 条，共 25 条");
  await expect(page.getByRole("dialog")).toContainText("问题 21");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("row", { name: "查看记录 21", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "保存所选 1 条" })).toBeEnabled();
  await page.getByLabel("搜索处理结果").fill("失败");
  await expect(page.getByRole("button", { name: "重试读取", exact: true })).toBeVisible();
  await expect(page.getByLabel("结果筛选")).toBeVisible();
  await expect(page.getByRole("row", { name: "查看记录 21", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存所选 1 条" })).toBeDisabled();
  failSearch = false;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page.getByLabel("搜索处理结果").fill("不存在");
  await expect(page.getByRole("button", { name: "选择全部匹配结果", exact: true })).toBeDisabled();
  await expect(page.getByLabel("结果筛选")).toBeVisible();
  await expect(page.getByText("没有匹配结果，可切换筛选条件。")).toBeVisible();
  await expect(page.getByText("已选 1 条（1 条在当前筛选外）")).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked();
});

test("searches and paginates task history and opens existing files without submitting", async ({
  page,
}) => {
  let submits = 0;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/processing-runs")) {
      if (route.request().method() === "POST") submits++;
      const query = new URL(route.request().url()).searchParams;
      const offset = Number(query.get("offset") ?? 0);
      return route.fulfill({
        json: {
          runs: Array.from({ length: 25 }, (_, i) => ({
            id: `r${i}`,
            sourceSummary: { name: "原始问题.csv", kindLabel: "原始数据", files: [] },
            options: {
              operation: "rewrite",
              instructions: i === 24 ? "唯一任务要求" : `任务要求 ${i}`,
            },
            status: "succeeded",
            executionComplete: true,
            hasSavedResult: i === 24,
            inputCount: 20,
            createdAt: "2026-10-11",
            errorCode: null,
          }))
            .filter((run) => run.options.instructions.includes(query.get("search") ?? ""))
            .slice(offset, offset + 20),
          pagination: { total: query.get("search") ? 1 : 25 },
          hasActive: false,
        },
      });
    }
    if (path.endsWith("/collections"))
      return route.fulfill({
        json: { collections: [{ id: "raw", name: "资料集合" }], pagination: { total: 1 } },
      });
    if (path.endsWith("/assets"))
      return route.fulfill({
        json: { assets: [{ id: "asset", fileName: "原始问题.csv" }], pagination: { total: 1 } },
      });
    if (path.endsWith("/processing-inputs"))
      return route.fulfill({
        json: {
          records: [],
          allIds: [],
          total: 0,
          sourceSummary: { name: "原始问题.csv", kindLabel: "原始数据", files: [] },
        },
      });
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing");
  await expect(page.locator("tbody tr")).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await page.getByLabel("搜索处理任务").fill("唯一任务要求");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("有保存记录");
  await page.getByRole("button", { name: "新建处理", exact: true }).click();
  await page.getByRole("combobox", { name: "原始数据集合" }).click();
  await page.getByRole("option", { name: "资料集合", exact: true }).click();
  await page.getByRole("button", { name: "原始问题.csv", exact: true }).click();
  await expect(page.getByRole("heading", { name: "处理 原始问题.csv" })).toBeVisible();
  expect(submits).toBe(0);
});

for (const kind of ["version", "draft"] as const)
  test(`chooses an explicit ${kind} without submitting a processing task`, async ({ page }) => {
    let submits = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/collaborative-drafts"))
        return route.fulfill({
          json: {
            drafts: [{ id: "draft-1", name: "共同草稿", paused: false, parentVersionLabel: "v1" }],
          },
        });
      if (await mockAccountRoute(route)) return;
      if (path.endsWith("/solo-test-sets"))
        return route.fulfill({
          json: {
            testSets: [{ id: "set", name: "正式测试集", currentVersionId: "version-2" }],
            pagination: { total: 1 },
          },
        });
      if (path.endsWith("/versions/version-2"))
        return route.fulfill({
          json: {
            graph: {
              nodes: [
                { id: "version-1", label: "v1", recordCount: 20 },
                { id: "version-2", label: "v2", recordCount: 25 },
              ],
            },
          },
        });
      if (path.endsWith("/processing-runs")) {
        if (route.request().method() === "POST") submits++;
        return route.fulfill({ json: { runs: [] } });
      }
      if (path.endsWith("/processing-inputs"))
        return route.fulfill({ json: { records: [], total: 0, allIds: [] } });
      return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
    });
    await page.goto("/projects/p/processing");
    await page.getByRole("button", { name: "新建处理", exact: true }).click();
    await page.getByRole("combobox", { name: "处理来源类型" }).click();
    await page
      .getByRole("option", { name: kind === "version" ? "测试集版本" : "测试集草稿", exact: true })
      .click();
    if (kind === "version") {
      await page.getByRole("combobox", { name: "测试集", exact: true }).click();
      await page.getByRole("option", { name: "正式测试集", exact: true }).click();
      await expect(page).toHaveURL(/\/processing$/);
      await page.getByRole("button", { name: "v1 · 20 条记录", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "共同草稿 · 基于 v1", exact: true }).click();
    }
    await expect(page).toHaveURL(
      kind === "version" ? /source=version&sourceId=version-1/ : /source=draft&sourceId=draft-1/,
    );
    expect(submits).toBe(0);
  });

test("does not expose processing inputs or creation to a read-only account", async ({ page }) => {
  let inputReads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/access"))
      return route.fulfill({
        json: {
          access: {
            role: "viewer",
            capabilities: { read: true, write: false, export: true, manage: false },
          },
        },
      });
    if (await mockAccountRoute(route)) return;
    if (path.endsWith("/processing-inputs")) inputReads++;
    return route.fulfill({ json: { runs: [], projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?source=assets&sourceId=asset");
  await expect(page.getByRole("alert")).toContainText("编辑权限才能运行处理和查看未发布结果");
  await expect(page.getByRole("button", { name: "新建处理", exact: true })).toHaveCount(0);
  expect(inputReads).toBe(0);
});

test("hides confirmed results when the same polling query loses access", async ({ page }) => {
  let forbidden = false;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    if (new URL(route.request().url()).pathname.endsWith("/processing-runs/revoked")) {
      if (forbidden)
        return route.fulfill({ status: 403, json: { error: { code: "processing_not_found" } } });
      return route.fulfill({
        json: {
          run: {
            id: "revoked",
            status: "running",
            options: { operation: "clean" },
            inputCount: 1,
            source: { kind: "assets" },
            createdAt: "2026-10-11",
          },
          records: [
            {
              id: "0:0",
              result: { question: "不能继续显示的记录", expectedOutput: "原值", metadata: [] },
            },
          ],
          total: 1,
          offset: 0,
          allIds: ["0:0"],
          stats: { all: 1, changed: 0, needsReview: 0 },
          issues: [],
        },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=revoked");
  await expect(page.getByText("不能继续显示的记录")).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).searchParams.get("view") === "changed",
    ),
    page.getByRole("button", { name: /^有变化/ }).click(),
  ]);
  forbidden = true;
  await expect(page.getByRole("alert")).toContainText("当前任务不可访问");
  await expect(page.getByText("不能继续显示的记录")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^全部/ })).toHaveCount(0);
  forbidden = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("不能继续显示的记录")).toBeVisible();
});

test("hides revoked source projections but retains the user's configuration", async ({ page }) => {
  let forbidden = false;
  let releaseSearch: (() => void) | undefined;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    if (new URL(route.request().url()).pathname.endsWith("/processing-inputs")) {
      if (forbidden) {
        if (route.request().postDataJSON().search === "保密")
          await new Promise<void>((resolve) => {
            releaseSearch = resolve;
          });
        return route.fulfill({ status: 403, json: { error: { code: "processing_not_found" } } });
      }
      return route.fulfill({
        json: {
          sourceRevision: "view-1",
          metadataKeys: ["隐私分类"],
          sourceSummary: {
            name: "保密原件.csv",
            kindLabel: "原始数据",
            files: [],
            href: "/private-source",
          },
          records: [
            {
              id: "asset:1",
              question: "保密记录",
              expectedOutput: "原值",
              metadata: [{ key: "隐私分类", value: "分类A" }],
            },
          ],
          total: 1,
          allIds: ["asset:1"],
        },
      });
    }
    return route.fulfill({ json: { projects: [], runs: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?source=assets&sourceId=asset");
  await expect(page.locator("summary").filter({ hasText: "保密记录" })).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/processing-inputs") &&
        response.request().postDataJSON().search === "保密",
    ),
    page.getByRole("textbox", { name: "搜索输入记录", exact: true }).fill("保密"),
  ]);
  await page.getByRole("textbox", { name: "搜索输入记录", exact: true }).fill("");
  await page.getByRole("textbox", { name: "补充要求（选填）" }).fill("这是用户自己的处理要求");
  await page.getByRole("link", { name: "返回处理任务", exact: true }).click();
  forbidden = true;
  await page.goBack();
  await expect(page.getByRole("button", { name: "重试读取来源", exact: true })).toBeVisible();
  await expect(page.getByText("保密记录")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "处理 保密原件.csv" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "查看来源", exact: true })).toHaveCount(0);
  await expect(page.locator("datalist option")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "补充要求（选填）" })).toHaveValue(
    "这是用户自己的处理要求",
  );
  await Promise.all([
    page.waitForRequest(
      (req) => req.url().endsWith("/processing-inputs") && req.postDataJSON().search === "保密",
    ),
    page.getByRole("textbox", { name: "搜索输入记录", exact: true }).fill("保密"),
  ]);
  expect(await page.getByText("保密记录").count()).toBe(0);
  releaseSearch?.();
  await expect(page.getByRole("button", { name: "重试读取来源", exact: true })).toBeVisible();
});
