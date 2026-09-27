import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getRouter } from "./router";

const requiredRoutes = [
  "/",
  "/activity",
  "/calculators",
  "/datasets",
  "/imports",
  "/publishes",
  "/reports",
  "/runs",
  "/settings/langfuse",
];

describe("static SPA router", () => {
  it("registers every primary product route", () => {
    const routePaths = Object.keys(getRouter().routesByPath);
    for (const route of requiredRoutes) expect(routePaths).toContain(route);
  });

  it("does not retain a server application runtime", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    );
    expect(packageJson.dependencies).not.toHaveProperty("@tanstack/react-start");
    expect(packageJson.devDependencies).not.toHaveProperty("nitro");
    expect(packageJson.devDependencies).not.toHaveProperty("@lovable.dev/vite-tanstack-config");
  });
});
