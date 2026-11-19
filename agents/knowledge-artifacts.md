# Knowledge artifacts

Before adding a helper, read the [intent index](docs/knowledge/intents/index.md) and run
`smrt-dev-mcp review --directory <pkg> --format summary`. Capabilities belong in
the owning package or SDK, never a downstream helper.

`smrt knowledge:review-context` / `knowledge:architecture-context` provide
scoped summaries; read the selected references on demand. Runtime manifests
remain separate from `.smrt/smrt-knowledge.json` / `dist/smrt-knowledge.json`
agent artifacts. `smrt docs:agents` exports snapshots to consumer projects.
Knowledge freshness is enforced by CI/hooks and artifact consumers; `smrt doctor`
is diagnostic, not an enforcement prerequisite. See
[standards](docs/content/standards.md) for artifact vocabulary, including
**generation snapshot** for the proposed immutable provenance bundle.
