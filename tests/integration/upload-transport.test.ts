import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPACITY_LIMITS } from "../../src/capacity.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

describe("pending upload real HTTP byte limit", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let artifacts: ArtifactRepository;
  let port: number;
  let cookie: string;
  let csrf: string;
  let projectId: string;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const tooLarge = Buffer.alloc(CAPACITY_LIMITS.dataAssetBytes + 1, "x");

  beforeAll(async () => {
    app = await buildApp({ soloOwnerMode: true });
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: loadConfig().appOrigin },
      payload: {},
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
    csrf = login.json().csrfToken;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { origin: loadConfig().appOrigin, cookie, "x-csrf-token": csrf },
      payload: { name: `Transport regression ${randomUUID()}` },
    });
    expect(project.statusCode, project.body).toBe(201);
    projectId = project.json().project.id;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    port = address.port;
  });

  afterAll(async () => {
    agent.destroy();
    await app?.close();
    await db?.end();
  });

  function upload(
    bytes: Buffer,
    extension: string,
    contentType: string,
    chunked: boolean,
  ) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          agent,
          method: "POST",
          path: `/api/projects/${projectId}/pending-uploads`,
          headers: {
            origin: loadConfig().appOrigin,
            cookie,
            "x-csrf-token": csrf,
            "content-type": contentType,
            "x-file-name": `transport.${extension}`,
            ...(!chunked ? { "content-length": bytes.length } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      request.on("error", reject);
      request.setTimeout(10_000, () =>
        request.destroy(new Error("HTTP upload timeout")),
      );
      if (chunked) {
        request.write(bytes.subarray(0, bytes.length - 1));
        request.end(bytes.subarray(bytes.length - 1));
      } else request.end(bytes);
    });
  }

  it.each([
    ["csv", "text/csv", false],
    ["csv", "text/csv", true],
    ["json", "application/json", false],
    ["json", "application/json", true],
    ["jsonl", "application/x-ndjson", false],
    ["jsonl", "application/x-ndjson", true],
  ] as const)(
    "returns a complete 413 for %s (%s, chunked=%s) and leaves no upload",
    async (extension, contentType, chunked) => {
      const stagingBefore = (await artifacts.list("staging/"))
        .map((item) => item.key)
        .sort();
      const rejected = await upload(tooLarge, extension, contentType, chunked);
      expect(rejected.status, rejected.body).toBe(413);
      expect(JSON.parse(rejected.body)).toMatchObject({
        error: {
          code: "asset_too_large",
          limitBytes: CAPACITY_LIMITS.dataAssetBytes,
        },
      });
      expect(
        (await artifacts.list("staging/")).map((item) => item.key).sort(),
      ).toEqual(stagingBefore);
      const counts = await db.query(
        `SELECT
      (SELECT count(*)::int FROM pending_upload WHERE project_id=$1) AS pending,
      (SELECT count(*)::int FROM data_asset WHERE project_id=$1) AS assets`,
        [projectId],
      );
      expect(counts.rows[0]).toEqual({ pending: 0, assets: 0 });
    },
  );

  it("accepts the next small upload after a rejection", async () => {
    const accepted = await upload(
      Buffer.from("question,answer\nHello,World\n"),
      "csv",
      "text/csv",
      false,
    );
    expect(accepted.status, accepted.body).toBe(201);
    expect(JSON.parse(accepted.body).pendingUpload.recordCount).toBe(1);
  });

  it("accepts the exact byte boundary without staging residue", async () => {
    const stored = await artifacts.storeOriginal(
      randomUUID(),
      Readable.from(tooLarge.subarray(0, CAPACITY_LIMITS.dataAssetBytes)),
    );
    expect(stored.size).toBe(CAPACITY_LIMITS.dataAssetBytes);
    expect(await artifacts.size(stored.objectRef)).toBe(
      CAPACITY_LIMITS.dataAssetBytes,
    );
    expect(await artifacts.list("staging/")).toEqual([]);
  });

  it("still cancels an owned worker stream when its byte limit is exceeded", async () => {
    let produced = 0;
    let cancelled = false;
    const source = Readable.from(
      (async function* () {
        try {
          while (produced < 100) {
            produced++;
            yield Buffer.alloc(6);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } finally {
          cancelled = true;
        }
      })(),
    );
    await expect(
      artifacts.stageStream(randomUUID(), source, 10, "items_too_large"),
    ).rejects.toMatchObject({ code: "items_too_large" });
    expect(source.destroyed).toBe(true);
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(100);
    expect(await artifacts.list("staging/")).toEqual([]);
  });

  it("stops a synchronous owned producer at overflow", async () => {
    let produced = 0;
    const source = new Readable({
      read() {
        if (produced === 100) this.push(null);
        else {
          produced++;
          this.push(Buffer.alloc(6));
        }
      },
    });
    await expect(
      artifacts.stageStream(randomUUID(), source, 10, "items_too_large"),
    ).rejects.toMatchObject({ code: "items_too_large" });
    expect(source.destroyed).toBe(true);
    expect(produced).toBeLessThan(100);
    expect(await artifacts.list("staging/")).toEqual([]);
  });
});
