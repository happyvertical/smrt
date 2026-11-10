# Agent skills: catalog and contribute

- `skills/smrt-catalog/SKILL.md` — router skill (#4708). Fires before infrastructure, utility, or integration
  code in a project that depends on smrt packages; reads `.agents/smrt-knowledge/intents/index.md`, the intent
  page, then the component page, proposes the smrt package and entry point before code, falls back to
  `build-context` when the bundle is missing or stale, and drafts an upstream issue plus a marked temporary shim
  when the home package lacks the behaviour. The description is the design: `skills/smrt-catalog/evals.json`
  holds the positive/negative trigger prompts and `src/agent-skills.test.ts` asserts every positive signal class
  is named. `smrt docs:agents` installs it into consumers (`./agent-skills` export: `getAgentSkill`,
  `getAgentSkillsPackageVersion`).
- `skills/smrt-contribute/SKILL.md` — contributor skill (#4709): `CONTRIBUTING.md` as a fork-PR procedure with the
  traps that fail from outside (package-name test filter, format then lint, generated knowledge pages, PR title
  ≤92, no changesets, `.github/` guard, fork CI approval). It deliberately omits the maintainer lifecycle.
  The repository root checks in an identical copy at `.agents/skills/smrt-contribute/SKILL.md` so a harness
  opening a checkout finds it without the MCP server; `src/agent-skills.test.ts` fails when they drift, so edit
  both together. Trigger evals: `skills/smrt-contribute/evals.json`.
