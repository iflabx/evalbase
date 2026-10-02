import { expect, test, type BrowserContext } from "@playwright/test";

const projectId = process.env["V2C_PROJECT_ID"];
const base = process.env["PLAYWRIGHT_BASE_URL"];
const adminEmail = process.env["V2C_ADMIN_EMAIL"] ?? "admin-v2c@example.test";
const editorEmail = process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test";
test.skip(!projectId || !base, "Requires the isolated V2-C checkpoint");

async function signedIn(context: BrowserContext, email: string, password: string) {
  const response = await context.request.post(`${base}/api/session`, {
    headers: { origin: base! },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("project settings keeps the member online for peers", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  try {
    await signedIn(adminContext, adminEmail, process.env["V2C_ADMIN_PASSWORD"]!);
    await signedIn(editorContext, editorEmail, process.env["V2C_EDITOR_PASSWORD"]!);
    const admin = await adminContext.newPage();
    const editor = await editorContext.newPage();
    await Promise.all([
      admin.goto(`/projects/${projectId}/test-sets`),
      editor.goto(`/projects/${projectId}/test-sets`),
    ]);
    const avatars = admin.locator("header").getByLabel("在线成员").getByRole("img");
    await expect(avatars).toHaveCount(2, { timeout: 5000 });
    await editor.getByText("设置", { exact: true }).click();
    await editor.getByText("项目成员", { exact: true }).click();
    await expect(editor.locator("header").getByLabel("在线成员").getByRole("img")).toHaveCount(2, {
      timeout: 5000,
    });
    await editor.waitForTimeout(18000);
    await expect(avatars).toHaveCount(2, { timeout: 5000 });
    await editor.getByRole("link", { name: "测试集" }).click();
    await expect(avatars).toHaveCount(2, { timeout: 5000 });
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});

test("project members lists both accepted accounts", async ({ browser }) => {
  const adminContext = await browser.newContext();
  try {
    await signedIn(adminContext, adminEmail, process.env["V2C_ADMIN_PASSWORD"]!);
    const admin = await adminContext.newPage();
    await admin.goto(`/projects/${projectId}/test-sets`);
    await admin.getByText("设置", { exact: true }).click();
    await admin.getByText("项目成员", { exact: true }).click();
    const memberCard = admin.locator("section").filter({
      has: admin.getByRole("heading", { name: "成员与权限" }),
    });
    await expect(memberCard.getByText(adminEmail)).toBeVisible();
    await expect(memberCard.getByText(editorEmail)).toBeVisible();
    const administrator = memberCard.locator(".member-row").filter({ hasText: adminEmail });
    await expect(administrator.locator(".role-chip")).toHaveText("管理员");
    await expect(memberCard.getByRole("button", { name: "移除" })).toHaveCount(1);
    await expect(memberCard.getByRole("combobox")).toHaveCount(1);
    await admin.getByRole("button", { name: "邀请成员" }).click();
    await expect(admin.getByRole("heading", { name: "邀请成员" })).toBeVisible();
    await admin.getByRole("button", { name: "取消邀请" }).click();
  } finally {
    await adminContext.close();
  }
});

test("direct settings entry resolves the current project before presence", async ({ browser }) => {
  const adminContext = await browser.newContext();
  try {
    await signedIn(adminContext, adminEmail, process.env["V2C_ADMIN_PASSWORD"]!);
    const admin = await adminContext.newPage();
    await admin.goto("/settings?section=members");
    await expect(admin).toHaveURL(new RegExp(`project=${projectId}`));
    await expect(admin.getByRole("heading", { name: "项目成员" })).toBeVisible();
    await expect(
      admin
        .locator("header")
        .getByLabel("在线成员")
        .getByRole("img", { name: /（我） · 管理员 · 在线/ }),
    ).toBeVisible();
    await admin.goto("/settings?project=missing&section=members");
    await expect(admin).toHaveURL(new RegExp(`project=${projectId}`));
    await expect(admin.getByText(adminEmail)).toBeVisible();
    await expect(
      admin
        .locator("header")
        .getByLabel("在线成员")
        .getByRole("img", { name: /（我） · 管理员 · 在线/ }),
    ).toBeVisible();
  } finally {
    await adminContext.close();
  }
});
