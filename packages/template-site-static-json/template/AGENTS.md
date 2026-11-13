# SMRT Static JSON Site

<!-- smrt:agents:begin -->
## smrt framework

- Framework reference: `.agents/smrt-framework.md`
- Intent index: `.agents/smrt-knowledge/intents/index.md`
- Data shape rules (what smrt requires of a field, how to harden a smrt class in this app): the "Data shape rules" section of the framework reference.
- Before adding infrastructure, utility or integration code, read the intent index.
- If smrt has the home package but lacks the behaviour, or lacks it entirely, file an issue on happyvertical/smrt and mark any local shim temporary: framework first, no glue.
- Refresh this block and the references: `smrt docs:agents`.
- Check for duplicated capability: `smrt-dev-mcp review --directory . --format summary`.

_Generated; edit outside the markers only. Text between them is replaced on refresh._
<!-- smrt:agents:end -->

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
