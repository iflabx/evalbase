import { mockAccountRoute } from "./mock-account";
import { expect, test } from "@playwright/test";

test("maps pending upload fields by drag and refreshes the preview", async ({ page }) => {
  const previewMappings: Array<{
    question?: string;
    expectedOutput?: string;
    metadata: string[];
  }> = [];
  let confirmedPendingUploadIds: string[] = [];
  const pendingUpload = {
    id: "pending_mapping",
    fileName: "faq.csv",
    format: "csv",
    size: 54,
    recordCount: 1,
    fields: [
      { path: "/question", sample: "如何重置密码？" },
      { path: "/answer", sample: "在设置中重置。" },
      { path: "/category", sample: "账户" },
      { path: "/tag", sample: "帮助中心" },
      { path: "/source", sample: "公开资料" },
    ],
    issues: [],
  };

  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/session") {
      await route.fulfill(
        method === "POST" ? { json: { csrfToken: "csrf" } } : { status: 401, body: "" },
      );
      return;
    }
    if (url.pathname === "/api/projects") {
      await route.fulfill({
        json: {
          projects: [
            {
              id: "project_mapping",
              name: "映射项目",
              description: "",
              datasetCount: 1,
              testSetCount: 0,
              updatedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_mapping/collections") {
      await route.fulfill({
        json: {
          collections: [
            {
              id: "collection_mapping",
              name: "未整理",
              description: "",
              isUnfiled: true,
              fileCount: 0,
              unifiedRecordCount: 0,
              updatedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project_mapping/collections/collection_mapping/assets") {
      await route.fulfill({ json: { assets: [], pagination: { total: 0 } } });
      return;
    }
    if (url.pathname === "/api/projects/project_mapping/pending-uploads" && method === "POST") {
      await route.fulfill({ status: 201, json: { pendingUpload } });
      return;
    }
    if (
      url.pathname === "/api/projects/project_mapping/pending-uploads/pending_mapping/preview" &&
      method === "PUT"
    ) {
      const { mapping } = route.request().postDataJSON() as {
        mapping: { question?: string; expectedOutput?: string; metadata: string[] };
      };
      previewMappings.push(mapping);
      await route.fulfill({
        json: {
          ...pendingUpload,
          preview: [
            {
              question: mapping.question === "/category" ? "账户" : "如何重置密码？",
              expectedOutput: "在设置中重置。",
              metadata: mapping.metadata.map((path) => ({ key: path.slice(1), value: "值" })),
            },
          ],
        },
      });
      return;
    }
    if (
      url.pathname === "/api/projects/project_mapping/pending-upload-batches/confirm" &&
      method === "POST"
    ) {
      const body = route.request().postDataJSON() as { pendingUploadIds: string[] };
      confirmedPendingUploadIds = body.pendingUploadIds;
      await route.fulfill({ json: { assets: [{ id: "asset_mapping", fileName: "faq.csv" }] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_mapping/datasets/collection_mapping");
  await page.getByRole("button", { name: "上传文件" }).click();
  await page.getByLabel("选择文件").setInputFiles({
    name: "faq.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "question,answer,category,tag,source\n如何重置密码？,在设置中重置。,账户,帮助中心,公开资料\n",
    ),
  });
  await page.getByRole("button", { name: "下一步" }).click();

  await expect(page.getByRole("heading", { name: "原始字段" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "映射后的统一记录" })).toBeVisible();
  await expect(page.getByText("拖入字段完成映射", { exact: true })).toBeVisible();
  await expect(page.getByText("拖到这里", { exact: true })).toHaveCount(1);
  await expect(page.getByText("映射到", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("listitem", { name: /category.*样例：账户/ })).toBeVisible();
  await expect(page.getByText("/category", { exact: true })).toHaveCount(0);
  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      question: "/question",
      expectedOutput: "/answer",
      metadata: [],
    });
  await expect(page.getByRole("button", { name: "取消 category 的映射" })).toHaveCount(0);
  await page
    .getByRole("listitem", { name: /category.*样例：账户/ })
    .dragTo(page.getByRole("region", { name: "Metadata" }));
  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      question: "/question",
      expectedOutput: "/answer",
      metadata: ["/category"],
    });
  await expect(page.getByRole("button", { name: "取消 category 的映射" })).toBeVisible();
  await page
    .getByRole("listitem", { name: /tag.*样例：帮助中心/ })
    .dragTo(page.getByRole("region", { name: "Metadata" }));
  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      question: "/question",
      expectedOutput: "/answer",
      metadata: ["/category", "/tag"],
    });
  await expect(page.getByRole("button", { name: "取消 tag 的映射" })).toBeVisible();
  await page
    .getByRole("listitem", { name: /source.*样例：公开资料/ })
    .dragTo(page.getByRole("region", { name: "Metadata" }));
  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      question: "/question",
      expectedOutput: "/answer",
      metadata: ["/category", "/tag", "/source"],
    });
  await expect(page.getByRole("button", { name: "取消 source 的映射" })).toBeVisible();
  await page
    .getByRole("listitem", { name: /category.*样例：账户/ })
    .dragTo(page.getByRole("region", { name: "问题" }));

  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      question: "/category",
      expectedOutput: "/answer",
      metadata: ["/tag", "/source"],
    });
  await expect(page.getByText("账户", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消 tag 的映射" })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消 source 的映射" })).toBeVisible();
  await page
    .locator('[aria-label="已映射字段 category"]')
    .dragTo(page.getByRole("region", { name: "期望输出" }));
  await expect
    .poll(() => previewMappings)
    .toContainEqual({ expectedOutput: "/category", metadata: ["/tag", "/source"] });
  await expect(
    page.getByRole("region", { name: "期望输出" }).getByText("category", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "问题" }).getByText("category", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("listitem", { name: /answer.*样例：在设置中重置。/ })
    .dragTo(page.getByRole("region", { name: "期望输出" }));
  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      expectedOutput: "/answer",
      metadata: ["/tag", "/source"],
    });
  await expect(page.getByRole("button", { name: "取消 answer 的映射" })).toBeVisible();
  await page.getByRole("button", { name: "取消 answer 的映射" }).click();
  await expect.poll(() => previewMappings).toContainEqual({ metadata: ["/tag", "/source"] });
  await expect(page.getByRole("button", { name: "取消 answer 的映射" })).toHaveCount(0);
  await page
    .getByRole("listitem", { name: /category.*样例：账户/ })
    .dragTo(page.getByRole("region", { name: "问题" }));
  await expect(
    page.getByRole("region", { name: "问题" }).getByText("category", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("listitem", { name: /answer.*样例：在设置中重置。/ })
    .dragTo(page.getByRole("region", { name: "期望输出" }));
  await expect
    .poll(() => previewMappings)
    .toContainEqual({
      question: "/category",
      expectedOutput: "/answer",
      metadata: ["/tag", "/source"],
    });
  await expect(page.getByRole("button", { name: "取消 answer 的映射" })).toBeVisible();
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect.poll(() => confirmedPendingUploadIds).toEqual(["pending_mapping"]);
});
