# Releasing `@happyvertical/smrt-planner`

Releases are manual GitHub Actions dispatches from `main`. The workflow builds,
validates, packs, and consumer-tests once, publishes that tarball to
`https://npm.happyvertical.com/`, and sends the same artifact to npmjs as a
best-effort mirror. Workstations never publish the package.

## One-time protected environment setup

An owner must finish this setup before merging the publication change. Create
the `release` environment with one custom deployment branch policy: the branch
`main`. Do not use the broader "protected branches" option, and do not add tag
or wildcard policies. The workflow reads the environment policy through the
GitHub API and stops before any secret-bearing job if it is missing or broader
than that exact rule.

Store these secrets directly on the `release` environment:

- `PLANNER_NPM_HAPPYVERTICAL_PUBLISH_TOKEN`: a scoped publisher for
  `https://npm.happyvertical.com/`.
- `PLANNER_NPMJS_TOKEN`: the npmjs token allowed to publish the package mirror.

The planner-specific names are deliberate. The workflow never reads the
legacy organization secrets `NPM_HAPPYVERTICAL_PUBLISH_TOKEN` or `NPM_TOKEN`,
so organization-secret visibility cannot silently substitute for missing
environment protection. Enter values from a private machine and never paste
them into an issue, pull request, command log, or workflow input.

With GitHub CLI, an owner can create the environment and branch rule with:

```bash
gh api --method PUT \
  repos/happyvertical/smrt-planner/environments/release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api --method POST \
  repos/happyvertical/smrt-planner/environments/release/deployment-branch-policies \
  -f name=main -f type=branch
gh secret set PLANNER_NPM_HAPPYVERTICAL_PUBLISH_TOKEN \
  --env release --repo happyvertical/smrt-planner
gh secret set PLANNER_NPMJS_TOKEN \
  --env release --repo happyvertical/smrt-planner
```

The `gh secret set` commands prompt for the values. If the environment or
policies already exist, inspect them before changing anything; there must be
exactly one deployment branch policy when the workflow is dispatched.

## Publish a version

1. Set the version in `package.json`, update release notes as appropriate, and
   merge the reviewed change to `main`. The first release remains `0.0.1`.
2. Open **Actions → Publish package → Run workflow** on `main` and choose
   `release`.
3. Confirm the safeguards, validation, primary publication, and mirror jobs.
   The primary registry defines release success; npmjs is reported separately.
4. Verify the exact version and `dist.integrity` on both registries. Never
   rebuild or repack a version that has reached the primary registry.

The primary job is safe to rerun. If the version already exists there, it
continues only when the registry integrity exactly matches the artifact built
by that run. A different integrity stops the workflow and requires a new
version.

If only the npmjs mirror fails, dispatch the workflow again from `main` with
mode `mirror`. That path downloads the published primary tarball, verifies its
integrity, and publishes those exact bytes to npmjs; it does not rebuild or
write to the primary registry. Mirror failures remain visible but do not turn a
successful primary publication into a failed release.
