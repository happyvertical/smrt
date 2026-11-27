# Knowledge artifacts

Before adding a helper, read the [intent index](docs/knowledge/intents/index.md) and run
`smrt-dev-mcp review --directory <pkg> --format summary`. Capabilities belong in
the owning package or SDK, never a downstream helper: add it there or file a framework issue.

Generated OKF pages under `docs/knowledge/components/` (and `docs/knowledge/index.md`)
are regenerated after merge to main via the rolling `chore/knowledge-regenerate`
PR (workflow `knowledge-regenerate.yml`); do not run `pnpm knowledge:okf` or commit
them in a PR (#5705). `check-generated-knowledge-untouched.mjs` fails a PR that
does; restore with `git restore --source="$(git merge-base origin/main HEAD)" --staged --worktree -- docs/knowledge/components docs/knowledge/index.md`.
`knowledge:check --strict` gates hand-written pages and generation inputs;
`--generated` also compares generated pages locally. Hand-written pages
(`intents/`, `solutions/`, `maintenance.md`) stay in PRs.

`smrt knowledge:review-context` / `knowledge:architecture-context` provide
scoped summaries; read the selected references on demand. Runtime manifests
remain separate from `.smrt/smrt-knowledge.json` / `dist/smrt-knowledge.json`
agent artifacts. `smrt docs:agents` exports snapshots to consumer projects.
Knowledge freshness is enforced by CI/hooks and artifact consumers; `smrt doctor`
is diagnostic, not an enforcement prerequisite. See
[standards](docs/content/standards.md) for artifact vocabulary, including
**generation snapshot** for the proposed immutable provenance bundle.
