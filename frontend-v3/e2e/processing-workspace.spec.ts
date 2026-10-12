import { test, expect } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("page selection retains earlier pages and submits the complete selection", async ({
  page,
}) => {
  const ids = Array.from({ length: 45 }, (_, i) => `asset:${i + 1}`);
  let submitted: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/processing-inputs")) {
      const body = route.request().postDataJSON();
      return route.fulfill({
        json: {
          records: ids.slice(body.offset, body.offset + body.limit).map((id) => ({
            id,
            question: `问题 ${id}`,
            expectedOutput: "回答",
            metadata: [{ key: "分类", value: "" }],
          })),
          allIds: ids,
          total: 45,
        },
      });
    }
    if (path.endsWith("/processing-runs") && route.request().method() === "POST") {
      submitted = route.request().postDataJSON().source.recordIds;
      return route.fulfill({
        status: 422,
        json: { error: { code: "processing_source_unavailable" } },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/processing_project/processing?source=assets&sourceId=asset");
  await page.getByRole("checkbox", { name: "选择记录 asset:1", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: /^(仅选择本页|勾选本页)$/ }).click();
  await expect(page.getByRole("button", { name: "开始清洗 · 21 条输入" })).toBeEnabled();
  await page.getByRole("button", { name: "开始清洗 · 21 条输入" }).click();
  await expect.poll(() => submitted).toEqual([ids[0], ...ids.slice(20, 40)]);
  await expect(page.getByRole("button", { name: "开始清洗 · 21 条输入" })).toBeEnabled();
});

for (const failure of ["network", "http500"])
  test(`reviews Metadata changes and safely retries an unknown ${failure} save`, async ({
    page,
  }, info) => {
    const value = {
      question: "一段需要保留的长问题".repeat(50),
      expectedOutput: "正常回答",
      metadata: [
        { key: "空值", value: "" },
        { key: "旧项", value: "保留" },
      ],
    };
    const run = {
      id: "review",
      source: { kind: "assets", assetIds: ["asset"] },
      sourceSummary: { name: "原始问题.csv", kindLabel: "原始数据", files: [] },
      actorName: "管理员",
      options: { operation: "rewrite", instructions: "只新增 gbRisk", allowedFields: ["metadata"] },
      status: "succeeded",
      progress: 100,
      inputCount: 1,
      outputCount: 1,
      createdAt: "2026-10-09T01:00:00Z",
      errorCode: null,
    };
    const keys: string[] = [];
    let saved = false;
    await page.route("**/api/**", async (route) => {
      if (await mockAccountRoute(route)) return;
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/processing-runs/review/accept")) {
        keys.push(route.request().headers()["idempotency-key"]!);
        if (keys.length === 1) {
          saved = true;
          return failure === "network"
            ? route.abort("failed")
            : route.fulfill({ status: 500, json: { error: { code: "http_error" } } });
        }
        return route.fulfill({
          json: {
            receipt: { adopted: 1, assetId: "derived", draftId: null, collectionId: "raw" },
            replayed: true,
          },
        });
      }
      if (path.endsWith("/processing-runs/review"))
        return route.fulfill({
          json: {
            run,
            records: [
              {
                id: "0:0",
                original: value,
                result: {
                  ...value,
                  metadata: [...value.metadata, { key: "gbRisk", value: "A.1" }],
                },
                changedFields: ["metadata"],
                issues: [],
                sourcePresentation: {
                  label: "原始问题.csv · 第 1 条",
                  badges: ["已改写"],
                  steps: [],
                },
              },
            ],
            total: 1,
            allIds: ["0:0"],
            issues: [],
            stats: { all: 1, changed: 1, needsReview: 0 },
            receipts: saved
              ? [{ adopted: 1, assetId: "derived", collectionId: "raw", draftId: null }]
              : [],
          },
        });
      return route.fulfill({ json: { projects: [], pagination: { total: 0 }, drafts: [] } });
    });
    await page.goto("/projects/processing_project/processing?run=review");
    const row = page.getByRole("row", { name: "查看记录 1", exact: true });
    await expect(row).toContainText("新增 gbRisk：A.1");
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("新增 gbRisk：A.1");
    await expect(page.getByRole("dialog")).toContainText(value.question);
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
    await page.setViewportSize({ width: 480, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("processing-review-480.png"), fullPage: true });
    await page.getByRole("button", { name: "选择全部匹配结果", exact: true }).click();
    await page.getByRole("button", { name: /^保存所选 \d+ 条$/ }).click();
    await page.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("保存响应未确认");
    await expect(page.getByRole("dialog").getByRole("combobox")).toBeDisabled();
    await page.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect(page.getByText("已保存 1 条处理结果到原始数据。")).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await page.reload();
    await expect(page.getByRole("link", { name: "打开原始数据", exact: true })).toBeVisible();
    expect(keys).toHaveLength(2);
  });

test("filters inputs without losing hidden selection and validates protected expansion settings", async ({
  page,
}) => {
  const rows = Array.from({ length: 45 }, (_, i) => ({
    id: `asset:${i + 1}`,
    question: `Q ${i + 1}`,
    expectedOutput: "Protected",
    metadata: [{ key: "category", value: i % 2 ? "B" : "A" }],
  }));
  let submitted: unknown;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/processing-inputs")) {
      const body = route.request().postDataJSON();
      const matched = rows.filter(
        (row) =>
          (!body.search || row.question.includes(body.search)) &&
          (!body.conditions?.length || row.metadata[0]!.value === "A"),
      );
      const visible = body.selectedOnly
        ? matched.filter((row) => body.selectedIds.includes(row.id))
        : matched;
      return route.fulfill({
        json: {
          records: visible.slice(body.offset, body.offset + body.limit),
          allIds: matched.map((row) => row.id),
          total: visible.length,
          sourceTotal: 45,
          matchedTotal: matched.length,
          sourceSummary: {
            name: "45条原始资料.jsonl",
            kindLabel: "原始数据",
            files: [],
            href: "/projects/processing_project/datasets/raw/files/asset",
          },
        },
      });
    }
    if (path.endsWith("/processing-runs") && route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 422,
        json: { error: { code: "model_connection_unavailable" } },
      });
    }
    return route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/processing_project/processing?source=assets&sourceId=asset");
  await page.getByLabel("选择记录 asset:2", { exact: true }).check();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByLabel("选择记录 asset:21", { exact: true }).check();
  await page.getByText("Metadata 筛选", { exact: true }).click();
  await page.getByLabel("Metadata 字段名").fill("category");
  await page.getByLabel("Metadata 筛选值").fill("A");
  await page.getByRole("button", { name: "添加筛选", exact: true }).click();
  await expect(page.getByLabel("选择记录 asset:1", { exact: true })).toBeVisible();
  await expect(page.getByText(/含筛选外 1 条，也会提交/)).toBeVisible();
  await page.getByRole("button", { name: /^选择全部匹配记录/ }).click();
  await expect(page.getByRole("button", { name: "开始清洗 · 24 条输入" })).toBeEnabled();
  await page.getByLabel("只看已选").check();
  await page.getByLabel("搜索输入记录").fill("不存在");
  await expect(page.getByText("当前范围没有已选记录。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除搜索和筛选", exact: true }).click();
  await page.getByLabel("选择记录 asset:2", { exact: true }).click();
  await expect(page.getByRole("button", { name: "开始清洗 · 23 条输入" })).toBeEnabled();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByLabel("只看已选").uncheck();
  for (const id of [1, 2, 3])
    await page.getByLabel(`选择记录 asset:${id}`, { exact: true }).check();
  await page.getByRole("button", { name: "扩充", exact: true }).click();
  await expect(page.getByText("请填写扩充要求。", { exact: true })).toBeVisible();
  await page.getByPlaceholder("例如：围绕相同意图增加不同措辞和场景。").fill("增加不同措辞");
  await page.getByLabel("新增记录数量").fill("0");
  await expect(page.getByText("新增数量须为 1–10,000 的整数。", { exact: true })).toBeVisible();
  await page.getByLabel("新增记录数量").fill("7");
  await expect(page.getByText("新增记录数量（输入 3 条）", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始扩充 · 3 条输入" }).click();
  await expect
    .poll(() => submitted)
    .toMatchObject({
      source: { recordIds: ["asset:1", "asset:2", "asset:3"] },
      options: { operation: "augment", allowedFields: ["question"], outputCount: 7 },
    });
  await expect(page.getByPlaceholder("例如：围绕相同意图增加不同措辞和场景。")).toHaveValue(
    "增加不同措辞",
  );
});

test("retains the chosen target on conflict and retries using the current draft revision", async ({
  page,
}) => {
  let revisionReads = 0;
  const attempts: { key: string | undefined; body: { target: { expectedRevision: number } } }[] =
    [];
  const value = { question: "原问题", expectedOutput: "保留", metadata: [] };
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/collaborative-drafts/source"))
      return route.fulfill({ json: { draft: { revision: ++revisionReads } } });
    if (path.endsWith("/processing-runs/conflict/accept")) {
      attempts.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postDataJSON(),
      });
      return attempts.length === 1
        ? route.fulfill({ status: 409, json: { error: { code: "draft_revision_conflict" } } })
        : route.fulfill({
            json: { receipt: { assetId: "derived", draftId: "source", adopted: 1 } },
          });
    }
    if (path.endsWith("/processing-runs/conflict"))
      return route.fulfill({
        json: {
          run: {
            id: "conflict",
            source: { kind: "draft", id: "source" },
            options: {
              operation: "rewrite",
              instructions: "改写问题",
              allowedFields: ["question"],
            },
            status: "succeeded",
            inputCount: 1,
            createdAt: "2026-10-09T00:00:00Z",
            errorCode: null,
          },
          records: [{ id: "0:0", original: value, result: { ...value, question: "新问题" } }],
          allIds: ["0:0"],
          total: 1,
          issues: [],
        },
      });
    return route.fulfill({ json: { drafts: [], projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/processing_project/processing?run=conflict");
  await page.getByRole("button", { name: "选择全部匹配结果", exact: true }).click();
  await page.getByRole("button", { name: "保存回原草稿", exact: true }).click();
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("草稿已变化");
  await expect(page.getByRole("dialog").getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByRole("link", { name: "返回草稿", exact: true })).toBeVisible();
  expect(attempts.map((entry) => entry.body.target.expectedRevision)).toEqual([1, 2]);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.key).not.toBe(attempts[1]!.key);
});

test("keeps confirmed results during a polling interruption and can recover without losing rows", async ({
  page,
}) => {
  let calls = 0,
    recovered = false;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/processing-runs/offline")) {
      calls++;
      if (calls > 1 && !recovered)
        return route.fulfill({ status: 503, json: { error: { code: "dependency_unavailable" } } });
      return route.fulfill({
        json: {
          run: {
            id: "offline",
            source: { kind: "assets" },
            options: { operation: "rewrite", instructions: "改写", allowedFields: ["question"] },
            status: recovered ? "succeeded" : "running",
            inputCount: 2,
            outputCount: 1,
            createdAt: "2026-10-09T00:00:00Z",
            errorCode: null,
          },
          records: [
            {
              id: "0:0",
              original: { question: "原问题", expectedOutput: "", metadata: [] },
              result: { question: "已保留的问题", expectedOutput: "", metadata: [] },
            },
          ],
          allIds: ["0:0"],
          total: 1,
          issues: [],
        },
      });
    }
    return route.fulfill({ json: { drafts: [], projects: [], pagination: { total: 0 } } });
  });
  await page.goto("/projects/processing_project/processing?run=offline");
  await expect(page.getByText("已保留的问题", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("状态读取中断", { timeout: 20000 });
  await expect(page.getByText("已保留的问题", { exact: true })).toBeVisible();
  recovered = true;
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await expect(page.getByRole("button", { name: "勾选本页", exact: true })).toBeEnabled();
  await expect(page.getByText("状态读取中断", { exact: false })).toHaveCount(0);
});
