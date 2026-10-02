import { spawn } from "node:child_process";

for (const script of ["dev:web", "dev:worker"] as const) {
  const child = spawn("npm", ["run", script], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (code) process.exitCode = code;
  });
}
