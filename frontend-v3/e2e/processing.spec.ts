import { test, expect } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("selects explicit inputs, previews processing results, and confirms adoption without duplicate writes", async ({
  page,
}, testInfo) => {
  const base = "/api/projects/processing_project",
    value = {
      question: " 原问题 ",
      expectedOutput: "保留答案",
      metadata: [{ key: "类别", value: "" }],
    };
  let created = false,
    accepted = 0;
  const run = {
    id: "processing_one",
    source: { kind: "assets" },
    options: { operation: "clean", instructions: "" },
    status: "succeeded",
    progress: 100,
    inputCount: 1,
    createdAt: "2026-10-04T08:00:00Z",
    errorCode: null,
  };
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
            { id: "processing_project", name: "处理验收项目", datasetCount: 1, testSetCount: 0 },
          ],
          pagination: { total: 1 },
        },
      });
    if (path === `${base}/processing-inputs`)
      return route.fulfill({
        json: {
          records: [{ id: "asset:1", ...value }],
          allIds: ["asset:1"],
          total: 1,
          offset: 0,
          limit: 20,
        },
      });
    if (path === `${base}/processing-runs`) {
      if (method === "POST") {
        const body = route.request().postDataJSON();
        expect(body.source.recordIds).toEqual(["asset:1"]);
        expect(body.options.allowedFields).toEqual(["question"]);
        created = true;
        return route.fulfill({ status: 201, json: { run, replayed: false } });
      }
      return route.fulfill({ json: { runs: created ? [run] : [] } });
    }
    if (path === `${base}/processing-runs/processing_one`)
      return route.fulfill({
        json: {
          run,
          records: [
            {
              id: "0:0",
              original: { id: "asset:1", ...value },
              result: { ...value, question: "原问题" },
            },
          ],
          allIds: ["0:0"],
          total: 1,
          issues: [],
        },
      });
    if (path === `${base}/processing-runs/processing_one/accept`) {
      accepted++;
      expect(route.request().postDataJSON()).toEqual({
        resultIds: ["0:0"],
        target: { kind: "asset" },
      });
      return route.fulfill({
        status: 201,
        json: { receipt: { assetId: "derived", draftId: null, adopted: 1 }, replayed: false },
      });
    }
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });
  await page.goto("/projects/processing_project/processing?source=assets&sourceId=asset");
  await expect(page.getByRole("heading", { name: "选择输入记录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "处理任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Metadata", exact: true })).toBeVisible();
  await expect(page.getByText("类别：", { exact: true })).toBeVisible();
  await expect(page.getByText("(空)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始清洗 · 0 条输入" })).toBeDisabled();
  await page.getByRole("button", { name: /^选择全部匹配记录/ }).click();
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("processing-config-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "开始清洗 · 1 条输入" }).click();
  await expect(page.getByRole("heading", { name: "清洗结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "选择输入记录" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "处理任务", exact: true })).toHaveCount(0);
  await expect(page.getByText("类别：", { exact: true })).toHaveCount(1);
  for (const entry of await page.getByText("类别：", { exact: true }).all())
    await expect(entry).toBeVisible();
  await page.getByRole("button", { name: "选择全部匹配结果" }).click();
  await page.getByRole("button", { name: /^保存所选 \d+ 条$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(accepted).toBe(0);
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect.poll(() => accepted).toBe(1);
  await expect(page.getByText("已保存 1 条处理结果，并建立独立文件。")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "清洗结果" })).toBeVisible();
  expect(accepted).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("processing-results-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "返回处理任务", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索处理任务", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "选择输入记录" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "清洗结果" })).toHaveCount(0);
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await expect(page.getByRole("heading", { name: "清洗结果" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "处理任务", exact: true })).toHaveCount(0);
});

test("can retry missing records in a legacy succeeded run", async ({ page }) => {
  const base = "/api/projects/processing_project/processing-runs";
  let recovered = false;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    const run = {
      id: "legacy_run",
      source: { kind: "assets" },
      options: { operation: "rewrite", instructions: "" },
      status: "succeeded",
      partial: !recovered,
      missingCount: recovered ? 0 : 1,
      progress: 100,
      inputCount: 2,
      createdAt: "2026-10-04T08:00:00Z",
      errorCode: null,
    };
    if (path === `${base}/legacy_run/retry`) {
      recovered = true;
      return route.fulfill({ json: { run } });
    }
    if (path === base) return route.fulfill({ json: { runs: [run] } });
    if (path === `${base}/legacy_run`)
      return route.fulfill({
        json: {
          run,
          total: recovered ? 2 : 1,
          allIds: recovered ? ["0:0", "0:1"] : ["0:0"],
          records: [
            {
              id: "0:0",
              original: { question: "原问题", expectedOutput: "", metadata: [] },
              result: { question: "保留的候选", expectedOutput: "", metadata: [] },
            },
          ],
          issues: recovered ? [] : [{ code: "missing_output", count: 1 }],
        },
      });
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });
  await page.goto("/projects/processing_project/processing?run=legacy_run");
  await expect(page.getByRole("status").filter({ hasText: "尚缺 1 条" })).toBeVisible();
  await expect(page.getByText("保留的候选", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "重试未完成批次" }).click();
  await expect.poll(() => recovered).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "已产生 2 / 2 条结果" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试未完成批次" })).toHaveCount(0);
});
