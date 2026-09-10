import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { canonicalJson, sha256 } from "../../src/package/contract.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import {
  dependencyHealth,
  startHealthServer,
} from "../../src/observability/health.js";
import {
  metricSnapshot,
  renderMetrics,
} from "../../src/observability/metrics.js";
import { scanConsistency } from "../../src/observability/consistency.js";

describe("Ticket 16 observability and local persistence", () => {
  let app: AgentBenchApp;
  let db: ReturnType<typeof createPool>;
  let artifacts: ArtifactRepository;
  let workerHealth: Awaited<ReturnType<typeof startHealthServer>>;
  let cookie: string;
  let csrf: string;
  const observabilityProjectId = `project_observability_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 20)}`;
  const consistencyAssetId = `asset_observability_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 20)}`;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    await artifacts.initialize();
    await db.query(
      `INSERT INTO project (id, name, owner_id)
       VALUES ($1,'Ticket 16 Observability','user_owner')`,
      [observabilityProjectId],
    );
    await db.query(
      `INSERT INTO project_member (project_id, user_id, role)
       VALUES ($1,'user_owner','owner')`,
      [observabilityProjectId],
    );
    const stored = await artifacts.storeImmutable(
      Buffer.from("observability-consistency-fixture\n"),
    );
    await db.query(
      `INSERT INTO data_asset
       (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
        file_name, format, status, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,'text/plain',
               'observability-consistency.txt','csv','stored','user_owner')`,
      [
        consistencyAssetId,
        observabilityProjectId,
        stored.sha256,
        stored.objectRef,
        stored.size,
      ],
    );
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(session.statusCode).toBe(200);
    cookie = `${session.cookies[0]?.name}=${session.cookies[0]?.value}`;
    csrf = session.json().csrfToken;
    workerHealth = await startHealthServer({
      hostname: "127.0.0.1",
      port: 0,
      gitSha: "observability-test",
      dependencies: () => dependencyHealth(db, artifacts),
      metrics: async () =>
        renderMetrics(
          await metricSnapshot(db, await dependencyHealth(db, artifacts)),
        ),
    });
  });

  afterAll(async () => {
    await workerHealth.close();
    await db.query(
      "DELETE FROM consistency_finding WHERE object_id LIKE 'asset_observability_%' OR object_id LIKE 'asset_marker_%'",
    );
    await db.query("DELETE FROM data_asset WHERE id=$1", [consistencyAssetId]);
    await app.close();
    await db.end();
  });

  it("exposes independent Web liveness and dependency readiness", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      status: "ok",
      git_sha: expect.any(String),
    });

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ok",
      dependencies: { postgresql: "ok", minio: "ok" },
    });
  });

  it("reports a missing MinIO bucket as unavailable", async () => {
    const health = await dependencyHealth({ query: async () => ({}) }, {
      bucket: "missing-bucket",
      client: { bucketExists: async () => false },
    } as any);
    expect(health).toEqual({ postgresql: "ok", minio: "failed" });
  });

  it("exposes Worker liveness and readiness over HTTP", async () => {
    const live = await fetch(
      `http://127.0.0.1:${workerHealth.port}/health/live`,
    );
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({
      status: "ok",
      git_sha: "observability-test",
    });

    const ready = await fetch(
      `http://127.0.0.1:${workerHealth.port}/health/ready`,
    );
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      status: "ok",
      dependencies: { postgresql: "ok", minio: "ok" },
    });
  });

  it("logs successful public HTTP operations with the structured schema", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: {
          username: "owner",
          password: "owner-test-password",
        },
      });
      expect(response.statusCode).toBe(200);
      const entries = logs.mock.calls
        .map((call) => JSON.parse(String(call[0])))
        .filter((entry) => entry.stage === "http:response");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        correlation_id: expect.any(String),
        job_id: null,
        project_id: null,
        object_id: null,
        stage: "http:response",
        duration_ms: expect.any(Number),
        error_code: null,
        status_code: 200,
      });
      expect(JSON.stringify(entries)).not.toMatch(
        /owner-test-password|session|credential|raw-record|Input content/i,
      );
    } finally {
      logs.mockRestore();
    }
  });

  it("logs stable error codes for client HTTP failures", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://untrusted.example" },
        payload: { username: "owner", password: "owner-test-password" },
      });
      expect(response.statusCode).toBe(403);
      const entries = logs.mock.calls
        .map((call) => JSON.parse(String(call[0])))
        .filter((entry) => entry.stage === "http:response");
      expect(entries).toContainEqual(
        expect.objectContaining({
          error_code: "origin_rejected",
          status_code: 403,
        }),
      );
      expect(JSON.stringify(entries)).not.toContain("owner-test-password");
    } finally {
      logs.mockRestore();
    }
  });

  it("exposes data-free minimum metrics for Web and Worker", async () => {
    const webMetrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(webMetrics.statusCode).toBe(200);
    const workerMetrics = await fetch(
      `http://127.0.0.1:${workerHealth.port}/metrics`,
    );
    expect(workerMetrics.status).toBe(200);
    const text = `${webMetrics.body}\n${await workerMetrics.text()}`;
    const requiredMetrics = [
      "agentbench_queue_depth",
      "agentbench_oldest_queued_age_seconds",
      "agentbench_job_successes_total",
      "agentbench_job_failures_total",
      "agentbench_job_retries_total",
      "agentbench_stage_duration_seconds_count",
      "agentbench_postgresql_health",
      "agentbench_minio_health",
      "agentbench_disk_usage_percent",
      "agentbench_hash_mismatches_total",
      "agentbench_orphan_count",
    ];
    for (const metric of requiredMetrics) expect(text).toContain(metric);
    expect(text).not.toMatch(
      /password|session|credential|raw[_-]record|prompt/i,
    );
    expect(text).not.toContain(loadConfig().databaseUrl);
    expect(text).not.toContain(loadConfig().minio.accessKey);
    expect(text).not.toContain(loadConfig().minio.secretKey);
  });

  it(
    "starts the real Worker health and metrics server",
    { timeout: 60_000 },
    async () => {
      const port = 3001;
      let worker: ChildProcess | undefined;
      try {
        const child = spawn(
          process.execPath,
          ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
          {
            stdio: ["ignore", "ignore", "ignore"],
            env: {
              ...process.env,
              JOB_CLAIM_DELAY_MS: "1000",
              WORKER_HEALTH_PORT: String(port),
            },
          },
        );
        worker = child;
        let ready: Response | undefined;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          ready = await fetch(`http://127.0.0.1:${port}/health/ready`).catch(
            () => undefined,
          );
          if (ready?.ok) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(ready?.ok).toBeTruthy();
        await expect(ready?.json()).resolves.toMatchObject({
          status: "ok",
          dependencies: { postgresql: "ok", minio: "ok" },
        });
        const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(metrics.ok).toBeTruthy();
        await expect(metrics.text()).resolves.toContain(
          "agentbench_queue_depth",
        );
        const upload = await app.inject({
          method: "POST",
          url: `/api/projects/${observabilityProjectId}/assets`,
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
            "idempotency-key": randomUUID(),
            "content-type": "text/csv; charset=utf-8",
            "x-file-name": "observability-stage-metrics.csv",
            "x-source-type": "synthetic",
            "x-source-name": "Ticket 16 stage metrics",
            "x-responsible-person": "Project Owner",
            "x-source-purpose": "Synthetic stage duration verification",
            "x-license-status": "not_applicable",
            "x-sensitivity": "non_sensitive",
          },
          payload: "question,answer\nStage duration,Persisted\n",
        });
        expect(upload.statusCode).toBe(201);
        let job: any;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const response = await app.inject({
            method: "GET",
            url: `/api/projects/${observabilityProjectId}/jobs/${upload.json().job.id}`,
            headers: { cookie },
          });
          job = response.json().job;
          if (job?.status === "succeeded") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(job?.status).toBe("succeeded");
        const stageMetrics = await fetch(
          `http://127.0.0.1:${port}/metrics`,
        ).then((response) => response.text());
        expect(stageMetrics).toContain('kind="parse_asset"');
        expect(stageMetrics).toContain('stage="parse:starting"');
      } finally {
        const child = worker;
        if (child) {
          child.kill("SIGTERM");
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
    },
  );

  it("reports one unhealthy dependency without marking both failed", async () => {
    const failedDatabase = {
      query: () => Promise.reject(new Error("dependency unavailable")),
    } as unknown as ReturnType<typeof createPool>;
    const degraded = renderMetrics(
      await metricSnapshot(failedDatabase, {
        postgresql: "ok",
        minio: "failed",
      }),
    );
    expect(degraded).toContain("agentbench_postgresql_health 1");
    expect(degraded).toContain("agentbench_minio_health 0");
    expect(degraded).toContain("agentbench_queue_depth 0");

    const server = await startHealthServer({
      hostname: "127.0.0.1",
      port: 0,
      gitSha: "dependency-test",
      dependencies: () =>
        Promise.resolve({
          postgresql: "ok" as const,
          minio: "failed" as const,
        }),
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/health/ready`,
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        status: "unavailable",
        dependencies: { postgresql: "ok", minio: "failed" },
      });
    } finally {
      await server.close();
    }
  });

  it("detects and resolves Version member count drift without rewriting hashes", async () => {
    const version = await db.query(
      `SELECT v.id, v.item_count
       FROM test_set_version v
       LEFT JOIN version_member vm ON vm.version_id = v.id
       WHERE v.status = 'published'
       GROUP BY v.id, v.item_count
       HAVING v.item_count = count(vm.case_revision_id)
       ORDER BY v.published_at DESC
       LIMIT 1`,
    );
    if (!version.rowCount)
      throw new Error("Ticket 16 requires a published Version fixture");
    const versionId = version.rows[0].id as string;
    const originalCount = Number(version.rows[0].item_count);
    const original = await db.query(
      "SELECT test_set_id FROM test_set_version WHERE id=$1",
      [versionId],
    );
    const originalTestSetId = original.rows[0].test_set_id as string;
    const baseline = await scanConsistency(db, artifacts, {
      objectIds: [versionId],
    });
    expect(
      baseline.findings.find((finding) => finding.object_id === versionId),
    ).toBeUndefined();
    try {
      await db.query(
        `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
         VALUES ($1,$2,'Ticket 16 count drift','Fault isolation','user_owner')`,
        [observabilityProjectId, observabilityProjectId],
      );
      await db.query("UPDATE test_set_version SET item_count=$2 WHERE id=$1", [
        versionId,
        originalCount + 1,
      ]);
      await db.query("UPDATE test_set_version SET test_set_id=$2 WHERE id=$1", [
        versionId,
        observabilityProjectId,
      ]);
      const drifted = await scanConsistency(db, artifacts, {
        objectIds: [versionId],
      });
      expect(
        drifted.findings.find(
          (finding) =>
            finding.error_code === "manifest_count_mismatch" &&
            finding.object_id === versionId,
        ),
      ).toBeTruthy();
      expect(
        drifted.findings.find(
          (finding) =>
            finding.error_code === "version_member_count_mismatch" &&
            finding.object_id === versionId,
        ),
      ).toBeTruthy();
    } finally {
      await db.query(
        "UPDATE test_set_version SET test_set_id=$3, item_count=$2 WHERE id=$1",
        [versionId, originalCount, originalTestSetId],
      );
      await db.query("DELETE FROM test_set WHERE id=$1", [
        observabilityProjectId,
      ]);
      const restored = await scanConsistency(db, artifacts, {
        objectIds: [versionId],
      });
      expect(
        restored.findings.find((finding) => finding.object_id === versionId),
      ).toBeUndefined();
    }
  });

  it("keeps a Manifest-only count drift open when members are healthy", async () => {
    const version = await db.query(
      `SELECT v.id, v.manifest_object_ref, v.item_count
       FROM test_set_version v
       WHERE v.status = 'published'
       ORDER BY v.published_at DESC
       LIMIT 1`,
    );
    if (!version.rowCount)
      throw new Error("Ticket 16 requires a published Version fixture");
    const versionId = version.rows[0].id as string;
    const originalObjectRef = version.rows[0].manifest_object_ref as string;
    const originalCount = Number(version.rows[0].item_count);
    const manifest = JSON.parse(
      (await artifacts.readBytes(originalObjectRef, 1_000_000)).toString(
        "utf8",
      ),
    );
    manifest.counts.items = originalCount + 1;
    const tampered = await artifacts.storeImmutable(
      Buffer.from(`${canonicalJson(manifest)}\n`),
    );
    await db.query(
      "UPDATE test_set_version SET manifest_object_ref=$2 WHERE id=$1",
      [versionId, tampered.objectRef],
    );
    try {
      const drifted = await scanConsistency(db, artifacts, {
        objectIds: [versionId],
      });
      expect(
        drifted.findings.find(
          (finding) =>
            finding.error_code === "manifest_count_mismatch" &&
            finding.object_id === versionId,
        ),
      ).toBeTruthy();
    } finally {
      await db.query(
        "UPDATE test_set_version SET manifest_object_ref=$2 WHERE id=$1",
        [versionId, originalObjectRef],
      );
      await scanConsistency(db, artifacts, { objectIds: [versionId] });
      await artifacts.remove(tampered.objectRef);
      await artifacts.remove(`markers/sha256/${tampered.sha256}.json`);
    }
  });

  it("detects missing evidence collection members", async () => {
    const candidate = await db.query(
      `SELECT id, evidence_object_ref
       FROM candidate_snapshot
       WHERE evidence_object_ref IS NOT NULL
         AND status NOT IN ('deletion_pending', 'tombstoned')
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (!candidate.rowCount)
      throw new Error("Ticket 16 requires a Candidate evidence fixture");
    const candidateId = candidate.rows[0].id as string;
    const descriptorRef = candidate.rows[0].evidence_object_ref as string;
    const descriptor = JSON.parse(
      (await artifacts.readBytes(descriptorRef, 1_000_000)).toString("utf8"),
    );
    const child = descriptor.objects?.[0];
    if (!child?.objectRef)
      throw new Error("Ticket 16 Candidate evidence has no child object");
    const childBytes = await artifacts.readBytes(child.objectRef, 2_000_000);
    await artifacts.remove(child.objectRef);
    try {
      const drifted = await scanConsistency(db, artifacts, {
        objectIds: [candidateId],
      });
      expect(
        drifted.findings.find(
          (finding) =>
            finding.error_code === "object_missing" &&
            finding.object_id === candidateId,
        ),
      ).toBeTruthy();
    } finally {
      await artifacts.client.putObject(
        artifacts.bucket,
        child.objectRef,
        childBytes,
        childBytes.byteLength,
      );
      await scanConsistency(db, artifacts, { objectIds: [candidateId] });
    }
  });

  it("detects Candidate evidence hash drift without rewriting the descriptor", async () => {
    const candidate = await db.query(
      `SELECT id, evidence_hash
       FROM candidate_snapshot
       WHERE evidence_object_ref IS NOT NULL AND evidence_hash IS NOT NULL
         AND status NOT IN ('deletion_pending', 'tombstoned')
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (!candidate.rowCount)
      throw new Error("Ticket 16 requires a Candidate evidence fixture");
    const candidateId = candidate.rows[0].id as string;
    const originalHash = candidate.rows[0].evidence_hash as string;
    const driftedHash = sha256("observability-evidence-hash-drift");
    await db.query(
      "UPDATE candidate_snapshot SET evidence_hash=$2 WHERE id=$1",
      [candidateId, driftedHash],
    );
    try {
      const drifted = await scanConsistency(db, artifacts, {
        objectIds: [candidateId],
      });
      expect(drifted.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: "evidence_hash_mismatch",
            object_type: "candidate_evidence",
            object_id: candidateId,
          }),
        ]),
      );
    } finally {
      await db.query(
        "UPDATE candidate_snapshot SET evidence_hash=$2 WHERE id=$1",
        [candidateId, originalHash],
      );
      await scanConsistency(db, artifacts, { objectIds: [candidateId] });
    }
  });

  it("observes and resolves an aged unreferenced commit marker", async () => {
    const stored = await artifacts.storeImmutable(
      Buffer.from(`observability-orphan-${randomUUID()}\n`),
    );
    const markerRef = `markers/sha256/${stored.sha256}.json`;
    try {
      const drifted = await scanConsistency(db, artifacts, {
        orphanGraceMs: -1,
      });
      expect(
        drifted.findings.find(
          (finding) =>
            finding.error_code === "aged_orphan" &&
            finding.object_id === markerRef,
        ),
      ).toBeTruthy();
      const beforeTargeted = await db.query(
        `SELECT status FROM consistency_finding
         WHERE error_code='aged_orphan' AND object_id=$1`,
        [markerRef],
      );
      expect(beforeTargeted.rows[0]?.status).toBe("open");
      const targeted = await scanConsistency(db, artifacts, {
        objectIds: [consistencyAssetId],
        orphanGraceMs: -1,
      });
      expect(
        targeted.findings.some(
          (finding) => finding.error_code === "aged_orphan",
        ),
      ).toBe(false);
      const afterTargeted = await db.query(
        `SELECT status FROM consistency_finding
         WHERE error_code='aged_orphan' AND object_id=$1`,
        [markerRef],
      );
      expect(afterTargeted.rows[0]?.status).toBe("open");
      await artifacts.remove(markerRef);
      await artifacts.remove(stored.objectRef);
      await scanConsistency(db, artifacts, { orphanGraceMs: -1 });
      const finding = await db.query(
        `SELECT status FROM consistency_finding
         WHERE error_code='aged_orphan' AND object_id=$1`,
        [markerRef],
      );
      expect(finding.rows[0]?.status).toBe("resolved");
    } finally {
      await artifacts.remove(markerRef).catch(() => undefined);
      await artifacts.remove(stored.objectRef).catch(() => undefined);
    }
  });

  it("fail-closes affected downloads after consistency drift", async () => {
    const healthy = await scanConsistency(db, artifacts, {
      objectIds: [consistencyAssetId],
    });
    expect(healthy.findings).toEqual([]);

    const object = await db.query(
      "SELECT object_ref FROM data_asset WHERE id=$1",
      [consistencyAssetId],
    );
    await artifacts.remove(object.rows[0].object_ref);
    const drifted = await scanConsistency(db, artifacts, {
      objectIds: [consistencyAssetId],
    });
    expect(drifted.findings).toEqual([
      expect.objectContaining({
        project_id: observabilityProjectId,
        error_code: "object_missing",
        object_type: "data_asset",
        object_id: consistencyAssetId,
      }),
    ]);

    const download = await app.inject({
      method: "GET",
      url: `/api/projects/${observabilityProjectId}/assets/${consistencyAssetId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(409);
    expect(download.json()).toMatchObject({
      error: { code: "integrity_blocked" },
    });

    const restoredObject = await artifacts.storeImmutable(
      Buffer.from("observability-consistency-fixture\n"),
    );
    expect(restoredObject.objectRef).toBe(object.rows[0].object_ref);

    const health = await dependencyHealth(db, artifacts);
    const metrics = renderMetrics(await metricSnapshot(db, health));
    expect(metrics).toContain("agentbench_hash_mismatches_total");
    expect(metrics).toContain("agentbench_orphan_count");
  });

  it("detects a missing commit marker and resolves it only after restoration", async () => {
    const markerAssetId = `asset_marker_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stored = await artifacts.storeImmutable(
      Buffer.from(`observability-marker-${randomUUID()}\n`),
    );
    await db.query(
      `INSERT INTO data_asset
       (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
        file_name, format, status, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,'text/plain',
               'observability-marker.txt','csv','stored','user_owner')`,
      [
        markerAssetId,
        observabilityProjectId,
        stored.sha256,
        stored.objectRef,
        stored.size,
      ],
    );
    const markerRef = `markers/sha256/${stored.sha256}.json`;
    const objects = [
      { path: stored.objectRef, sha256: stored.sha256, size: stored.size },
    ];
    const marker = Buffer.from(
      canonicalJson({
        objects,
        rootHash: sha256(canonicalJson(objects)),
      }),
    );
    try {
      const baseline = await scanConsistency(db, artifacts, {
        objectIds: [markerAssetId],
      });
      expect(
        baseline.findings.find(
          (finding) => finding.object_id === markerAssetId,
        ),
      ).toBeUndefined();
      await artifacts.remove(markerRef);
      const drifted = await scanConsistency(db, artifacts, {
        objectIds: [markerAssetId],
      });
      expect(drifted.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: "marker_missing",
            object_id: markerAssetId,
          }),
        ]),
      );
      expect(drifted.hashMismatches).toBe(baseline.hashMismatches + 1);

      await artifacts.client.putObject(
        artifacts.bucket,
        markerRef,
        marker,
        marker.byteLength,
        { "Content-Type": "application/json" },
      );
      const restored = await scanConsistency(db, artifacts, {
        objectIds: [markerAssetId],
      });
      expect(
        restored.findings.find(
          (finding) => finding.object_id === markerAssetId,
        ),
      ).toBeUndefined();
      expect(restored.hashMismatches).toBe(baseline.hashMismatches);

      const tamperedMarker = Buffer.from(
        canonicalJson({
          objects,
          rootHash: "f".repeat(64),
        }),
      );
      await artifacts.client.putObject(
        artifacts.bucket,
        markerRef,
        tamperedMarker,
        tamperedMarker.byteLength,
        { "Content-Type": "application/json" },
      );
      const rootHashDrifted = await scanConsistency(db, artifacts, {
        objectIds: [markerAssetId],
      });
      expect(rootHashDrifted.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: "marker_hash_mismatch",
            object_type: "data_asset",
            object_id: markerAssetId,
          }),
        ]),
      );
      const blocked = await app.inject({
        method: "GET",
        url: `/api/projects/${observabilityProjectId}/assets/${markerAssetId}/download`,
        headers: { cookie },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({
        error: { code: "integrity_blocked" },
      });
    } finally {
      await artifacts.client.putObject(
        artifacts.bucket,
        markerRef,
        marker,
        marker.byteLength,
        { "Content-Type": "application/json" },
      );
      await db.query("DELETE FROM consistency_finding WHERE object_id=$1", [
        markerAssetId,
      ]);
      await db.query("DELETE FROM data_asset WHERE id=$1", [markerAssetId]);
      await artifacts.remove(markerRef).catch(() => undefined);
      await artifacts.remove(stored.objectRef).catch(() => undefined);
    }
  });

  it("detects and resolves object hash drift without rewriting storage", async () => {
    const original = await db.query(
      "SELECT blob_sha256 FROM data_asset WHERE id=$1",
      [consistencyAssetId],
    );
    const originalHash = original.rows[0].blob_sha256 as string;
    try {
      await db.query("UPDATE data_asset SET blob_sha256=$2 WHERE id=$1", [
        consistencyAssetId,
        sha256("observability-hash-drift"),
      ]);
      const drifted = await scanConsistency(db, artifacts, {
        objectIds: [consistencyAssetId],
      });
      expect(drifted.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: "object_hash_mismatch",
            object_type: "data_asset",
            object_id: consistencyAssetId,
          }),
        ]),
      );
    } finally {
      await db.query("UPDATE data_asset SET blob_sha256=$2 WHERE id=$1", [
        consistencyAssetId,
        originalHash,
      ]);
      const restored = await scanConsistency(db, artifacts, {
        objectIds: [consistencyAssetId],
      });
      expect(restored.findings).toEqual([]);
    }
  });

  it("fail-closes a Standard Package download for its affected Version", async () => {
    const version = await db.query(
      `SELECT v.id, dr.id AS delivery_id
       FROM test_set_version v
       JOIN delivery_record dr ON dr.version_id = v.id
          AND dr.package_type = 'standard'
       WHERE v.status = 'published' AND dr.status = 'generated'
       ORDER BY v.published_at DESC LIMIT 1`,
    );
    if (!version.rowCount)
      throw new Error("Ticket 16 requires a generated Standard Package");
    const versionId = version.rows[0].id as string;
    const original = await db.query(
      "SELECT test_set_id FROM test_set_version WHERE id=$1",
      [versionId],
    );
    const originalTestSetId = original.rows[0].test_set_id as string;
    try {
      await db.query(
        `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
         VALUES ($1,$1,'Ticket 16 package drift','Fault isolation','user_owner')`,
        [observabilityProjectId],
      );
      await db.query("UPDATE test_set_version SET test_set_id=$2 WHERE id=$1", [
        versionId,
        observabilityProjectId,
      ]);
      await db.query(
        `INSERT INTO consistency_finding
           (project_id, error_code, object_type, object_id)
         VALUES ($2,'consistency_check_failed','test_set_version',$1)`,
        [versionId, observabilityProjectId],
      );
      const download = await app.inject({
        method: "GET",
        url: `/api/projects/${observabilityProjectId}/versions/${versionId}/package`,
        headers: { cookie },
      });
      expect(download.statusCode).toBe(409);
      expect(download.json()).toMatchObject({
        error: { code: "integrity_blocked" },
      });
      const deliveryDownload = await app.inject({
        method: "GET",
        url: `/api/projects/${observabilityProjectId}/deliveries/${version.rows[0].delivery_id}/download`,
        headers: { cookie },
      });
      expect(deliveryDownload.statusCode).toBe(409);
      expect(deliveryDownload.json()).toMatchObject({
        error: { code: "integrity_blocked" },
      });
    } finally {
      await db.query(
        "DELETE FROM consistency_finding WHERE object_id=$1 AND object_type='test_set_version'",
        [versionId],
      );
      await db.query("UPDATE test_set_version SET test_set_id=$2 WHERE id=$1", [
        versionId,
        originalTestSetId,
      ]);
      await db.query("DELETE FROM test_set WHERE id=$1", [
        observabilityProjectId,
      ]);
    }
  });
});
