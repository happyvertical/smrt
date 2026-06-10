# SMRT Monorepo Package Standards

This document defines the standards every package in `packages/*` must follow. It exists to:

- Make every package look the same so contributors can move between packages without surprise
- Catch drift early via a checkable list rather than ad-hoc review
- Provide a single canonical reference the audit epic and per-package issues link to

The standard is prescriptive. Where a package needs to deviate, it must document why in its own `AGENTS.md`.

The companion document `docs/PROJECT_REQUIREMENTS.md` defines requirements for SMRT *consumer* projects. This document defines requirements for *packages inside this monorepo*. The two overlap heavily, but the audiences are different.

## Table of contents

1. [Repository layout](#1-repository-layout)
2. [package.json](#2-packagejson)
3. [Build configuration](#3-build-configuration)
4. [TypeScript configuration](#4-typescript-configuration)
5. [Testing](#5-testing)
6. [Documentation](#6-documentation)
7. [Code conventions](#7-code-conventions)
8. [UI packaging (Svelte)](#8-ui-packaging-svelte)
9. [Triple-consumption packages](#9-triple-consumption-packages)
10. [Templates](#10-templates)
11. [Forbidden artifacts](#11-forbidden-artifacts)
12. [Appendix A: audit snapshot](#appendix-a-audit-snapshot)
13. [Appendix B: rationale for changes](#appendix-b-rationale-for-changes)

---

## 1. Repository layout

### Required files

```
packages/<name>/
├── src/
│   ├── index.ts              # public API root
│   └── __tests__/            # unit + integration tests
├── package.json
├── tsconfig.json
├── vite.config.ts            # uses createPackageConfig(name, opts?)
├── vitest.config.ts          # uses smrtVitestPlugin()
├── README.md
├── AGENTS.md                 # canonical package expert guidance
├── CLAUDE.md                 # one-line Claude Code shim: @AGENTS.md
└── CHANGELOG.md              # changesets-managed
```

### Conditional files

| File | When required |
|---|---|
| `src/__smrt-register__.ts` | Package defines `@smrt()` classes (issue #1132 self-registration pattern) |
| `src/svelte/` and `ambient.d.ts` and `tsconfig.svelte.json` | Package ships Svelte UI components |
| `src/manifest/` | Package participates in build-time manifest generation |
| `tsconfig.build.json` | `vite-plugin-dts` needs different inclusions than `tsc --noEmit` |
| `tsconfig.typecheck.json` | `tsc --noEmit` needs different inclusions than build |
| `bin/` | Package exposes a CLI binary |
| `e2e/` and `playwright.config.ts` | Package has Playwright end-to-end tests |

### Forbidden at any package root or src

See [§11](#11-forbidden-artifacts) for the full list.

---

## 2. package.json

### Skeleton

```json
{
  "name": "@happyvertical/smrt-<name>",
  "version": "0.X.Y",
  "type": "module",
  "description": "<one sentence>",
  "author": "HappyVertical",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/happyvertical/smrt.git",
    "directory": "packages/<name>"
  },
  "files": ["dist", "AGENTS.md", "CLAUDE.md"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "vite build",
    "build:watch": "vite build --watch",
    "dev": "vite build --watch",
    "clean": "rm -rf dist .turbo",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "prepack": "node ../../scripts/prepack-package.js",
    "verify:pack": "node ../../scripts/verify-pack.js"
  },
  "dependencies": {
    "@happyvertical/smrt-core": "workspace:*",
    "@happyvertical/ai": "catalog:"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

### Rules

- `type: "module"` — always
- `author: "HappyVertical"` — uniform; replace `"HAVE Team"`, `"Will Griffin <willgriffin@gmail.com>"`, and missing fields
- `repository.directory` — required
- `files` — `["dist", "AGENTS.md", "CLAUDE.md"]`. Add `"bin"` if package has a CLI. Do not add `README.md` (it is published automatically). Do not add directories that don't exist.
- **Exports map condition order**: `{types, import}` — `types` must come first (Node resolves the first matching condition; if `import` is first, types resolution silently fails). Bare-string targets are forbidden — every entry must be a conditional object.
- **Dependencies**:
  - All `@happyvertical/smrt-*` references use `workspace:*`
  - All `@happyvertical/sdk` references (`ai`, `sql`, `files`, `utils`, `cache`, `documents`, `email`, `encryption`, `geo`, `images`, `jobs`, `json`, `logger`, `messages`, `ocr`, `pdf`, `projects`, `repos`, `secrets`, `spider`) use `catalog:`
  - `@types/node` always `catalog:`
  - `vite`, `vitest`, `vite-plugin-dts`, `typescript` come from root devDependencies — do not redeclare per-package unless overriding
  - Pinning style: prefer caret (`^X.Y.Z`) for third-party deps; exact pins (`X.Y.Z`) only for tools where minor bumps cause breakage (document why)
- **Scripts**: every package has `build`, `build:watch`, `dev`, `clean`, `test`, `test:watch`, `typecheck`, `prepack`, `verify:pack`. No `lint` or `format` scripts — those are root-level via Biome. The presence of `typecheck` is enforced by `scripts/check-standards.mjs`; the only carve-outs are the plain-JS template wrappers (`template-sveltekit`, `template-site-static-json`), whose typecheck obligation lives in their scaffolded `template/package.json` (see §10).
- **`peerDependencies`**:
  - Svelte peer always `svelte: ^5.18.0` for packages shipping UI
  - Optional peers explicitly marked in `peerDependenciesMeta`
  - Required peers (e.g. `users` requires `profiles`) documented in `AGENTS.md`
- **`publishConfig.registry`** always `https://npm.pkg.github.com` for published packages; templates may opt out

---

## 3. Build configuration

### Standard config

```typescript
// vite.config.ts
import { createPackageConfig } from '../../vite.config.base';

export default createPackageConfig('<package-name>', {
  // optional
  entries: ['ui', 'playground'],
  svelte: 'svelte',
});
```

### Rules

- **Always use `createPackageConfig`** from `vite.config.base.ts`. Hand-written `vite.config.ts` files require an explicit comment stating why and a tracking issue.
- **Build target**: `es2022` for libraries; `node20` only for tools that must run server-side (CLIs); `node24` only when explicitly required.
- **`vite-plugin-dts`**: comes via `vite.config.base.ts`; do not add to per-package devDependencies.
- **DTS bundling**:
  - `rollupTypes: false` for foundation packages (`core`, `cli`) — many internal types
  - `rollupTypes: true` for narrow public APIs
- **Output format**: ESM only (`formats: ['es']`)
- **Sourcemaps**: on
- **`vitest` package** is exempt — it must build with `tsc` because it provides the vite plugin to others. The empty `vite.config.ts` should be removed.

---

## 4. TypeScript configuration

### Base configs at repo root

| Base | Purpose |
|---|---|
| `tsconfig.json` | Default for libraries — strict, ES2022, ESNext modules, bundler resolution |
| `tsconfig.package-build.json` | Settings for `vite-plugin-dts` build path |
| `tsconfig.package-svelte.json` | Settings for packages with `.svelte` source |
| `tsconfig.package-typecheck.json` | Settings for `tsc --noEmit` |
| `tsconfig.package-ui.json` | Settings for packages shipping UI (extends svelte + adds DOM lib) |

### Per-package rules

- Always have `tsconfig.json` extending the appropriate base
- Add `tsconfig.svelte.json` only if `.svelte` source is present
- Add `tsconfig.typecheck.json` only if typecheck inclusions differ from build
- Add `tsconfig.build.json` only if `vite-plugin-dts` needs different inclusions
- Maximum: 4 tsconfig files per package. If you need more, talk to maintainers first.
- Do not extend `tsconfig.kit.json` unless the package ships a SvelteKit app (templates only)

---

## 5. Testing

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
```

> **Note**: Inside this monorepo, packages import `smrtVitestPlugin` directly from the workspace source (`../vitest/src/index.ts`) rather than from the published `@happyvertical/smrt-vitest`. This avoids a circular workspace build dependency. Consumer projects (outside the monorepo) should import from the package name.

### Rules

- **`smrtVitestPlugin()` is mandatory.** This is non-negotiable; it is the framework's own dogfooding requirement.
- **Test naming** (per `.claude/rules/testing.md`):
  - `*.test.ts` — unit
  - `*.spec.ts` — integration
  - `*.optional.test.ts` — requires external APIs, skipped in CI
- **Test location**: tests live under `src/__tests__/`. Colocated tests are deprecated; do not introduce new ones.
- **Minimum**: every published package has at least one unit test. Stub packages (e.g. `gnode`) document why they don't and link to the implementation issue.
- **Templates**: at least one Playwright e2e verifying `pnpm scaffold` works end-to-end.
- **`testTimeout`**: 30s default; raise per-test if a specific case needs longer; raise the package default only with documented reason (`users` is at 60s for legitimate reasons).

---

## 6. Documentation

### Required

- **`README.md`** — ≥80 lines. Purpose, install, basic usage, link to `AGENTS.md`, links to other relevant package READMEs.
- **`AGENTS.md`** — ≥30 lines. Package-specific patterns, gotchas, integration points. Included in `files:` allowlist.
- **`CLAUDE.md`** — exactly one line: `@AGENTS.md`. Included in `files:` allowlist for Claude Code compatibility.
- **`CHANGELOG.md`** — managed by changesets. Don't hand-edit.

### Discouraged

These create a "every package has its own snowflake docs" problem:

- `ARCHITECTURE.md`
- `SPEC.md`
- `MIGRATION.md`
- `BRAINSTORM.md`
- `AUTO_POPULATE_GUIDE.md`
- `SECRETS_MIGRATION.md`
- `TEMPLATE_README.md`

If you have content that would go into one of those files, the right home is:

- Architectural reasoning → `docs/architecture/<topic>.md` (Docusaurus site)
- Migration instructions for a specific change → ephemeral migration note in the changeset
- Specs and brainstorms → `docs/rfcs/`
- Detailed how-tos → `AGENTS.md`

Existing files of these types should be migrated and the per-package files removed.

---

## 7. Code conventions

These are already documented in the root `AGENTS.md`. They are reproduced here for completeness:

- `@smrt()` decorator on every persisted class
- **Never override `toJSON()`.** Use `transformJSON()` instead. The base class handles STI discriminator and meta-field extraction.
  - Exception: `tenancy/interceptor.ts` calls `instance.toJSON()` directly to handle stub instances. This must be documented in the file with a comment.
- Same-package foreign keys: use `@foreignKey(Target)`.
- Cross-package foreign keys: use `@crossPackageRef('@happyvertical/smrt-package:Class')`; this avoids circular DDL constraints while preserving runtime relationship metadata.
- Junction collections extend `SmrtJunction` and expose `byLeft()` / `byRight()` plus options-object `attach()` / `detach()`.
- Hierarchical tree models extend `SmrtHierarchical`; chains/DAGs use package-specific fields and methods.
- Polymorphic generic/provenance links extend `SmrtPolymorphicAssociation`.
- `@TenantScoped({ mode: 'optional' })` on tenant-aware models. Tenant-aware packages without the decorator (`secrets`, `prompts`, `features`, `images` for some models) must document the tenant strategy in `AGENTS.md`.
- `__smrt-register__.ts` self-registration imported from `index.ts` (issue #1132 pattern)
- `@meta()` for STI child-specific fields (stored in `_meta_data`, not as columns)
- STI discriminator format: `@happyvertical/smrt-<package>:<ClassName>`
- Numeric defaults: `count: number = 0` → INTEGER; `price: number = 0.0` → DECIMAL
- `conflictColumns` set on junction/upsert tables
- System tables prefixed `_smrt_`
- JSON fields stored as strings with `getX()`/`setX()` helpers wrapped in `try/catch`

### Logging (S14 / dim 9)

Shipped library code logs through `@happyvertical/logger`, never `console.*`.
`console` is reserved for contexts where stdout/stderr **is** the product, not a
diagnostic side-channel.

**Use the logger** — runtime diagnostics emitted by shipped library code (caught
errors, recoverable warnings, operational traces):

```ts
import { createLogger } from '@happyvertical/logger';
const logger = createLogger({ level: 'info' });

logger.error('Failed to load schema', { error });  // was console.error(error)
logger.warn('Falling back to default', { id });     // was console.warn(...)
logger.debug('resolved relationship', { target });  // was a diagnostic console.log
```

Map by intent: a caught/operational error → `logger.error`; a recoverable
problem → `logger.warn`; developer diagnostics → `logger.debug` (or `info` for
genuinely operational milestones).

**Keep `console` (Biome `noConsole: off`)** where the output IS the contract:

- the `cli` package's user-facing command output (results, tables, prompts,
  help) — its *internal* diagnostics still use the logger;
- standalone / dev / demo entrypoints — `server.ts`, `*-server.ts`, `bin/`,
  `scripts/`, `lib/server/seed-*`, `demo*`;
- build-time & codegen tooling — vite / consumer plugins, scanners, prebuild,
  and the REST / CLI / MCP / manifest **generators** (`vite-plugin/`,
  `consumer-plugin/`, `prebuild/`, `scanner/`, `generators/`,
  `manifest/generator*`, `manifest/discover-*`). Note this is the *generation*
  side only — runtime manifest loading (`manifest/manifest-loader.ts`,
  `store.ts`) is shipped library code and uses the logger;
- test files and `*.config.*` (already exempt).

**Browser / Svelte code keeps `console`.** `@happyvertical/logger` is a
Node/server logger; it has no place in code that runs in the browser. So `.svelte`
components and browser-only modules (e.g. `smrt-svelte`, `browser-ai/` adapters,
client-side state) use `console` — that's the browser's diagnostic channel.
Migrate to the logger only on the Node/server side (collections, services, server
routes/hooks, ORM/runtime libraries).

**Never touch** `console.*` inside comments or JSDoc `@example` blocks — that is
documentation, not code.

**Enforcement (ratchet).** Global `noConsole: "warn"` in `biome.json`.
Keep-console contexts above get `"off"` overrides; a runtime module flips to
`"error"` once migrated — per package/file, the same incremental ratchet used by
the design-token sweeps (S1). The raw `console.*` count overstates the work:
most of it is the keep-console contexts above; the real target is runtime
library logging, concentrated in `core`.

### Secret scanning (S7)

Committed credentials are blocked by [gitleaks](https://github.com/gitleaks/gitleaks),
run deterministically (tool-only, no model-assisted checks) in two places:

- **lefthook pre-commit** — `gitleaks git --staged` scans the staged diff before
  the commit lands. Local-only and best-effort: if gitleaks isn't installed it
  warns and skips (CI is the hard gate). Install with `brew install gitleaks`.
- **CI (`on-pull-request`)** — the `Secret Scan (gitleaks)` job installs a pinned
  gitleaks and scans the PR commit range (`merge-base..HEAD`). A finding fails
  the PR.

Both runs pass `--redact`, so a matched secret is never printed to logs (org
secret-handling policy). Real secrets belong in Warden, never in the repo.

**Config + allowlist.** `.gitleaks.toml` at the repo root is the single source of
truth: it extends gitleaks' default rules (`useDefault = true`) and allowlists
justified false positives (build artifacts under `dist/`, the lockfile, `*.test.`
/`*.spec.` fixtures that embed deliberate dummy keys, and the legacy
initial-import commit). Add new exclusions there with a justification comment —
never disable the scan.

### Dependency audit (S8)

`pnpm audit` runs as a CI gate on every PR (`on-pull-request` →
`Dependency Vulnerability Audit`), reading the dependency tree from
`pnpm-lock.yaml` (no install needed).

- **Blocking threshold: high.** The gate runs `pnpm audit --audit-level=high`, so
  any **high or critical** advisory fails the PR. Moderate/low are reported but
  non-blocking.
- **Remediation first.** Prefer fixing over ignoring: most advisories are stale
  transitive deps with a published patch, fixable by a version-range-scoped entry
  in `pnpm.overrides` (e.g. `"undici@>=7.0.0 <7.24.0": "7.24.0"`). Scope the key
  to the vulnerable range so unrelated majors aren't force-bumped.
- **Accept-with-justification.** Only when an advisory can't be remediated without
  breaking a pinned API (e.g. `protobufjs` 6.x held by `onnx-proto` under the
  deprecated `@xenova/transformers` v2 fallback) add its GHSA to
  `pnpm.auditConfig.ignoreGhsas` — with a justification recorded in the PR.
  Revisit baselined advisories when their blocker is removed.

---

## 8. UI packaging (Svelte)

### Required exports for UI packages

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./ui": { "types": "./dist/ui.d.ts", "import": "./dist/ui.js" },
    "./svelte": {
      "types": "./dist/svelte/index.d.ts",
      "svelte": "./dist/svelte/index.js",
      "import": "./dist/svelte/index.js"
    },
    "./playground": { "types": "./dist/playground.d.ts", "import": "./dist/playground.js" }
  }
}
```

### Rules

- **Directory layout**: `src/svelte/components/` (not flat `src/svelte/`)
- **`svelte/index.ts`**: uses `ModuleUIRegistry.register(...)` pattern. Pure re-exports without registry are deprecated.
- **`./ui` subpath**: exports `MODULE_META` and `UI_SLOTS` constants. The vite config builds a `ui` entry; the package.json must declare the matching export. (`chat` currently has the entry without the export.)
- **`./playground` subpath**: exports the package's playground module for use by `smrt-playground`
- **Svelte peer**: `svelte: ^5.18.0` (uniform). Drop the `^4.0.0 || ^5.0.0` range.
- **Build script**: `vite build && svelte-package -i src/svelte -o dist/svelte --tsconfig tsconfig.svelte.json`
- **Typecheck script**: packages with `./svelte` exports must run both TypeScript and Svelte checks, e.g. `tsc --noEmit && svelte-check --tsconfig ./tsconfig.svelte.json`. SvelteKit-backed packages should run `svelte-kit sync` before both the TypeScript and `svelte-check` passes.
- **`tsconfig.svelte.json`**: extends `tsconfig.package-svelte.json`, includes `ambient.d.ts` and `*.svelte`

---

## 9. Triple-consumption packages

`products` is the reference template for packages that need to ship as:

1. npm library (consumed via import)
2. Module Federation host
3. Standalone SvelteKit app

This is **opt-in**, not the default. Most packages are library-only. To opt in, the package must:

- Add `src/{lib,app,federation}/`
- Add `federation.config.ts`, `index.html`
- Add scripts `dev:standalone`, `dev:federation`, `build:app`, `build:federation`
- Use a hand-written `vite.config.ts` (not `createPackageConfig`)
- Document in its `AGENTS.md` why it needs all three modes

Don't scaffold federation/standalone for a package unless there's a real consumer. `commerce`, `ads`, `affiliates`, `ledgers`, `analytics` — currently library-only — should stay that way.

---

## 10. Templates

Templates ship a `template/` directory that is copied wholesale by the scaffold tool.

### Rules

- `template/package.json` always `private: true`
- `template/package.json` and `template.config.js` SMRT versions match the monorepo's current major (do not pin to `^0.17.0` while monorepo is at `0.23.x`)
- All files referenced in `template/package.json` scripts must actually exist in `template/`
- `template/README.md` ≥100 lines, explaining the scaffolding flow and runtime parameters
- CI verifies that `pnpm install && pnpm build` succeeds in each scaffolded template (would have caught the `template-site-static-json` missing-`caelus.ts` bug)
- Scaffolded SvelteKit templates must ship `typecheck` as a TypeScript pass plus `svelte-check`; otherwise generated projects inherit the `.svelte` ambient typing gap.

---

## 11. Forbidden artifacts

These never belong in `packages/*` and should be `.gitignore`'d at the repo root:

Local Lefthook checks enforce the highest-signal subset of this list on staged
files. The same hook suite also runs deterministic SMRT knowledge freshness
checks:

- pre-commit: `pnpm knowledge:check --changed --strict --format markdown`
- pre-push: `pnpm knowledge:check --strict --format markdown`

Knowledge hooks are deterministic and local. They must not call Codex, Claude,
or any other model provider; model-assisted audits stay manual and must be
followed by the deterministic checker.

### Domain knowledge artifacts

Downstream packages and apps use `smrt-knowledge.json` as the deterministic
agent/developer contract. It is separate from `manifest.json`, which remains
runtime-focused.

- local dev/build artifact: `.smrt/smrt-knowledge.json`
- package build artifact: `dist/smrt-knowledge.json`
- package export, when published: `"./smrt-knowledge.json": "./dist/smrt-knowledge.json"`

Knowledge artifact generation is on by default in the SMRT Vite plugin. CLI and
MCP consume these artifacts through deterministic dev tooling; HTTP exposure is
off by default and must be enabled explicitly with `knowledge.api.enabled: true`.
Generated HTTP routes are GET-only and must require dev mode or configured admin
auth.

Use object-level `@smrt({ knowledge: false })` only to exclude an object from
authored agent context while preserving runtime manifest behavior. Use
`@smrt({ knowledge: { tags, summary, risks } })` for package-specific review or
architecture constraints.

If a package exports `./smrt-knowledge.json`, the package `files` allowlist must
publish `dist` or `dist/smrt-knowledge.json`, and the deterministic checker must
be able to find a current artifact.

### Model-assisted knowledge workflow

Use models as optional local reviewers, not as freshness gates:

1. Ask `smrt-dev-mcp` for deterministic context with `build-review-context`,
   `smrt-review`, `build-architecture-context`, or `smrt-architecture`.
2. For formal downstream reviews, fetch the portable `smrt-code-review` procedure
   with MCP tool `get-agent-skill` and follow it before writing findings.
3. Send the returned prompt bundle to Codex, Claude, or another model under the
   user's local plan.
4. Apply only reviewed changes to source docs or package expertise.
5. Re-run `pnpm knowledge:check --strict --format markdown` before committing.

When an automation needs to consume checker output, use
`pnpm knowledge:check --strict --format json`. Hooks and CI must stay
token-free; prompt bundles are the boundary between deterministic SMRT tooling
and optional model assistance. Bundled agent skills are procedural wrappers
around that boundary; they must not require a specific model provider or harness.

| Pattern | Source | Action |
|---|---|---|
| `vite.config.ts.timestamp-*.mjs` | Vite config write-cache | Add to root `.gitignore`; remove existing from agents, content (×2), tags |
| `vite.config.ts.bak` | Manual backups | Remove (currently in profiles, with legacy HappyVertical namespace refs) |
| `temp-test-manifest-gen-*.ts` | Manifest builder driver scripts | Generate to a gitignored path; remove existing from agents, users, ads, affiliates |
| `*.timestamp-*.mjs` | Vite write-cache | Catch-all for vite |
| `.DS_Store` | macOS finder | Add to root `.gitignore` |
| Empty `test-*.{js,mjs,ts}` files | Dev throwaways | Remove (currently in products) |
| `woohoo.txt`, ASCII-art dumps | Random | Remove |
| Binary assets >100KB in `src/` or package root | Misplaced | Move to top-level `assets/` if needed |
| Generated `.agents/smrt-framework.md` / `.claude/smrt-framework.md` | `smrt docs:agents` / compatibility `smrt docs:claude` output | Generate to consumer projects only; remove from package directories |
| Per-package `.changeset/` | Changesets at sub-package level | Move to repo root (currently in `cli/`) |
| Empty config files | Dead | Remove (currently in `vitest/vite.config.ts`) |

---

## Appendix A: audit snapshot

This is a snapshot of the monorepo as of the standards audit. Numbers reflect non-compliant packages; the [per-package issues](https://github.com/happyvertical/smrt/issues?q=is%3Aopen+is%3Aissue+label%3A%22type%3A+maintenance%22) track resolution.

### Headline non-compliance

1. `smrtVitestPlugin()` not used in 7 packages: config, types, scanner, tags, social, secrets, voice
2. Stale build/dev artifacts committed in 8 packages (see §11)
3. 6 packages ship with zero tests: affiliates, voice, tags, gnode, template-sveltekit, template-site-static-json
4. Templates pin `@happyvertical/smrt-core: ^0.17.0` while monorepo is at `0.23.11`
5. Historical packages drifted on `AGENTS.md` / `CLAUDE.md` shim publishing
6. `smrt-playground` previously had no package agent guidance

### Drift dimensions

| Dimension | Non-compliant packages |
|---|---|
| Hand-written `vite.config.ts` (not using `createPackageConfig`) | core, cli, config, types, scanner, products, secrets, content, assets, images, smrt-svelte |
| Wrong exports map condition order (`{import, types}`) | config, cli, types |
| Bare-string export targets | scanner |
| `@types/node` pinned to `24.10.9` (vs catalog `25.0.9`) | core, affiliates, prompts, features |
| Missing `typecheck` script | resolved (#1375) — every package ships one except `products` (carved out in check-standards EXEMPTIONS pending #1370) |
| Missing `prepack` / `verify:pack` | secrets, sites, properties, social, video, voice, ads, affiliates, ledgers, smrt-svelte, smrt-dev-mcp |
| Inconsistent `author` field | ~all (3 different forms in use) |
| Missing `repository` field | ~39 of 41 |
| Build target inconsistency (mix of es2022/node20/node24/unset) | core, cli, scanner, others unset |
| Test naming convention violations | core (mixes .test/.spec inverted), social (.spec only), places (mixes both) |
| Tests outside `src/__tests__/` | core, products, places, voice |
| Per-package SPEC/ARCHITECTURE/BRAINSTORM/MIGRATION files | core, agents, tags, places, events, facts, profiles, assets, messages, config, tenancy |
| Triple-consumption scaffolding without need | none (only products has it; this is correct) |
| UI registry pattern not used | assets, images, chat (chat builds the entry but no export declared) |
| Svelte peer range `^4.0.0 \|\| ^5.0.0` instead of `^5.18.0` | assets, images |

### Per-package open issues threaded into the audit

| Package | Open issues |
|---|---|
| core | #1003 (epic), #1009, #1010, #1011, #1024, #1127, #1139, #972, #1115 |
| cli | #1178, #1085 |
| tenancy | #1112, #1028, #1039 |
| users | #1028, #1039, #1115, #1021, #1136, #1178 |
| jobs | #1115, #1021 |
| agents | #1178, #1021 |
| profiles | #1136, #1178, #1085 |
| content | #1189, #1057 |
| assets | #1057 |
| images | #1022, #1127 |
| commerce, ledgers, ads | #1021, #1178 (cross-cutting) |
| affiliates | #997 |
| products | #1136 |
| analytics | #1021 |
| places | #1152 |
| secrets | #1112 |
| smrt-svelte | #1028, #1021, #1178, #1189 |

### Issues likely closeable on this audit pass

- #1136 — `smrt-prompts` package now exists at `0.23.11`. Close.
- #1003 (and children #1009, #1010, #1011) — verify against current state of `core/src/registry.ts`. Likely partially complete.
- ~13 issues with `stale` label — triage and close or revive.

---

## Appendix B: rationale for changes

A few of the rules above remove something that's currently in the repo. Justification:

**Why kill per-package `SPEC.md` / `ARCHITECTURE.md`**: They drift. `core/ARCHITECTURE.md` is 970 lines and has not been updated in line with the registry refactor tracked by #1003. `assets/SPEC.md` is 473 lines and predates the `content_assets` ownership migration tracked by #1057. Living architectural documentation belongs in `docs/architecture/` where it gets reviewed alongside code changes, not buried in package directories where readers don't think to look.

**Why force `repository.directory`**: GitHub renders package READMEs from this field. Without it, packages on the GitHub registry show no source link and contributors cannot navigate from the registry to the code.

**Why exports condition order matters**: Node's resolution picks the first matching condition. If a consumer imports the package and `import` matches before `types`, TypeScript silently falls back to `dist/index.js` for type info, which provides no types. The bug is invisible until a downstream user complains about losing autocomplete.

**Why mandate `createPackageConfig`**: Hand-written vite configs duplicate ~80 lines of boilerplate per package and drift independently. Build targets, externals, and DTS settings that should be uniform are not. The base config is the only viable lever for a coordinated change (e.g. swapping the bundler).

**Why `smrtVitestPlugin()` is non-negotiable**: It generates the manifest at vitest startup. Without it, tests pass that should fail (because cross-package classes aren't loaded) and tests fail with "No field metadata" for reasons that look like a bug in user code. The framework's own foundation packages currently violate this; they should be the first to fix it.
