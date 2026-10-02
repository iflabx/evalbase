import type { Route } from "@playwright/test";

/** Shared authenticated shell responses for feature mocks written before V2 accounts. */
export async function mockAccountRoute(route: Route): Promise<boolean> {
  const path = new URL(route.request().url()).pathname;
  let json: unknown;
  if (path === "/api/installation") json = { needsAdministrator: false, needsMigration: false };
  else if (path === "/api/session")
    json = { csrfToken: "csrf", actor: { id: "admin", role: "admin" } };
  else if (path === "/api/me")
    json = {
      account: { id: "admin", displayName: "管理员", avatarColor: "#6366f1", role: "admin" },
    };
  else if (/^\/api\/projects\/[^/]+\/access$/.test(path))
    json = {
      access: {
        role: "admin",
        capabilities: { read: true, write: true, export: true, manage: true },
      },
    };
  else if (/^\/api\/projects\/[^/]+\/presence$/.test(path)) {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 204 });
      return true;
    }
    json = { users: [] };
  } else if (path.includes("/presence/")) {
    await route.fulfill({ status: 204 });
    return true;
  } else if (path.endsWith("/collaborative-drafts") && route.request().method() === "GET")
    json = { drafts: [] };
  else return false;
  await route.fulfill({ json });
  return true;
}
