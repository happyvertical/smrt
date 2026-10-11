# Releasing `@happyvertical/smrt-planner`

Releases are manual GitHub Actions dispatches from `main`. The workflow builds,
validates, packs, and consumer-tests once, publishes that tarball to
`https://npm.happyvertical.com/`, and sends the same artifact to npmjs as a
best-effort mirror. Workstations never publish the package.

## One-time protected environment setup

Create the `release` environment with one custom deployment branch policy: the
branch `main`. Do not use the broader "protected branches" option, and do not
add tag or wildcard policies. The workflow reads the environment policy through
the GitHub API and stops before any credential-bearing job if it is missing or
broader than that exact rule.

The protected publication jobs use the existing organization secrets
`NPM_HAPPYVERTICAL_PUBLISH_TOKEN` and `NPM_TOKEN`. No pull-request workflow
references either secret, and every job that does reference one declares the
`release` environment. The environment therefore gates this publication path,
but it does not narrow the credentials' organization-wide repository exposure.
Rotation and migration to environment-local secrets remain tracked in
[`happyvertical/iac#2165`](https://github.com/happyvertical/iac/issues/2165).
Never paste secret values into an issue, pull request, command log, or workflow
input.

With GitHub CLI, an owner can create the environment and branch rule with:

```bash
gh api --method PUT \
  repos/happyvertical/smrt-planner/environments/release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api --method POST \
  repos/happyvertical/smrt-planner/environments/release/deployment-branch-policies \
  -f name=main -f type=branch
```

If the environment or policies already exist, inspect them before changing
anything; there must be exactly one deployment branch policy when the workflow
is dispatched.

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
mode `mirror` and enter the failed release in `mirror_version` (for example,
`0.0.1`). The explicit version lets an operator recover an older release after
`main` has advanced. That path downloads the selected primary tarball, verifies
its integrity, and publishes those exact bytes to npmjs; it does not rebuild or
write to the primary registry. Mirror failures remain visible but do not turn a
successful primary publication into a failed release.
