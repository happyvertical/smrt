# Draft issue bodies — Phase 1 cross-cutting

> **This file is ephemeral.** Edit freely; delete after issues are posted on GitHub.
> Once you sign off, these get posted as the epic + 7 cross-cutting issues.

---

## EPIC

**Title**: `epic: monorepo standards audit & per-package alignment`

**Labels**: `type: maintenance`, `priority: high`, `size: xl`, `area: core`

```markdown
## Summary

Cross-monorepo audit identified significant drift between packages in repo layout, build configuration, test setup, dependency strategy, and documentation. Findings, the proposed standard, and the audit snapshot are in [docs/standards.md](docs/standards.md).

## Headline non-compliance

1. `smrtVitestPlugin()` (mandated by CLAUDE.md) is not used in 7 packages
2. Stale build/dev artifacts committed to git across 8 packages
3. 6 packages ship with zero tests
4. Templates pin `@happyvertical/smrt-core: ^0.17.0` while monorepo is at `0.23.11`
5. `scanner` does not include `CLAUDE.md` in `files:` allowlist
6. `smrt-playground` has no `CLAUDE.md`

## Plan

Two-phase rollout.

**Phase 1 — cross-cutting sweep.** Each child issue below is a repo-wide mechanical change. Running them first eliminates ~70% of what would otherwise be boilerplate checklist items in per-package issues.

**Phase 2 — per-package alignment.** After Phase 1 lands, re-baseline the audit and post 41 per-package issues focused on substance (code conventions, missing tests, doc refresh, package-specific bugs).

## Phase 1 — cross-cutting issues

- [ ] #X — Repo-wide stale-artifact cleanup
- [ ] #X — package.json normalization
- [ ] #X — Build configuration migration to `createPackageConfig`
- [ ] #X — Test infrastructure rollout (`smrtVitestPlugin` + layout)
- [ ] #X — Documentation consolidation
- [ ] #X — Drift guards (lefthook + CI)
- [ ] #X — Stale issue triage

## Phase 2 — per-package alignment

41 issues, one per package, posted after Phase 1 completes and audit is re-baselined. Each will absorb existing overlapping issues per the audit appendix.

## Out of scope — existing standalone issues, work in parallel

These are independent and don't wait on this epic:

- #997 — affiliates: DB-backed commission rate config
- #1003 (epic) + #1009, #1010, #1011 — core: ObjectRegistry (verify current status)
- #1022 — images: crop/extract API
- #1024 — core: test-manifest-stub.ts in src/manifest
- #1028 — tenancy/users: UI ownership refactor
- #1039 — users: RBAC contribution moderation
- #1057 — content/assets: asset_associations → content_assets backfill
- #1112 — tenancy/secrets: detect duplicate runtime instances
- #1115 — jobs/users: db:migrate Postgres schema drift
- #1127 — core: eliminate manifest split
- #1139 — core: eager inheritedFields invalidation

## Success criteria

- [ ] All 41 packages pass automated standards checks
- [ ] No package has stray temp/timestamp/bak files
- [ ] `docs/standards.md` is the canonical reference linked from root README
- [ ] Per-package issues, once posted, focus on substance not boilerplate
```

---

## CC-1: Repo-wide stale-artifact cleanup

**Title**: `chore(repo): remove stale build/dev artifacts and add gitignore guards`

**Labels**: `type: maintenance`, `priority: high`, `size: s`, `area: core`

```markdown
## Summary

Remove stale build/dev artifacts committed to git across 8 packages, add `.gitignore` patterns to prevent recurrence, and remove unrelated dead files. Part of [epic #X](#).

Standard: [§11 Forbidden artifacts](docs/standards.md#11-forbidden-artifacts)

## Files to remove

### Vite write-cache leftovers (~1.4MB combined)

- [ ] `packages/agents/vite.config.ts.timestamp-1760639427627-9c6454b7d1c8d8.mjs` (13.7 KB)
- [ ] `packages/content/vite.config.ts.timestamp-1761674887013-2a93bd34b0757.mjs` (~436 KB)
- [ ] `packages/content/vite.config.ts.timestamp-1762774000997-e0cbe26aed12f.mjs` (~482 KB)
- [ ] `packages/tags/vite.config.ts.timestamp-1761674887014-28cd5f1f4afd9.mjs` (~426 KB)

### Manifest-builder driver scripts (committed test scaffolding)

- [ ] `packages/agents/temp-test-manifest-gen-1769096828238-wlx4tzxxrwi.ts`
- [ ] `packages/users/temp-test-manifest-gen-1769097271477-r2uen4v7ik.ts`
- [ ] `packages/ads/temp-test-manifest-gen-1769096831071-54jfelxjtb9.ts`
- [ ] `packages/affiliates/temp-test-manifest-gen-1769096828194-fo3iqr1zfi8.ts`

### Manual backups

- [ ] `packages/profiles/vite.config.ts.bak` (contains legacy `@have/*` import refs)

### Empty / dead config files

- [ ] `packages/vitest/vite.config.ts` (0 bytes — pkg builds with `tsc`, file is dead)
- [ ] `packages/products/test-client-import.mjs` (0 bytes)
- [ ] `packages/products/test-virtual-modules.mjs`

### Stray dev artifacts

- [ ] `packages/core/woohoo.txt` (3.2 KB ASCII art)
- [ ] `packages/core/test-direct-imports.js` (1.4 KB dev throwaway)
- [ ] `packages/core/smrt-homer.png` (650 KB — not in `files:` allowlist; delete or move to top-level `assets/` if needed)

### Misplaced tooling

- [ ] `packages/cli/.changeset/` (sub-package level — repo root only)
- [ ] `packages/cli/.claude/smrt-framework.md` (generated artifact; should be written to consumer projects only)

## .gitignore additions

Append to repo-root `.gitignore`:

```
# Vite write-cache
**/vite.config.ts.timestamp-*.mjs
**/vite.config.*.timestamp-*.mjs

# Manual backups
**/*.bak

# Generated manifest-builder driver scripts
**/temp-test-manifest-gen-*.ts

# macOS
.DS_Store
```

## Acceptance

- [ ] All listed files removed
- [ ] `.gitignore` patterns added
- [ ] `pnpm test` and `pnpm build` pass on a fresh clone
- [ ] Running `pnpm dev` and re-running tests does not produce any of the gitignored patterns as tracked changes
```

---

## CC-2: package.json normalization

**Title**: `chore(repo): normalize package.json across all packages`

**Labels**: `type: maintenance`, `priority: high`, `size: l`, `area: core`

```markdown
## Summary

Normalize `package.json` across all 41 packages. One mechanical PR (or one PR per category if review surface is too large). Part of [epic #X](#).

Standard: [§2 package.json](docs/standards.md#2-packagejson)

## Field-by-field changes

### `author` (currently 4 different forms)

- All packages set `"author": "HappyVertical"`
- Replace: `"HAVE Team"`, `"Will Griffin <willgriffin@gmail.com>"`, missing field

### `repository` (currently in 2/41 packages)

- All packages set:
  ```json
  "repository": {
    "type": "git",
    "url": "https://github.com/happyvertical/smrt.git",
    "directory": "packages/<name>"
  }
  ```

### `files`

- Standard: `["dist", "CLAUDE.md"]`
- Add `"bin"` if package has CLI binaries
- **`scanner` currently missing CLAUDE.md** — add
- `gnode` currently lists `"docs"` directory that doesn't exist — remove

### `exports` map

- Convert all bare-string targets to conditional objects (`scanner`)
- Fix condition order: `{types, import}` (types must come first)
  - Currently wrong in: `config`, `cli`, `types`
- `chat` currently builds a `ui` entry but does not declare `./ui` export — add the export or remove the entry (audit which is intended)
- `profiles` has `auth/`, `models/`, `collections/` directories without subpath exports — decide whether to expose or rename to internal

### `scripts` (gaps in many packages)

Required: `build`, `build:watch`, `dev`, `clean`, `test`, `test:watch`, `typecheck`, `prepack`, `verify:pack`

- Add missing `typecheck` to ~33 packages
- Add missing `prepack` / `verify:pack` to: secrets, sites, properties, social, video, voice, ads, affiliates, ledgers, smrt-svelte, smrt-dev-mcp
- Add missing `dev` and `clean` to: video, voice, affiliates
- Standardize `dev` semantics across packages (currently mix of `vite dev` and `npm run build:watch`)
- Remove all per-package `lint` / `format` scripts (Biome runs at root)

### `peerDependencies`

- Svelte peer always `svelte: ^5.18.0` for UI packages
  - Currently `^4.0.0 || ^5.0.0` in: `assets`, `images`
- Optional peers explicitly marked in `peerDependenciesMeta`
  - Currently missing in `profiles` (which has a required `smrt-tenancy` peer)

### `dependencies` strategy

- All `@happyvertical/smrt-*` references → `workspace:*`
- All `@happyvertical/sdk` references (`ai`, `sql`, `files`, `utils`, etc.) → `catalog:`
- All `@types/node` → `catalog:` (currently `24.10.9` pinned in core, affiliates, prompts, features; rest on `25.0.9`)
- Drop per-package `vite`, `vitest`, `vite-plugin-dts`, `typescript` from devDependencies (root-only)
- Caret (`^X.Y.Z`) for third-party deps; exact pins only for tools where minor bumps cause breakage (document why in CLAUDE.md)

## Acceptance

- [ ] `pnpm install` succeeds with no warnings
- [ ] All packages export the same script surface (`build`, `dev`, `test`, `typecheck`, `prepack`, etc.)
- [ ] `gh repo view` page for each package shows the correct repository link
- [ ] Type-imports work for downstream consumers (verify with `verify:pack` and a smoke install)
```

---

## CC-3: Build configuration migration to `createPackageConfig`

**Title**: `chore(repo): migrate all packages to createPackageConfig and standardize build`

**Labels**: `type: maintenance`, `priority: medium`, `size: m`, `area: core`

```markdown
## Summary

Migrate hand-written `vite.config.ts` files to use `createPackageConfig` from `vite.config.base.ts`. Standardize build target, DTS generation, and remove duplicated devDeps. Part of [epic #X](#).

Standard: [§3 Build configuration](docs/standards.md#3-build-configuration)

## Hand-written vite.config.ts to migrate

- [ ] `packages/core/vite.config.ts` — Foundation, complex, may need extending base
- [ ] `packages/cli/vite.config.ts` — SSR mode, may need extending base
- [ ] `packages/config/vite.config.ts`
- [ ] `packages/types/vite.config.ts`
- [ ] `packages/scanner/vite.config.ts`
- [ ] `packages/products/vite.config.ts` — federation, justified hand-written; document opt-out in CLAUDE.md
- [ ] `packages/secrets/vite.config.ts`
- [ ] `packages/content/vite.config.ts` — dual-mode SvelteKit; document opt-out
- [ ] `packages/assets/vite.config.ts` — dual-mode SvelteKit; document opt-out
- [ ] `packages/images/vite.config.ts` — dual-mode SvelteKit; document opt-out
- [ ] `packages/smrt-svelte/vite.config.ts` — uses `svelte-package`, may be vestigial; verify

## Base config updates

`vite.config.base.ts` may need to absorb common patterns:

- [ ] Build target = `es2022` for libraries
- [ ] `vite-plugin-dts` configured at base
- [ ] `formats: ['es']` only
- [ ] Sourcemap = on
- [ ] Externals: `^@happyvertical/`, `^@modelcontextprotocol/`, `^node:`

## Per-package devDep cleanup

Drop from per-package `devDependencies` (now in root):

- `vite`
- `vitest`
- `vite-plugin-dts`
- `typescript`
- `@types/node` (move to root + use `catalog:` for explicit override)

Currently listed redundantly in: most packages.

## Special cases

- **`packages/vitest`**: keep `tsc`-based build (it provides the vite plugin to others). Remove the empty `vite.config.ts` file. Document the exemption in its `CLAUDE.md`.
- **`packages/products`**: hand-written config justified by triple-consumption (npm/federation/standalone). Add a top-of-file comment linking to docs/standards.md §9.
- **`packages/content`, `packages/assets`, `packages/images`**: dual-mode (library + SvelteKit dev) configs. Either migrate to `createPackageConfig` with new options or document the dual-mode opt-out.

## Acceptance

- [ ] `pnpm build` succeeds across all 41 packages
- [ ] `pnpm test` succeeds across all packages
- [ ] Build output is byte-identical (or improved) for migrated packages — diff `dist/` before and after
- [ ] Each hand-written `vite.config.ts` that remains has a top-of-file comment explaining why
```

---

## CC-4: Test infrastructure rollout

**Title**: `chore(repo): roll out smrtVitestPlugin and standardize test layout`

**Labels**: `type: maintenance`, `priority: high`, `size: m`, `area: tests`

```markdown
## Summary

Make `smrtVitestPlugin()` mandatory across all packages with a `vitest.config.ts`, standardize pool/timeout settings, move tests under `src/__tests__/`, and remove `--passWithNoTests` from packages that simply don't have tests. Part of [epic #X](#).

Standard: [§5 Testing](docs/standards.md#5-testing)

## Add vitest.config.ts with smrtVitestPlugin

These packages currently have no `vitest.config.ts`:

- [ ] `packages/config`
- [ ] `packages/types`
- [ ] `packages/scanner`
- [ ] `packages/tags`
- [ ] `packages/social`
- [ ] `packages/secrets`
- [ ] `packages/voice`

Use the standard config from `docs/standards.md §5`.

## Replace raw `setupFiles` with `smrtVitestPlugin()`

These packages have `vitest.config.ts` but don't use the plugin (the framework's own foundation is currently violating the convention):

- [ ] `packages/core`
- [ ] `packages/cli`
- [ ] `packages/vitest` — itself; uses raw setup. Verify the plugin can configure itself.

## Standardize pool/timeout settings

Apply the standard config from §5 to all `vitest.config.ts`:

- `pool: 'forks'`, `singleFork: true`, `isolate: true`
- `fileParallelism: false`
- `testTimeout: 30_000` default
- `users` may keep 60s with documented reason
- `analytics` may keep its multi-adapter `projects: [sqlite, postgres, json]` configuration with documented reason

## Move tests to `src/__tests__/`

Currently colocated tests to relocate:

- [ ] `packages/core` — 9 `.spec.ts` files at src root (mixed with implementation)
- [ ] `packages/products` — `demo.test.ts`, `product-assets.test.ts` at src root
- [ ] `packages/places` — `place-assets.test.ts`, `place-discovery.test.ts` at src root + `models/PlaceType.spec.ts`
- [ ] `packages/prompts` — `prompt-resolver.test.ts` at src root
- [ ] `packages/features` — 4 `.test.ts` files at src root
- [ ] `packages/assets` — `asset-store.test.ts`, `media-bundle-persistence.test.ts`, `route-module.test.ts` colocated
- [ ] `packages/images` — `route-module.test.ts` colocated
- [ ] `packages/video` — `video-owned-assets.test.ts` colocated
- [ ] `packages/social` — `social.spec.ts` colocated

## Test naming convention enforcement

Per `.claude/rules/testing.md`:
- `*.test.ts` — unit
- `*.spec.ts` — integration

Currently inverted in `core` and inconsistent in `places`/`social`. Audit during the sweep.

## Add at-least-one-test for stub-state packages

These packages currently have zero tests + `--passWithNoTests`:

- [ ] `packages/affiliates` — add at least one unit test (Partner/Commission/Payout); the package has 3 `@smrt()` classes and zero coverage
- [ ] `packages/voice` — add at least one unit test
- [ ] `packages/tags` — package has 687-line SPEC and zero tests; add baseline coverage
- [ ] `packages/gnode` — stub package; add a stub test asserting the stub interface, and link to implementation issue

## Acceptance

- [ ] All `vitest.config.ts` use `smrtVitestPlugin()`
- [ ] No package uses `--passWithNoTests` unless it's a template
- [ ] All test files live under `src/__tests__/`
- [ ] `pnpm test` passes across all packages
- [ ] At least one test exists per published package
```

---

## CC-5: Documentation consolidation

**Title**: `docs: consolidate per-package SPEC/ARCHITECTURE files into docs/ site`

**Labels**: `type: docs`, `priority: medium`, `size: m`, `area: docs`

```markdown
## Summary

Migrate per-package `SPEC.md` / `ARCHITECTURE.md` / `BRAINSTORM.md` / `MIGRATION.md` files into the `docs/` Docusaurus site. Verify `CLAUDE.md` is included in every package's `files:` allowlist. Add missing `CLAUDE.md` to `smrt-playground`. Part of [epic #X](#).

Standard: [§6 Documentation](docs/standards.md#6-documentation)

## Files to migrate to docs/

### Architecture / specs (move to `docs/architecture/` or `docs/rfcs/`)

- [ ] `packages/core/ARCHITECTURE.md` (970 lines) → `docs/architecture/core-architecture.md` (review against current registry state — likely partially stale per #1003)
- [ ] `packages/core/MIGRATION.md` (186 lines) → `docs/architecture/core-migration-history.md` or delete if superseded
- [ ] `packages/agents/SPEC.md` (289 lines) → `docs/rfcs/agents-spec.md`
- [ ] `packages/tags/SPEC.md` (687 lines) → `docs/rfcs/tags-spec.md`
- [ ] `packages/places/SPEC.md` (351 lines) → `docs/rfcs/places-spec.md`
- [ ] `packages/events/SPEC.md` (404 lines) → `docs/rfcs/events-spec.md`
- [ ] `packages/facts/SPEC.md` (134 lines) → `docs/rfcs/facts-spec.md`
- [ ] `packages/profiles/SPEC.md` (817 lines) → `docs/rfcs/profiles-spec.md`
- [ ] `packages/assets/SPEC.md` (473 lines) → `docs/rfcs/assets-spec.md`
- [ ] `packages/config/SPEC.md` (638 lines) → `docs/rfcs/config-spec.md`
- [ ] `packages/tenancy/AUTO_POPULATE_GUIDE.md` (226 lines) → `docs/architecture/tenancy-auto-populate.md`
- [ ] `packages/messages/SECRETS_MIGRATION.md` (296 lines) → `docs/architecture/messages-secrets-migration.md` or fold into changelog if migration is complete

### Brainstorm/draft files (delete or move to rfcs)

- [ ] `packages/places/BRAINSTORM.md` (9 lines) — delete or expand into rfc
- [ ] `packages/config/BRAINSTORM.md` (5 lines) — delete
- [ ] `packages/assets/BRAINSTORM.md` (25 lines) — delete or expand into rfc
- [ ] `packages/products/TEMPLATE_README.md` (185 lines) — fold into `template/README.md` if relevant; otherwise delete

## CLAUDE.md verification

- [ ] Add `"CLAUDE.md"` to `packages/scanner/package.json` `files:` allowlist (currently absent)
- [ ] Create `packages/smrt-playground/CLAUDE.md` (currently no CLAUDE.md)
- [ ] Verify `packages/features/CLAUDE.md` is more than 5 lines (currently a stub) — write real content
- [ ] Verify `packages/prompts/CLAUDE.md` is more than 16 lines — expand

## README.md refresh

Bring all per-package READMEs up to current code:

- [ ] `packages/features/README.md` (3 lines) — write real content
- [ ] `packages/prompts/README.md` (14 lines) — write real content
- Verify all 41 READMEs link to package's `CLAUDE.md` and to `docs/standards.md`

## Sidebar updates

- [ ] Update `docs/sidebars.ts` to include the migrated SPECs and architecture files
- [ ] Add a "Standards" entry pointing to `docs/standards.md`

## Acceptance

- [ ] No `SPEC.md`, `ARCHITECTURE.md`, `BRAINSTORM.md`, `MIGRATION.md`, `AUTO_POPULATE_GUIDE.md`, `SECRETS_MIGRATION.md`, or `TEMPLATE_README.md` in any `packages/*/`
- [ ] `pnpm --filter docs build` succeeds with all migrated files reachable
- [ ] Every package has a `CLAUDE.md` ≥30 lines and a `README.md` ≥80 lines
```

---

## CC-6: Drift guards (lefthook + CI)

**Title**: `chore(ci): add lefthook and CI guards to prevent standards drift`

**Labels**: `type: maintenance`, `priority: medium`, `size: m`, `area: core`

```markdown
## Summary

Add automated checks so the standards in `docs/standards.md` cannot silently drift back. Part of [epic #X](#).

Standard: [docs/standards.md](docs/standards.md) (all sections)

## Lefthook pre-commit checks

Add to `lefthook.yml`:

- [ ] `forbidden-artifacts` — fail commit if any of these patterns are staged:
  - `**/vite.config.ts.timestamp-*.mjs`
  - `**/*.bak`
  - `**/temp-test-manifest-gen-*.ts`
  - `.DS_Store`
  - Empty `.mjs`/`.js`/`.ts` config files at package root
- [ ] `package-json-schema` — validate every staged `package.json` against a JSON schema enforcing:
  - `type: "module"`
  - `author: "HappyVertical"`
  - `repository.directory` present
  - `files: ["dist", "CLAUDE.md"]` (or with `"bin"`)
  - `publishConfig.registry` correct for non-template packages
- [ ] `exports-condition-order` — check that every entry in `exports` puts `types` before `import`

## CI checks

Add to `.github/workflows/test-suite.yml` (or new `standards.yml`):

- [ ] Standards script: `pnpm exec standards-check` runs all the above checks repo-wide
- [ ] `smrtVitestPlugin()` presence: grep every `vitest.config.ts` and fail if missing
- [ ] CLAUDE.md presence: every `packages/*/CLAUDE.md` exists and is in `files:`
- [ ] No package uses `--passWithNoTests` (with allowlist for templates)

## Per-package validate-build invariants

Existing `scripts/validate-build.js` should also check:

- [ ] Every published package has `dist/index.js` and `dist/index.d.ts`
- [ ] Every package's `dist/` matches its `exports` map (no missing files)
- [ ] No `workspace:*` references leak into published `package.json` (handled by `prepack-package.js`, but verify)

## Acceptance

- [ ] CI fails on a synthetic PR that re-introduces a forbidden artifact
- [ ] CI fails on a synthetic PR that breaks `package.json` schema
- [ ] CI fails on a synthetic PR that removes `smrtVitestPlugin()` from a config
- [ ] Documentation in `docs/standards.md` references the CI script as the enforcement mechanism
```

---

## CC-7: Stale issue triage

**Title**: `chore(issues): triage stale-labeled and superseded issues`

**Labels**: `type: maintenance`, `priority: low`, `size: s`, `area: core`

```markdown
## Summary

Triage open issues that are either superseded by recent work, stale, or covered by the standards epic. Part of [epic #X](#).

## Issues to verify and likely close

- [ ] **#1136** — `[Feature]: Add @happyvertical/smrt-prompts` — package now exists and ships at `0.23.11`. Close as completed; link to `packages/prompts/` and CHANGELOG.
- [ ] **#1003** epic + children **#1009**, **#1010**, **#1011** — verify against current state of `packages/core/src/registry.ts`. Likely partially complete after recent work. Update epic body or close children that landed.

## Stale-labeled issues to triage

Run through every issue currently tagged `stale` and decide: close (no longer relevant), revive (drop `stale`, re-prioritize), or fold into per-package issue scope. Issues currently `stale`-tagged:

- [ ] #1105 — Cleanup stale claude-context bins from published SDK deps
- [ ] #1085 — Refactor docs and release workflows to use pnpm
- [ ] #1057 — smrt-content: asset_associations → content_assets backfill (likely revive — substantive)
- [ ] #1039 — Add RBAC enforcement for contribution moderation
- [ ] #1028 — Refactor tenant-domain UI ownership between smrt-tenancy and smrt-users
- [ ] #1024 — fix(core): stop generating test-manifest-stub.ts into src/manifest
- [ ] #1022 — P2: Expose true crop/extract API in image processor adapter
- [ ] #1021 — Standardize Standalone Dev Servers for Package UI Components
- [ ] #1011 — Registry lockdown phase after initialization
- [ ] #1010 — Build-time declarative schema generation
- [ ] #1009 — Implement two-phase initialization model
- [ ] #1003 — epic: ObjectRegistry Architectural Debt
- [ ] #997 — DB-backed commission rate configuration in smrt-affiliates
- [ ] #972 — perf: batch ensureSystemTables + reduce schema passing in initialize()

## Acceptance

- [ ] All 14 stale issues have an explicit decision (closed, revived, or folded)
- [ ] #1136 is closed with a link to the shipped package
- [ ] Issues that are revived have the `stale` label removed and an updated priority/size
- [ ] No issue with `stale` label is older than 30 days at audit close
```

---

## Posting plan

Once you sign off, I will (in order):

1. Post the **epic** first → capture its issue number
2. Post **CC-1 through CC-7** in sequence, with `parent: epic` references in each body
3. Edit the epic body to fill in the seven `#X` placeholders with the actual issue numbers
4. Apply labels per the body of each issue

I will NOT post until you say go. You can edit this file freely; I'll re-read it when you're ready.
