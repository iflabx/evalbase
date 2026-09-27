# Domain Docs

How engineering skills consume this repository's domain documentation.

## Before exploring

- Read the root `CONTEXT.md`.
- Read ADRs under `docs/adr/` that affect the area being changed.
- If `docs/adr/` does not exist or contains no relevant ADR, proceed silently.

## Layout

This is a single-context repository:

- `CONTEXT.md` is the only domain glossary.
- `docs/adr/` contains qualifying system-wide technical decisions.
- Do not create `CONTEXT-MAP.md` or additional context glossaries unless the repository is deliberately reconfigured as a multi-context system.

## Use the glossary vocabulary

Use the canonical terms defined in `CONTEXT.md` in specs, tickets, code, tests, and reviews. Avoid synonyms explicitly listed under `_Avoid_`.

If a required concept is missing, reconsider whether a new term is necessary. Use `/domain-modeling` when a genuine domain meaning needs to be resolved.

## ADR threshold

Create an ADR only when the decision is:

1. Hard to reverse
2. Surprising without context
3. The result of a real trade-off

Surface conflicts with an existing ADR instead of silently overriding it.
