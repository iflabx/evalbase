import { expect, test } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("continues only selected processed values without an intermediate save", async ({ page }) => {
  const attempts: { key: string; body: unknown }[] = [];
  const ids = Array.from({ length: 24 }, (_, i) => `${Math.floor(i / 20)}:${i % 20}`);
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/input"))
      return route.fulfill({
        json: {
          records: [0, 1].map((i) => ({
            id: `candidate:${i === 0 ? "0:0" : "1:0"}`,
            question: `清洗后的问题 ${i === 0 ? 1 : 21}`,
            expectedOutput: "保留",
            metadata: [],
          })),
          allIds: ["candidate:0:0", "candidate:1:0"],
          total: 2,
          sourceTotal: 2,
          sourceRevision: "1",
          metadataKeys: [],
          sourceSummary: { name: "问题.csv", kindLabel: "上一次处理结果", files: [] },
          parent: {
            id: "parent",
            options: { operation: "clean", instructions: "旧要求" },
            createdAt: "2026-10-12",
          },
        },
      });
    if (path.endsWith("/rounds")) {
      const body = route.request().postDataJSON();
      attempts.push({ key: route.request().headers()["idempotency-key"]!, body });
      expect(body.resultIds).toEqual(["0:0", "1:0"]);
      expect(body.options.operation).toBe("rewrite");
      if (attempts.length === 1) return route.abort("failed");
      return route.fulfill({ status: 201, json: { run: { id: "child" } } });
    }
    if (path.endsWith("/processing-tasks/parent") || path.endsWith("/processing-tasks/child"))
      return route.fulfill({
        json: {
          run: {
            id: "parent",
            status: "succeeded",
            executionComplete: true,
            inputCount: 24,
            outputCount: 24,
            options: { operation: "clean", instructions: "旧要求", allowedFields: ["question"] },
            source: { kind: "assets" },
            createdAt: "2026-10-12",
            sourceSummary: { name: "问题.csv", files: [] },
          },
          task: {
            id: "parent",
            revision: 1,
            title: "问题.csv · 数据处理",
            roundCount: 1,
            currentCount: 24,
            excludedCount: 0,
            unsavedCount: 24,
            savedCount: 0,
          },
          records: Array.from({ length: 24 }, (_, i) => i)
            .slice(
              Number(new URL(route.request().url()).searchParams.get("offset") ?? 0),
              Number(new URL(route.request().url()).searchParams.get("offset") ?? 0) + 20,
            )
            .map((i) => ({
              id: ids[i],
              original: { question: "原始值", expectedOutput: "保留", metadata: [] },
              result: { question: `清洗后的问题 ${i + 1}`, expectedOutput: "保留", metadata: [] },
              changedFields: ["question"],
              issues: [],
            })),
          total: 24,
          allIds: ids,
          stats: { all: 24, changed: 24, needsReview: 0 },
          issues: [],
          receipts: [],
          adoptedIds: [],
        },
      });
    return route.fulfill({ json: { projects: [], runs: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=parent");
  await page.getByLabel("选择结果 1", { exact: true }).check();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByLabel("选择结果 21", { exact: true }).check();
  await page.getByRole("button", { name: "继续处理所选 2 条", exact: true }).click();
  expect(attempts).toHaveLength(0);
  await expect(page.locator("summary").filter({ hasText: "清洗后的问题 1" })).toBeVisible();
  await expect(page.getByText("清洗后的问题 3", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "补充要求（选填）" })).toHaveValue("");
  await page.getByRole("button", { name: "改写", exact: true }).click();
  await page.getByRole("textbox", { name: "具体要求" }).fill("表达更清楚");
  await page.getByRole("button", { name: "开始改写 · 2 条输入", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("提交结果尚未确认");
  await expect(page.getByRole("textbox", { name: "具体要求" })).toBeDisabled();
  await page.getByRole("button", { name: "核对提交结果", exact: true }).click();
  await expect(page).toHaveURL(/run=parent/);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
});

test("defaults to the true source draft and reconciles an unknown save with the same key", async ({
  page,
}) => {
  const attempts: { key: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/collaborative-drafts/source"))
      return route.fulfill({ json: { draft: { revision: 7 } } });
    if (path.endsWith("/accept")) {
      attempts.push({
        key: route.request().headers()["idempotency-key"]!,
        body: route.request().postDataJSON(),
      });
      if (attempts.length === 1) return route.abort("failed");
      return route.fulfill({
        status: 200,
        json: { receipt: { assetId: "saved", draftId: "source", adopted: 1 } },
      });
    }
    if (path.endsWith("/processing-tasks/draft-run"))
      return route.fulfill({
        json: {
          run: {
            id: "draft-run",
            source: { kind: "draft", id: "source" },
            sourceSummary: { name: "真实来源草稿", files: [] },
            status: "succeeded",
            inputCount: 1,
            outputCount: 1,
            createdAt: "2026-10-12",
            options: {
              operation: "rewrite",
              instructions: "改写新增问题",
              allowedFields: ["question"],
            },
          },
          task: {
            id: "draft-run",
            revision: 1,
            title: "真实来源草稿 · 数据处理",
            roundCount: 1,
            currentCount: 1,
            excludedCount: 0,
            unsavedCount: 1,
            savedCount: 0,
          },
          rootOperation: "augment",
          saveDisposition: { updateIds: [], addIds: ["0:0"], removeCount: 0 },
          total: 1,
          allIds: ["0:0"],
          adoptedIds: [],
          issues: [],
          receipts: [],
          records: [
            {
              id: "0:0",
              result: { question: "生成的新问题", expectedOutput: "保留", metadata: [] },
              changedFields: ["new"],
              issues: [],
            },
          ],
        },
      });
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=draft-run");
  await page.getByLabel("选择结果 1", { exact: true }).check();
  await page.getByRole("button", { name: "保存回原草稿", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("真实来源草稿");
  await expect(page.getByRole("dialog")).toContainText("新增 1 条");
  await expect(page.getByRole("dialog").getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("保存响应未确认");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "另存到…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "保存回原草稿", exact: true }).click();
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[1]?.body).toEqual({
    expectedRevision: 1,
    resultIds: ["0:0"],
    target: { kind: "draft", id: "source", expectedRevision: 7 },
  });
  await expect(page.getByRole("link", { name: "返回草稿", exact: true })).toHaveAttribute(
    "href",
    "/projects/p/test-sets/drafts/source",
  );
});

test("shows compact source history, keeps distinct processing steps and restores keyboard focus", async ({
  page,
}, info) => {
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    if (new URL(route.request().url()).pathname.endsWith("/processing-tasks/source"))
      return route.fulfill({
        json: {
          run: {
            id: "source",
            status: "succeeded",
            inputCount: 1,
            outputCount: 1,
            source: { kind: "assets" },
            options: { operation: "augment", instructions: "生成", allowedFields: ["question"] },
            createdAt: "2026-10-12",
          },
          total: 1,
          allIds: ["0:0"],
          issues: [],
          receipts: [],
          records: [
            {
              id: "0:0",
              result: { question: "新问题", expectedOutput: "保留", metadata: [] },
              changedFields: ["new"],
              issues: [],
              sourcePresentation: {
                label: "模型扩写 · 参考 100个问题_new.csv",
                generated: true,
                badges: ["模型扩写"],
                steps: [
                  { kind: "reference", label: "100个问题_new.csv · 第 1 条", href: "/original" },
                  {
                    kind: "processing",
                    label: "模型扩写",
                    href: "/projects/p/processing?run=first",
                    occurredAt: "2026-10-11T01:00:00Z",
                  },
                  {
                    kind: "processing",
                    label: "模型扩写",
                    href: "/projects/p/processing?run=second",
                    occurredAt: "2026-10-12T01:00:00Z",
                  },
                  { kind: "saved", label: "扩充结果-12345678.jsonl", href: "/saved" },
                ],
              },
            },
          ],
        },
      });
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/p/processing?run=source");
  for (const width of [1440, 1280, 480]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`opt13-result-${width}.png`), fullPage: true });
  }
  const trigger = page.getByRole("button", { name: "查看来源", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("任务参考范围");
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "模型扩写", exact: true }),
  ).toHaveCount(2);
  await expect(page.getByRole("dialog")).toContainText("参考位置");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const target of ["newDraft", "existingDraft"] as const) {
  test(`restores an unknown ${target} save after returning to the result page`, async ({
    page,
  }) => {
    const attempts: { key: string; body: unknown }[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/collaborative-drafts"))
        return route.fulfill({
          json: {
            drafts: [{ id: "target", name: "另存目标", parentVersionLabel: null, paused: false }],
          },
        });
      if (await mockAccountRoute(route)) return;
      if (path.endsWith("/collaborative-drafts/target"))
        return route.fulfill({ json: { draft: { revision: 5 } } });
      if (path.endsWith("/accept")) {
        attempts.push({
          key: route.request().headers()["idempotency-key"]!,
          body: route.request().postDataJSON(),
        });
        if (attempts.length === 1) return route.abort("failed");
        return route.fulfill({
          json: { receipt: { assetId: "saved", draftId: "target", adopted: 1 } },
        });
      }
      if (path.endsWith("/processing-tasks/restore"))
        return route.fulfill({
          json: {
            run: {
              id: "restore",
              source: { kind: "assets", assetIds: ["asset"] },
              sourceSummary: { name: "问题.csv", files: [] },
              status: "succeeded",
              inputCount: 1,
              outputCount: 1,
              createdAt: "2026-10-12",
              options: { operation: "clean", instructions: "", allowedFields: ["question"] },
            },
            task: {
              id: "restore",
              revision: 1,
              title: "问题.csv · 数据处理",
              roundCount: 1,
              currentCount: 1,
              excludedCount: 0,
              unsavedCount: 1,
              savedCount: 0,
            },
            total: 1,
            allIds: ["0:0"],
            issues: [],
            receipts: [],
            adoptedIds: [],
            records: [
              {
                id: "0:0",
                result: { question: "问题", expectedOutput: "保留", metadata: [] },
                changedFields: [],
                issues: [],
              },
            ],
          },
        });
      return route.fulfill({ json: { projects: [], runs: [], pagination: { total: 0 } } });
    });
    await page.goto("/projects/p/processing?run=restore");
    await page.getByLabel("选择结果 1", { exact: true }).check();
    await page.getByRole("button", { name: "保存所选 1 条", exact: true }).click();
    await page.getByRole("dialog").getByRole("combobox").click();
    await page
      .getByRole("option", {
        name: target === "newDraft" ? "新建测试集草稿" : "加入已有草稿",
        exact: true,
      })
      .click();
    if (target === "newDraft")
      await page.getByRole("textbox", { name: "测试集名称", exact: true }).fill("另存目标");
    else {
      await page.getByRole("combobox", { name: "目标草稿", exact: true }).click();
      await page.getByRole("option", { name: "另存目标 · 新建草稿", exact: true }).click();
    }
    await page.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("保存响应未确认");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "返回处理任务", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "搜索处理任务", exact: true })).toBeVisible();
    await page.goBack();
    await page.getByRole("button", { name: "保存所选 1 条", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认保存", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "确认保存", exact: true }).click();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    await expect(page.getByRole("link", { name: "返回草稿", exact: true })).toBeVisible();
  });
}
