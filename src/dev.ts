import { spawn } from "node:child_process";

for (const script of ["start:web", "start:worker"] as const) {
  const child = spawn("npm", ["run", script], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (code) process.exitCode = code;
  });
}
