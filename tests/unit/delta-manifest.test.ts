import { expect, it } from "vitest";
import { encodeDeltaManifest } from "../../src/version/delta-manifest.js";

it("releases the encoder queue after an invalid request and preserves later bytes", async () => {
  const unsigned = { changes: [], new_revisions: [], item_count: 0 };
  const results = await Promise.allSettled([
    encodeDeltaManifest(unsigned),
    encodeDeltaManifest({ ...unsigned, invalid: NaN }),
    encodeDeltaManifest(unsigned),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  if (results[0].status !== "fulfilled" || results[2].status !== "fulfilled")
    throw new Error("queue stuck");
  expect(results[2].value.bytes).toEqual(results[0].value.bytes);
  expect(results[2].value.manifestHash).toBe(results[0].value.manifestHash);
  if (results[1].status === "rejected")
    expect(results[1].reason).toBeInstanceOf(TypeError);
});
