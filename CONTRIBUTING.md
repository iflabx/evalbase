# Contributing to EvalBase

[中文](CONTRIBUTING.zh-CN.md) · [Documentation](docs/README.md)

## Reporting issues

Search existing issues first. For a bug, include expected and actual behavior, reproduction steps, the code revision, and relevant screenshots or logs with secrets and private data removed.

For assistant problems, include the ordinary user request and the stage where work stopped: planning, processing, confirmation, saving, or continuation. Distinguish the first error, automatic correction, and any manual intervention. Do not publish model keys, session cookies, private documents, or an entire private conversation.

Discuss new behavior through an issue or an existing approved feature ticket. Use the applicable product contract and recorded amendments; research and frozen prototypes alone do not establish current implementation status.

## Development setup

Follow the [setup guide](docs/getting-started.md) for accounts, PostgreSQL, MinIO, and the separate model worker. Install both dependency sets:

```bash
npm ci
npm --prefix frontend-v3 ci
```

With the appropriate environment configured, `npm run dev` starts the source Web and ordinary Worker. Model processing additionally needs `WORKER_TASK_GROUP=model npm run dev:worker`. The [frontend guide](frontend-v3/README.md) covers Vite development and the API proxy.

`npm run build` builds the formal frontend and compiled server. `start:web`, `start:worker`, and `db:migrate` use compiled files; source development uses the corresponding `dev:*` and `db:migrate:dev` commands.

## Checks

Choose checks for the behavior changed:

| Change                        | Relevant checks                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation                 | Inspect the final diff and changed links, tables, fences, and examples; run `npm run docs:check`.                                                              |
| Backend logic or APIs         | Focused unit/integration regressions, `npm run typecheck`, `npm run lint`, and an affected build check.                                                        |
| Frontend                      | `npm --prefix frontend-v3 run typecheck`, a formal frontend build, and focused browser verification where available.                                           |
| Assistant or model processing | Real SDK-path regressions for affected preparation, execution, correction, saving, and recovery; bounded live-model verification only within an agreed budget. |

Unit and integration entry points are `npm test` and `npm run test:integration`. Run database and object-storage tests in an isolated instance. Model tests must preserve previous results and budgets, record actual requests, and distinguish automated tests from observed browser results.

## Pull requests

- Keep the change focused and preserve unrelated work.
- Explain the user-visible result, relevant validation, and remaining limitations.
- Add meaningful regression coverage for behavior changes; update documentation when setup or behavior changes.
- Use `frontend-v3/` for formal frontend changes and retain the `frontend-v1/` visual style.
- Keep frozen prototypes and historical evidence intact.
- Do not commit credentials, private datasets, database volumes, or generated build output.

Branch, acceptance, merge, push, and release handling follow the [development workflow](docs/agents/development-workflow.md). Detailed repository rules are in [AGENTS.md](AGENTS.md).

## License

By contributing, you agree that your contributions are licensed under [Apache-2.0](LICENSE).
