import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { canonicalJson, sha256 } from "../package/contract.js";

type EncodedManifest = { bytes: Buffer; manifestHash: string };
function encode(unsigned: Record<string, unknown>): EncodedManifest {
  const deltaHash = sha256(
    canonicalJson({
      changes: unsigned.changes,
      new_revisions: unsigned.new_revisions,
    }),
  );
  const withoutHash = { ...unsigned, delta_hash: deltaHash };
  const manifestHash = sha256(canonicalJson(withoutHash));
  return {
    bytes: Buffer.from(
      `${canonicalJson({ ...withoutHash, manifest_hash: manifestHash })}\n`,
    ),
    manifestHash,
  };
}

// The canonical algorithm and bytes are unchanged. Only CPU allocation moves off HTTP.
if (!isMainThread && workerData?.kind === "encode_delta_manifest") {
  try {
    const encoded = encode(workerData.unsigned);
    const bytes = new Uint8Array(encoded.bytes);
    parentPort!.postMessage({ bytes, manifestHash: encoded.manifestHash }, [
      bytes.buffer,
    ]);
  } catch (error) {
    parentPort!.postMessage({
      error: {
        name: error instanceof Error ? error.name : "Error",
        message:
          error instanceof Error ? error.message : "manifest_encoding_failed",
      },
    });
  } finally {
    parentPort!.close();
  }
}

// One encoding thread per process; errors release the next caller's turn as well.
let turn = Promise.resolve();
export async function encodeDeltaManifest(
  unsigned: Record<string, unknown>,
): Promise<EncodedManifest> {
  const previous = turn;
  let release!: () => void;
  turn = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  try {
    return await new Promise<EncodedManifest>((done, fail) => {
      const source = import.meta.url.endsWith(".ts");
      const worker = new Worker(
        source
          ? `const {workerData}=require("node:worker_threads");
           import("tsx/esm/api").then(({tsImport})=>tsImport(workerData.entry,workerData.entry))
             .catch(error=>{throw error});`
          : new URL(import.meta.url),
        {
          workerData: {
            kind: "encode_delta_manifest",
            unsigned,
            entry: import.meta.url,
          },
          ...(source ? { eval: true } : {}),
        },
      );
      let result:
        | {
            bytes: Uint8Array;
            manifestHash: string;
            error?: { name: string; message: string };
          }
        | undefined;
      let failure: Error | undefined;
      worker.once("message", (value) => {
        result = value;
      });
      worker.once("error", (error) => {
        failure = error;
      });
      worker.once("exit", (code) => {
        if (failure) return fail(failure);
        if (result?.error) {
          const error =
            result.error.name === "TypeError"
              ? new TypeError(result.error.message)
              : new Error(result.error.message);
          return fail(Object.assign(error, { name: result.error.name }));
        }
        if (code !== 0 || !result)
          return fail(new Error(`manifest_encoder_exit_${code}`));
        done({
          bytes: Buffer.from(
            result.bytes.buffer,
            result.bytes.byteOffset,
            result.bytes.byteLength,
          ),
          manifestHash: result.manifestHash,
        });
      });
    });
  } finally {
    release();
  }
}
