## Agent skills

### Issue tracker

Issues, specs, implementation progress, and acceptance status are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Product baseline

Before planning or implementing V1, read `GLOSSARY.md`, `docs/product-foundation.md`, and the current GitHub issue. Repository documents define the current product and architectural contract; the issue defines the work and its acceptance state.

### Workflow

Every bug or change starts as a GitHub issue before any code; commits reference it.

The session talking with the maintainer is the **lead**. It confirms bugs (`diagnosing-bugs`: a loop that goes red on the exact reported symptom), files the issue, grills the plan, and accepts the result. It hands implementation to a new session in its own worktree (model `claude-haiku-5-5`, effort `xhigh`) whose brief is to run `/mattpocock-skills:implement` on the issue. When that session reports back, the lead re-runs the bug's loop, `npm run check` and `npm run test:unit` against the issue's acceptance criteria, merges the branch, and closes the issue with evidence.

A session whose brief says to implement an issue is the **implementer**: it commits on its worktree branch and reports back; merging belongs to the lead.
