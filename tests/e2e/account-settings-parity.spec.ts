import { expect, test } from "@playwright/test";

test("registration opens the project list and its invitation entry", async ({
  page,
}) => {
  let signedIn = false;
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/installation")
      return route.fulfill({ json: { needsAdministrator: false } });
    if (pathname === "/api/accounts" && route.request().method() === "POST")
      return route.fulfill({ json: { account: { id: "new-user" } } });
    if (pathname === "/api/session" && route.request().method() === "POST") {
      signedIn = true;
      return route.fulfill({
        json: { csrfToken: "test", actor: { id: "new-user", role: "user" } },
      });
    }
    if (pathname === "/api/session")
      return route.fulfill(
        signedIn
          ? {
              json: {
                csrfToken: "test",
                actor: { id: "new-user", role: "user" },
              },
            }
          : {
              status: 401,
              json: { error: { code: "authentication_required" } },
            },
      );
    if (pathname === "/api/projects")
      return route.fulfill({
        json: { projects: [], pagination: { total: 0 } },
      });
    if (pathname === "/api/me")
      return route.fulfill({
        json: {
          account: {
            id: "new-user",
            email: "new@example.test",
            displayName: "new",
            avatarColor: "#2563eb",
            role: "user",
          },
        },
      });
    if (pathname === "/api/me/invitations")
      return route.fulfill({ json: { invitations: [] } });
    return route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "账号注册 →" }).click();
  await page.getByRole("textbox", { name: "邮箱" }).fill("new@example.test");
  await page.getByLabel(/^密码/).fill("password123");
  await page.getByLabel("确认密码").fill("password123");
  await page.getByRole("button", { name: "注册账号" }).click();
  await expect(
    page.getByRole("heading", { name: "尚未加入任何项目" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "项目邀请" })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "查看项目邀请" }).click();
  await expect(page).toHaveURL(/section=info/);
  await expect(page.getByRole("heading", { name: "项目邀请" })).toBeVisible();
  await expect(page.getByRole("button", { name: "项目成员" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "项目邀请" })).toBeVisible();
});

test("separates pending invitations from historical records", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/installation")
      return route.fulfill({ json: { needsAdministrator: false } });
    if (pathname === "/api/session")
      return route.fulfill({
        json: { csrfToken: "test", actor: { id: "admin", role: "admin" } },
      });
    if (pathname === "/api/projects")
      return route.fulfill({
        json: {
          projects: [
            {
              id: "p1",
              name: "项目甲",
              description: "",
              datasetCount: 0,
              testSetCount: 0,
              updatedAt: "2026-09-28T00:00:00Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
    if (pathname === "/api/me")
      return route.fulfill({
        json: {
          account: {
            id: "admin",
            email: "admin@example.test",
            displayName: "Admin",
            avatarColor: "#2563eb",
            role: "admin",
          },
        },
      });
    if (pathname === "/api/me/invitations")
      return route.fulfill({ json: { invitations: [] } });
    if (pathname === "/api/projects/p1/members")
      return route.fulfill({ json: { members: [] } });
    if (pathname === "/api/projects/p1/invitations")
      return route.fulfill({
        json: {
          invitations: [
            {
              id: "i1",
              projectId: "p1",
              projectName: "项目甲",
              email: "pending@example.test",
              role: "editor",
              status: "pending",
              expiresAt: "2026-10-05T00:00:00Z",
            },
            {
              id: "i2",
              projectId: "p1",
              projectName: "项目甲",
              email: "accepted@example.test",
              role: "viewer",
              status: "accepted",
              expiresAt: "2026-10-05T00:00:00Z",
            },
          ],
        },
      });
    return route.fulfill({ json: {} });
  });

  await page.goto("/settings?project=p1&section=members");
  const pending = page.locator("section.member-card").filter({
    has: page.getByRole("heading", { name: "待处理邀请" }),
  });
  const history = page.locator("section.member-card").filter({
    has: page.getByRole("heading", { name: "邀请记录" }),
  });
  await expect(pending).toContainText("pending@example.test");
  await expect(pending).not.toContainText("accepted@example.test");
  await expect(history).toContainText("accepted@example.test");
  await expect(history).toContainText("成员已移除");
  await expect(history).not.toContainText("pending@example.test");
});
