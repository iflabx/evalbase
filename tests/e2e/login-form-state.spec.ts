import { expect, test } from "@playwright/test";

test("keeps the login email through resize, tab switch, and reload", async ({
  page,
}) => {
  await page.route("**/api/installation", (route) =>
    route.fulfill({ json: { needsAdministrator: false } }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "authentication_required" } },
    }),
  );
  await page.goto("/");
  const email = page.getByRole("textbox", { name: "邮箱" });
  await expect(email).toBeVisible();
  await email.fill("viewer.v2a@example.test");
  const loadedAt = await page.evaluate(() => performance.timeOrigin);
  await page.setViewportSize({ width: 550, height: 800 });
  const other = await page.context().newPage();
  await other.bringToFront();
  await page.bringToFront();
  await other.close();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
  await expect(email).toHaveValue("viewer.v2a@example.test");
  await page.reload();
  await expect(email).toHaveValue("viewer.v2a@example.test");
});
