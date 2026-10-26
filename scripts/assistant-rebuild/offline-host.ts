// Local-only subprocess used by the controlled restart regression. No provider credentials are loaded.
import { buildApp } from "../../src/server/app.js";
const app = await buildApp({}, { disableLegacyTestBootstrap: true });
const address = await app.listen({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ rebuildListening: address, pid: process.pid }));
process.once("SIGTERM", () => {
  void app.close().then(() => process.exit(0));
});
