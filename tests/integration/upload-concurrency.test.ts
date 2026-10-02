import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const config = loadConfig(),
  name = `evalbase_upload_races_${randomUUID().replaceAll("-", "")}`;
const url = config.databaseUrl.replace(/\/[^/]+$/, `/${name}`),
  db = createPool(url),
  root = createPool(config.databaseUrl);
const origin = "http://127.0.0.1:3000",
  artifacts = new ArtifactRepository(config.minio);
let app: AgentBenchApp,
  projectId: string,
  collectionId: string,
  headers: Record<string, string>;
function gate() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((done) => (enter = done)),
    wait: new Promise<void>((done) => (release = done)),
    enter: () => enter(),
    release: () => release(),
  };
}
let pendingGate: ReturnType<typeof gate> | undefined;
const originalQuery = pg.Client.prototype.query;
const querySpy = vi
  .spyOn(pg.Client.prototype, "query")
  .mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const sql = typeof args[0] === "string" ? args[0] : "";
    if (
      pendingGate &&
      sql.includes("SELECT * FROM pending_upload WHERE id=ANY")
    ) {
      const held = pendingGate;
      pendingGate = undefined;
      held.enter();
      if (typeof args.at(-1) === "function") {
        void held.wait.then(() => Reflect.apply(originalQuery, this, args));
        return undefined;
      }
      return held.wait.then(() => Reflect.apply(originalQuery, this, args));
    }
    return Reflect.apply(originalQuery, this, args);
  } as typeof originalQuery);
beforeAll(async () => {
  await root.query(`CREATE DATABASE ${name}`);
  await migrate(url);
  app = await buildApp(
    {
      databaseUrl: url,
      appOrigin: origin,
      soloOwnerMode: false,
      allowTestIdentity: false,
    },
    { artifacts, disableLegacyTestBootstrap: true },
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/installation/administrator",
        headers: { origin },
        payload: {
          email: "admin@race.test",
          displayName: "管理员",
          password: "RaceAdmin123!",
          confirmPassword: "RaceAdmin123!",
        },
      })
    ).statusCode,
  ).toBe(201);
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { origin },
    payload: { email: "admin@race.test", password: "RaceAdmin123!" },
  });
  headers = {
    origin,
    cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    "x-csrf-token": login.json().csrfToken,
  };
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers,
    payload: { name: "上传竞态合成项目" },
  });
  projectId = project.json().project.id;
  collectionId = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers,
    })
  ).json().collections[0].id;
});
afterAll(async () => {
  pendingGate?.release();
  await app?.close();
  querySpy.mockRestore();
  await db.end();
  await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await root.end();
});
async function upload() {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/pending-uploads`,
    headers: {
      ...headers,
      "content-type": "text/csv",
      "x-file-name": "race.csv",
    },
    payload: `question,answer\n${randomUUID()},old\n`,
  });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json().pendingUpload.id;
  const preview = await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/pending-uploads/${id}/preview`,
    headers,
    payload: {
      mapping: {
        question: "/question",
        expectedOutput: "/answer",
        metadata: [],
      },
    },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  return id;
}
function confirm(id: string, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
    headers: { ...headers, "idempotency-key": key },
    payload: { collectionId, pendingUploadIds: [id] },
  });
}
it("replays a same-key commit between the preflight receipt and pending reads", async () => {
  const id = await upload(),
    key = randomUUID(),
    held = gate();
  pendingGate = held;
  const retry = confirm(id, key);
  await held.entered;
  try {
    const first = await confirm(id, key);
    expect(first.statusCode, first.body).toBe(201);
    held.release();
    const replay = await retry;
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      assets: first.json().assets,
      replayed: true,
    });
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) FROM data_asset WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  } finally {
    held.release();
  }
});
it.each(["cancel", "expire", "mapping"] as const)(
  "rechecks %s after parsing without holding upload row locks",
  async (action) => {
    const id = await upload(),
      held = gate(),
      originalRead = artifacts.read.bind(artifacts);
    const read = vi
      .spyOn(artifacts, "read")
      .mockImplementationOnce(async (ref) => {
        held.enter();
        await held.wait;
        return originalRead(ref);
      });
    const attempt = confirm(id);
    await held.entered;
    try {
      const lock = await db.connect();
      try {
        await lock.query("BEGIN");
        await lock.query(
          "SELECT id FROM pending_upload WHERE id=$1 FOR UPDATE NOWAIT",
          [id],
        );
        await lock.query("ROLLBACK");
      } finally {
        lock.release();
      }
      if (action === "cancel")
        await db.query(
          "UPDATE pending_upload SET status='cancelled' WHERE id=$1",
          [id],
        );
      if (action === "expire")
        await db.query(
          "UPDATE pending_upload SET expires_at=now()-interval '1 second' WHERE id=$1",
          [id],
        );
      if (action === "mapping")
        await db.query(
          "UPDATE pending_upload SET display_mapping=$2 WHERE id=$1",
          [
            id,
            { question: "/answer", expectedOutput: "/question", metadata: [] },
          ],
        );
      held.release();
      const response = await attempt;
      if (action === "mapping") {
        expect(response.statusCode, response.body).toBe(201);
        const view = await db.query(
          "SELECT display_mapping FROM parsed_view WHERE asset_id=$1",
          [response.json().assets[0].id],
        );
        expect(view.rows[0].display_mapping.question).toBe("/answer");
      } else {
        expect(response.statusCode, response.body).toBe(404);
        expect(
          Number(
            (
              await db.query(
                "SELECT count(*) FROM data_asset WHERE project_id=$1 AND blob_sha256=(SELECT blob_sha256 FROM pending_upload WHERE id=$2)",
                [projectId, id],
              )
            ).rows[0].count,
          ),
        ).toBe(0);
      }
    } finally {
      held.release();
      read.mockRestore();
    }
  },
);
