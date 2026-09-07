# Contributing to SMRT

Read [AGENTS.md](AGENTS.md), the affected package's AGENTS, and
[WORKFLOW.md](WORKFLOW.md) before starting. The shared workflow owns tracking,
claims, review, and shipping; this guide covers repository setup.

## Setup

Use Node >=24.18.0 and pnpm >=11.13.1, as specified by `package.json`.
The floor excludes 11.13.0 deliberately: pnpm's own `BROKEN_RELEASES` list
rejects that version, so every command in this repository fails closed on it.
Git and GitHub CLI are needed for contribution management.

```bash
git clone https://github.com/happyvertical/smrt.git
cd smrt
pnpm install
pnpm build
```

Workspace packages consume built artifacts. Build before running checks in a
fresh checkout. Run the narrow package commands documented in its AGENTS,
then the applicable root checks listed in root AGENTS.

## Changes and validation

- Find or create an issue with a reproduction or acceptance criteria. Keep
  changes focused; use the shared workflow's patch-train rules when applicable.
- Use TypeScript, ESM, and the repository Biome configuration. Run `pnpm format`
  to format and `pnpm format-check` to verify. Public APIs need accurate types.
- Follow [TESTING_STANDARD.md](TESTING_STANDARD.md), including real-resource
  tests, bug regressions, README example coverage, full touched-package suites,
  and maintained browser harnesses where applicable.
- Update user-facing API guidance in package README files and non-obvious
  maintainer constraints in AGENTS or its linked module references. CLAUDE files
  are compatibility adapters, not an editing destination.
- Preserve distinct invariants; remove duplicate explanations and obsolete
  history. Prefer a source/test pointer to restating implementation details.
- Use conventional commits such as `fix(core): preserve tenant scope`.
  Reference issues with `Refs #N` in commits; declare intended closing issues
  in the PR body. Do not manually create changesets; release automation does it.

## Review and help

Prepare a ready-for-review PR with the concrete behavior change, validation,
and any remaining limitations. Address actionable feedback through the shared
workflow. Do not merge without authorization.

Use [issues](https://github.com/happyvertical/smrt/issues) for bugs and proposals,
and [discussions](https://github.com/happyvertical/smrt/discussions) for questions.
Be constructive and respectful. Contributions are licensed under MIT.
