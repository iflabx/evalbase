// One bounded burst of ten real HTTP sessions while a large request is in progress.
process.send({ ready: true });
process.once(
  "message",
  async ({ baseUrl, draftUrl, sessions, records, valuePrefix }) => {
    try {
      const latencies = await Promise.all(
        sessions.map(async (session, index) => {
          const at = performance.now();
          const saved = await fetch(
            `${baseUrl}${draftUrl}/records/${records[index].id}`,
            {
              method: "PATCH",
              headers: { ...session, "content-type": "application/json" },
              body: JSON.stringify({
                field: "expectedOutput",
                value: `${valuePrefix}-${index}`,
                expectedFieldRevision: records[index].expectedOutputRevision,
              }),
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (saved.status !== 200)
            throw new Error(`save_status_${saved.status}`);
          await saved.arrayBuffer();
          const read = await fetch(`${baseUrl}${draftUrl}`, {
            headers: session,
            signal: AbortSignal.timeout(30_000),
          });
          if (read.status !== 200)
            throw new Error(`read_status_${read.status}`);
          await read.arrayBuffer();
          return performance.now() - at;
        }),
      );
      const sorted = [...latencies].sort((a, b) => a - b);
      process.send({
        latencies,
        p50Ms: sorted[4],
        p95Ms: sorted[9],
        failures: 0,
      });
    } catch (error) {
      process.send({
        error: error instanceof Error ? error.message : "load_failed",
      });
    } finally {
      process.disconnect();
    }
  },
);
