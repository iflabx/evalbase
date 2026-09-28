import { expect, test } from "@playwright/test";

for (const role of ["user", "admin"] as const) {
  test(`keeps the selected project in settings for ${role}`, async ({
    page,
  }) => {
    const projects = ["项目甲", "项目乙"].map((name, index) => ({
      id: `p${index + 1}`,
      name,
      description: "",
      datasetCount: 0,
      testSetCount: 0,
      updatedAt: "2026-09-28T00:00:00Z",
    }));
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/installation")
        return route.fulfill({ json: { needsAdministrator: false } });
      if (path === "/api/session")
        return route.fulfill({
          json: { csrfToken: "test", actor: { id: "viewer", role } },
        });
      if (path === "/api/projects")
        return route.fulfill({
          json: { projects, pagination: { total: projects.length } },
        });
      if (path === "/api/me")
        return route.fulfill({
          json: {
            account: {
              id: "viewer",
              email: "viewer@example.test",
              displayName: "Viewer",
              avatarColor: "#2563eb",
              role: "user",
            },
          },
        });
      if (path === "/api/me/invitations")
        return route.fulfill({ json: { invitations: [] } });
      if (path.endsWith("/members"))
        return route.fulfill({ json: { members: [] } });
      return route.fulfill({ json: {} });
    });

    await page.goto("/");
    await page
      .getByRole("row", { name: /项目乙/ })
      .getByRole("link", { name: "查看" })
      .click();
    await expect(page).toHaveURL(/\/projects\/p2\/datasets/);
    await page.getByRole("link", { name: "设置" }).click();
    await expect(page).toHaveURL(/\/settings\?project=p2/);
    await expect(page.getByTestId("project-nav-children")).toBeVisible();
    await expect(page.getByRole("button", { name: "切换项目" })).toContainText(
      "项目乙",
    );
    await page.getByRole("button", { name: "项目成员" }).click();
    await expect(page.getByText("成员与权限")).toBeVisible();
    if (role === "admin") {
      await page.getByLabel("当前项目").selectOption("p1");
      await expect(page).toHaveURL(/\/settings\?project=p1/);
      await expect(
        page.getByRole("button", { name: "切换项目" }),
      ).toContainText("项目甲");
    }
  });
}
