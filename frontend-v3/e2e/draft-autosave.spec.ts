import { expect, test } from "@playwright/test";

const projectId = "project_browser";
const draftId = "draft_auto";

test("draft fields save on blur and exit waits for in-flight saves", async ({ page }) => {
  const draft = {
    id: draftId,
    projectId,
    testSetId: null,
    parentVersionId: null,
    parentVersionLabel: null,
    parentRecordCount: null,
    name: "自动保存草稿",
    purpose: "",
    status: "editing",
    suspended: false,
    revision: 1,
    nameRevision: 0,
    purposeRevision: 0,
    createdBy: "admin",
    createdByName: "管理员",
    createdAt: "2026-09-29T08:00:00.000Z",
    updatedBy: "admin",
    updatedByName: "管理员",
    updatedAt: "2026-09-29T08:00:00.000Z",
    publishedVersionId: null,
  };
  const record = {
    id: "row_1",
    position: 1,
    activeOrdinal: 1,
    caseId: null,
    beforeRevisionId: null,
    question: "旧问题",
    expectedOutput: "旧答案",
    metadata: [{ key: "渠道", value: "" }],
    source: null,
    sourceFileName: null,
    rowRevision: 0,
    questionRevision: 0,
    expectedOutputRevision: 0,
    metadataRevision: 0,
    sourceRevision: 0,
    fieldAttribution: {},
    updatedBy: "admin",
    updatedAt: "2026-09-29T08:00:00.000Z",
  };
  const savedFields: string[] = [];
  let failNextSave = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/api/installation")
      return route.fulfill({ json: { needsAdministrator: false, needsMigration: false } });
    if (path === "/api/session")
      return route.fulfill({ json: { csrfToken: "csrf", actor: { id: "admin", role: "admin" } } });
    if (path === "/api/projects")
      return route.fulfill({
        json: { projects: [{ id: projectId, name: "演示项目" }], pagination: { total: 1 } },
      });
    if (path === `/api/projects/${projectId}/access`)
      return route.fulfill({
        json: {
          access: {
            role: "admin",
            capabilities: { read: true, write: true, export: true, manage: true },
          },
        },
      });
    if (path === `/api/projects/${projectId}/collaborative-drafts`)
      return route.fulfill({ json: { drafts: [draft] } });
    if (path === `/api/projects/${projectId}/solo-test-sets`)
      return route.fulfill({ json: { testSets: [], pagination: { total: 0 } } });
    if (path === `/api/projects/${projectId}/collaborative-drafts/${draftId}` && method === "GET")
      return route.fulfill({
        json: {
          draft,
          records: [record],
          authors: { admin: { name: "管理员", avatarColor: "#6366f1" } },
          total: 1,
        },
      });
    if (
      path === `/api/projects/${projectId}/collaborative-drafts/${draftId}/records/row_1` &&
      method === "PATCH"
    ) {
      const body = route.request().postDataJSON() as {
        field: "question" | "expectedOutput" | "metadata";
        value: string | Array<{ key: string; value: string }>;
      };
      if (failNextSave) {
        failNextSave = false;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({ status: 503, json: { error: { code: "temporary_failure" } } });
      }
      if (body.field === "question") await new Promise((resolve) => setTimeout(resolve, 400));
      Object.assign(record, {
        [body.field]: body.value,
        [`${body.field}Revision`]: record[`${body.field}Revision`] + 1,
        rowRevision: record.rowRevision + 1,
      });
      draft.revision++;
      savedFields.push(body.field);
      return route.fulfill({ json: { record } });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        json: {
          events: [],
          cursor: draft.revision,
          hasMore: false,
          needsSnapshot: false,
          status: "editing",
        },
      });
    if (path.endsWith("/presence"))
      return method === "POST"
        ? route.fulfill({ status: 204 })
        : route.fulfill({ json: { users: [] } });
    if (path.includes("/presence/")) return route.fulfill({ status: 204 });
    if (path.endsWith("/selected-sources")) return route.fulfill({ json: { sources: [] } });
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto(`/projects/${projectId}/test-sets/drafts/${draftId}`);
  await expect(page.getByRole("button", { name: "保存草稿" })).toHaveCount(0);
  await expect(page.getByText("测试集 v1 草稿", { exact: true })).toHaveCount(0);
  await page.getByRole("row", { name: /旧问题/ }).click();
  const editor = page.getByLabel("记录编辑区");
  const question = editor.getByRole("textbox", { name: "问题" });
  const answer = editor.getByRole("textbox", { name: "期望输出" });
  await question.fill("新问题");
  await question.blur();
  await expect(answer).toBeEnabled();
  await answer.fill("新答案");
  await answer.blur();
  await editor.getByRole("textbox", { name: "第 1 项 Metadata 字段名" }).fill("业务渠道");
  await editor.getByRole("textbox", { name: "第 1 项 Metadata 值" }).fill("网页");
  expect(savedFields).not.toContain("metadata");
  await page.getByRole("button", { name: "退出草稿" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/test-sets$`));
  expect(savedFields).toEqual(expect.arrayContaining(["question", "expectedOutput", "metadata"]));
  expect(record).toMatchObject({
    question: "新问题",
    expectedOutput: "新答案",
    metadata: [{ key: "业务渠道", value: "网页" }],
  });
  await page.goto(`/projects/${projectId}/test-sets/drafts/${draftId}`);
  await page.getByRole("row", { name: /新问题/ }).click();
  await expect(
    page.getByLabel("记录编辑区").getByRole("textbox", { name: "期望输出" }),
  ).toHaveValue("新答案");
  failNextSave = true;
  const retryQuestion = page.getByLabel("记录编辑区").getByRole("textbox", { name: "问题" });
  await retryQuestion.fill("失败后保留的问题");
  await retryQuestion.blur();
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
  await expect(retryQuestion).toHaveValue("失败后保留的问题");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(record.question).toBe("失败后保留的问题");

  failNextSave = true;
  await retryQuestion.fill("并发失败的问题");
  await retryQuestion.blur();
  const retryAnswer = page.getByLabel("记录编辑区").getByRole("textbox", { name: "期望输出" });
  await retryAnswer.fill("并发成功的答案");
  await retryAnswer.blur();
  await expect.poll(() => record.expectedOutput).toBe("并发成功的答案");
  await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
  await expect(retryQuestion).toHaveValue("并发失败的问题");
  await page.getByRole("button", { name: "重试保存" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(record.question).toBe("并发失败的问题");
});
