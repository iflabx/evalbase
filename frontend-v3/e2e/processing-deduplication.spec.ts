import { expect, test } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("checks hidden selections, restores exclusions, and confirms explicit original-row removals", async ({
  page,
}, info) => {
  const ids = Array.from({ length: 25 }, (_, i) => `${Math.floor(i / 20)}:${i % 20}`);
  const kept = ids.filter((id) => id !== "1:0");
  let checked: string[] = [],
    save: { resultIds: string[]; expectedRevision: number } | undefined;
  let excluded = false;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (path.endsWith("/deduplication")) {
      const body = route.request().postDataJSON();
      if (body.action === "restore") {
        excluded = false;
        return route.fulfill({ json: { restoredIds: ["1:0"] } });
      }
      if (body.action === "exclude") excluded = true;
      checked = route.request().postDataJSON().resultIds;
      return route.fulfill({
        json: {
          checkedIds: ids,
          keptIds: kept,
          excludedIds: ["1:0"],
          removedRecordIds: ["original-duplicate"],
          inspected: 25,
        },
      });
    }
    if (path.endsWith("/accept")) {
      save = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        json: {
          receipt: {
            acceptanceId: "receipt",
            assetId: "asset",
            draftId: "draft",
            adopted: 24,
            removed: 1,
          },
        },
      });
    }
    if (path.endsWith("/collaborative-drafts/draft"))
      return route.fulfill({ json: { draft: { revision: 3 } } });
    if (path.endsWith("/processing-tasks/run")) {
      const search = url.searchParams.get("search");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const visible = search
        ? [0]
        : Array.from({ length: 25 }, (_, i) => i).slice(offset, offset + 20);
      return route.fulfill({
        json: {
          run: {
            id: "run",
            source: { kind: "draft", id: "draft" },
            sourceSummary: { name: "协作草稿", files: [] },
            options: { operation: "clean", instructions: "去重", allowedFields: ["question"] },
            status: "succeeded",
            executionComplete: true,
            inputCount: 25,
            outputCount: 25,
            createdAt: "2026-10-13",
          },
          rootOperation: "clean",
          task: {
            id: "run",
            revision: 1,
            title: "协作草稿 · 数据处理",
            roundCount: 1,
            currentCount: excluded ? 24 : 25,
            excludedCount: excluded ? 1 : 0,
            unsavedCount: excluded ? 24 : 25,
            savedCount: 0,
          },
          saveDisposition: { updateIds: ids, addIds: [], removeCount: excluded ? 1 : 0 },
          records: visible.map((i) => ({
            id: ids[i],
            original: { question: "问题", expectedOutput: "A", metadata: [] },
            result: { question: `问题${i}`, expectedOutput: "A", metadata: [] },
            changedFields: ["question"],
            issues: i === 0 || i === 20 ? [{ code: "duplicate_content" }] : [],
          })),
          total: search ? 1 : 25,
          allIds: search ? [ids[0]] : ids,
          stats: { all: 25, changed: 25, needsReview: 2, duplicates: 2 },
          issues: [{ code: "duplicate_content" }],
          adoptedIds: [],
          receipts: [],
        },
      });
    }
    return route.fulfill({
      json: { drafts: [], runs: [], projects: [], pagination: { total: 0 } },
    });
  });
  await page.goto("/projects/p/processing?run=run");
  await page.getByRole("button", { name: "选择全部匹配结果", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索处理结果" }).fill("问题0");
  await expect(page.getByText("已选 25 条", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "去重", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("检查 25 条，每组保留一条，排除 1 条");
  expect(checked).toEqual(ids);
  await page.getByRole("button", { name: "排除重复", exact: true }).click();
  await page.getByRole("button", { name: "恢复排除（1）", exact: true }).click();
  await expect(page.getByText("已选 25 条", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "去重", exact: true }).click();
  await page.getByRole("button", { name: "排除重复", exact: true }).click();
  for (const width of [1440, 480]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`opt16-results-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "保存回原草稿", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("移除 1 条排除的原记录");
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect.poll(() => save?.resultIds).toEqual(kept);
  expect(save!.expectedRevision).toBe(1);
});

test("shows only five status filters and keeps one-page footers close to settled tables", async ({
  page,
}, info) => {
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    return route.fulfill({
      json: {
        runs: [
          {
            id: "r",
            sourceSummary: { name: "问题.csv", files: [] },
            options: { operation: "clean", instructions: "" },
            inputCount: 1,
            status: "succeeded",
            executionComplete: true,
            actorName: "管理员",
            createdAt: "2026-10-13",
          },
        ],
        pagination: { total: 1 },
        hasActive: false,
        projects: [],
      },
    });
  });
  await page.goto("/projects/p/processing");
  await page.getByRole("combobox", { name: "任务执行状态" }).click();
  await expect(page.getByRole("option")).toHaveCount(5);
  await expect(page.getByRole("option", { name: "全部状态", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toHaveCount(0);
  const table = await page.locator("table").boundingBox(),
    footer = await page.getByText("共 1 项匹配任务", { exact: false }).boundingBox();
  expect(footer!.y - (table!.y + table!.height)).toBeLessThanOrEqual(20);
  await page.screenshot({ path: info.outputPath("opt16-history.png"), fullPage: true });
});
