---
name: smrt-contribute
description: Use when working in a fork or clone of the happyvertical/smrt repository as an outside contributor, for example "fix a bug in smrt-jobs and open a PR", "contribute this change upstream", or "add docs to smrt-core". Gives the fork pull-request procedure from CONTRIBUTING.md and the traps that fail from outside (package-name test filters, format then lint, generated knowledge pages, PR title length, no changesets, fork CI approval). Do not use in a project that merely depends on smrt packages (use smrt-catalog), or in a maintainer session where the control-plane skills (implement, claim-issue, review-cycle, ship) are installed.
---

# SMRT Contribute

Procedure for contributing to `happyvertical/smrt` from a fork or clone. It
is `CONTRIBUTING.md` as steps. The maintainer lifecycle in
`AGENTS.md` (claim labels, dispatch labels, patch trains, `hv-agent-run`
blocks, `implement`, `review-cycle`) does not apply to you: you cannot claim
issues and the skills live in a private repository. Do not try to load them.

You submit the PR, so read and understand every line of it before opening it.

## Procedure

1. **Scope.** One concern per PR. For anything bigger than a focused bug fix,
   or for changes to core decorators, the scanner or schema generation,
   dependencies, new packages, or `.github/`, open or comment on an issue first.
2. **Orient.** Read `AGENTS.md` and the affected package's `AGENTS.md`
   (non-obvious invariants and extra checks). Use Node and pnpm versions from
   `package.json`.
3. **Setup.** `pnpm install` then `pnpm build`; packages consume each other's
   built output, so build once in a fresh clone.
4. **Branch** in your fork, off `main`. Target `main` with the PR.
5. **Change.** Add a regression test for a bug fix and tests for new behaviour
   (`TESTING_STANDARD.md`). Update the package README for user-facing behaviour.
6. **Test by package name:** `pnpm --filter @happyvertical/smrt-jobs test`.
   Directories under `packages/` drop the `smrt-` prefix, and a filter that
   matches no package exits 0 having run nothing. Confirm tests actually ran.
7. **Format, then lint:** `pnpm format` then `pnpm lint`.
8. **Generated pages.** When a package manifest, an `AGENTS.md`, an intent or a
   playbook changed, run `pnpm knowledge:check --strict --format markdown` and
   `pnpm knowledge:okf`, and commit the regenerated pages (they are checked in).
   Keep root `AGENTS.md` chain under the 32 KB cap: `pnpm check:agents-chain`.
9. **Commit** with conventional commits (`fix(core): preserve tenant scope`).
   Never author `.changeset/*.md`; release automation writes them.
10. **Open the PR** against `main`. Title: conventional form, at most 92
    characters (the squash appends ` (#N)` and the commit header limit is 100).

## Never

- `--no-verify`, skipping a hook, disabling a gate, or pinning around a failure.
  If a documented command cannot run as documented, say so in the PR instead
  of working around it.
- Touching `.github/`. The **Fork Workflow Change Guard** fails any fork PR
  that changes it; a maintainer re-lands such changes from the main repository.
- Claiming issues, adding claim or dispatch labels, or adding `hv-agent-run`
  blocks.

## CI on a fork PR

- A maintainer must approve your workflow runs (**Fork PR Validation**,
  **Pull Request Validation**, **PostgreSQL Tests**) before they execute.
- Until a maintainer approves your head commit, `Required CI` and
  `postgres-required` wait for that run approval or fail with "awaiting
  maintainer approval". That is expected; do not try to fix it.
- A maintainer applies `ci: fork-approved` after reviewing and approving the
  head commit. A new push removes the label and needs a fresh approval.
- If a maintainer's approval was refused, they must remove and re-add the
  label; re-adding a label that is already present fires no event.

## PR description

Include:

- the behaviour change (what and why);
- how it was validated (commands run, with results);
- which package `AGENTS.md` invariants it touches, or "none".

## Upstream gaps found from a consumer project

If you arrived here because a consumer project needed behaviour an smrt package
lacks, link the originating issue or use case in the PR description.
