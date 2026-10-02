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
    metadata: [] as Array<{ key: string; value: string }>,
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
  let conflictNextQuestion = false;
  let failNextAnswer = false;
  let holdRecordSave = false;
  let releaseRecordSave = () => {};
  let forceSnapshot = false;
  let holdDraftField: "name" | "purpose" | undefined;
  let releaseDraftSave = () => {};
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
    if (
      path === `/api/projects/${projectId}/collaborative-drafts/${draftId}` &&
      method === "PATCH"
    ) {
      const body = route.request().postDataJSON() as {
        field: "name" | "purpose";
        value: string;
        expectedFieldRevision: number;
      };
      if (body.expectedFieldRevision !== draft[`${body.field}Revision`])
        return route.fulfill({ status: 409, json: { error: { code: "draft_field_conflict" } } });
      draft[body.field] = body.value;
      draft[`${body.field}Revision`]++;
      draft.revision++;
      if (holdDraftField === body.field) {
        holdDraftField = undefined;
        const acknowledged = JSON.parse(JSON.stringify(draft));
        draft[body.field] = `更新的远端${body.field}`;
        draft[`${body.field}Revision`]++;
        draft.revision++;
        forceSnapshot = true;
        await new Promise<void>((resolve) => {
          releaseDraftSave = resolve;
        });
        return route.fulfill({ json: { draft: acknowledged } });
      }
      return route.fulfill({ json: { draft } });
    }
    if (path === `/api/projects/${projectId}/collaborative-drafts/${draftId}` && method === "GET") {
      forceSnapshot = false;
      return route.fulfill({
        json: {
          draft,
          records: [record],
          authors: { admin: { name: "管理员", avatarColor: "#6366f1" } },
          total: 1,
        },
      });
    }
    if (
      path === `/api/projects/${projectId}/collaborative-drafts/${draftId}/records/row_1` &&
      method === "PATCH"
    ) {
      const body = route.request().postDataJSON() as {
        field: "question" | "expectedOutput" | "metadata";
        value: string | Array<{ key: string; value: string }>;
      };
      if (body.field === "question" && conflictNextQuestion) {
        conflictNextQuestion = false;
        record.question = "其他成员的新问题";
        record.questionRevision++;
        record.rowRevision++;
        draft.revision++;
        return route.fulfill({ status: 409, json: { error: { code: "draft_field_conflict" } } });
      }
      if (body.field === "expectedOutput" && failNextAnswer) {
        failNextAnswer = false;
        await new Promise((resolve) => setTimeout(resolve, 600));
        return route.fulfill({ status: 503, json: { error: { code: "temporary_failure" } } });
      }
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
      if (body.field === "question" && holdRecordSave) {
        holdRecordSave = false;
        const acknowledged = JSON.parse(JSON.stringify(record));
        record.question = "更新的远端问题";
        record.questionRevision++;
        record.rowRevision++;
        draft.revision++;
        forceSnapshot = true;
        await new Promise<void>((resolve) => {
          releaseRecordSave = resolve;
        });
        return route.fulfill({ json: { record: acknowledged } });
      }
      return route.fulfill({ json: { record } });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        json: {
          events: [],
          cursor: draft.revision,
          hasMore: false,
          needsSnapshot: forceSnapshot,
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
  // The untouched empty editor placeholder must accept a peer's named empty value.
  record.metadata = [{ key: "渠道", value: "" }];
  record.metadataRevision++;
  record.rowRevision++;
  draft.revision++;
  forceSnapshot = true;
  await expect(editor.getByRole("textbox", { name: "第 1 项 Metadata 字段名" })).toHaveValue(
    "渠道",
  );
  await expect(editor.getByRole("textbox", { name: "第 1 项 Metadata 值" })).toHaveValue("");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "采用对方输入" })).toHaveCount(0);
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
  conflictNextQuestion = true;
  failNextAnswer = true;
  await retryAnswer.fill("等待重试的答案");
  await retryAnswer.blur();
  await retryQuestion.fill("冲突保留的本地问题");
  await retryQuestion.blur();
  await expect(page.getByText("temporary_failure", { exact: false })).toBeVisible();
  await expect(retryQuestion).toHaveValue("冲突保留的本地问题");
  await expect(page.getByRole("button", { name: "创建 v1", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "采用对方输入", exact: true }).click();
  await retryAnswer.focus();
  await retryAnswer.blur();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  holdRecordSave = true;
  await retryQuestion.fill("已提交等待响应的问题");
  await retryQuestion.blur();
  await expect(page.getByRole("row", { name: /更新的远端问题/ })).toBeVisible();
  const acknowledged = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/records/row_1"),
  );
  releaseRecordSave();
  await acknowledged;
  await expect(retryQuestion).toBeEnabled();
  await expect(page.getByRole("row", { name: /更新的远端问题/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /已提交等待响应的问题/ })).toHaveCount(0);

  await page.getByRole("button", { name: "采用对方输入", exact: true }).click();
  for (const field of ["name", "purpose"] as const) {
    const input = page.getByLabel(field === "name" ? "测试集名称" : "用途说明（可选）", {
      exact: true,
    });
    holdDraftField = field;
    await input.fill(`已提交${field}`);
    await input.blur();
    await expect(
      page.getByRole("alert").getByText(new RegExp(`对方当前输入.*更新的远端${field}`)),
    ).toBeVisible();
    const response = page.waitForResponse(
      (reply) =>
        reply.request().method() === "PATCH" &&
        new URL(reply.url()).pathname.endsWith(`/collaborative-drafts/${draftId}`),
    );
    releaseDraftSave();
    await response;
    await expect(input).toBeEnabled();
    await page.getByRole("button", { name: "采用对方输入", exact: true }).click();
    await expect(input).toHaveValue(`更新的远端${field}`);
    await input.fill(`后续${field}`);
    await input.blur();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    expect(draft[field]).toBe(`后续${field}`);
  }
});
