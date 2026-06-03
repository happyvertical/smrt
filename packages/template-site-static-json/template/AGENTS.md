# SMRT Static JSON Site

This project uses SMRT configuration and generated local data for a static site.
If SMRT objects are added, enable the SMRT Vite plugin so local knowledge
artifacts are generated in `.smrt/smrt-knowledge.json`.

## Agent Workflow

- Treat `AGENTS.md` as the canonical project guidance file.
- Keep `CLAUDE.md` as the one-line `@AGENTS.md` shim.
- Use `smrt knowledge:architecture-context --format markdown` or the
  `build-domain-architecture-context` MCP tool when adding SMRT packages.
- Use `knowledge: { tags, summary, risks }` on domain objects that need
  package-specific review guidance.

## Safety

- Do not expose `/__smrt/knowledge` HTTP routes in production without explicit
  admin auth.
- Keep generated data and `.smrt` artifacts out of source control unless the
  project intentionally publishes a package artifact.
