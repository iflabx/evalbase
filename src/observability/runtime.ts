import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

const BUCKETS = [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 30];
type Observation = { count: number; sum: number; buckets: number[] };
const emptyObservation = (): Observation => ({
  count: 0,
  sum: 0,
  buckets: BUCKETS.map(() => 0),
});
function observe(observation: Observation, seconds: number) {
  observation.count++;
  observation.sum += seconds;
  BUCKETS.forEach((limit, index) => {
    if (seconds <= limit) observation.buckets[index]++;
  });
}
function histogram(
  name: string,
  observation: Observation,
  labels: Record<string, string> = {},
): string[] {
  const formatted = Object.entries(labels).map(
    ([key, value]) => `${key}=${JSON.stringify(value)}`,
  );
  const suffix = formatted.length ? `{${formatted.join(",")}}` : "";
  return [
    ...BUCKETS.map(
      (limit, index) =>
        `${name}_bucket{${[...formatted, `le="${limit}"`].join(",")}} ${observation.buckets[index]}`,
    ),
    `${name}_bucket{${[...formatted, 'le="+Inf"'].join(",")}} ${observation.count}`,
    `${name}_count${suffix} ${observation.count}`,
    `${name}_sum${suffix} ${observation.sum}`,
  ];
}

/** Process-local, bounded diagnostics. Values and SQL text never enter the registry. */
export class RuntimeMetrics {
  private readonly http = new Map<
    string,
    { labels: Record<string, string>; observation: Observation }
  >();
  private readonly sql = emptyObservation();
  private readonly waits = emptyObservation();
  private sqlErrors = 0;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  constructor(readonly enabled = true) {
    if (enabled) this.loop.enable();
  }
  close() {
    this.loop.disable();
  }

  instrument(pool: Pool) {
    if (!this.enabled) return;
    const record = (kind: "sql" | "wait", seconds: number, failed: boolean) => {
      observe(kind === "sql" ? this.sql : this.waits, seconds);
      if (kind === "sql" && failed) this.sqlErrors++;
    };
    // pg's Pool uses callback connect/query internally; preserve both overload families.
    function measured<T extends (...args: never[]) => unknown>(
      original: T,
      kind: "sql" | "wait",
    ): T {
      return function (this: unknown, ...args: unknown[]) {
        const started = performance.now();
        let finished = false;
        const finish = (failed: boolean) => {
          if (finished) return;
          finished = true;
          record(kind, (performance.now() - started) / 1000, failed);
        };
        const callback = args.at(-1);
        if (typeof callback === "function") {
          args[args.length - 1] = function (
            this: unknown,
            ...result: unknown[]
          ) {
            finish(Boolean(result[0]));
            return Reflect.apply(callback, this, result);
          };
        }
        try {
          const result: unknown = Reflect.apply(original, this, args);
          if (result instanceof Promise)
            return result.then(
              (value) => {
                finish(false);
                return value;
              },
              (error) => {
                finish(true);
                throw error;
              },
            );
          // Submittable/streaming queries retain their original event/error behavior.
          return result;
        } catch (error) {
          finish(true);
          throw error;
        }
      } as unknown as T;
    }
    pool.connect = measured(pool.connect, "wait");
    pool.on("connect", (client) => {
      client.query = measured(client.query, "sql");
    });
  }

  installHttp(app: FastifyInstance) {
    if (!this.enabled) return;
    const routes = new Set<string>();
    const started = new WeakMap<object, number>();
    app.addHook("onRoute", (route) => {
      routes.add(route.url);
    });
    app.addHook("onRequest", async (request) => {
      started.set(request, performance.now());
    });
    app.addHook("onResponse", async (request, reply) => {
      const url = request.routeOptions.url ?? "unmatched";
      const route = routes.has(url) ? url : "unmatched";
      const method = [
        "GET",
        "POST",
        "PATCH",
        "PUT",
        "DELETE",
        "HEAD",
        "OPTIONS",
      ].includes(request.method)
        ? request.method
        : "other";
      const labels = { method, route, status: String(reply.statusCode) };
      const key = JSON.stringify(labels);
      let entry = this.http.get(key);
      if (!entry) {
        entry = { labels, observation: emptyObservation() };
        this.http.set(key, entry);
      }
      observe(
        entry.observation,
        (performance.now() - (started.get(request) ?? performance.now())) /
          1000,
      );
    });
  }

  render(pool: Pool): string {
    const lines = [
      "# TYPE evalbase_runtime_metrics_enabled gauge",
      `evalbase_runtime_metrics_enabled ${this.enabled ? 1 : 0}`,
    ];
    if (!this.enabled) return `${lines.join("\n")}\n`;
    const memory = process.memoryUsage();
    lines.push("# TYPE evalbase_http_duration_seconds histogram");
    for (const entry of this.http.values())
      lines.push(
        ...histogram(
          "evalbase_http_duration_seconds",
          entry.observation,
          entry.labels,
        ),
      );
    lines.push(
      "# TYPE evalbase_sql_duration_seconds histogram",
      ...histogram("evalbase_sql_duration_seconds", this.sql),
    );
    lines.push(
      "# TYPE evalbase_sql_errors_total counter",
      `evalbase_sql_errors_total ${this.sqlErrors}`,
    );
    lines.push(
      "# TYPE evalbase_pool_wait_duration_seconds histogram",
      ...histogram("evalbase_pool_wait_duration_seconds", this.waits),
    );
    for (const [name, value] of Object.entries({
      pool_connections: pool.totalCount,
      pool_idle_connections: pool.idleCount,
      pool_waiting_connections: pool.waitingCount,
      process_resident_memory_bytes: memory.rss,
      process_heap_used_bytes: memory.heapUsed,
      event_loop_delay_seconds: Number.isFinite(this.loop.mean)
        ? this.loop.mean / 1e9
        : 0,
      event_loop_delay_max_seconds: Number.isFinite(this.loop.max)
        ? this.loop.max / 1e9
        : 0,
    }))
      lines.push(`# TYPE evalbase_${name} gauge`, `evalbase_${name} ${value}`);
    return `${lines.join("\n")}\n`;
  }
}
