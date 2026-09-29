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
    await admin.locator("tbody tr").first().click();
    await editor.locator("tbody tr").first().click();
    const adminPanel = admin.getByLabel("记录编辑区");
    const editorPanel = editor.getByLabel("记录编辑区");
    const adminQuestion = adminPanel.getByRole("textbox", { name: "问题" });
    const editorQuestion = editorPanel.getByRole("textbox", { name: "问题" });
    await adminQuestion.focus();
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toBeVisible({ timeout: 5000 });
    const adminOtherTab = await adminContext.newPage();
    await adminOtherTab.goto(`/projects/${projectId}/test-sets`);
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toHaveCount(0, {
      timeout: 5000,
    });
    await expect(editor.locator("header").getByLabel("在线成员").getByRole("img")).toHaveCount(2);
    await admin.bringToFront();
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toBeVisible({
      timeout: 5000,
    });
    const update = `协作同步问题 ${Date.now()}`;
    await adminQuestion.fill(update);
    await admin.getByRole("button", { name: "保存草稿", exact: true }).click();
    const savedAt = Date.now();
    await expect(editorQuestion).toHaveValue(update, { timeout: 2500 });
    console.log(`COLLAB-07 confirmed-save-to-peer-ms=${Date.now() - savedAt}`);
    await editorContext.setOffline(true);
    await editorQuestion.fill(`编辑者本地值 ${Date.now()}`);
    const local = await editorQuestion.inputValue();
    await adminQuestion.fill(`管理员冲突值 ${Date.now()}`);
    await admin.getByRole("button", { name: "保存草稿", exact: true }).click();
    await editorContext.setOffline(false);
    await expect(editor.getByText("问题冲突")).toBeVisible({ timeout: 5000 });
    await expect(editorQuestion).toHaveValue(local);
    await expect(editor.getByText("我的未保存输入：", { exact: false })).toContainText(local);
    await editor.getByRole("button", { name: "保留我的输入" }).click();
    await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(adminQuestion).toHaveValue(local, { timeout: 2500 });
    await admin.screenshot({ path: "/evidence/v2c-admin-draft.png", fullPage: true });
    await editor.screenshot({ path: "/evidence/v2c-editor-draft.png", fullPage: true });
    await editorContext.close();
    await expect(admin.locator("header").getByLabel("在线成员").getByRole("img")).toHaveCount(1, {
      timeout: 20000,
    });
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});

test("revocation hides cached draft content and keeps only unsent input", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  let editorId = "";
  let csrf = "";
  try {
    const login = await adminContext.request.post(`${base}/api/session`, {
      headers: { origin: base! },
      data: { email: "admin-v2c@example.test", password: process.env["V2C_ADMIN_PASSWORD"]! },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    csrf = (await login.json()).csrfToken;
    await signedIn(editorContext, "editor-v2c@example.test", process.env["V2C_EDITOR_PASSWORD"]!);
    const members = await adminContext.request.get(`${base}/api/projects/${projectId}/members`);
    expect(members.ok()).toBeTruthy();
    editorId = (await members.json()).members.find(
      (member: { email: string }) => member.email === "editor-v2c@example.test",
    ).id;
    expect(editorId).toBeTruthy();
    const editor = await editorContext.newPage();
    await editor.goto(`/projects/${projectId}/test-sets/drafts/${draftId}`);
    await editor.locator("tbody tr").first().click();
    const panel = editor.getByLabel("记录编辑区");
    const remoteAnswer = await panel.getByRole("textbox", { name: "期望输出" }).inputValue();
    const local = `失权前未提交的输入 ${Date.now()}`;
    await panel.getByRole("textbox", { name: "问题" }).fill(local);
    const revoke = await adminContext.request.patch(
      `${base}/api/projects/${projectId}/members/${editorId}`,
      { headers: { origin: base!, "x-csrf-token": csrf }, data: { role: "viewer" } },
    );
    expect(revoke.status(), await revoke.text()).toBe(200);
    await expect(editor.getByRole("heading", { name: "草稿访问已结束" })).toBeVisible({
      timeout: 7000,
    });
    await expect(editor.getByText(local)).toBeVisible();
    await expect(editor.getByLabel("记录编辑区")).toHaveCount(0);
    await expect(editor.locator("main").last()).not.toContainText(remoteAnswer);
  } finally {
    if (editorId && csrf) {
      const restore = await adminContext.request.patch(
        `${base}/api/projects/${projectId}/members/${editorId}`,
        { headers: { origin: base!, "x-csrf-token": csrf }, data: { role: "editor" } },
      );
      expect(restore.status(), await restore.text()).toBe(200);
    }
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});
