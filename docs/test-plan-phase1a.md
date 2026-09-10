# Testing Guide

## Local checks

```bash
npm test
npm run typecheck
npm run lint
npm run docs:check
npm run licenses:check
npm run build
```

## Integration checks

Copy `.env.example` to `.env` and set the required random values. Then run:

```bash
docker compose --profile test run --rm test
```

The normal Compose stack keeps test identities disabled. The isolated test profile enables them only for test coverage.

## Browser smoke test

After `docker compose up -d --build`, verify:

1. `GET /health/ready` returns success.
2. The initial page opens without a login screen.
3. A project and Dataset can be created.
4. A CSV, JSON, or JSONL file can be mapped, previewed, and confirmed.
5. A Test Set version can be created, browsed, downloaded, moved to Trash, and restored.

Use only synthetic, public, or confirmed de-identified data in development and test environments.
