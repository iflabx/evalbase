---
name: diagnosing-bugs
description: Diagnose bugs with an unclear cause, intermittent failures or complex performance regressions. Use when explicitly requested. An obvious localized defect can use the quick path without a full diagnostic workflow.
---

# Diagnosing Bugs

## Pick the necessary depth

- **Quick path:** inspect the affected code/logs and callers, establish the reported symptom, fix the identified cause when authorized, and run a focused regression plus affected checks. Stop when sufficient evidence exists.
- **Full path:** use the steps below when the cause is unknown or the failure is intermittent/complex. Skip steps already answered by reliable evidence; do not manufacture hypotheses or a harness to complete a ritual.
- Read only relevant glossary/ADR clauses when semantics or technical constraints matter; reuse unchanged context. Read-only diagnosis does not authorize code edits or instrumentation.

## Protect data and resources

Redact credentials and sensitive payloads from logs and reports. Use isolated authorized fixtures. Choose bounded request count, concurrency and timeout before repeats; begin with the smallest useful load. Do not automatically run 100 retries, parallel stress, production instrumentation or destructive replays. Escalate load only within an authorized environment/resource budget; ask only for genuinely missing authorization.

## 1. Establish evidence

Read code and available logs to identify the flow. Prefer a focused failing test, API/CLI call, browser flow or isolated trace replay that detects the user's symptom. Reuse existing harnesses before creating one. Pin inputs/time/seeds where useful.

If live reproduction is unavailable, continue with safe static inspection and existing traces. Distinguish confirmed causes from hypotheses. Request only the missing evidence needed to progress; inability to build a loop is not itself a reason to stop all analysis.

## 2. Narrow the cause

Reduce a reproduction only until it distinguishes plausible causes. Do not prove every remaining input is indispensable. State testable hypotheses when multiple causes remain; use as many as the evidence warrants. Share meaningful findings without requiring approval at each step.

## 3. Test the hypothesis

Probe the boundary that distinguishes the hypotheses, changing one relevant variable at a time. Prefer debugger/REPL or targeted logs; never log everything. Tag temporary instrumentation for cleanup. For performance, measure the relevant baseline before fixing; choose bounded samples, not a fixed stress recipe.

## 4. Fix and verify

When repair is authorized, reproduce the failure through a meaningful public seam where feasible, apply the smallest root-cause fix and verify the corrected behavior and direct adjacent risk. Existing Ticket/Spec test boundaries are already agreed; routine regression selection needs no new confirmation. If a reliable automated seam is unavailable, record the limitation and use the strongest available direct check without claiming full coverage.

## 5. Finish

Remove only this task's temporary instrumentation and disposable fixtures. Reuse successful verification of unchanged behavior; do not rerun the same loop solely to satisfy another checklist. Report the cause, fix or recommendation, evidence and material remaining uncertainty.
