# EvalBase

[中文](README.zh-CN.md) · [Documentation](docs/README.md) · [Setup guide](docs/getting-started.md)

EvalBase helps teams turn source material and model-generated candidates into traceable, versioned test datasets. It brings file organization, record selection, collaborative drafts, data processing, and a project assistant into one workspace.

Use it to prepare datasets for scenarios such as intent recognition, entity extraction, agent workflows, and safety testing. Each test record contains a **Question**, **Expected Output**, and **Metadata**. Running evaluations and collecting actual model answers are separate from this dataset-management workflow.

## What you can do

| Area                | Capabilities                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Projects and access | Sign in with individual accounts; organize project members with editor or viewer access.                                                                                                         |
| Source material     | Upload CSV, JSON, and JSONL; organize files in collections; map fields without overwriting the originals.                                                                                        |
| Record selection    | Search and filter records, include all matches or take a reproducible random selection, and review the fixed selection before adding it to a draft.                                              |
| Test datasets       | Edit shared drafts, save fields on blur, handle concurrent edits, publish immutable versions, inspect changes and provenance, and export data with provenance.                                   |
| Data processing     | Clean, rewrite, expand from existing records, or generate from background documents; inspect candidates and continue processing in the same task workspace.                                      |
| Project assistant   | Use natural language to find material, plan work, prepare drafts, process records, and review results. Upload PDF, Markdown, or text background documents in a dedicated conversation workspace. |
| Model settings      | Administrators configure an OpenAI-compatible endpoint, credentials, and a selectable model. Credentials stay on the server.                                                                     |

The core workflow is:

**Organize material or attach background → select records or plan generation → inspect and edit candidates → confirm saving to a draft → publish a version → export.**

Processing produces candidates first. Saving results and publishing versions use explicit confirmation. Draft autosave runs when you leave a field; it does not mean each keystroke has reached the server. Generated content and automated review still need human assessment.

## Getting started

See the [setup guide](docs/getting-started.md) for a local installation, first-administrator setup, model-worker configuration, and development commands. It also explains the difference between the legacy defaults in `compose.yaml` and the settings required for accounts and model processing.

An empty account-enabled installation opens administrator setup on first access. Existing installations use their existing accounts; upgrading a legacy single-owner instance follows the [account migration runbook](docs/runbooks/v2-account-upgrade.md).

## Architecture

| Component           | Responsibility                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| React Web           | The formal frontend in `frontend-v3/`, with TanStack Router, TanStack Query, and Tailwind CSS.  |
| Fastify Web service | Authentication, project permissions, business APIs, assistant requests, and the built frontend. |
| Ordinary Worker     | Non-model background jobs and cleanup.                                                          |
| Model Worker        | Model-processing jobs, using the same worker entry point with `WORKER_TASK_GROUP=model`.        |
| PostgreSQL          | Accounts, project state, drafts, versions, jobs, assistant progress, and operation receipts.    |
| MinIO               | Original files, processing artifacts, and exports.                                              |

The assistant uses AI SDK with an OpenAI-compatible provider. The application persists requirements, execution progress, budgets, and business receipts; models propose business operations within the current user's permissions. Details are in the [architecture](docs/architecture/data-selection-and-assistant.md) and [ADR](docs/adr/0014-project-agent-and-processing-runtime.md).

## Repository map

| Path           | Contents                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `frontend-v3/` | Formal frontend; its [README](frontend-v3/README.md) explains local commands.                   |
| `src/`         | API, security, selection, processing, assistant, storage, and worker modules.                   |
| `tests/`       | Unit, integration, and browser tests.                                                           |
| `docs/`        | [Documentation index](docs/README.md), product contracts, architecture, runbooks, and research. |
| `.scratch/`    | Feature specifications, tickets, and development evidence; review before publishing.            |
| `frontend-v1/` | Frozen visual/component reference. `frontend-v2/` and `src/web/` retain historical source.      |

## Status and validation

This overview describes the code in the checked-out revision. Accounts, collaboration, data processing, and the project assistant are implemented; assistant reliability work and acceptance records continue to evolve. The latest targeted checks do not establish that every prompt, model, or long-running task will succeed.

Use repository tags and Releases to identify published versions. Feature implementation and acceptance are tracked in the [v2 ledger](.scratch/evalbase-v2/spec.md), [data-processing ledger](.scratch/agent-data-processing/spec.md), and [assistant ledger](.scratch/assistant-optimization/spec.md). The [Phase 1A ledger](docs/agents/phase1a-progress.md) records the earlier single-owner baseline.

## Contributing and security

See [Contributing](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [Security Policy](SECURITY.md). Keep model keys, session cookies, deployment secrets, and private datasets out of commits. Review historical evidence under `.scratch/` before sharing a fork.

Licensed under [Apache-2.0](LICENSE).
