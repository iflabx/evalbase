# Ticket review protocol

Use this protocol when reviewing an implementation Ticket, rechecking named findings, or deciding whether a higher-risk Ticket needs a fixed-HEAD closure review. It complements the risk-based validation rule in `AGENTS.md`; it does not require every Ticket to repeat a complete repository audit.

## Default review

Every implementation Ticket receives one bounded review of its final diff on two axes:

- **Standards:** repository instructions, scope discipline, public seam, test quality, maintainability, data/environment restrictions, and accidental future work.
- **Spec:** the current Ticket's applicable acceptance criteria and Definition of Done plus the governing PRD, `CONTEXT.md`, architecture, ADR and Implementation Spec clauses directly affected by the diff.

The reviewer fixes or reports every P0/P1 finding. The evidence set is proportional to the change: directly affected normal behavior, one applicable critical failure/boundary behavior, and affected static/build/document checks. A green unrelated suite is not evidence for the Ticket, and an intentionally omitted broad suite is not automatically a failure.

After the local implementation commit, follow the [Owner browser checkpoint environment](../../AGENTS.md#owner-browser-checkpoint-environment) before collecting Owner acceptance. The review validates the fixed diff; the checkpoint proves the Owner is using that fixed frontend/backend pair.

## Targeted Recheck

After an authorized repair, recheck the named finding, its regression test, and direct adjacent behavior. Do not restart a wider audit unless the repair changed a public contract, crossed another module, or exposed an authoritative conflict.

The permitted conclusion is:

> Targeted findings closed at `<HEAD>`; no new review scope was introduced.

List any residual P2 risk and any broader suite not run.

## When Closure Review is required

Run a fixed-HEAD Ticket Closure Review only when at least one condition applies:

- the Ticket changes a database migration or persistence contract;
- it changes shared authentication, authorization or a security boundary;
- it changes publication, version-label allocation, immutable history or Controlled Deletion;
- it changes a shared parser, canonical artifact, package or validator contract;
- it performs the formal frontend/deployment cutover;
- it is part of a formal release or Owner acceptance;
- the Project Owner explicitly requests a complete review.

Ordinary localized UI, copy, isolated API, test or internal refactor Tickets do not need a second Closure Review after their Standards/Spec review.

## Bounded closure matrix

For a triggered Closure Review, freeze the `HEAD` and map only the Ticket's affected surface:

- applicable Ticket AC/DoD and directly governing authoritative clauses;
- public success behavior and stable error behavior;
- applicable validation, authorization, retry, cancellation, persistence or failure paths;
- concurrency orders only at boundaries the Ticket changes;
- capacity/resource boundaries only when the Ticket claims or changes them;
- direct interaction with already implemented features sharing the changed seam;
- Ticket lifecycle comments, progress evidence and deployment identity affected by completion.

Do not automatically reopen every historical Ticket, enumerate unrelated concurrency orders, or run the full repository suite. Record uncovered or untestable claims and the reason rather than inferring them from green tests.

## Closure sequence

1. Record fixed `HEAD`, baseline, changed files, Ticket/Spec references and the bounded matrix.
2. Review without editing and publish one findings list ordered P0, P1, P2 with file/line evidence and the smallest remedy.
3. Apply authorized P0/P1 repairs as one bounded batch.
4. Run the repaired behavior's regression test and affected validation; expand only if the repair materially changes another seam.
5. If `HEAD` changes, record the new fixed `HEAD` and recheck the same bounded matrix.
6. Record accepted P2 findings, residual risks, untested claims, omitted broad suites and the closure conclusion.

Use **`Ticket Closure Review P0/P1 cleared at <HEAD>`** only when every bounded matrix item has a recorded result and all P0/P1 findings are closed. Otherwise report **Failed** or **Blocked** with the open items. A later material change to an affected seam invalidates the conclusion; unrelated commits do not require repeating the review.
