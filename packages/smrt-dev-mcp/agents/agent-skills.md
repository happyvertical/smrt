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
- `skills/smrt-ai-work/SKILL.md` — AI work skill (#5005). Asked to add AI work it produces a registered prompt
  (`definePrompt`), a tracked call carrying its prompt key (`createTrackedAiClient` + `trackedPromptCall`) and, for
  multi-step work, a `smrt-workflows` definition; it states the handler job contract and explains runs, events,
  trajectories, evaluations, tiers, latency, effort, budgets and fusions from the AI runs page and the package
  notes. `smrt-catalog` routes AI requests to it. It is served by `get-agent-skill` and shipped in the plugin; `docs:agents`
  does not install it (only catalog and contribute). When the vocabulary in `ai-runs.md` changes, edit the skill. It cites
  only what a consuming project reaches: docs site pages (`https://happyvertical.github.io/smrt/<page>`), files under
  `node_modules/@happyvertical/<package>/` that the package's `files` ships, and `.agents/smrt-knowledge/`; the test
  checks each one, and refuses a monorepo path. Trigger evals: `skills/smrt-ai-work/evals.json`.
