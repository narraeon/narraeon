# Issue tracker: GitHub Issues

GitHub Issues is the source of truth for proposed work, specs, implementation progress, blockers, discussion, and acceptance status. Repository Markdown only records durable current contracts that must evolve with the code.

## Conventions

- One independently closable outcome per issue.
- Put the current scope, constraints, acceptance criteria, and dependencies in the issue body.
- Put investigation, decisions, evidence summaries, and changed assumptions in issue comments; do not maintain a second local status copy.
- Use a parent issue for a larger spec and linked child issues for independently deliverable work.
- Use GitHub Projects or milestones for ordering and progress across issues.
- Apply the triage labels defined in `triage-labels.md`.
- Close an issue only after its acceptance criteria have evidence. Link the implementation commit and any resulting ADR from the closing comment.

## Repository boundary

- `CONTEXT.md` contains only the current domain glossary.
- `docs/product-foundation.md` and maintained guides contain current product contracts.
- `docs/adr/` contains concise current architectural decisions and their rationale, not implementation progress or experiment transcripts.
- GitHub Issues contain work with a lifecycle: proposals, research, tasks, bugs, migrations, and acceptance.
- Raw traces, screenshots, generated reports, and large evidence bundles belong in CI artifacts or a local archive; issues contain their conclusion and a link.
- `.scratch/` is a local historical archive and is not an active tracker or source of truth.

## Publishing and fetching

When asked to publish or fetch an issue, use the repository's GitHub issue tracker. If GitHub access or the repository remote is unavailable, report the operation as blocked instead of creating a replacement file under `.scratch/`.
