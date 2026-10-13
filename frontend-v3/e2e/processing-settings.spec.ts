import { test, expect } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("operation settings protect defaults and retain separate configurations", async ({
  page,
}, info) => {
  const submissions: { options: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/processing-inputs"))
      return route.fulfill({
        json: {
          records: [
            {
              id: "asset:1",
              question: "参考问题",
              expectedOutput: "类别",
              metadata: [{ key: "来源", value: "参考" }],
            },
          ],
          allIds: ["asset:1"],
          total: 1,
          sourceRevision: "fixed",
        },
      });
    if (path.endsWith("/processing-runs") && route.request().method() === "POST") {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { run: { id: "created" } } });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?source=assets&sourceId=asset");
  await page.getByRole("checkbox", { name: "选择记录 asset:1", exact: true }).click();
  await expect(page.getByText("允许修改的字段", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "期望输出", exact: true })).not.toBeVisible();
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByRole("checkbox", { name: "期望输出", exact: true }).check();
  await page.getByRole("button", { name: "改写", exact: true }).click();
  await expect(page.getByText("改写哪些内容", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "期望输出", exact: true })).not.toBeChecked();
  await page.getByRole("textbox", { name: "具体要求", exact: true }).fill("保留原意改写");
  await page.getByRole("button", { name: "扩充", exact: true }).click();
  await expect(
    page.getByText("生成问题 · 期望输出、Metadata沿用参考值", { exact: true }),
  ).toBeVisible();
  await page.getByText("生成设置", { exact: true }).click();
  await page.getByRole("combobox", { name: "期望输出生成方式" }).click();
  await page.getByRole("option", { name: "由模型生成", exact: true }).click();
  await page.getByRole("textbox", { name: "生成要求", exact: true }).fill("增加新场景");
  await page.getByLabel("新增记录数量", { exact: true }).fill("2");
  await page.getByRole("button", { name: "清洗", exact: true }).click();
  await page.getByText("高级设置", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "期望输出", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "改写", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "具体要求", exact: true })).toHaveValue(
    "保留原意改写",
  );
  await page.getByRole("button", { name: "扩充", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "生成要求", exact: true })).toHaveValue(
    "增加新场景",
  );
  await page.reload();
  await page.getByRole("button", { name: "扩充", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "生成要求", exact: true })).toHaveValue(
    "增加新场景",
  );
  await expect(page.getByLabel("新增记录数量", { exact: true })).toHaveValue("2");
  await page.getByRole("checkbox", { name: "选择记录 asset:1", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: info.outputPath("operation-settings-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 480, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("operation-settings-narrow.png"), fullPage: true });
  await page.evaluate(() => {
    Storage.prototype.removeItem = () => {
      throw new DOMException("disabled", "SecurityError");
    };
  });
  await page.getByRole("button", { name: "开始扩充 · 1 条输入", exact: true }).click();
  await expect(page).toHaveURL(/run=created/);
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]!.options).toEqual({
    operation: "augment",
    instructions: "增加新场景",
    allowedFields: ["question", "expectedOutput"],
    outputCount: 2,
  });
});

test("partial rewrite offers only missing-input continuation and safe diagnostic details", async ({
  page,
}, info) => {
  let submitted: unknown;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/rounds")) {
      submitted = route.request().postDataJSON();
      return route.fulfill({ status: 409, json: { error: { code: "processing_task_changed" } } });
    }
    if (path.endsWith("/processing-tasks/partial"))
      return route.fulfill({
        json: {
          run: {
            id: "partial",
            source: { kind: "assets" },
            options: {
              operation: "rewrite",
              instructions: "改写问题",
              allowedFields: ["question"],
            },
            status: "failed",
            inputCount: 3,
            outputCount: 1,
            missingCount: 2,
            createdAt: "2026-10-13",
            executionComplete: false,
          },
          task: {
            id: "partial",
            revision: 2,
            title: "问题.csv · 数据处理",
            roundCount: 1,
            currentCount: 3,
            unsavedCount: 1,
            savedCount: 0,
            latestUsableCount: 1,
            incomplete: true,
          },
          recovery: { canRetry: false, canContinue: true, reason: "budget_exhausted" },
          diagnostics: [
            {
              batch: 0,
              attempts: 3,
              accepted: 1,
              missing: 2,
              calls: [
                {
                  attempt: 3,
                  durationMs: 600,
                  code: "invalid_json",
                  generated: 0,
                  validated: 0,
                  duplicates: 0,
                  invalid: 0,
                  accepted: 0,
                },
              ],
            },
          ],
          records: [],
          allIds: [],
          total: 0,
          issues: [],
          receipts: [],
          unsavedIds: [],
          unprocessedIds: [],
          adoptedIds: [],
        },
      });
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=partial");
  await expect(page.getByText("部分完成", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试未完成部分", exact: true })).toHaveCount(0);
  await page.getByText("查看执行说明", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/模型未返回有效 JSON/)).toBeVisible();
  await page.setViewportSize({ width: 480, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("partial-recovery-narrow.png"), fullPage: true });
  await page.getByRole("button", { name: "继续处理未完成部分", exact: true }).click();
  await expect.poll(() => submitted).toEqual({ mode: "complete", expectedRevision: 2 });
});
