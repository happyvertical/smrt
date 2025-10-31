# Changesets Workflow

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing packages.

## Why Changesets?

Changesets provides better control over releases in monorepos:
- Manual control over what gets released
- Better changelog quality (human-written descriptions)
- Batch multiple changes together
- Works well with pnpm workspaces
- No need for conventional commits (but still recommended)

## Creating a Changeset

You have two options for creating changesets:

### Option 1: Auto-generate from Conventional Commits (Recommended)

Simply use conventional commit format in your commits:

```bash
git commit -m "feat(core): add eager loading support"
git commit -m "fix(agents): handle retry timeout"
```

When you open a PR, a GitHub Action automatically generates a changeset from your commits!

**Conventional Commit Format:**
```
type(scope): description

Examples:
feat(core): add new feature          → minor bump
fix(agents): fix bug                 → patch bump
feat(core)!: breaking change         → minor bump (pre-1.0)
feat: change affecting all packages  → all packages, minor bump
```

**Supported scopes** (package names):
- `core`, `types`, `config`
- `accounts`, `agents`, `assets`, `cli`, `content`
- `events`, `gnode`, `places`, `products`, `profiles`
- `svelte`, `tags`, `dev-mcp`, `docs-mcp`

**No scope** = affects all packages

### Option 2: Manual Creation

Create a changeset manually for more control:

```bash
pnpm changeset
```

This will prompt you to:
1. **Select packages** - Choose which packages your changes affect
2. **Select bump type** - Choose patch, minor, or major (see Version Policy below)
3. **Write summary** - Describe your changes (appears in CHANGELOG)

The changeset is saved as a markdown file in `.changeset/` directory.

### Changeset Example

```markdown
---
"@happyvertical/smrt-core": minor
"@happyvertical/smrt-types": patch
---

Add support for eager loading relationships

Implemented JOIN-based eager loading for foreignKey relationships
to prevent N+1 queries. Performance improvement of 40-70% for
relationship-heavy queries.
```

## Version Policy (Pre-1.0)

**⚠️ IMPORTANT**: This framework stays in 0.x.x versioning until API is stable.

### Bump Types

- **patch** (0.7.1 → 0.7.2): Bug fixes, small improvements
- **minor** (0.7.1 → 0.8.0): New features, **breaking changes**
- **major** (0.7.1 → 1.0.0): ❌ **BLOCKED** - Framework not ready for 1.0.0

### Breaking Changes = Minor

Breaking changes bump **minor** version (not major) until 1.0.0:

```bash
# When creating changeset for breaking change:
? What kind of change is this for @happyvertical/smrt-core?
  patch (0.7.1 → 0.7.2)
❯ minor (0.7.1 → 0.8.0)  # Choose this for breaking changes
  major (0.7.1 → 1.0.0)  # Blocked by version check
```

### Version Check

`scripts/check-version-limit.js` prevents any package from reaching 1.0.0:

```bash
# Runs automatically during versioning
pnpm run version

# Or run manually
node scripts/check-version-limit.js
```

## Auto-generation Details

The auto-changeset GitHub Action (`.github/workflows/auto-changeset.yml`):

1. **Triggers** on PR open/sync/reopen
2. **Checks** for existing changesets
3. **If no changesets exist**:
   - Analyzes commits since main
   - Parses conventional commit format
   - Maps scopes to package names
   - Determines bump types (feat → minor, fix → patch)
   - Generates changeset file
   - Commits and pushes to PR branch
4. **Comments** on PR with status

**Manual script usage:**
```bash
# Generate changeset from commits since main
node scripts/generate-changesets-from-commits.js

# From specific base branch
node scripts/generate-changesets-from-commits.js develop
```

## Release Workflow

### Automated (via GitHub Actions)

#### With Auto-generated Changesets

1. **Write conventional commits**:
   ```bash
   git commit -m "feat(core): add feature"
   git commit -m "fix(agents): fix bug"
   git push
   ```

2. **Open PR** - GitHub Action automatically:
   - Generates changeset from commits
   - Commits it to your PR branch
   - Comments on PR

3. **Merge PR to main** - Triggers workflow:
   - Tests run
   - Build completes
   - Changesets bot creates "Version Packages" PR

3. **Review Version Packages PR**:
   - Check version bumps
   - Review generated CHANGELOGs
   - Verify no version exceeds 0.x.x

4. **Merge Version Packages PR**:
   - Updates all package versions
   - Publishes to GitHub Package Registry
   - Creates GitHub release with notes

### Manual Release

```bash
# 1. Apply version bumps
pnpm run version

# 2. Build packages
pnpm run build

# 3. Publish to registry
pnpm run release
```

## Commands

```bash
# Create changeset
pnpm changeset

# Apply version bumps (with version check)
pnpm run version

# Build and publish packages
pnpm run release

# Check versions don't exceed 0.x.x
node scripts/check-version-limit.js
```

## Workflow Details

### What Happens When You Merge to Main?

1. **Tests run** - Must pass before release
2. **Changesets bot checks** for pending changesets:
   - **If changesets exist**: Creates/updates "Version Packages" PR
   - **If no changesets**: No action taken

### Version Packages PR

The bot creates a PR that:
- Updates `package.json` versions
- Generates/updates CHANGELOGs
- Commits changes as `chore(release): version packages`

### When Version Packages PR Merges

1. **Version check runs** - Ensures no package >= 1.0.0
2. **Packages publish** to GitHub Package Registry
3. **GitHub release created** with changelog notes
4. **Git tags created** for each package version

## Changeset Best Practices

### Good Changeset Summary

```markdown
---
"@happyvertical/smrt-core": minor
---

Add eager loading for relationships

Implemented JOIN-based eager loading using the `include` option
in collection.list(). This prevents N+1 queries when loading
related objects.

**Breaking**: Changed loadRelated() signature to require options object.

Migration:
```ts
// Before
await obj.loadRelated('customerId')

// After  
await obj.loadRelated('customerId', {})
```
```

### Bad Changeset Summary

```markdown
---
"@happyvertical/smrt-core": minor
---

Updated stuff
```

### Multiple Packages

If changes affect multiple packages, select all affected:

```markdown
---
"@happyvertical/smrt-core": minor
"@happyvertical/smrt-types": patch
"@happyvertical/smrt-agents": patch
---

Add AI retry logic with exponential backoff

Core package adds retry utilities, types updated for
new retry configuration, agents updated to use retries.
```

## Editing Auto-generated Changesets

Auto-generated changesets can be edited for better descriptions:

1. **Find the changeset file**: `.changeset/<timestamp>-<random>.md`
2. **Edit the summary** - Make it more detailed
3. **Add migration notes** if breaking change
4. **Commit changes**

**Example enhancement:**
```markdown
---
"@happyvertical/smrt-core": minor
---

Add eager loading for relationships

Implemented JOIN-based eager loading using the `include` option
in collection.list(). This prevents N+1 queries when loading
related objects.

**Performance**: 40-70% improvement for relationship-heavy queries.

**Breaking**: loadRelated() now requires options parameter.

Migration:
```ts
// Before
await obj.loadRelated('customerId')

// After
await obj.loadRelated('customerId', {})
```
```

## Regenerating Changesets

If you want to regenerate the changeset:

1. **Delete existing changeset**: `rm .changeset/*.md` (keep README.md)
2. **Push changes** - Triggers auto-generation again
3. **Or run manually**: `node scripts/generate-changesets-from-commits.js`

## Troubleshooting

### "No changesets found"

**Auto-generation scenario:**
If your commits don't follow conventional format, no changeset is generated.
Fix by either:
1. Use conventional commits: `feat(scope): description`
2. Manually create: `pnpm changeset`

**Manual scenario:**
If you don't create a changeset, the bot won't create a Version Packages PR.
Make sure to run `pnpm changeset` before merging.

### Changeset not auto-generated

Check that:
1. **Commits use conventional format**: `type(scope): description`
2. **PR is targeting main branch**
3. **GitHub Action ran** - Check Actions tab
4. **No existing changesets** - Delete and push to regenerate

### Version check fails

If version check fails with "exceeds 0.x.x limit":
1. Check which package is at 1.0.0
2. Review your changeset - did you select "major"?
3. Change to "minor" for breaking changes

### Publish fails

Common causes:
- GitHub registry authentication (`NODE_AUTH_TOKEN`)
- Package name conflicts
- Build failures

Check GitHub Actions logs for details.

## Migration from Semantic Release

This project previously used semantic-release. Key differences:

| Semantic Release | Changesets |
|-----------------|------------|
| Automatic from commits | Manual changesets |
| Conventional commits required | Optional |
| Single release at a time | Batch multiple changes |
| CI-driven | Developer-driven |
| Less control | More control |

### Why Switch?

- **Better for monorepos**: Changesets designed for multi-package repos
- **Better changelogs**: Human-written descriptions instead of commit messages
- **More control**: Choose exactly what gets released and when
- **Industry standard**: Used by Remix, Chakra UI, Radix, and many others

## Additional Resources

- [Changesets Documentation](https://github.com/changesets/changesets)
- [Changesets GitHub Action](https://github.com/changesets/action)
- [Why Changesets](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
