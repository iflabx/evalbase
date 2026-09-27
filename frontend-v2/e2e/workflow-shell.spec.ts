import { expect, test } from "@playwright/test";

test.describe("Ticket 18 workflow shell", () => {
  test("opens directly into the two-page Owner workspace", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/materials$/u);
    await expect(page.getByRole("heading", { name: "原始资料", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(2);
    await expect(page.getByRole("link", { name: "原始资料", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("进入 AgentBench")).toHaveCount(0);
    await expect(page.getByText("项目成员")).toHaveCount(0);

    await page.reload();
    await expect(page).toHaveURL(/\/materials$/u);
    await expect(page.getByRole("heading", { name: "原始资料", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "测试集", exact: true }).click();
    await expect(page).toHaveURL(/\/test-sets$/u);
    await expect(page.getByRole("heading", { name: "测试集", exact: true })).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/test-sets$/u);
    await expect(page.getByRole("heading", { name: "测试集", exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/materials$/u);
    await expect(page.getByRole("heading", { name: "原始资料", exact: true })).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/test-sets$/u);
    await expect(page.getByRole("heading", { name: "测试集", exact: true })).toBeVisible();
  });

  test("keeps the shell usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/materials");

    await expect(page.getByRole("heading", { name: "原始资料", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("overflow-x", "visible");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(2);
  });
});
