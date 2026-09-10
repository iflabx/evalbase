import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";

import * as Minio from "minio";

import { CAPACITY_LIMITS } from "../capacity.js";
import type { Config } from "../config.js";
import { canonicalJson, sha256 } from "../package/contract.js";

export interface StoredArtifact {
  sha256: string;
  size: number;
  objectRef: string;
}

export interface StoredArtifactCollection {
  objectRef: string;
  rootHash: string;
}

export interface StagedArtifact {
  stagingKey: string;
  sha256: string;
  size: number;
}

export interface StoredObjectSummary {
  key: string;
  lastModified: Date;
}

export class ArtifactRepository {
  readonly client: Minio.Client;
  readonly bucket: string;

  constructor(config: Config["minio"]) {
    this.client = new Minio.Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: false,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    this.bucket = config.bucket;
  }

  async initialize(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket)))
      await this.client.makeBucket(this.bucket);
  }

  async read(objectRef: string): Promise<Readable> {
    return this.client.getObject(this.bucket, objectRef);
  }

  async size(objectRef: string): Promise<number> {
    return (await this.client.statObject(this.bucket, objectRef)).size;
  }

  async list(
    prefix: string,
    startAfter?: string,
    limit = 1000,
  ): Promise<StoredObjectSummary[]> {
    const result = await this.client.listObjectsV2Query(
      this.bucket,
      prefix,
      "",
      "",
      Math.min(limit, 1000),
      startAfter ?? "",
    );
    return result.objects
      .filter((item) => typeof item.name === "string")
      .map((item) => ({
        key: item.name as string,
        lastModified: new Date(item.lastModified ?? 0),
      }));
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async readBytes(objectRef: string, maximumBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of await this.read(objectRef)) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maximumBytes) throw new Error("Artifact exceeds read limit");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }

  async readPrefix(objectRef: string, maximumBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of await this.read(objectRef)) {
      const bytes = Buffer.from(chunk);
      const remaining = maximumBytes - size;
      if (remaining <= 0) break;
      chunks.push(bytes.subarray(0, remaining));
      size += Math.min(bytes.byteLength, remaining);
      if (bytes.byteLength >= remaining) break;
    }
    return Buffer.concat(chunks);
  }

  async storeImmutable(
    bytes: Uint8Array,
    operationId: string = randomUUID(),
  ): Promise<StoredArtifact> {
    const digest = sha256(bytes);
    const stagingKey = `staging/${operationId}/immutable-${randomUUID()}`;
    try {
      await this.client.putObject(
        this.bucket,
        stagingKey,
        Buffer.from(bytes),
        bytes.byteLength,
      );
      return await this.commitStagedObject(
        stagingKey,
        digest,
        bytes.byteLength,
      );
    } finally {
      await this.client
        .removeObject(this.bucket, stagingKey)
        .catch(() => undefined);
    }
  }

  async stageStream(
    operationId: string,
    stream: Readable,
    maximumBytes: number,
    errorCode: string,
  ): Promise<StagedArtifact> {
    return this.stageStreamObject(
      `staging/${operationId}/items-${randomUUID()}`,
      stream,
      maximumBytes,
      errorCode,
    );
  }

  private async stageStreamObject(
    stagingKey: string,
    stream: Readable,
    maximumBytes: number,
    errorCode: string,
  ): Promise<StagedArtifact> {
    const hash = createHash("sha256");
    let size = 0;
    let failed = false;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > maximumBytes) {
          callback(
            Object.assign(new Error("Artifact exceeds exact byte limit"), {
              code: errorCode,
              observedBytes: size,
            }),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      const metered = stream.pipe(meter);
      const meterFailure = new Promise<never>((_resolve, reject) =>
        meter.once("error", reject),
      );
      const sourceFailure = new Promise<never>((_resolve, reject) =>
        stream.once("error", reject),
      );
      const upload = this.client.putObject(this.bucket, stagingKey, metered);
      upload.catch(() => undefined);
      await Promise.race([upload, meterFailure, sourceFailure]);
      await upload;
      return { stagingKey, sha256: hash.digest("hex"), size };
    } catch (error) {
      failed = true;
      stream.destroy();
      meter.destroy();
      throw error;
    } finally {
      if (failed)
        await this.client
          .removeObject(this.bucket, stagingKey)
          .catch(() => undefined);
    }
  }

  async commitStaged(staged: StagedArtifact): Promise<StoredArtifact> {
    return await this.commitStagedObject(
      staged.stagingKey,
      staged.sha256,
      staged.size,
    );
  }

  private async commitStagedObject(
    stagingKey: string,
    digest: string,
    size: number,
  ): Promise<StoredArtifact> {
    const objectRef = `blobs/sha256/${digest}`;
    try {
      try {
        const existing = await this.client.statObject(this.bucket, objectRef);
        if (existing.size !== size)
          throw new Error("Immutable artifact hash collision");
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "NoSuchKey" && code !== "NotFound") throw error;
        await this.client.copyObject(
          this.bucket,
          objectRef,
          `/${this.bucket}/${stagingKey}`,
        );
      }
      const committed = await this.client.statObject(this.bucket, objectRef);
      if (committed.size !== size)
        throw new Error("Committed artifact size mismatch");
      await this.commitMarker(objectRef, digest, size);
      return { sha256: digest, size, objectRef };
    } finally {
      await this.client
        .removeObject(this.bucket, stagingKey)
        .catch(() => undefined);
    }
  }

  async storeCollection(
    files: Record<string, Uint8Array | string>,
  ): Promise<StoredArtifactCollection> {
    const objects = [];
    for (const path of Object.keys(files).sort()) {
      const bytes =
        typeof files[path] === "string"
          ? Buffer.from(files[path])
          : files[path];
      const stored = await this.storeImmutable(bytes);
      objects.push({ path, ...stored });
    }
    const rootHash = sha256(canonicalJson(objects));
    const descriptor = await this.storeImmutable(
      Buffer.from(canonicalJson({ objects, rootHash })),
    );
    return { objectRef: descriptor.objectRef, rootHash };
  }

  async verifyCollection(
    descriptorRef: string,
    files: Record<string, Uint8Array | string>,
  ): Promise<void> {
    const objects = Object.keys(files)
      .sort()
      .map((path) => {
        const bytes =
          typeof files[path] === "string"
            ? Buffer.from(files[path])
            : files[path];
        const digest = sha256(bytes);
        return {
          path,
          sha256: digest,
          size: bytes.byteLength,
          objectRef: `blobs/sha256/${digest}`,
        };
      });
    const expected = canonicalJson({
      objects,
      rootHash: sha256(canonicalJson(objects)),
    });
    const actual = await this.readBytes(descriptorRef, 1_000_000);
    if (actual.toString("utf8") !== expected)
      throw new Error("Immutable artifact collection mismatch");
    for (const object of objects) {
      const stored = await this.client.statObject(
        this.bucket,
        object.objectRef,
      );
      if (stored.size !== object.size)
        throw new Error("Immutable artifact collection object mismatch");
    }
  }

  async storeOriginal(
    operationId: string,
    stream: Readable,
    maximumBytes = CAPACITY_LIMITS.dataAssetBytes,
  ): Promise<StoredArtifact> {
    const staged = await this.stageStreamObject(
      `staging/${operationId}/original-${randomUUID()}`,
      stream,
      maximumBytes,
      "asset_too_large",
    );
    return await this.commitStaged(staged);
  }

  private async commitMarker(
    objectRef: string,
    digest: string,
    size: number,
  ): Promise<void> {
    const objects = [{ path: objectRef, sha256: digest, size }];
    const marker = Buffer.from(
      canonicalJson({ objects, rootHash: sha256(canonicalJson(objects)) }),
    );
    const markerRef = `markers/sha256/${digest}.json`;
    try {
      const existing = await this.readBytes(markerRef, 100_000);
      if (!existing.equals(marker))
        throw new Error("Immutable artifact marker mismatch");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "NoSuchKey" && code !== "NotFound") throw error;
      await this.client.putObject(
        this.bucket,
        markerRef,
        marker,
        marker.byteLength,
        { "Content-Type": "application/json" },
      );
    }
  }
}
