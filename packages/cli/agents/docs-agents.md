# docs:agents in pnpm monorepos

`smrt docs:agents` (and the deprecated `docs:claude`) documents the
`@happyvertical/*` packages a consumer project installs. pnpm installs per
workspace member, so a consumer monorepo's root `node_modules` holds none of
them (#4734). Source: `src/commands/docs-workspace.ts`,
`src/commands/docs-claude.ts`.

## Monorepo roots

- **Root detection.** `resolveDocsRoot({ cwd, here })` walks up from the working
  directory to the nearest `pnpm-workspace.yaml`. That directory is the docs root
  unless its `package.json` is `@happyvertical/smrt` (the smrt repository keeps
  its cwd-relative behaviour). It is deliberately not `detectMonorepoRoot()`,
  which is the smrt repository's own detector.
- **Discovery.** `listConsumerWorkspaceInstallRoots(root)` (owned by
  `@happyvertical/smrt-dev-mcp/knowledge`, reusing the #2143/#2275 workspace glob
  expansion) returns the root plus every member. Each one's
  `node_modules/@happyvertical` is read via `discoverScopedPackageDirectories`;
  `collectWorkspacePackages(docsRoot)` returns the merged `packages` and
  `sdkPackages`.
- **Output.** `.agents/smrt-framework.md` (a default output; `--output` stays
  relative to the working directory), `.agents/smrt-knowledge/`, and the skills
  under `.claude/skills` / `.agents/skills` are all written at the docs root; the
  skill's bundle path is relative to it. The chosen root is printed (stderr under
  `--dry-run`).
- **`--here`.** Skips workspace resolution: the working directory alone, exactly
  as before. Outside any workspace nothing changes.

## Version skew

Identical name+version across members is one entry. A package at several
versions is listed once; the table cell reads `1.2.0 (apps/a), 1.3.0 (apps/b)`
(ascending semver, sorted member paths, `.` for the root). The highest version's
AGENTS.md and knowledge page are exported. In `bundle.json` that package's entry
keeps `version` (the highest, equal to the page's `package_version`) and gains
`versions` (all, ascending); the field is absent without skew, so single-version
bundles are byte-identical to before. `checkOkfBundleFreshness` takes
`installRoots` (the dev-mcp knowledge check passes the same list) and compares
the page against the highest installed version.
