import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { queueContinuation } from "../../src/assistant/tasks.js";
const rootUrl = loadConfig().databaseUrl,
  name = "opt39_events_" + randomUUID().replaceAll("-", ""),
  databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + name);
const origin = "http://127.0.0.1:4217";
describe("OPT39 persisted continuation boundaries", () => {
  let db: ReturnType<typeof createPool>, projectId: string, actorId: string;
  beforeAll(async () => {
    const root = createPool(rootUrl);
    try {
      await root.query("CREATE DATABASE " + name);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    const app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
    const account = {
      email: "opt39-events@example.test",
      password: "Assistant123",
      confirmPassword: "Assistant123",
      displayName: "续步验收",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/installation/administrator",
          headers: { origin },
          payload: account,
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: account,
    });
    const headers = {
      origin,
      cookie: login.cookies[0].name + "=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrfToken,
    };
    projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "OPT39隔离续步" },
      })
    ).json().project.id;
    await app.close();
    db = createPool(databaseUrl);
    actorId = (
      await db.query("SELECT id FROM app_user WHERE email=$1", [account.email])
    ).rows[0].id;
  });
  afterAll(async () => {
    await db?.end();
    const root = createPool(rootUrl);
    try {
      await root.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
    } finally {
      await root.end();
    }
  });
  async function fixture(patch: Record<string, any> = {}) {
    const id = "session_" + randomUUID(),
      turnId = "turn_" + randomUUID();
    const task = {
      goal: "继续已授权工作",
      turnControl: {
        turnId,
        taskRevision: 1,
        source: "model",
        mode: "execute",
        updateSaved: true,
      },
      turnBudget: {
        turnId,
        startedAt: Date.now(),
        deadlineAt: Date.now() + 80000,
        modelSteps: 3,
        toolCalls: 7,
        transportRetries: 1,
        accountingVersion: 2,
        activeMs: 200,
      },
      budgetCheckpoint: {
        turnId,
        pendingAction: "create_draft",
        progressHashes: ["persisted-server-progress"],
      },
      stage: "processing",
      autoCount: 0,
      executionBudget: {
        modelSteps: 3,
        toolCalls: 7,
        transportRetries: 1,
        activeMs: 200,
      },
      ...patch,
    };
    await db.query(
      "INSERT INTO assistant_session(id,project_id,actor_id,task,task_revision) VALUES($1,$2,$3,$4,1)",
      [id, projectId, actorId, JSON.stringify(task)],
    );
    await db.query(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at,requires_write,task_revision) VALUES($1,$2,'original','hash','原用户授权','succeeded',now()+interval '1 minute',true,1)",
      [turnId, id],
    );
    const read = async () =>
      (await db.query("SELECT task FROM assistant_session WHERE id=$1", [id]))
        .rows[0].task;
    const turns = async () =>
      Number(
        (
          await db.query(
            "SELECT count(*) n FROM assistant_turn WHERE session_id=$1",
            [id],
          )
        ).rows[0].n,
      );
    return { id, turnId, task, read, turns };
  }
  it("preserves the old 12-event allowance and spent model budget on repeated completion events", async () => {
    const f = await fixture({ autoCount: 12 });
    await queueContinuation(db, f.id, "processing_completed", "done", 1);
    await queueContinuation(db, f.id, "processing_completed", "done-again", 1);
    expect(await f.read()).toMatchObject({
      autoCount: 12,
      executionPaused: true,
      stage: "waiting_input",
      error: "assistant_auto_limit",
      executionBudget: f.task.executionBudget,
    });
    expect((await f.read()).autoEventLimit).toBeUndefined();
    expect(await f.turns()).toBe(1);
  });
  it("deduplicates an event before charging and pauses only genuinely new work at its frozen limit", async () => {
    const f = await fixture({ autoEventLimit: 2, autoCount: 1 });
    await queueContinuation(db, f.id, "budget_yield", "one", 1);
    expect((await f.read()).autoCount).toBe(2);
    expect(await f.turns()).toBe(2);
    await db.query(
      "UPDATE assistant_turn SET status='succeeded' WHERE session_id=$1",
      [f.id],
    );
    await queueContinuation(db, f.id, "budget_yield", "one", 1);
    expect((await f.read()).autoCount).toBe(2);
    expect(await f.turns()).toBe(2);
    await queueContinuation(db, f.id, "budget_yield", "two", 1);
    expect(await f.read()).toMatchObject({
      autoCount: 2,
      autoEventLimit: 2,
      error: "assistant_auto_limit",
      executionBudget: f.task.executionBudget,
    });
    expect(await f.turns()).toBe(2);
  });
  it.each(["paused", "stopped", "old-revision", "active-turn"])(
    "does not dispatch after %s",
    async (kind) => {
      const f = await fixture(
        kind === "paused"
          ? { executionPaused: true }
          : kind === "stopped"
            ? { stage: "stopped" }
            : {},
      );
      if (kind === "active-turn")
        await db.query(
          "UPDATE assistant_turn SET status='running' WHERE id=$1",
          [f.turnId],
        );
      await queueContinuation(
        db,
        f.id,
        "confirmed",
        "event",
        kind === "old-revision" ? 0 : 1,
      );
      expect(await f.turns()).toBe(1);
      expect((await f.read()).autoCount).toBe(0);
    },
  );
  it("retains capacity and permission checks without incrementing event or model budgets", async () => {
    const f = await fixture({ autoEventLimit: 18 });
    await db.query(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at,task_revision) SELECT $1||i::text,$1,'fill-'||i::text,'hash','历史消息','succeeded',now()+interval '1 minute',1 FROM generate_series(1,99) i",
      [f.id],
    );
    await queueContinuation(db, f.id, "budget_yield", "capacity", 1);
    expect(await f.turns()).toBe(100);
    expect(await f.read()).toMatchObject({
      error: "assistant_session_limit",
      autoCount: 0,
      executionBudget: f.task.executionBudget,
    });
    const denied = await fixture();
    await db.query("UPDATE app_user SET role='user' WHERE id=$1", [actorId]);
    await db.query(
      "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [projectId, actorId],
    );
    try {
      await expect(
        queueContinuation(db, denied.id, "budget_yield", "denied", 1),
      ).rejects.toMatchObject({ status: 404, code: "assistant_not_found" });
      expect(await denied.turns()).toBe(1);
      expect(await denied.read()).toEqual(denied.task);
    } finally {
      await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [actorId]);
      await db.query(
        "UPDATE project_member SET role='owner' WHERE project_id=$1 AND user_id=$2",
        [projectId, actorId],
      );
    }
  });
  it("settles the final committed confirmation at the old ceiling without allocating a turn", async () => {
    const f = await fixture({
      stage: "awaiting_confirmation",
      autoCount: 12,
      executionPlan: {
        contractVersion: 1,
        mode: "execute",
        current: 2,
        steps: [
          {
            action: "generate_candidates",
            deliveryId: "H",
            status: "executed",
            revision: 1,
            input: { outputCount: 1 },
            receipt: { runId: "run-H", draftId: "draft-H" },
          },
          {
            action: "read_processing",
            deliveryId: "H",
            status: "executed",
            revision: 1,
            receipt: { runId: "run-H" },
          },
          {
            action: "request_processing_apply",
            deliveryId: "H",
            status: "waiting",
            revision: 1,
            receipt: {
              key: "save-H",
              proposalId: "proposal-final",
              draftId: "draft-H",
            },
          },
        ],
      },
    });
    await db.query(
      "INSERT INTO assistant_proposal(id,turn_id,session_id,project_id,actor_id,action,parameters,digest,summary,status,expires_at,task_revision,receipt) VALUES('proposal-final',$1,$2,$3,$4,'processing','{}','digest',$5,'succeeded',now()-interval '1 minute',1,$6)",
      [
        f.turnId,
        f.id,
        projectId,
        actorId,
        JSON.stringify({ range: "task" }),
        JSON.stringify({ receipt: { draftId: "draft-H", adopted: 1 } }),
      ],
    );
    await queueContinuation(db, f.id, "confirmed", "proposal-final", 1);
    await queueContinuation(db, f.id, "confirmed", "proposal-final", 1);
    expect(await f.read()).toMatchObject({
      stage: "complete",
      autoCount: 12,
      executionPlan: { current: 3 },
      executionBudget: f.task.executionBudget,
    });
    expect(await f.turns()).toBe(1);
  });
});
