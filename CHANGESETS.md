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

## Release Workflow

### Automated (via GitHub Actions)

1. **Create changeset** on feature branch:
   ```bash
   pnpm changeset
   git add .changeset
   git commit -m "chore: add changeset for feature"
   ```

2. **Merge PR to main** - Triggers workflow:
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

## Auto-Generated Changesets

### How Auto-Generation Works

1. **Write conventional commits** on your feature branch
2. **Open PR** to main branch
3. **PR validation** checks conventional commit format (`.github/workflows/on-pull-request.yml`)
4. **Merge PR** to main branch
5. **On-merge workflow triggers** publish workflow (`.github/workflows/on-merge-main.yml`)
6. **Publish workflow auto-generates changesets** from conventional commits (`scripts/generate-changesets-from-commits.js`)
7. **Versions bumped** and packages published to npm

**Note:** Changesets are NOT created in PRs - they are auto-generated after merge to main as part of the publish workflow.

### Editing Auto-Generated Changesets

Auto-generated changesets can be edited for better descriptions:

```bash
# Find the changeset file
ls .changeset/*.md | grep -v README

# Edit it
code .changeset/some-changeset-name.md

# Commit changes
git add .changeset
git commit -m "docs: improve changeset description"
```

### Regenerating Changesets

If you want to regenerate after adding more commits:

```bash
# Delete existing changeset
rm .changeset/some-changeset-name.md

# Push to trigger regeneration
git push

# Or run manually
node scripts/generate-changesets-from-commits.js
```

### Skipping Auto-Generation

To skip auto-generation and create manually:

```bash
# Create changeset before opening PR
pnpm changeset
git add .changeset
git commit -m "chore: add changeset"
git push

# Open PR - auto-generation will skip (changeset exists)
```

## Troubleshooting

### "No changesets found"

If you don't create a changeset, the bot won't create a Version Packages PR.

**Solutions**:
- Use conventional commits → auto-generation creates one
- Run `pnpm changeset` manually before merging

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

### Auto-generation not working

If changesets aren't being auto-generated:

1. **Check commits use conventional format**:
   ```bash
   git log --oneline
   # Should show: feat(core): description
   ```

2. **Check GitHub Action ran**:
   - Visit PR → "Checks" tab
   - Look for "Auto-generate changeset" workflow

3. **Check for existing changesets**:
   ```bash
   ls .changeset/*.md | grep -v README
   # Auto-generation skips if changeset exists
   ```

4. **Run script manually**:
   ```bash
   node scripts/generate-changesets-from-commits.js
   ```

5. **Check script output**:
   - "No conventional commits found" → Fix commit format
   - "Changesets already exist" → Delete to regenerate
   - "No changes to commit" → Script succeeded

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
