---
name: implement
description: "Implement an authorized feature or behavior-changing Ticket from an approved spec. Do not apply the full workflow to documentation, presentation-only edits, explanations or read-only audits."
---

# Implement

1. Apply the repository's proportional-change rules first. Reuse the authorized feature/batch branch and already-established scope; prior explicit authorization remains valid within that scope.
2. Read the current Ticket and relevant governing clauses, reusing unchanged context. Implement the accepted behavior with the smallest complete change; do not reduce requirements to save effort.
3. Use TDD for new logic and meaningful regressions at existing or already-approved public boundaries. Choose routine seams independently; ask only when a material contract or cost is unresolved.
4. Run checks covering the affected behavior and risk. Reuse results until their inputs change. No automatic full-suite run, periodic unrelated typechecks or duplicate build/review merely because this Skill is active.
5. For behavior-changing work, use one Standards/Spec review of the actual final diff, including uncommitted work when appropriate. Fold any required risk matrix into that pass; repairs receive targeted rechecks.
6. Make a local commit only on the permitted branch and with this task's files after necessary checks pass. Follow repository lifecycle/checkpoint rules. Merge, push, tag and deploy only when explicitly authorized; do not ask again for the same authorized action.

Preserve user changes, permission checks, data-loss protection, credentials and environment isolation. Stop at the end of authorized scope or an agreed checkpoint, not at an arbitrary Skill phase.
