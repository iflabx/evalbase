import { expect, test } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("saves an original without mapping and prepares it later with keyboard controls", async ({
  page,
}) => {
  let saved = false,
    ready = false,
    lastMapping: Record<string, unknown> = { metadata: [] };
  const fields = [
    { path: "/prompt", sample: "如何重置密码？" },
    { path: "/answer", sample: "在设置中重置。" },
  ];
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    const base = "/api/projects/project_raw";
    if (path === "/api/projects")
      return route.fulfill({
        json: {
          projects: [{ id: "project_raw", name: "原件整理", datasetCount: 1, testSetCount: 0 }],
          pagination: { total: 1 },
        },
      });
    if (path === `${base}/collections`)
      return route.fulfill({
        json: {
          collections: [
            {
              id: "collection_raw",
              name: "待整理资料",
              fileCount: saved ? 1 : 0,
              unifiedRecordCount: ready ? 1 : 0,
            },
          ],
          pagination: { total: 1 },
        },
      });
    if (path === `${base}/collections/collection_raw/assets`)
      return route.fulfill({
        json: {
          assets: saved
            ? [
                {
                  id: "asset_raw",
                  fileName: "original.csv",
                  format: "csv",
                  size: 24,
                  recordCount: 1,
                  uploadedAt: "2026-10-04T00:00:00Z",
                  mappingReady: ready,
                  status: ready ? "可浏览" : "待整理字段",
                },
              ]
            : [],
          pagination: { total: saved ? 1 : 0 },
        },
      });
    const pendingUpload = {
      id: "pending_raw",
      fileName: "original.csv",
      format: "csv",
      size: 24,
      recordCount: 1,
      fields,
      issues: [],
    };
    if (path === `${base}/pending-uploads`)
      return route.fulfill({ status: 201, json: { pendingUpload } });
    if (path.endsWith("/pending-uploads/pending_raw/preview"))
      return route.fulfill({
        json: {
          ...pendingUpload,
          preview: [{ question: "如何重置密码？", expectedOutput: "在设置中重置。", metadata: [] }],
        },
      });
    if (path.endsWith("/pending-upload-batches/confirm")) {
      expect(route.request().postDataJSON().mode).toBe("raw");
      saved = true;
      return route.fulfill({
        status: 201,
        json: { assets: [{ id: "asset_raw", fileName: "original.csv" }] },
      });
    }
    if (path === `${base}/collections/collection_raw/assets/asset_raw`)
      return route.fulfill({
        json: {
          asset: { fileName: "original.csv", format: "csv", recordCount: 1, mappingReady: ready },
        },
      });
    if (path === `${base}/collections/collection_raw/records`)
      return route.fulfill({
        json: {
          records: ready
            ? [
                {
                  assetId: "asset_raw",
                  ordinal: 1,
                  sourceFile: "original.csv",
                  question: "如何重置密码？",
                  expectedOutput: "在设置中重置。",
                  metadata: [],
                },
              ]
            : [],
          pagination: { total: ready ? 1 : 0 },
        },
      });
    if (path === `${base}/assets/asset_raw/mapping`) {
      if (method === "PUT") {
        expect(route.request().postDataJSON()).toMatchObject({
          parsedViewId: "view_raw",
          expectedRevision: 0,
          mapping: { question: "/prompt", expectedOutput: "/answer", metadata: [] },
        });
        ready = true;
        return route.fulfill({ json: { mappingReady: true, mappingRevision: 1 } });
      }
      return route.fulfill({
        json: {
          parsedViewId: "view_raw",
          mappingRevision: ready ? 1 : 0,
          mappingReady: ready,
          mapping: lastMapping,
          fields,
          records: [
            {
              ordinal: 1,
              value: { prompt: "如何重置密码？", answer: "在设置中重置。" },
              parseStatus: "valid",
            },
          ],
          total: 1,
        },
      });
    }
    if (path.endsWith("/mapping/preview")) {
      lastMapping = route.request().postDataJSON().mapping;
      return route.fulfill({
        json: {
          preview: [
            {
              question: lastMapping["question"] ? "如何重置密码？" : "",
              expectedOutput: lastMapping["expectedOutput"] ? "在设置中重置。" : "",
              metadata: [],
            },
          ],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: { code: "not_found" } } });
  });
  await page.goto("/projects/project_raw/datasets/collection_raw");
  await page.getByRole("button", { name: "上传文件" }).click();
  await page.getByLabel("选择文件").setInputFiles({
    name: "original.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("prompt,answer\n如何重置密码？,在设置中重置。\n"),
  });
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "先保存原文件，稍后整理" }).click();
  await expect(page.getByText("待整理字段", { exact: true })).toBeVisible();
  await page
    .getByRole("row", { name: /original.csv/ })
    .getByRole("link", { name: "查看" })
    .click();
  await expect(page.getByRole("heading", { name: "原始记录", exact: true })).toBeVisible();
  await expect(page.getByLabel("搜索文件记录")).toHaveCount(0);
  await page.getByRole("button", { name: "整理字段", exact: true }).click();
  await page.getByRole("combobox", { name: "映射 prompt", exact: true }).click();
  await page.getByRole("option", { name: "问题", exact: true }).click();
  await page.getByRole("combobox", { name: "映射 answer", exact: true }).click();
  await page.getByRole("option", { name: "期望输出", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认字段映射" })).toBeEnabled();
  await page.setViewportSize({ width: 800, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("raw-mapping-narrow.png"), fullPage: true });
  await page.getByRole("button", { name: "确认字段映射" }).click();
  await expect(page.getByLabel("搜索文件记录")).toBeVisible();
  await expect(page.getByText("如何重置密码？", { exact: true })).toBeVisible();
});
