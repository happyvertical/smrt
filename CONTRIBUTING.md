# Contributing to SMRT

Thanks for trying the framework. Feedback is the most useful contribution right
now: if something on [s-m-r-t.dev](https://s-m-r-t.dev) confused you, broke,
or took longer than it should have, tell us.

## Ways to help

- **Questions, first impressions, "I tried X and…"**: start a
  [discussion](https://github.com/happyvertical/smrt/discussions).
- **Bugs**: open an [issue](https://github.com/happyvertical/smrt/issues/new/choose)
  with a minimal reproduction.
- **Docs and examples**: small fixes are welcome as pull requests directly.
- **Code**: look for [`good first issue`](https://github.com/happyvertical/smrt/labels/good%20first%20issue)
  and [`help wanted`](https://github.com/happyvertical/smrt/labels/help%20wanted).
  For anything bigger than a focused bug fix, open or comment on an issue
  first so we can agree on the approach before you spend time on it.

Please discuss before opening a PR that changes core decorators, the scanner or
schema generation, adds or upgrades a dependency, adds a package, or changes
anything under `.github/`. Fork PRs that touch `.github/` cannot pass the
approval gate; a maintainer re-lands them from a branch in this repository.

## Setup

Use Node >=26.0.0 and pnpm >=11.13.1, as specified by `package.json`.
(pnpm 11.13.0 is excluded on purpose: pnpm itself marks it broken.)

```bash
git clone https://github.com/<you>/smrt.git
cd smrt
pnpm install
pnpm build
```

Packages consume each other's built output, so build once before running any
checks in a fresh clone.

## Making a change

- Work on a branch in your fork. Keep each PR to one concern.
- Run the tests for the package you touched, by its package name:
  `pnpm --filter @happyvertical/smrt-core test`. Directory names under
  `packages/` drop the `smrt-` prefix, and pnpm silently runs nothing for a
  name that matches no package.
- Add a regression test for a bug fix and tests for new behavior.
  [TESTING_STANDARD.md](TESTING_STANDARD.md) has the details.
- Run `pnpm format`, then `pnpm lint`, before pushing.
- Use [conventional commits](https://www.conventionalcommits.org/), for example
  `fix(core): preserve tenant scope`. Keep the PR title under 100 characters in
  the same form; it becomes the squash commit.
- Do not add `.changeset/` files. Release automation writes them.
- Update the package README when you change user-facing behavior.

The package's `AGENTS.md` lists its non-obvious invariants and any extra checks.

## Using an AI coding agent

You are welcome to use one. This repository is built to be read by agents:
point yours at the [`smrt-contribute`](.agents/skills/smrt-contribute/SKILL.md)
skill (the same steps as this guide, with the traps agents hit from a fork),
[AGENTS.md](AGENTS.md) and the affected package's `AGENTS.md`.
Two rules apply:

- You submit the PR, so you need to have read and understood every line of it.
- AGENTS.md and [WORKFLOW.md](WORKFLOW.md) also describe the maintainers'
  internal agent lifecycle: claim labels, dispatch labels, patch trains and
  review cycles. Contributors don't need any of that; skip it, and do not try
  to load the `implement` or `claim-issue` skills they name.

## What happens to your pull request

1. Open the PR against `main` and describe the behavior change and how you
   tested it.
2. A maintainer approves the **Fork PR Validation** run. It runs the full test
   suite and the PostgreSQL suites against your branch in a sandbox with no
   secrets. If your PR changes `.github/`, the **Fork Workflow Change Guard**
   check fails and a maintainer re-lands the change from a branch in this
   repository instead, keeping your commits and authorship.
3. A maintainer reviews the change. Until it is approved, the `Required CI` and
   `postgres-required` checks fail with an "awaiting maintainer approval"
   message. That is expected.
4. Once the sandbox run passes, a maintainer approves the review on your latest
   commit and applies `ci: fork-approved`; the required checks then re-run and
   pass. Approval covers that exact commit: pushing new commits removes the
   label, and the new head needs another review and approval.
5. The maintainer adds the PR to the merge queue, which runs the full
   validation once more before merging.

We aim to give every new issue and pull request a first response within a few
business days.

## Conduct, security and license

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security vulnerabilities privately through
[GitHub security advisories](https://github.com/happyvertical/smrt/security/advisories/new),
never in a public issue. Contributions are licensed under the [MIT License](LICENSE).
