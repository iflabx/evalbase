import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config } from "../config.js";
import type { Database } from "../db/pool.js";
import { isPlainObject } from "../server/support.js";

export class ModelConnectionError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
type Credential = { nonce: string; tag: string; ciphertext: string };
type Connection = {
  revision: number;
  name: string;
  endpoint: string;
  model: string;
  enabled: boolean;
  credential: Credential;
  tested_at: Date | null;
  test_ok: boolean | null;
  test_code: string | null;
};
function key(config: Config) {
  const value = config.modelEncryptionKey;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value)
    throw new ModelConnectionError(503, "model_encryption_unavailable");
  return bytes;
}
function encrypt(secret: string, config: Config, revision: number): Credential {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(config), nonce);
  cipher.setAAD(Buffer.from(`evalbase-model:${revision}`));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
function decrypt(connection: Connection, config: Config) {
  const encryptionKey = key(config);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(connection.credential.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(`evalbase-model:${connection.revision}`));
    decipher.setAuthTag(Buffer.from(connection.credential.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(connection.credential.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ModelConnectionError(503, "model_encryption_unavailable");
  }
}
async function readConnection(db: Pick<Database, "query">, revision?: number) {
  const result = await db.query<Connection>(
    "SELECT * FROM model_connection WHERE ($1::integer IS NULL OR revision=$1) ORDER BY revision DESC LIMIT 1",
    [revision ?? null],
  );
  return result.rows[0];
}
function publicConnection(connection: Connection | undefined) {
  if (!connection) return null;
  return {
    revision: connection.revision,
    name: connection.name,
    endpoint: connection.endpoint,
    model: connection.model,
    enabled: connection.enabled,
    hasKey: true,
    testedAt: connection.tested_at,
    testOk: connection.test_ok,
    testCode: connection.test_code,
  };
}
export async function modelConnectionSettings(db: Database, config: Config) {
  let encryptionReady = true;
  try {
    key(config);
  } catch {
    encryptionReady = false;
  }
  return {
    connection: publicConnection(await readConnection(db)),
    encryptionReady,
  };
}
export async function availableModelConnection(db: Database) {
  const connection = await readConnection(db);
  return {
    connection: connection
      ? {
          revision: connection.revision,
          name: connection.name,
          enabled: connection.enabled,
          testedAt: connection.tested_at,
          testOk: connection.test_ok,
        }
      : null,
  };
}
export async function saveModelConnection(
  db: Database,
  config: Config,
  actorId: string,
  input: unknown,
) {
  if (
    !isPlainObject(input) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0 ||
    typeof input.enabled !== "boolean" ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80 ||
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 200 ||
    typeof input.endpoint !== "string" ||
    input.endpoint.length > 2048 ||
    (input.apiKey !== undefined &&
      (typeof input.apiKey !== "string" ||
        input.apiKey.length > 8192 ||
        /[\r\n\0]/u.test(input.apiKey)))
  )
    throw new ModelConnectionError(422, "model_connection_invalid");
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new ModelConnectionError(422, "model_connection_invalid");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    throw new ModelConnectionError(422, "model_connection_invalid");
  key(config);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('evalbase-model-connection'))",
    );
    const previous = await readConnection(client);
    if ((previous?.revision ?? 0) !== input.revision)
      throw new ModelConnectionError(409, "model_connection_conflict");
    if (
      previous &&
      new URL(previous.endpoint).origin !== endpoint.origin &&
      !(typeof input.apiKey === "string" && input.apiKey.trim())
    )
      throw new ModelConnectionError(422, "model_key_required_for_endpoint");
    const secret =
      typeof input.apiKey === "string" && input.apiKey.trim()
        ? input.apiKey.trim()
        : previous
          ? decrypt(previous, config)
          : "";
    if (!secret) throw new ModelConnectionError(422, "model_key_required");
    const revision = Number(input.revision) + 1;
    const saved = await client.query<Connection>(
      `INSERT INTO model_connection(revision,name,endpoint,model,enabled,credential,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        revision,
        input.name.trim(),
        endpoint.href.replace(/\/+$/u, ""),
        input.model.trim(),
        input.enabled,
        encrypt(secret, config, revision),
        actorId,
      ],
    );
    await client.query("COMMIT");
    return {
      connection: publicConnection(saved.rows[0]),
      encryptionReady: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Providers are administrator configured. Bound responses even if a server ignores token limits.
const modelFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  let received = 0;
  const body = response.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > 8_000_000)
          throw Object.assign(new Error("model_response_too_large"), {
            code: "model_response_too_large",
          });
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body ?? null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
export async function configuredModel(
  db: Database,
  config: Config,
  revision?: number,
  allowDisabled = false,
  observeRequest?: (
    observation: {
      httpStatus: number | null;
      timeToHeadersMs: number;
    },
    error?: unknown,
  ) => void,
  decorateFetch?: (request: typeof fetch) => typeof fetch,
  requestScope?: {
    projectId: string;
    sessionId?: string;
    turnId?: string;
    runId?: string;
  },
) {
  const connection = await readConnection(db, revision);
  if (!connection || (!allowDisabled && !connection.enabled))
    throw new ModelConnectionError(409, "model_connection_unavailable");
  const observedFetch: typeof fetch = observeRequest
    ? async (input, init) => {
        const started = Date.now();
        let httpStatus: number | null = null;
        let failure: unknown;
        try {
          const response = await modelFetch(input, init);
          httpStatus = response.status;
          return response;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          observeRequest(
            {
              httpStatus,
              timeToHeadersMs: Date.now() - started,
            },
            failure,
          );
        }
      }
    : modelFetch;
  // Internal identity for request accounting; Symbols never become provider headers/body.
  const scopedFetch: typeof fetch = requestScope
    ? (input, init) =>
        observedFetch(input, {
          ...init,
          [Symbol.for("evalbase.modelRequestScope")]: Object.freeze({
            ...requestScope,
          }),
        })
    : observedFetch;
  const provider = createOpenAICompatible({
    name: "evalbase",
    baseURL: connection.endpoint,
    apiKey: decrypt(connection, config),
    fetch: decorateFetch ? decorateFetch(scopedFetch) : scopedFetch,
  });
  return {
    revision: connection.revision,
    model: provider.chatModel(connection.model),
  };
}
export async function testModelConnection(
  db: Database,
  config: Config,
  input: unknown,
) {
  if (!isPlainObject(input) || !Number.isSafeInteger(input.revision))
    throw new ModelConnectionError(422, "model_connection_invalid");
  const current = await readConnection(db);
  if (!current || current.revision !== input.revision)
    throw new ModelConnectionError(409, "model_connection_conflict");
  const { model } = await configuredModel(db, config, current.revision, true);
  let ok = false;
  try {
    const result = await generateText({
      model,
      prompt: "Reply with OK only.",
      maxOutputTokens: 32,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
      experimental_telemetry: { isEnabled: false },
    });
    ok = result.text.trim().length > 0;
  } catch {
    /* Never return provider errors, response bodies, or request headers. */
  }
  const code = ok ? null : "model_connection_failed";
  await db.query(
    "UPDATE model_connection SET tested_at=now(),test_ok=$2,test_code=$3 WHERE revision=$1",
    [current.revision, ok, code],
  );
  const latest = await readConnection(db);
  if (latest?.revision !== current.revision)
    throw new ModelConnectionError(409, "model_connection_conflict");
  return {
    test: { revision: current.revision, ok, code },
    connection: publicConnection(latest),
    encryptionReady: true,
  };
}
