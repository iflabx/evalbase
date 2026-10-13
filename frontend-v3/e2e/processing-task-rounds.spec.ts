import { expect, test } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("keeps a stable task workspace and opens read-only round history without changing the current selection", async ({
  page,
}, info) => {
  let submitted = 0;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url()),
      path = url.pathname;
    const run = {
      id: "round2",
      source: { kind: "assets" },
      sourceSummary: { name: "问题.csv", files: [] },
      options: { operation: "clean", instructions: "第二轮要求", allowedFields: ["question"] },
      status: "succeeded",
      executionComplete: true,
      inputCount: 1,
      outputCount: 1,
      createdAt: "2026-10-13",
      actorName: "管理员",
    };
    const row = {
      id: "1:1",
      original: { question: "原始问题", expectedOutput: "A", metadata: [] },
      result: { question: "当前问题", expectedOutput: "A", metadata: [] },
      changedFields: ["question"],
      issues: [],
    };
    if (path.endsWith("/processing-tasks/task"))
      return route.fulfill({
        json: {
          run,
          task: {
            id: "task",
            revision: 3,
            title: "问题.csv · 数据处理",
            latestRunId: "round2",
            roundCount: 2,
            currentCount: 1,
            excludedCount: 0,
            unsavedCount: 1,
            savedCount: 0,
          },
          unsavedIds: ["1:1"],
          adoptedIds: [],
          total: 1,
          allIds: ["1:1"],
          records: [row],
          issues: [],
          stats: { all: 1, changed: 1, needsReview: 0 },
          receipts: [],
        },
      });
    if (path.endsWith("/history"))
      return route.fulfill({
        json: {
          rounds: [
            { ...run, roundNumber: 2, savedCount: 0 },
            {
              ...run,
              id: "round1",
              roundNumber: 1,
              options: { ...run.options, instructions: "首轮要求" },
              savedCount: 0,
            },
          ],
          total: 2,
        },
      });
    if (path.endsWith("/processing-runs/round1"))
      return route.fulfill({
        json: {
          run: { ...run, id: "round1" },
          records: [{ ...row, result: { ...row.result, question: "历史问题" } }],
          total: 1,
          allIds: ["1:1"],
          issues: [],
          receipts: [],
        },
      });
    if (path.endsWith("/rounds")) {
      submitted++;
      return route.fulfill({ status: 201, json: { run: { id: "round3" } } });
    }
    return route.fulfill({ json: { projects: [], runs: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=task");
  await expect(page.getByRole("heading", { name: "问题.csv · 数据处理" })).toBeVisible();
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "轮次历史（2）" }).click();
  await expect(page.getByRole("dialog")).toContainText("首轮要求");
  await page.getByRole("button", { name: "查看本轮", exact: true }).nth(1).click();
  await expect(page.getByRole("dialog")).toContainText("历史问题");
  await expect(page.getByRole("dialog").getByLabel("选择结果 1", { exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked();
  await expect(page).toHaveURL(/run=task/);
  expect(submitted).toBe(0);
  for (const width of [1440, 480]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`opt17-workspace-${width}.png`),
      fullPage: true,
    });
  }
});

test("selects results after the first terminal read and refreshes a missing-output continuation", async ({
  page,
}) => {
  let reads = 0,
    continued = false,
    submitted: unknown;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/rounds")) {
      submitted = route.request().postDataJSON();
      continued = true;
      return route.fulfill({ status: 201, json: { run: { id: "round3" } } });
    }
    if (path.endsWith("/processing-tasks/task")) {
      const running = ++reads === 1 || continued;
      const ids = ["1:1", "1:2", "2:1"];
      return route.fulfill({
        json: {
          run: {
            id: continued ? "round3" : "round2",
            source: { kind: "assets" },
            sourceSummary: { name: "问题.csv", files: [] },
            options: {
              operation: "augment",
              outputCount: 3,
              instructions: "新增三条",
              allowedFields: ["question"],
            },
            status: running ? "queued" : "failed",
            inputCount: 2,
            outputCount: 1,
            createdAt: "2026-10-13",
            executionComplete: false,
          },
          task: {
            id: "task",
            revision: running ? (continued ? 3 : 1) : 2,
            title: "问题.csv · 数据处理",
            roundCount: 2,
            currentCount: 3,
            unsavedCount: running ? 0 : 3,
            savedCount: 0,
            latestUsableCount: 1,
            excludedCount: 0,
            incomplete: true,
          },
          records: ids.map((id, i) => ({
            id,
            unprocessed: running,
            result: { question: `问题${i}`, expectedOutput: "A", metadata: [] },
            issues: [],
          })),
          recovery: {
            canRetry: false,
            canContinue: !running,
            reason: running ? null : "budget_exhausted",
          },
          unprocessedIds: running ? ids : [],
          unsavedIds: running ? [] : ids,
          adoptedIds: [],
          usableCount: 3,
          allIds: ids,
          total: 3,
          issues: [],
          receipts: [],
        },
      });
    }
    return route.fulfill({ json: { projects: [], runs: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=task");
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("选择结果 1", { exact: true })).toBeChecked({ timeout: 10000 });
  await page.getByRole("button", { name: "补齐剩余 2 条", exact: true }).click();
  await expect.poll(() => submitted).toEqual({ mode: "complete", expectedRevision: 2 });
  await expect(page.getByText("等待中", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/run=task/);
});
