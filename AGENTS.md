## Repository guide

### Issue tracker

Issues, specs, implementation progress, and acceptance status are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Product baseline

Before planning or implementing V1, read `GLOSSARY.md`, `docs/product-foundation.md`, and the current GitHub issue. Repository documents define the current product and architectural contract; the issue defines the work and its acceptance state.

### Workflow

1. The **lead** works with the maintainer to define the change. For bugs, reproduce the reported symptom with a repeatable check. Open or identify the GitHub issue before changing code, review the plan against its acceptance criteria, and hand the issue to a separate implementation session.
2. The **implementer** works in a dedicated Git worktree, references the issue in commits, and reports the branch and verification results to the lead.
3. The lead checks the result against the issue’s acceptance criteria, repeats the original check for a bug, and runs `npm run check` and `npm run test:unit`. Once the checks pass and the criteria are met, the lead merges the branch and closes the issue with evidence.
