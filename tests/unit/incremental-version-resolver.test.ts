import { describe, expect, it } from "vitest";

import {
  resolveSpikeVersion,
  type VersionMember,
} from "../../src/spikes/incremental-version-resolver.js";
import { assertIsolatedSpikeEnvironment } from "../../src/spikes/incremental-version-storage-environment.js";

const checkpoint: VersionMember[] = [
  { caseId: "case_a", revisionId: "revision_a1", position: 1 },
  { caseId: "case_b", revisionId: "revision_b1", position: 2 },
  { caseId: "case_c", revisionId: "revision_c1", position: 3 },
];

describe("incremental version storage spike resolver", () => {
  it("rebuilds an ordered version from a checkpoint and sparse changes", () => {
    expect(
      resolveSpikeVersion(checkpoint, [
        [
          {
            kind: "upsert",
            caseId: "case_a",
            revisionId: "revision_a2",
            position: 1,
          },
          { kind: "delete", caseId: "case_c" },
          {
            kind: "upsert",
            caseId: "case_d",
            revisionId: "revision_d1",
            position: 4,
          },
        ],
      ]),
    ).toEqual([
      { caseId: "case_a", revisionId: "revision_a2", position: 1 },
      { caseId: "case_b", revisionId: "revision_b1", position: 2 },
      { caseId: "case_d", revisionId: "revision_d1", position: 4 },
    ]);
  });

  it("rejects a delta that assigns one position to two cases", () => {
    expect(() =>
      resolveSpikeVersion(checkpoint, [
        [
          {
            kind: "upsert",
            caseId: "case_a",
            revisionId: "revision_a2",
            position: 2,
          },
        ],
      ]),
    ).toThrow("Duplicate position 2");
  });
});

describe("incremental version storage spike environment", () => {
  const isolatedConfig = {
    databaseUrl: "postgresql://spike:password@postgres:5432/spike",
    minio: { endPoint: "minio", bucket: "evalbase-incremental-storage-spike" },
  };

  it("only permits the dedicated Compose database and bucket", () => {
    expect(() =>
      assertIsolatedSpikeEnvironment(isolatedConfig, { SPIKE_ISOLATED: "1" }),
    ).not.toThrow();
    expect(() =>
      assertIsolatedSpikeEnvironment(
        {
          ...isolatedConfig,
          databaseUrl: "postgresql://user:password@postgres:5432/evalbase",
        },
        { SPIKE_ISOLATED: "1" },
      ),
    ).toThrow("isolated Compose");
    expect(() => assertIsolatedSpikeEnvironment(isolatedConfig, {})).toThrow(
      "isolated Compose",
    );
  });
});
