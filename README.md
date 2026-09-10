# EvalBase

[中文文档](README.zh-CN.md)

EvalBase is a single-owner application for organizing source data, creating immutable Test Set versions, recording record-level provenance, and exporting CSV files.

## Features

- Project-scoped Datasets and Test Sets.
- Confirmed CSV, JSON, and JSONL uploads with drag field mapping.
- Normalized record browsing, bounded raw-file previews, search, pagination, and row-density controls.
- Immutable linear or branched Test Set versions with source and change facts.
- CSV and provenance CSV downloads, Trash restore, and typed permanent deletion.

## Architecture

Docker Compose runs a Fastify Web/API service, a background Worker, PostgreSQL, and MinIO. PostgreSQL and MinIO use an internal Docker network and do not publish host ports. The formal React frontend is in `frontend-v3/`.

## Quick start

Requirements: Docker Engine with Docker Compose v2. The first run also needs network access to pull the pinned images.

```bash
git clone git@github.com:iflabx/evalbase.git EvalBase
cd EvalBase
cp .env.example .env
```

Set `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, and `OWNER_PASSWORD` in `.env` to separate URL-safe random values. For example, run `openssl rand -hex 32` once for each value.

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
curl http://127.0.0.1:3000/health/ready
```

Open <http://127.0.0.1:3000>. EvalBase uses a single-owner, no-login workflow. The default Web bind is loopback; change `WEB_BIND_ADDRESS`, `WEB_PORT`, and `APP_ORIGIN` together only when your access path requires it.

Stop the stack while preserving data:

```bash
docker compose down
```

Remove all local PostgreSQL and MinIO data:

```bash
docker compose down -v
```

## Development and checks

Node.js 24 and npm are required for local development.

```bash
npm ci
npm --prefix frontend-v3 ci
npm test
npm run typecheck
npm run lint
npm run docs:check
npm run build
```

Run integration tests through the isolated Compose profile after preparing `.env`:

```bash
docker compose --profile test run --rm test
```

## Data boundaries

- One source file: up to 50,000,000 bytes and 10,000 source records.
- One edit: up to 5 files, 100,000,000 total source bytes, and 10,000 source records.
- One published version: up to 10,000 records and 100,000,000 normalized bytes.

These are Phase 1A limits, not capacity guarantees.

## Documentation

- [Product requirements](docs/PRD-v2-test-data-management.md)
- [Domain vocabulary](CONTEXT.md)
- [Architecture](docs/architecture/phase1a-architecture.md)
- [System flow](docs/system-flow-v2.md)
- [Frozen interaction prototype](docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- [Testing guide](docs/test-plan-phase1a.md)

## Contributing, security, and licenses

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This project is licensed under [Apache-2.0](LICENSE).
