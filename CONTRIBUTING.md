# Contributing to EvalBase

[中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in contributing to EvalBase.

## Before opening an issue

Search existing issues first. For bugs, include:

- Expected behavior.
- Actual behavior.
- Steps to reproduce.
- Relevant logs or screenshots with secrets and private data removed.

For a new feature or behavior change, open an issue for discussion before writing code. EvalBase follows its PRD, architecture documents, and frozen interaction contract; a pull request must not silently expand that scope.

See the [development workflow](docs/agents/development-workflow.md) for branches, acceptance, integration, GitHub push, releases, and deployment handoff.

## Development setup

```bash
npm ci
npm run dev
```

Start the containerized stack when the change needs PostgreSQL, MinIO, the Worker, or the formal Web runtime:

```bash
docker compose up -d --build
```

## Checks

Run the checks relevant to your change before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:check
npm run build
```

Run focused integration or browser tests when a change affects an HTTP route, persistence, upload, versioning, deletion, or browser behavior.

## Pull requests

- Keep each pull request focused on one problem.
- Add or update tests for changed observable behavior.
- Update documentation when behavior, setup, or user-visible text changes.
- Do not commit secrets, real datasets, database volumes, generated build output, or browser reports.
- Do not modify `frontend-v1/`; it is an immutable visual/component donor.
- Use `frontend-v3/` for formal frontend changes.
- Explain the user-visible effect and validation evidence in the pull request description.

## License

By contributing, you agree that your contributions are licensed under the [Apache-2.0 License](LICENSE).
