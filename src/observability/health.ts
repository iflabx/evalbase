import { createServer, type Server } from "node:http";

import type { ArtifactRepository } from "../storage/artifacts.js";

export interface DependencyHealth {
  postgresql: "ok" | "failed";
  minio: "ok" | "failed";
}

export async function dependencyHealth(
  db: { query: (text: string) => Promise<unknown> },
  artifacts: Pick<ArtifactRepository, "client" | "bucket">,
): Promise<DependencyHealth> {
  const [postgresql, minio] = await Promise.all([
    db
      .query("select 1")
      .then(() => "ok" as const)
      .catch(() => "failed" as const),
    artifacts.client
      .bucketExists(artifacts.bucket)
      .then((exists) => (exists ? ("ok" as const) : ("failed" as const)))
      .catch(() => "failed" as const),
  ]);
  return { postgresql, minio };
}

export async function startHealthServer({
  hostname,
  port,
  gitSha,
  dependencies,
  metrics,
}: {
  hostname: string;
  port: number;
  gitSha: string;
  dependencies: () => Promise<DependencyHealth>;
  metrics?: () => Promise<string>;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const send = (
    status: number,
    body: Record<string, unknown>,
  ): [number, string] => [
    status,
    `${JSON.stringify({
      ...body,
      git_sha: gitSha,
    })}\n`,
  ];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/health/live") {
        const [status, body] = send(200, { status: "ok" });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      if (request.url === "/health/ready") {
        const health = await dependencies();
        const status = Object.values(health).every((value) => value === "ok")
          ? 200
          : 503;
        const [statusCode, body] = send(status, {
          status: status === 200 ? "ok" : "unavailable",
          dependencies: health,
        });
        response.writeHead(statusCode, {
          "content-type": "application/json",
        });
        response.end(body);
        return;
      }
      if (request.url === "/metrics" && metrics) {
        const body = await metrics();
        response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4",
        });
        response.end(body);
        return;
      }
      const [status, body] = send(404, {
        error: { code: "route_not_found" },
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    })().catch(() => {
      const [status, body] = send(503, {
        status: "unavailable",
        dependencies: { postgresql: "failed", minio: "failed" },
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
