# Issue tracker: GitHub Issues

GitHub Issues is the source of truth for proposed work, specs, implementation progress, blockers, discussion, and acceptance status. Repository Markdown only records durable current contracts that must evolve with the code. Use the `gh` CLI for all tracker operations; infer the repository from `git remote -v`.

## Conventions

- One independently closable outcome per issue.
- Put the current scope, constraints, acceptance criteria, and dependencies in the issue body.
- Put investigation, decisions, evidence summaries, and changed assumptions in issue comments; do not maintain a second local status copy.
- Use a parent issue for a larger spec and linked child issues for independently deliverable work.
- Use GitHub Projects or milestones for ordering and progress across issues.
- Apply the triage labels defined in `triage-labels.md`.
- Close an issue only after its acceptance criteria have evidence. Link the implementation commit and any resulting ADR from the closing comment.

## GitHub operations

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. Write multi-line bodies to a file with actual newlines.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate `--label` and `--state` filters.
- **Link a sub-issue**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. If sub-issues are unavailable, use a task list in the parent and `Part of #<parent>` at the top of the child body.
- **Comment on an issue**: `gh issue comment <number> --body-file <file>`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close an issue**: `gh issue close <number>` after posting the acceptance evidence.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. Resolve a bare `#42` with `gh pr view 42` and fall back to `gh issue view 42`.

## Repository boundary

- `GLOSSARY.md` contains only the current domain glossary.
- `docs/product-foundation.md` and maintained guides contain current product contracts.
- `docs/adr/` contains concise current architectural decisions and their rationale, not implementation progress or experiment transcripts.
- GitHub Issues contain work with a lifecycle: proposals, research, tasks, bugs, migrations, and acceptance.
- Raw traces, screenshots, generated reports, and large evidence bundles belong in CI artifacts or a local archive; issues contain their conclusion and a link.
- `.scratch/` is a local historical archive and is not an active tracker or source of truth.

## Publishing and fetching

When asked to publish or fetch an issue, use the repository's GitHub issue tracker. If GitHub access or the repository remote is unavailable, report the operation as blocked instead of creating a replacement file under `.scratch/`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Create it with `gh issue create --label wayfinder:map --title "..." --body-file <file>`.
- **Child ticket**: link it to the map as a sub-issue using the operation above. Labels are `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, assign it to the driving developer.
- **Blocking**: use GitHub's native issue dependencies: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the numeric database ID with `gh api repos/<owner>/<repo>/issues/<number> --jq .id`; issue numbers and node IDs are not database IDs. `issue_dependencies_summary.blocked_by` counts open blockers. If dependencies are unavailable, use `Blocked by: #<number>, #<number>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, using its sub-issues or task list. Drop assigned tickets and tickets with open blockers; choose the first remaining ticket in map order.
- **Claim**: `gh issue edit <number> --add-assignee @me`, the session's first tracker write.
- **Resolve**: post the answer with `gh issue comment <number> --body-file <file>`, close the issue, then append a context pointer (gist + link) to the map's Decisions-so-far.
