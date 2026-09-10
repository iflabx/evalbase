import { loadConfig } from "../config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp();
await app.listen({ host: config.host, port: config.port });
