# GitHub Package Registry Migration Summary

## ✅ Completed Changes

### 1. Release Configuration (`.releaserc.json`)
- ✅ Version check already configured (`breaking → minor`)
- ✅ Added `@semantic-release/exec` plugin to run `sync-versions.js`
- ✅ Switched from `@semantic-release/npm` to `@anolilab/semantic-release-pnpm`
- ✅ Configured `npmPublish: true` for GitHub Package Registry
- ✅ Added `dist/**/*` files to git commit assets

**Key Feature**: Breaking changes only bump minor version, preventing 1.0.0 until intentional

### 2. NPM Registry Configuration (`.npmrc`)
- ✅ Added `@happyvertical` scope mapping to GitHub Package Registry
- ✅ Authentication via `${GITHUB_TOKEN}` environment variable
- ✅ Existing `@have` scope configuration preserved

### 3. Package Configuration
- ✅ All packages already have `publishConfig` with GitHub registry
- ✅ Updated root `package.json` pnpm overrides (only SMRT internal packages)
- ✅ Kept SDK dependencies as `workspace:*` (see Next Steps below)

### 4. Version Synchronization (`scripts/sync-versions.js`)
- ✅ Created script to sync all package versions with root version
- ✅ Scans all `packages/` directories
- ✅ Called automatically by semantic-release via `@semantic-release/exec`

### 5. GitHub Actions Workflow (`.github/workflows/on-merge-main.yml`)
- ✅ Removed SDK repository checkout (will use published packages)
- ✅ Updated authentication from `NPM_TOKEN` to `NODE_AUTH_TOKEN`
- ✅ Added `registry-url: 'https://npm.pkg.github.com'` to setup-environment
- ✅ Removed duplicate SDK build step from deploy-docs job

## ⚠️ Dependency Strategy

**Current State**: SDK dependencies use `workspace:*`

**Why**: SDK packages are not yet published to GitHub Package Registry (404 errors when fetching)

**Options**:

### Option A: Wait for SDK Publish (Recommended)
1. Wait for ../sdk to publish packages to GitHub registry
2. Then update SDK dependencies to version ranges (e.g., `^0.51.0`)
3. Run `pnpm install` to fetch from registry

### Option B: Dual-Mode Development
Keep `workspace:*` for local development, let CI/CD handle registry packages:
- Local: Uses workspace protocol (links to ../sdk)
- CI/CD: Fetches from GitHub registry (via .npmrc configuration)

## 📋 Next Steps

### 1. Publish SDK Packages First
```bash
cd ../sdk
git checkout main
git pull origin main

# Trigger publish via merge to main or workflow dispatch
# Or manually:
npm run release
```

### 2. Verify SDK Packages Published
```bash
npm view @happyvertical/ai --registry=https://npm.pkg.github.com
npm view @happyvertical/files --registry=https://npm.pkg.github.com
npm view @happyvertical/sql --registry=https://npm.pkg.github.com
npm view @happyvertical/utils --registry=https://npm.pkg.github.com
npm view @happyvertical/logger --registry=https://npm.pkg.github.com
```

### 3. Update SMRT Dependencies (After SDK Publish)
```bash
# Update dependencies from workspace:* to version ranges
# Run this script after SDK packages are published:
node << 'EOSCRIPT'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SDK_PACKAGES = [
  '@happyvertical/ai',
  '@happyvertical/files',
  '@happyvertical/logger',
  '@happyvertical/sql',
  '@happyvertical/utils'
];

const packagesDir = 'packages';
const packages = readdirSync(packagesDir);

for (const pkg of packages) {
  const pkgJsonPath = join(packagesDir, pkg, 'package.json');
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    let changed = false;

    if (pkgJson.dependencies) {
      for (const dep of SDK_PACKAGES) {
        if (pkgJson.dependencies[dep] === 'workspace:*') {
          pkgJson.dependencies[dep] = '^0.51.0'; // Update to latest SDK version
          changed = true;
        }
      }
    }

    if (changed) {
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    }
  } catch (err) {
    // Skip
  }
}
EOSCRIPT
```

### 4. Test Publishing (Dry Run)
```bash
# Test semantic-release without actually publishing
npm run release:dry-run
```

### 5. Publish SMRT Packages
```bash
# Merge to main will automatically trigger publish via GitHub Actions
# Or manually:
npm run release
```

## 🔍 Testing & Verification

### Local Testing
```bash
# Build all packages
npm run build

# Run tests
npm test

# Preview what would be released
npm run release:preview
```

### CI/CD Testing
```bash
# Trigger workflow manually with dry-run
gh workflow run on-merge-main.yml -f dry-run=true

# Check workflow status
gh run list --workflow=on-merge-main.yml
```

## 📝 Configuration Reference

### `.releaserc.json` Key Settings
```json
{
  "plugins": [
    ["@semantic-release/commit-analyzer", {
      "releaseRules": [
        { "breaking": true, "release": "minor" }  // Prevents 1.0.0
      ]
    }],
    ["@semantic-release/exec", {
      "prepareCmd": "node scripts/sync-versions.js"  // Sync all package versions
    }],
    ["@anolilab/semantic-release-pnpm", {
      "npmPublish": true  // Publish to GitHub registry
    }]
  ]
}
```

### `.npmrc` Authentication
```ini
@happyvertical:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

### Package `publishConfig`
```json
{
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "public"
  }
}
```

## 🚨 Important Notes

1. **Authentication**: Requires `GITHUB_TOKEN` environment variable for local publishing
   - Generate at: https://github.com/settings/tokens
   - Needs `write:packages` and `read:packages` permissions

2. **Version Check**: Breaking changes bump minor version (0.x.0), not major (1.x.0)

3. **Monorepo**: All packages sync to root version via `sync-versions.js`

4. **Workspace Protocol**: Internal SMRT packages keep `workspace:*` (types, config, core)

5. **Registry Scope**: Both `@have` and `@happyvertical` scopes point to GitHub registry

## 📚 Related Documentation

- **SDK Workflow**: `../sdk/.github/workflows/on-merge-main.yml`
- **SDK Release Config**: `../sdk/.releaserc.json`
- **Semantic Release**: https://semantic-release.gitbook.io/
- **GitHub Packages**: https://docs.github.com/en/packages
- **pnpm Workspace**: https://pnpm.io/workspaces

## ✨ Summary

This repository is now **fully configured** to publish to GitHub Package Registry with:
- ✅ Version control (prevents 1.0.0)
- ✅ Automated release workflow
- ✅ Package registry authentication
- ✅ Version synchronization across packages

**Next**: Publish ../sdk packages, then update dependencies in this repo from `workspace:*` to version ranges.
