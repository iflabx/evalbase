# EvalBase

[中文文档](README.zh-CN.md)

EvalBase is a single-owner test-data management application. It helps one maintainer organize source files, map and inspect records, create immutable Test Set versions, track provenance, export CSV files, and safely recover or permanently delete Test Sets and versions.

Phase 1A is complete. The user-visible interaction contract is the frozen [solo-workflow prototype](docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html); the formal implementation is in `frontend-v3/`.

## What it does

- Create project workspaces with project-scoped Datasets and Test Sets.
- Upload CSV, JSON, and JSONL files through a two-step confirmation flow.
- Drag-map source fields to Question, Expected Output, and multiple Metadata fields.
- Browse normalized records, inspect a bounded raw-content preview, move files between Datasets, and use search, pagination, and row-height controls.
- Create `v1`, derive linear or branched immutable Test Set versions, and inspect record-level source and change facts.
- Download a version as data CSV or data CSV plus provenance CSV.
- Restore Test Sets and version branches from Trash; permanently delete only after entering the exact Test Set name or version label.

## Architecture

Docker Compose runs four services:

| Service    | Responsibility                                                      |
| ---------- | ------------------------------------------------------------------- |
| Web        | Fastify API and the built `frontend-v3` application                 |
| Worker     | Background processing and cleanup work                              |
| PostgreSQL | Projects, Datasets, Test Sets, versions, provenance, and state      |
| MinIO      | Original files, staged bytes, normalized artifacts, and CSV exports |

PostgreSQL and MinIO stay on an internal Docker network and do not publish host ports. Only Web is published.

## Quick start with Docker Compose

### Prerequisites

- Docker Engine with Docker Compose v2
- Network access to pull the pinned container images on the first run
- At least a few GB of free disk space for images and local PostgreSQL/MinIO volumes

Clone the repository and start the application:

```bash
git clone <your-repository-url> EvalBase
cd EvalBase

GIT_SHA=$(git rev-parse --short HEAD) \
WEB_BIND_ADDRESS=127.0.0.1 \
WEB_PORT=3000 \
APP_ORIGIN=http://127.0.0.1:3000 \
docker compose up -d --build
```

Open <http://127.0.0.1:3000>. The application has no login page because Phase 1A supports one non-interactive Owner only.

Verify the running revision and dependencies:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/health/ready
```

`git_sha` should match the checked-out commit. To stop containers while preserving local application data:

```bash
docker compose down
```

To remove the Compose volumes as well, including all local PostgreSQL and MinIO data:

```bash
docker compose down -v
```

The checked-in credentials are synthetic development defaults. Replace them before deployment.

## Local development and checks

Node.js 24 and npm are required for local development.

```bash
npm ci
npm run dev

npm test
npm run test:integration
npm run typecheck
npm run lint
npm run docs:check
npm run build
```

Run browser tests in the repository's containerized environment when needed:

```bash
docker compose --profile e2e run --rm e2e
```

The full command list and the risk-based validation rule are documented in [AGENTS.md](AGENTS.md).

## Data and capacity boundaries

- One source file: up to 50,000,000 bytes and 10,000 source records.
- One edit: up to 5 files, 100,000,000 total source bytes, and 10,000 source records.
- One published version: up to 10,000 records and 100,000,000 normalized bytes.

These are Phase 1A limits, not capacity guarantees.

## Repository layout

| Path                                     | Purpose                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `frontend-v3/`                           | Formal React frontend                                               |
| `src/`                                   | Fastify server, domain modules, database, storage, and worker       |
| `tests/`                                 | Unit and integration tests                                          |
| `docs/`                                  | PRD, architecture, ADRs, prototype records, research, and test plan |
| `.scratch/phase1a-test-data-management/` | Local implementation Spec, Tickets, and execution evidence          |
| `frontend-v1/`                           | Immutable visual/component donor; not a runtime frontend            |

`frontend-v2/` and `src/web/` are historical source only and do not participate in the formal build or Compose runtime.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines. A [Chinese version](CONTRIBUTING.zh-CN.md) is also available.

## Community and security

Report security concerns privately as described in [SECURITY.md](SECURITY.md). Community participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Project status

The Phase 1A v5.3 implementation sequence and final Owner end-to-end acceptance are complete. See the [progress ledger](docs/agents/phase1a-progress.md) for implementation evidence and the [PRD](docs/PRD-evalbase-v1.md) for the authoritative scope.

## Before publishing a fork

Review tracked files and remove any private server addresses, credentials, cookies, internal paths, logs, or data that should not be public. Do not publish `.env` files, database/MinIO volumes, `node_modules/`, generated `dist/`, browser reports, or real datasets. Review `.scratch/` before publishing because it preserves the project's development history and may contain environment-specific evidence.

This project is licensed under [Apache-2.0](LICENSE).
