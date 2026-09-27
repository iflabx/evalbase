# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Never combine all implementation tickets into one file
- Triage state is recorded as a `Status:` line near the top of each spec or issue file
- Implementation lifecycle is recorded separately as an `Implementation:` line (`not-started`, `in-progress`, or `completed`); do not infer completion from `Status:`. A Ticket returned from Owner checkpoint uses `in-progress` until the corrected fixed HEAD is accepted.
- Blocking edges are recorded as a `Blocked by:` line in each ticket
- Comments and conversation history append under a `## Comments` heading
- Completion uses an implementation commit, the P0/P1-cleared [Ticket Closure Review](ticket-review-protocol.md), then a progress-record commit that can reference the already-existing implementation SHA without a circular self-reference

## When a skill says "publish to the issue tracker"

Create the corresponding file under `.scratch/<feature-slug>/`, creating the directory when needed.

## When a skill says "fetch the relevant ticket"

Read the referenced Markdown file in full. The user will normally provide its path or ticket number.

## Workflow

- `/to-spec` writes `.scratch/<feature-slug>/spec.md`
- `/to-tickets` writes one numbered file per approved tracer-bullet ticket
- `/implement` reads the referenced spec or ticket, implements it, validates it, reviews it, and commits the implementation to the current branch
