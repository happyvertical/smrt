# Development workflow

[AGENTS.md](AGENTS.md) and [.agents/project.yaml](.agents/project.yaml) define
repository policy and tracker routing. This page is a navigation aid; shared
lifecycle procedures are maintained in `happyvertical/have-config`.

## Starting work on an issue

Use the shared `implement` skill for GitHub implementation and `claim-issue`
for its exclusive lease. Read the issue and affected package AGENTS before
editing. Track documentation work too; only an explicitly scoped throwaway
spike is exempt. Preserve unrelated work and use a feature branch.

## Creating a pull request

Follow `implement` through `review-cycle` and `ship`; use `resolve` for review
feedback. These skills own validation, exact-revision review, claim release,
and ready-for-review PR handling. Do not replace them with a second local SOP.
Merging requires explicit authorization. Work/buzz `*-v2` skills apply only
when project tracker configuration selects that workflow.

## Repository references

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, coding conventions, contribution scope.
- [TESTING_STANDARD.md](TESTING_STANDARD.md): test design and package release gates.
- [AGENTS.md](AGENTS.md): framework invariants and validation entrypoints.
- [standards](docs/content/standards.md): packaging and documentation contracts.
- [CHANGESETS.md](CHANGESETS.md): automated release/version policy.

If shared skills are unavailable, restore them from the designated control
plane; do not reconstruct claim/release commands from old local checklists.
