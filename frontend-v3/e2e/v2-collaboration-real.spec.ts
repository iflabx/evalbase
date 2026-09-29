import { expect, test, type BrowserContext } from "@playwright/test";

const projectId = process.env["V2C_PROJECT_ID"];
const draftId = process.env["V2C_DRAFT_ID"];
const base = process.env["PLAYWRIGHT_BASE_URL"];
test.skip(!projectId || !draftId || !base, "Requires the isolated V2-C checkpoint");

async function signedIn(context: BrowserContext, email: string, password: string) {
  const response = await context.request.post(`${base}/api/session`, {
    headers: { origin: base! },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("two accounts see field focus, live saves and a resolvable same-field conflict", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  try {
    await signedIn(adminContext, "admin-v2c@example.test", process.env["V2C_ADMIN_PASSWORD"]!);
    await signedIn(editorContext, "editor-v2c@example.test", process.env["V2C_EDITOR_PASSWORD"]!);
    const admin = await adminContext.newPage();
    const editor = await editorContext.newPage();
    const path = `/projects/${projectId}/test-sets/drafts/${draftId}`;
    await Promise.all([admin.goto(path), editor.goto(path)]);
    await expect(admin.getByRole("heading", { name: /继续创建新版本/ })).toBeVisible();
    await expect(editor.getByRole("heading", { name: /继续创建新版本/ })).toBeVisible();
    await expect(admin.locator("header").getByLabel("在线成员").getByRole("img")).toHaveCount(2, {
      timeout: 5000,
    });
    await admin.getByText("如何修改昵称？", { exact: true }).first().click();
    await editor.getByText("如何修改昵称？", { exact: true }).first().click();
    const adminPanel = admin.getByLabel("记录编辑区");
    const editorPanel = editor.getByLabel("记录编辑区");
    const adminQuestion = adminPanel.getByRole("textbox", { name: "问题" });
    const editorQuestion = editorPanel.getByRole("textbox", { name: "问题" });
    await adminQuestion.focus();
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toBeVisible({ timeout: 5000 });
    const update = `协作同步问题 ${Date.now()}`;
    await adminQuestion.fill(update);
    await admin.getByRole("button", { name: "保存草稿", exact: true }).click();
    const savedAt = Date.now();
    await expect(editorQuestion).toHaveValue(update, { timeout: 2500 });
    console.log(`COLLAB-07 confirmed-save-to-peer-ms=${Date.now() - savedAt}`);
    await adminQuestion.fill(`管理员冲突值 ${Date.now()}`);
    await editorQuestion.fill(`编辑者本地值 ${Date.now()}`);
    const local = await editorQuestion.inputValue();
    await admin.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(editor.getByText("问题冲突")).toBeVisible({ timeout: 5000 });
    await expect(editorQuestion).toHaveValue(local);
    await expect(editor.getByText("我的未保存输入：", { exact: false })).toContainText(local);
    await editor.getByRole("button", { name: "保留我的输入" }).click();
    await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(adminQuestion).toHaveValue(local, { timeout: 2500 });
    await admin.screenshot({ path: "/evidence/v2c-admin-draft.png", fullPage: true });
    await editor.screenshot({ path: "/evidence/v2c-editor-draft.png", fullPage: true });
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});
