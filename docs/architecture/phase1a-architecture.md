# EvalBase Architecture

EvalBase is a single TypeScript application. The browser frontend is built from `frontend-v3/` and served with the Fastify HTTP API. A separate Node.js Worker handles asynchronous parsing, normalization, exports, and cleanup.

## Runtime topology

Docker Compose runs four services:

| Service | Responsibility |
| --- | --- |
| Web | Static frontend, HTTP API, database migration on startup |
| Worker | Background jobs and cleanup |
| PostgreSQL | Projects, Datasets, Test Sets, versions, provenance, and state |
| MinIO | Uploaded bytes, normalized artifacts, and exports |

PostgreSQL and MinIO are on the internal Docker network and have no published host ports. Web is the only published service and defaults to `127.0.0.1:3000`.

## Product boundaries

- One non-interactive Owner workflow; the frontend has no login page.
- Source files are CSV, JSON, or JSONL and are mapped to normalized records before use in a Test Set.
- Test Set versions are immutable. A later version records its direct parent and does not overwrite history.
- Destructive operations go through Trash first. Permanent deletion requires typed confirmation and preserves tombstones where needed to retain version relationships.

## Operational rules

- Use the checked-in lockfiles and Node.js 24.
- Keep deployment secrets in the ignored `.env`, never in source control.
- Do not publish PostgreSQL or MinIO ports.
- The frozen [interaction prototype](../prototypes/THROWAWAY-phase1a-solo-workflow-ui.html) defines visible workflows; backend internals must not introduce extra user operations.

Relevant irreversible choices are recorded in [ADRs](../adr/).
