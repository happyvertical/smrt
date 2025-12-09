# Changesets Workflow

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing packages.

## Simple Release Model

**Every merge to main = release.**

No selective commit types, no manual changeset creation needed. The workflow is:

1. Create PR with conventional commits
2. Tests pass, merge to main
3. Version bumps automatically (patch, or minor for breaking changes)
4. Packages published to GitHub Packages

## Version Policy (Pre-1.0)

**⚠️ IMPORTANT**: This framework stays in 0.x.x versioning until API is stable.

### Bump Types

- **patch** (0.7.1 → 0.7.2): All commits (feat, fix, chore, docs, refactor, etc.)
- **minor** (0.7.1 → 0.8.0): Breaking changes only (using `!` or `BREAKING CHANGE`)
- **major** (0.7.1 → 1.0.0): ❌ **BLOCKED** - Framework not ready for 1.0.0

### Breaking Changes = Minor

Breaking changes bump **minor** version (not major) until 1.0.0:

```bash
# Breaking change example:
git commit -m "feat(core)!: rename method"
git commit -m "fix(agents): change signature

BREAKING CHANGE: method signature changed"
```

## Commit Format

Use conventional commits:

```
type(scope): description

Examples:
feat(core): add new feature
fix(agents): fix bug
docs: update README
chore: update dependencies
refactor(svelte): reorganize components
feat(core)!: breaking change
```

**Supported scopes** (package names):
- `core`, `types`, `config`
- `accounts`, `agents`, `assets`, `cli`, `content`
- `events`, `gnode`, `places`, `products`, `profiles`
- `svelte`, `tags`, `dev-mcp`, `docs-mcp`

**No scope** = affects all packages

## What Happens When You Merge?

1. **Tests run** on main
2. **Build** completes
3. **Changeset auto-generated** from commits (`scripts/auto-changeset.ts`)
4. **Versions bumped** across all packages (fixed group)
5. **Packages published** to GitHub Packages
6. **Git tag created** (e.g., `v0.17.33`)
7. **GitHub release** created with changelog
8. **Downstream repos notified** (cascade)

## Manual Changeset (Optional)

You can still create manual changesets for more detailed changelogs:

```bash
pnpm changeset
```

If a changeset already exists, auto-generation is skipped.

## Commands

```bash
# Create manual changeset
pnpm changeset

# Apply version bumps (with version check)
pnpm run version

# Build and publish packages
pnpm run release

# Check versions don't exceed 0.x.x
node scripts/check-version-limit.js
```

## Troubleshooting

### "No conventional commits found"

The auto-changeset script requires at least one commit following conventional format.

**Fix**: Ensure commits use format `type(scope): description`

### Version check fails

If version check fails with "exceeds 0.x.x limit":
1. Check which package is at 1.0.0
2. This shouldn't happen with normal operation
3. Contact maintainers if it does

### Publish fails

Common causes:
- GitHub registry authentication (`NODE_AUTH_TOKEN`)
- Package name conflicts
- Build failures

Check GitHub Actions logs for details.

## Fixed Group

All SMRT packages share the same version number. When one package bumps, all bump together.

This is configured in `.changeset/config.json`:

```json
{
  "fixed": [
    ["@happyvertical/smrt-*"]
  ]
}
```

## Additional Resources

- [Changesets Documentation](https://github.com/changesets/changesets)
- [Conventional Commits](https://www.conventionalcommits.org/)
