# EvalBase Documentation Guide

## Project

EvalBase contains the product definitions and application implementation. `frontend-v1/` is the read-only visual/component donor; `frontend-v2/` is deprecated history; formal frontend changes belong in `frontend-v3/`. Frozen prototypes remain read-only unless the Owner explicitly requests their revision.

## Sources of truth

- Use the current feature's approved PRD and Implementation Spec for behavior; use `CONTEXT.md` for domain meaning. Latest explicit Owner decisions override earlier project rules within their stated scope. Preserve applicable security and data constraints; ask only when a material conflict remains unresolved by those decisions and the documented scope.
- For Phase 1A inherited behavior, use `docs/PRD-evalbase-v1.md`, `docs/architecture/phase1a-architecture.md` and relevant `docs/adr/` decisions. Commit `92cb8a5` / `prototype/solo-workflow-v5.3` governs that iteration, not later approved features.
- For v2 work, use [v2 Implementation Spec](.scratch/evalbase-v2/spec.md) to locate the v2 PRD, frozen prototype, batch dependencies and progress. For later feature tracks, use the current Ticket's governing Spec, such as `.scratch/agent-data-processing/spec.md` or `.scratch/assistant-optimization/spec.md` when present in the working checkout. Later approved contracts override only the behavior they change; inherited behavior keeps its existing contract.
- Read the current Ticket in full. Read only affected sections of its Spec, PRD, glossary, architecture, test plan and relevant ADRs; follow references that constrain this change. Reuse already-read unchanged context. Historical audits and decision records are evidence to consult when needed, not a mandatory reading chain.
- For workflow only, this guide replaces older generic full-reading, per-Ticket branch/confirmation and duplicate-check requirements in Specs or Skills. Product AC, explicit execution holds and risk-specific safety checks remain binding.
- For frontend work, consult the applicable prototype and [frontend reuse guidance](docs/architecture/phase1a-frontend-reuse.md). Research documents are evidence, not product commitments; verify external claims when changing them.

## Current implementation state

At the start of a task, inspect the working directory, branch, `HEAD` and relevant tracked/untracked changes; preserve unrelated work. Consult the feature's progress record when executing a Ticket. Phase 1A uses [implementation progress](docs/agents/phase1a-progress.md); later tracks use their Spec ledger. `Status:` is the triage label; `Implementation:` and Comments record execution.

Follow [development workflow](docs/agents/development-workflow.md) for branches, integration, push and deployment. Reuse the authorized feature/batch branch; a new Ticket within it does not require another branch. Implementation must not run directly on `main`. Merge, push, tag, Release and production deployment each need authorization covering that action; existing explicit authorization remains valid within its scope and must not be requested again.

## Complete root-cause scope

“精简流程、不要过度开发” means the smallest complete design that satisfies the approved behavior and resolves the root cause across affected callers. File count and diff length are not completion criteria.

- Choose the repair scope from the failed contract and its actual consumers. When failures recur across inputs or recovery paths, trace input, validation, persistence, execution, recovery and presentation before choosing another patch. Record only the affected paths in the existing Ticket or design.
- Necessary structural changes are allowed within authorized behavior: consolidate conflicting decisions, adjust internal interfaces, extract shared logic with real callers, and remove replaced branches. State the responsibility conflict, compatibility boundary and verification path; routine restructuring needs no separate approval. Product scope, data use, permissions and budget changes still follow their existing authorization constraints.
- Reuse existing infrastructure and the authoritative state. New abstractions must reduce an observed duplication or contract conflict. Keep unrelated cleanup and speculative capabilities out of scope.
- Verify the mechanism through affected public flows and shared callers: normal completion, correction, continuation and relevant failure/budget boundaries. A green helper test alone does not establish user-flow completion. Preserve first failures and distinguish automatic recovery, normal user clarification and technical intervention.
- Use this rule in place of older generic “fewest files”, “shortest diff” or localized-only guidance. Explicit product AC, permission checks, fixed confirmations, immutable data and frozen budgets remain binding. This rule adds no mandatory new Ticket, review pass, broad suite or permission checkpoint.

For assistant planning, correction or recovery work, read the affected sections of the [mechanism consolidation plan](docs/assistant-mechanism-consolidation-2026-10-22.md); its proposed changes require implementation evidence before being reported as deployed.

## Proportional changes

- **Documentation only:** change the relevant rules/records, inspect the diff, check changed Markdown and run `npm run docs:check` once after the final document edits. No application build, browser checkpoint, TDD or full code review is required.
- **Presentation only:** wording, accessible labels or styling without changing operations, navigation, state, permissions, APIs, stored data or domain meaning. Use the smallest diff on the authorized branch. No new Ticket, parity table, red-green test, full Standards/Spec review or broad suite is needed solely for changing frontend files. Inspect affected occurrences; run frontend typecheck for TS/TSX and one focused browser check when available. An actual checkpoint Web rebuild counts as the build check. Update existing wording assertions only when affected; report unrelated fixture failures without expanding the task.
- **Behavior changes:** use the Ticket protocol below. A known, localized bug needs a focused reproduction/regression and affected checks; the full diagnostic loop is reserved for an unclear cause, intermittent failure or complex regression. Do not create a new Ticket solely to fix an already authorized localized bug.
- Choose validation by the affected behavior and risk. Reuse successful checks for unchanged inputs; rerun only checks invalidated by later changes. Full repository suites require a concrete remaining risk or an explicit gate. Ordinary Owner acceptance alone is not such a reason.
- Reuse the existing Owner checkpoint and its data. Rebuild only changed services; a documentation-only edit leaves the running environment unchanged. Update current normative terminology only when its meaning or display contract changes; preserve historical PRDs and frozen prototypes.

### Frontend prototype parity

For behavior-changing frontend Tickets, compare the affected screen with its applicable frozen prototype plus recorded Owner-approved amendments. Record only the affected fields, control order, labels, states and exclusions in a compact Ticket note; reuse an existing comparison when still valid. Match `frontend-v1/` typography, tokens, icons, density and suitable components. Do not introduce a different visual style through a design skill.

Check the affected page through a focused browser flow when available, including relevant empty/error states and narrow-window behavior. Never claim a browser check passed when unavailable. Do not expose future operations through fake routes, placeholder pages or hidden wider APIs. Public APIs must implement the current approved contract, with permissions enforced server-side.

## Agent skills

Use Skills whose scope matches the task; explaining a term or editing a rule is not an implementation task. Load a relevant Skill once and reuse it until its instructions change. Project scope, explicit user decisions and safety constraints take precedence over generic Skill workflows.

- Local issues/specs: [issue tracker](docs/agents/issue-tracker.md).
- Eligibility labels: [triage labels](docs/agents/triage-labels.md).
- Domain vocabulary and ADR use: [domain docs](docs/agents/domain.md).

## Phase 1A ticket execution protocol

This protocol also applies to later behavior-changing Tickets, with their current Spec and batch rules. A ready label indicates eligibility, not authorization; check dependencies and any active Owner hold.

### Required skill pair

Use `implement` and `ponytail full` for authorized behavior-changing Ticket implementation. If unavailable, identify the missing Skill; do not pretend to have followed it. This pair does not trigger for documentation/presentation-only follow-ups. Minimalism must preserve accepted requirements, permissions, validation at trust boundaries, data-loss protection and accessibility.

### Implementation and validation

1. Establish the baseline, approved scope and branch once. Test boundaries already defined by the approved Ticket/Spec are agreed; choose routine tests at existing public interfaces without another confirmation. Ask only about an unresolved material change in product contract, data use, permissions or cost. Preserve overlapping user changes and resolve ambiguous ownership before editing them.
2. Implement one observable behavior at a time using red → green checks for new logic or meaningful regressions. Refactor within the same proven behavior when necessary. Trace affected callers; inventory routes only when their public contracts actually change. Keep unrelated cleanup and future capabilities out of the diff.
3. Validate the affected normal path, applicable critical failure/boundary paths and relevant static/build/document checks. Migration, shared security, publication, deletion, parser or cutover changes require evidence for those risks, not an automatic full-suite run.
4. Review the final implementation diff once for Standards and Spec using `code-review`, including uncommitted changes when reviewing before commit. Apply the bounded risk matrix in [Ticket review protocol](docs/agents/ticket-review-protocol.md) to that same review when needed. Fix P0/P1 findings; recheck their regression and directly affected behavior. Do not repeat a complete review just because HEAD changes through a documentation commit.
5. Commit only this task's intended files on the authorized branch after necessary checks pass. Update the current Ticket/ledger when lifecycle state changes. Store detailed commands, baseline, code SHA, findings and results once in a Ticket or evidence record; other records link to it. A separate progress-only commit is optional.
6. Report the result, relevant checks/limits, commit and checkpoint instructions briefly. Continue within an already authorized Ticket batch when dependencies permit; stop at an agreed checkpoint or the end of authorized scope. A single-Ticket instruction authorizes only that Ticket. Acceptance alone does not grant new scope.

### Owner browser checkpoint environment

- Follow the current Spec's agreed checkpoint batches. For incremental storage, see [Test Plan §H.3](docs/test-plan-phase1a.md#h3-切换与验收规则). Intermediate Tickets in an authorized batch can continue with automated evidence; do not request the same authorization per Ticket.
- Keep checkpoints isolated from production and other projects. Reuse the designated Owner environment; create new resources only when isolation requires them. Check exact Compose project, paths, networks, database, bucket and port before changing resources. Bind Web to loopback unless an alternative access path is explicitly authorized.
- Build changed services at a fixed code commit. Verify their code identity, `/health`, `/health/ready` and one frontend request to the intended backend. Unchanged services may retain their recorded code SHA; a later documentation-only HEAD does not require rebuilding them. Do not claim readiness when a prerequisite failed.
- Keep setup small and understandable: normally one synthetic acceptance project and two accounts (administrator and edit role). Preserve existing Owner-created projects, accounts and data; this default limits new fixtures, not existing user data. Extra test identities/resources must be temporary and isolated. Provide the URL/tunnel and short acceptance steps, with automated-only claims identified.
- After explicit acceptance, record the accepted code SHA and result. Release resources known to be exclusive and disposable for that batch, after verifying their identities and preserving evidence. Shared/reused Owner environments and user data are retained. Stopping compute is separate from deleting databases, volumes, buckets or files; acceptance is not blanket deletion authorization. If resource ownership or disposability is unclear, retain it and report the issue.
- Backend-only changes need targeted runtime verification when required by the checkpoint, not invented browser assertions. Documentation-only work has no runtime checkpoint.

## Editing rules

- Write Markdown in UTF-8 and use the current Chinese product terminology. Keep each requirement in one authoritative place and link supporting evidence.
- Preserve confirmed scope and frozen history unless explicitly changed. Do not access or modify other server projects. Keep credentials out of logs, reports and commits; use only the data and environments authorized for the task.
- When the main flow changes, keep the first Mermaid block in `docs/system-flow-v2.md` identical to `docs/system-flow-v2.mmd`, then regenerate its PNG. Do not regenerate diagrams for unrelated changes.

## Validation

Check changed Markdown links, tables and fences; parse changed JSON examples; render changed Mermaid diagrams. Run document/lifecycle validation once for the final affected document set. Regenerate the main diagram only when changed:

`npx -y @mermaid-js/mermaid-cli@11.12.0 -i docs/system-flow-v2.mmd -o docs/system-flow-v2.png -b white -w 5600 -H 1800 -s 1`

For actual checkpoint builds, set `GIT_SHA` to the fixed code commit and verify deployed identity as above. Ignored `dist/`, `playwright-report/` and `test-results/` alone are not progress or deployment evidence.
