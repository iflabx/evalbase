# EvalBase Documentation Guide

## Project

This repository contains the EvalBase Phase 1A product definition and application implementation. Commit `92cb8a5` / `prototype/solo-workflow-v5.3` is the complete user-visible interaction contract: the product must include every frozen behavior and expose no user operation absent from that prototype. `frontend-v1/` is the immutable visual/component donor; `frontend-v2/` is deprecated history; formal frontend work occurs only under `frontend-v3/`.

## Current implementation state

Confirm the exact branch, `HEAD`, and [implementation progress](docs/agents/phase1a-progress.md) before making a new change. `Status:` remains the triage eligibility label defined in `docs/agents/triage-labels.md`; implementation completion is recorded separately in each Ticket's `Implementation:` line and `Comments`.

Run `npm run docs:check` when a Ticket changes documentation, lifecycle records, the progress ledger, or cross-document status. It is not required for a code-only Ticket that cannot affect those files.

For branch creation, integration, GitHub push, Release and deployment handoff, follow [development workflow](docs/agents/development-workflow.md).

## Sources of truth

- When changing product scope, behavior, formats, states, permissions, or acceptance criteria, read `docs/PRD-evalbase-v1.md` and `CONTEXT.md` first.
- Treat the PRD as the normative product contract and `CONTEXT.md` as the domain-language contract.
- Treat `docs/architecture/phase1a-architecture.md` as the Phase 1A technical design and qualifying ADRs under `docs/adr/` as the authority for hard-to-reverse technical decisions. Read both before writing specs, tickets, or implementation; neither may expand the PRD.
- When designing or implementing the Phase 1A Web, read `docs/architecture/phase1a-frontend-reuse.md`, the frozen prototype record, and [`docs/reviews/phase1a-frozen-prototype-v5.3-contract-ticket-implementation-delta-audit.md`](docs/reviews/phase1a-frozen-prototype-v5.3-contract-ticket-implementation-delta-audit.md). `frontend-v3/` is the formal frontend; never edit `frontend-v1/` or continue product development in deprecated `frontend-v2/`.
- Keep `docs/system-flow-v2.md`, `docs/system-flow-v2.mmd`, and `docs/system-flow-v2.png` aligned with affected PRD behavior.
- Treat `docs/research/reference-products.md` as research evidence, not as a product commitment. Verify changed external claims against primary sources.

### Frontend prototype parity

For every Ticket that changes `frontend-v3/`, treat frozen v5.3 as the interaction contract and `frontend-v1/` as the visual/component donor. Before editing, write a compact Ticket-local parity table covering the affected page's visible fields, control order, labels, enabled states, empty/error states, and explicit exclusions. Do not replace that comparison with a generic component library interpretation.

- Reuse copied donor typography, tokens, components, icons, layout and decorative transitions directly where they fit. Decorative donor animation may remain when it adds no user operation, page, state or workflow and honors `prefers-reduced-motion`.
- Implement only the frozen paths that belong to the current Ticket. Do not make a later-Ticket path look callable through a fake route, placeholder page, hidden wide API, or speculative control; record any necessary staged inactive item explicitly in the Ticket.
- Before commit, run the current Ticket's narrow browser semantic check when the browser environment is available, and check the affected screen against the frozen prototype for hierarchy, control order, labels, pagination, dialogs, empty/error states and forbidden controls. Owner checkpoint dependencies follow the relevant Ticket; the incremental-storage iteration uses the batches in [Test Plan §H.3](docs/test-plan-phase1a.md#h3-切换与验收规则).

## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default canonical state labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: use the root `CONTEXT.md` and record qualifying technical decisions under `docs/adr/`. See `docs/agents/domain.md`.

## Phase 1A ticket execution protocol

Apply this protocol to every implementation Ticket under `.scratch/phase1a-test-data-management/issues/`. A Ticket marked `ready-for-agent` is eligible for work only when all dependencies are complete and no Project Owner execution hold remains.

### Required skill pair

For every Project Owner-authorized Ticket implementation, use `implement` and `ponytail full` together. Confirm that both skill instructions are loaded before implementation; if either skill is unavailable in the active session, report the missing skill and stop instead of simulating it.

- `implement` owns the outer workflow: execute the current Ticket from its approved Spec, use TDD at the agreed public seams, run regular and final checks, perform the required code review, and create the permitted local commit.
- `ponytail full` owns each implementation decision: understand the affected flow first, then prefer existing code, the standard library, native platform behavior, installed dependencies, and the smallest working diff—in that order.
- The PRD, `CONTEXT.md`, architecture, ADRs, Implementation Spec, current Ticket, test plan, and this protocol remain authoritative over both skills. Minimalism may remove speculative structure, but it may not remove an acceptance criterion, required test evidence, trust-boundary validation, data-loss protection, security control, accessibility requirement, or explicit Owner instruction.
- `implement` does not authorize work on `main`, bypass the checks below, push a commit, clear an execution hold, or continue into another Ticket.

### 1. Read and bound the Ticket

Before editing implementation files, read in full:

1. This `AGENTS.md`.
2. The current Ticket and its referenced Implementation Spec.
3. `docs/PRD-evalbase-v1.md` and `CONTEXT.md`.
4. `docs/reviews/phase1a-solo-owner-decision-record.md`.
5. `docs/architecture/phase1a-architecture.md`.
6. Every ADR referenced by the Ticket or governing its affected seam.
7. `docs/test-plan-phase1a.md`.

Follow any additional required-reading links in the Ticket. For Web work or reuse from `frontend-v1/`, also follow the frontend-reuse rule in **Sources of truth** above.

The implementation boundary is the current Ticket's smallest accepted Phase 1A vertical slice. Use only approved data classifications. Keep Phase 1B capabilities, future-Ticket behavior, real sensitive data, and speculative abstractions outside the change.

### 2. Establish the start state

Before the first test or implementation edit:

1. Report `git status --short`, the current branch, and the baseline commit. Preserve existing user changes; stop if an unaccounted change overlaps the Ticket.
2. Confirm the current Ticket's dependencies are complete and that the Project Owner has authorized execution.
3. Confirm that the required `implement` + `ponytail full` pair is active.
4. Create a Ticket-specific working branch from the approved baseline. Implementation work must not run directly on `main`.
5. Name the public test seam for this Ticket and identify the acceptance criterion exercised by the first slice.
6. Show the first planned red → green behavior: the public observation that will fail, why it should fail, and the smallest expected green outcome.
7. Inventory every affected public route and current caller. Mark each route `reused`, `narrowed`, or `retired` under Architecture §5.0; a historical frontend, Ticket, or test is not a current compatibility requirement.

If the Ticket, Implementation Spec, ADR, PRD, or `CONTEXT.md` disagree on behavior, scope, domain meaning, capacity, permissions, or allowed data, stop before implementation and ask the Project Owner to resolve the conflict.

The start state is complete only when the skill pair, branch, dependency/authorization state, public seam, target AC, and first red → green behavior are all explicit.

### 3. Implement one behavior at a time

- Use TDD: make one public behavior fail for the intended reason, add only the code required to make it pass, then refactor within the same proven behavior if needed.
- Complete one vertical red → green slice before starting another. Test observable contracts rather than private tables, keys, call order, or implementation structure.
- Make each affected HTTP request, response and action no wider than the frozen prototype. Prefer narrowing an existing route; add a thin task route only when the existing deep module is reusable but its public contract cannot be narrowed in place. Remove the superseded route from public registration within the owning Ticket.
- Run the narrow relevant test after each change. Add integration or static checks only when the current behavior crosses those seams.
- Keep the diff within the current Ticket. Leave unrelated cleanup and refactoring untouched.
- Preserve the confirmed product scope. Stop and request a decision before changing product behavior, domain meaning, ADRs, capacity, permissions, or allowed data.

### 4. Verify and review before commit

After the Ticket's final green behavior:

1. Select the **necessary validation set** from the actual diff and public seam. By default it contains the directly affected normal path, one applicable critical failure/boundary path, and static/build/document checks for affected files.
2. Do not run the complete repository unit, integration, E2E, performance, security, or persistence suite by default. Expand only for a database migration/persistence change, shared request/security boundary, publication/version allocator, permanent deletion, shared parser/CSV contract, frontend deployment cutover, formal release/Owner acceptance, or explicit Project Owner instruction.
3. Use the `code-review` skill once on the final diff for **Standards** and **Spec**. Fix every P0/P1 finding and rerun only the finding's regression test and directly affected checks. An unresolved P0/P1 blocks completion and commit.
4. Review the final diff for accidental Phase 1B behavior, future-Ticket implementation, unrelated refactoring, and changes outside the approved data/environment boundary.
5. Create the local implementation commit only after the selected necessary checks pass. Do not push unless the Project Owner explicitly requests it.
6. A separate Ticket Closure Review under [`docs/agents/ticket-review-protocol.md`](docs/agents/ticket-review-protocol.md) is required only for a high-risk Ticket, formal frontend/deployment cutover, release acceptance, or explicit Project Owner request. Otherwise the Standards/Spec review plus targeted P0/P1 recheck is the closure evidence.
7. Update the Ticket's `Implementation:` line, `Comments`, and progress ledger when completion changes. Record the implementation SHA, `reused` / `narrowed` / `retired` route list, actual validation commands, review result, next-Ticket dependency, omitted broad suites, and why the selected evidence is sufficient. Run `npm run docs:check` for those documentation changes; a separate progress-only commit is optional rather than mandatory.

### 5. Report and stop

The final Ticket report must state:

- What was implemented and which acceptance criteria it satisfies.
- Test and validation evidence, including exact commands, outcomes, why the selected set is sufficient, and which broader suites were not run.
- Standards/Spec code-review results and any unresolved risks.
- The fixed `HEAD`; if a Closure Review was triggered, include its conclusion, accepted P2 findings, and untested claims. For an intermediate Ticket in a combined batch, provide automated evidence and identify the later checkpoint batch.
- The local commit SHA.
- Which next Ticket, if any, is now unblocked.

Stop after the report. Never start the next Ticket without a separate Project Owner instruction.

### Owner browser checkpoint environment

Use the checkpoint cadence in [Test Plan §H.3](docs/test-plan-phase1a.md#h3-切换与验收规则) for the incremental-storage iteration. An intermediate Ticket in a combined batch closes with automated evidence and its own report, then waits for separate Owner authorization for the next Ticket; its batch checkpoint is created at the final Ticket's fixed `HEAD`. Other Tickets retain their own checkpoint after the local implementation commit. A checkpoint is a verification environment, not a production deployment.

1. Give the Compose project, edge/internal networks, PostgreSQL volume, MinIO volume, database and bucket a checkpoint-batch-specific `owner-checkpoint` name. Bind Web only to a free loopback port unless the Project Owner explicitly authorizes an already approved access path. Never restart, replace, or reuse another checkpoint or project's running resources.
2. Start the current Ticket's backend, Worker and `frontend-v3` together. Point the frontend API proxy only at that checkpoint backend. Do not leave the Owner testing a stale frontend or backend from an earlier Ticket.
3. Set `GIT_SHA` from the fixed commit, verify `/health.git_sha` and `/health/ready`, then verify one frontend API request reaches that same backend. Report any unavailable prerequisite as a blocked checkpoint; do not describe it as ready.
4. Before handoff, seed the isolated checkpoint with small, allowed synthetic test data for its Ticket/batch. Verify the seeded records through the same frontend API the Owner will use. In the report give the browser URL, SSH tunnel command when needed, test-set/version identifiers, setup data, short browser actions, expected results and any behavior supported only by automated evidence. The Owner should be able to open the page and start testing without preparing the fixture.
5. Keep the checkpoint running for feedback. After explicit Owner acceptance, record the accepted SHA, result and evidence in the Ticket Comments and progress ledger, then stop and remove only that checkpoint's containers, networks, PostgreSQL/MinIO volumes, seeded test data and port binding. Verify the exact Compose project and resource names before removal; preserve acceptance logs and hashes outside the disposable volumes, and report cleanup completion or any failed removal. Acceptance releases only the dependency stated in the tracker and never authorizes the next Ticket automatically.

For a Ticket with no browser-observable behavior, still switch the checkpoint to its fixed `HEAD`, report that no new browser assertion exists, and give the smallest Owner-visible health or workflow verification that proves the changed seam is active.

## Editing rules

- Write Markdown in UTF-8 and use the established Chinese product terminology from `CONTEXT.md`.
- Preserve confirmed Phase 1A boundaries unless the user explicitly changes them; record future capabilities as backlog rather than silently expanding P0.
- Keep each requirement in one authoritative place. Link to supporting documents instead of duplicating long explanations.
- When the main flow changes, keep the first Mermaid block in `docs/system-flow-v2.md` identical to `docs/system-flow-v2.mmd`, then regenerate the PNG.

## Validation

- Check changed Markdown for broken links, malformed tables, and unclosed fences.
- Parse every changed JSON example.
- Render every changed Mermaid diagram. Regenerate the main PNG with:

  `npx -y @mermaid-js/mermaid-cli@11.12.0 -i docs/system-flow-v2.mmd -o docs/system-flow-v2.png -b white -w 5600 -H 1800 -s 1`

- For deployed Web/Worker validation, set `GIT_SHA=$(git rev-parse --short HEAD)` when running Compose, then verify `/health.git_sha` matches that commit. Ignored `dist/`, `playwright-report/`, and `test-results/` are never progress or deployment evidence.
