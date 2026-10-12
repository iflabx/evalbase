# Ticket review protocol

Use this protocol for behavior-changing implementation reviews and targeted rechecks. Documentation and presentation-only changes use [Proportional changes](../../AGENTS.md#proportional-changes). Owner acceptance alone does not require another review or a full suite.

## Default review

Review the final affected diff once on two axes:

- **Standards:** applicable repository rules, scope, public boundaries, meaningful tests, maintainability and data/environment restrictions.
- **Spec:** the current Ticket's AC/DoD and only the governing PRD, glossary, architecture, ADR and Spec clauses affected by the diff.

Pin the baseline and review target. Before commit, include the intended working-tree and staged changes plus relevant new files; `base...HEAD` alone misses them. Preserve unrelated changes. A committed target uses a fixed HEAD; if code is unchanged by a later docs-only commit, carry the evidence forward and record both identities.

Validate affected normal behavior, applicable critical failure/boundary paths and relevant static/build/document checks. Fix P0/P1 before completion. Do not repeat tooling-enforced checks manually or infer coverage from an unrelated green suite. Record detailed evidence once; Ticket/ledger entries link to it.

## Targeted Recheck

After an authorized repair, recheck the named finding, its regression and directly adjacent behavior. Reuse evidence for unchanged surfaces. Expand only when the repair changes another public contract or reveals a concrete additional risk. Report unresolved findings and material limits; do not restart the whole audit for a new commit SHA alone.

## When Closure Review is required

Use the bounded closure matrix below **within the same Standards/Spec review** for:

- database migrations or persistence contracts;
- shared authentication, authorization or security boundaries;
- publication, version allocation, immutable history or permanent deletion;
- shared parsers, canonical artifacts, packages or validators;
- formal deployment cutover or release integration with changed dependencies/code;
- a complete review explicitly requested by the Owner.

An already adequate review at the same code content satisfies this gate. Ordinary checkpoints and document/status commits do not trigger a second independent review.

## Bounded closure matrix

Cover only affected AC/DoD and contracts: success and stable errors; permissions and trust boundaries; retry/cancellation/failure/persistence; changed concurrency or capacity boundaries; direct interaction with existing features sharing the seam; relevant lifecycle evidence and deployment identity.

Do not reopen historical Tickets or enumerate unrelated concurrency orders. Explain uncovered material claims rather than running unrelated suites to fill a checklist.

## Closure sequence

1. Record baseline, target code identity, changed files and applicable matrix items in the existing review evidence.
2. Report findings with severity, file/line evidence and the smallest remedy. Preserve the Standards/Spec distinction while identifying blockers clearly.
3. Apply authorized repairs and run only invalidated checks. Map prior evidence to unchanged items rather than rerunning them.
4. Record the final code identity, resolved and residual findings, material untested claims and conclusion. Link this record from lifecycle documents as needed.

Use **`Ticket Closure Review P0/P1 cleared at <HEAD>`** only when every applicable item has evidence and P0/P1 findings are closed. Otherwise name the open items and report Failed or Blocked. A later material change invalidates only its affected evidence.

The [Owner browser checkpoint](../../AGENTS.md#owner-browser-checkpoint-environment) verifies the deployed code identity and Owner workflow; it is not a duplicate code review or permission to delete retained data.
