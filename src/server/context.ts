import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Database } from "../db/pool.js";
import type { Config } from "../config.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import type { SessionActor } from "./support.js";

/** Shared infrastructure and the two request guards; business state stays in its owning module. */
export interface ServerContext {
  publishInitial: (
    request: FastifyRequest<{ Params: { projectId: string }; Body: unknown }>,
    reply: FastifyReply,
  ) => Promise<unknown>;
  app: FastifyInstance;
  db: Database;
  config: Config;
  artifacts: ArtifactRepository;
  now: () => Date;
  legacyTestBootstrap: boolean;
  authenticate: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;
  writeAllowed: (request: FastifyRequest, actor: SessionActor) => boolean;
  enforceDeletionLock: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<boolean>;
}
