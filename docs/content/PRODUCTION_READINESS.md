# SMRT Production Readiness Rubric

> Status: **Ratified 2026-06-05** (epic #1354: production hardening). The shared bar
> every package is measured against as we move from "move fast and break things" to
> "slow down and stabilize." Audits score packages against it; remediation closes the
> gaps; CI ratchets lock the gains in so they cannot regress.

## How to use this document

- **Auditors** run the per-package audit and fill in the [Scorecard](#scorecard-template),
  one row per dimension, citing the exact command or `file:line` as evidence.
- **Implementers** close punch-list items, then add or tighten the matching
  [enforcement ratchet](#enforcement-ratchets) so the fix is permanent.
- A dimension is **PASS / FAIL / N/A-for-tier** — objective, with a proof command.
  "Looks fine" is not a status.

## Review passes

A package's readiness comes from layered passes, all scored against this rubric:

1. **Breadth audit** (Wave 1) — read-only triage across all 10 dimensions; produces
   the scorecard + punch-list. Cheap, parallel, the map for everything else.
2. **Security audit** (per package) — dedicated AppSec pass: tenant isolation, the
   users permission cascade on generated api/mcp/cli surfaces, injection
   (SQL/command/path/SSRF), secret & crypto handling, dependency risk.
3. **Deep code review** (per package) — correctness + architecture + maintainability,
   with the **style & consistency** check folded in (STYLE_GUIDE.md, design tokens,
   API consistency, JSDoc, logging idioms).
4. **Tests to standard** — coverage raised to the tier floor under the real-resource
   policy, then enforced by the per-tier coverage gate.

Audits and deep reviews emit *findings*, not edits; remediation closes them; the
enforcement ratchets lock each standard into CI.

## Tiers

Not every package earns the same bar. A scaffold should not be failed for missing
coverage; a stub should not masquerade as production code. Each package is assigned
one tier; the dimension table states what each tier must satisfy.

| Tier | Definition | Coverage floor |
|------|------------|----------------|
| **T1 Foundation** | Everything depends on these. Highest bar. | 80% |
| **T2 Mature domain** | Substantial, actively-consumed (or high-risk) domain packages. | 70% |
| **T3 Light domain** | Real but thin domain/tooling packages. Full bar minus the coverage stretch. | 50% |
| **T4 Stub / scaffold** | Intentionally incomplete or generative. Must be honest about it. | none |

### Tier assignments (all 48 packages)

- **T1 (7):** `cli` · `config` · `core` · `scanner` · `tenancy` · `types`† · `vitest`
- **T2 (12):** `agents` · `assets` · `chat` · `commerce` · `content` · `jobs` · `ledgers`‡ · `messages` · `profiles` · `secrets`‡ · `smrt-svelte` · `users`
- **T3 (24):** `ads` · `affiliates` · `analytics` · `app-cli` · `assets-ergot` · `assets-local` · `events` · `facts` · `features` · `images` · `inventory` · `languages` · `manufacturing` · `places` · `products` · `projects` · `prompts` · `properties` · `sites` · `smrt-dev-mcp` · `social` · `tags` · `video` · `voice`
- **T4 (5):** `gnode` · `smrt-app-mcp` · `smrt-playground` · `template-site-static-json` · `template-sveltekit`

> † `types` is zero-runtime (pure types/enums) → coverage is **waived**; all other dimensions apply.
> ‡ `ledgers` (double-entry, balance enforcement) and `secrets` (envelope encryption) are thin by size but held to the **T2** bar because a defect there has outsized blast radius.
>
> A T4 package MUST be explicitly labeled a stub/scaffold in its docs — "not done"
> must never be mistaken for "done." Tiers may move as packages mature.

### Coverage-floor policy: hard floor

A PR that touches a package must bring that package to **at or above its tier floor**
to merge — existing debt is not grandfathered. This is intentionally strict: the
point of the stabilize phase is that you cannot add to a package without leaving it at
standard. Enforced by the coverage gate (sweep S6, #1411): the `Coverage Gate` CI job
runs `scripts/check-coverage.mjs`, which measures per-package line coverage for the
packages a PR touches and fails any below its tier floor. Under-floor packages a PR
does not touch are not blocked; bringing them to floor is Wave 3 remediation.

"Touches" means changing a package's **shipped source** (`src/**`, excluding
`*.test`/`*.spec`/`__tests__`). Config-only (`vitest.config`/`tsconfig`/
`package.json`), test-only, and docs changes do **not** trigger the floor — they
add no testable surface, so a vitest-timeout tweak or a test-only PR isn't
blocked by a package's pre-existing coverage debt.

A below-floor package is also **not blocked when the PR cannot have changed its
covered surface** — specifically when every touched file is an in-place
*modification* (no add/delete/rename) **and** none of those files appear in the
coverage report. That covers a `.svelte`-only refactor in a package without
component tests (a UI consolidation, S10 #1415): the change can't move the
measured number, so the shortfall is pre-existing debt the PR didn't cause
(Wave 3), not a regression to block on. Anything that *can* shift coverage still
gates: a modified file that **is** measured (e.g. `content`'s component-tested
`.svelte`), or any **added/deleted/renamed** source in a below-floor package.

**Interim ratchet floor.** The hard floor with only the exemptions above would
*freeze* a below-floor package the moment a PR legitimately adds new measured
source to it (the modified-only exemption can't cover a new file) — even though
bringing the whole package to its tier floor is Wave 3 work, not that PR's job.
For such a package, `INTERIM_FLOORS` in `check-coverage.mjs` pins an interim
floor at its **measured baseline** instead: regressions below the baseline still
block, but the PR isn't forced to close the entire tier gap. This is the
narrowest possible relaxation — it never lowers an at-floor package and is
deleted the moment the package reaches its tier floor. The uplift itself is
tracked as a per-package Wave 3 issue (core measured ~66% vs the T1 80% floor →
interim floor 65%, uplift #1500).

**Gate exemption — `smrt-svelte` and `vitest`.** The v8 line-coverage gate can't instrument
`.svelte` files, so for a Svelte-heavy package the `.ts`-only measure is both
unrepresentative and unstable (rendering a component in a test pulls its untested
transitive `.ts` into the denominator, so adding tests can *lower* the number).
`smrt-svelte` is therefore exempt from the line-coverage gate
(`GATE_EXEMPT` in `check-coverage.mjs`); its real component-coverage bar is the
deliverable of sweep S11 (#1416, UI test harness + axe). Remove the exemption
when S11 lands. `vitest` (`@happyvertical/smrt-vitest`) is exempt for a
different reason: it is the shared test/build plugin whose uncovered surface is
the Vite plugin lifecycle, exercised through every other package's test run
rather than its own unit line-coverage.

## Dimensions

Legend: ✅ required · ➖ waived for tier · ⚠️ best-effort (not blocking).

### 1. Packaging & scripts
**PASS when:** `package.json` has `build`, `test`, and `typecheck` scripts — lint and
format are **root-level Biome tasks, not per-package scripts** (per `standards.md`);
`type: "module"`; `exports` map orders the `types` condition before `import`; `files`
allowlist includes `dist`, `AGENTS.md`, **and** `CLAUDE.md` (all three enforced by
`check-standards.mjs`); `tsconfig.json` is `composite` with correct project `references`.
**Proof:** `node scripts/check-standards.mjs` · `pnpm --filter <pkg> typecheck` · lint/format via root `turbo lint` / `npm run format-check`
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ✅

### 2. Type safety
**PASS when:** no `any` in public signatures; no `@ts-ignore` / `@ts-expect-error`
without a one-line justification; package does not rely on the blanket Biome
`noExplicitAny` source override; `typecheck` is clean under root `strict: true`.
**Proof:** `pnpm --filter <pkg> typecheck` · `rg '\bany\b|@ts-(ignore|expect-error)' packages/<pkg>/src`
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ✅

### 3. Lint & format
**PASS when:** clean under `biome ci` with no errors; every `// biome-ignore`
carries a one-line reason; no reliance on per-package overrides that disable
recommended rules.
**Proof:** `npx biome check packages/<pkg>` · `npm run format-check`
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ✅

### 4. Tests
**PASS when:** coverage meets the tier floor; tests follow the real-resource policy
(real in-memory SQLite via `createIsolatedTestDb*`; mock ONLY external APIs —
`@happyvertical/ai`, HTTP — never SmrtObject/SmrtCollection/agents/business logic);
correct naming (`*.test.ts` unit, `*.spec.ts` integration, `*.optional.test.ts`
external) **and** the package's `vitest.config.ts` actually discovers both `*.test.ts`
and `*.spec.ts` (many configs include only `*.test.ts`, so `*.spec.ts` files silently
never run); every fixed bug has a regression test; clean `afterEach`/`afterAll`.
**Proof:** `pnpm --filter @happyvertical/smrt-<pkg> exec vitest run --coverage` (the form in `TESTING_STANDARD.md`) · `.claude/rules/testing.md`
**Tiers:** T1 ✅ (80%) · T2 ✅ (70%) · T3 ✅ (50%) · T4 ➖ (smoke test only)
> Tier floors **refine** `TESTING_STANDARD.md`'s blanket 80% line-coverage minimum:
> T1 retains 80%; T2/T3 are interim stabilization floors, ratcheted toward 80% as
> packages are uplifted (Wave 3). See [Coverage-floor policy](#coverage-floor-policy-hard-floor)
> for how the gate handles packages still below their floor (interim ratchet floor).

### 5. SMRT pattern compliance
**PASS when:** `@smrt()` usage is correct; same-package FKs use `@foreignKey`,
cross-package use `@crossPackageRef`; `toJSON()` is never overridden (use
`transformJSON()`); `0` vs `0.0` matches INTEGER vs DECIMAL intent; junctions set
`conflictColumns`; JSON fields use `getX()`/`setX()` helpers with guarded parse;
system tables are `_smrt_`-prefixed; no private reach-ins (`_db`, `_tableName`,
registry internals) from outside the owning class.
**Proof:** `smrt dev:knowledge-check --format json` · smrt-dev-mcp `smrt-review` ·
`.claude/rules/smrt-patterns.md`
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ⚠️

### 6. UI & design tokens *(packages with `.svelte` files)*
**PASS when:** no hardcoded color literals (hex / `rgb(a)` / `hsl()` / named) in
style blocks — components consume `--smrt-color-*` (and `--smrt-spacing/radius/
elevation-*`) tokens; `var(--token, #fallback)` is allowed only when the fallback
equals the token's real light value; basic a11y (labels, roles, focus states).
**Proof (current):** `rg -n '#[0-9a-fA-F]{3,8}|rgba?\(|hsl\(' packages/<pkg>/src --glob '*.svelte'` (deterministic) · theme source: `packages/smrt-svelte/src/theme/tokens.ts`
**Future ratchet (not yet wired):** design-token lint rule (#1373), component test harness + axe (#1416), a11y enforcement (#1417). The svelte MCP autofixer is a local authoring aid, not a CI gate.
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ⚠️ (applies only if it ships `.svelte`)

### 7. Documentation
**PASS when:** package has an `AGENTS.md` expert doc (canonical) and a one-line
`CLAUDE.md` shim containing only `@AGENTS.md`; a `README.md` exists; doc content
is fresh — `smrt dev:knowledge-check` passes with no stale references.
**Proof:** `smrt dev:knowledge-check` · presence of `AGENTS.md` + shim `CLAUDE.md`
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ✅ (must state "stub/scaffold")

### 8. Public API hygiene
**PASS when:** `src/index.ts` barrel exports are intentional (no accidental leakage
of internals); public classes/functions carry JSDoc; no breaking changes to exported
surface without a changeset-worthy commit.
**Proof:** review `src/index.ts` · `pnpm --filter <pkg> build` (declaration emit)
**Tiers:** T1 ✅ · T2 ✅ · T3 ⚠️ · T4 ➖

### 9. Errors & logging
**PASS when:** uses `@happyvertical/logger` rather than `console.*` in library code;
JSON parsing is guarded (try/catch with graceful fallback); thrown errors are typed
and actionable.
**Proof:** `rg -n 'console\.' packages/<pkg>/src`
**Tiers:** T1 ✅ · T2 ✅ · T3 ⚠️ · T4 ⚠️

### 10. Security
**PASS when:** no committed secrets; tenant isolation holds on every query (no
cross-tenant leak via `loadRelated` without explicit `allowCrossTenant`); the users
permission cascade is enforced on `@smrt()`-generated api/mcp/cli surfaces; no
injection vectors (SQL / command / path / SSRF) in input handling; secret-bearing
fields use the envelope-encryption/sanitization paths; logs & exports are redacted;
no known-vuln dependencies.
**Proof (current):** manual AppSec review pass (the per-package security-audit issues in epic #1354) · `npx biome check` · config sanitization in `@happyvertical/smrt-config`
**Future ratchet (not yet wired):** gitleaks secret scanning (#1412), `pnpm audit` / osv-scanner dependency gate (#1413). `/security-review` is an optional local tool, not a repo-wired gate.
**Tiers:** T1 ✅ · T2 ✅ · T3 ✅ · T4 ✅

## Scorecard template

```markdown
## packages/<NAME> — Readiness Scorecard (Tier: <T1|T2|T3|T4>)

| # | Dimension              | Status        | Evidence (cmd / file:line) |
|---|------------------------|---------------|----------------------------|
| 1 | Packaging & scripts    | PASS/FAIL/N/A | |
| 2 | Type safety            |               | |
| 3 | Lint & format          |               | |
| 4 | Tests                  |               | |
| 5 | SMRT patterns          |               | |
| 6 | UI & design tokens     |               | |
| 7 | Documentation          |               | |
| 8 | Public API hygiene     |               | |
| 9 | Errors & logging       |               | |
| 10| Security               |               | |

**Overall:** READY | NEEDS WORK | NOT STARTED
**Effort:** S | M | L

### Punch-list
- [ ] [blocker|major|minor] [dim N] <issue> — file:line — fix sketch

### Systemic flags
(issues better fixed as a horizontal sweep than per-package)
```

## Enforcement ratchets

Every closed gap ends by tightening a deterministic, fast gate (no model-assisted
checks in hooks/CI — see AGENTS.md):

- **Packaging/scripts** → assert in `scripts/check-standards.mjs` (runs in CI).
- **Typecheck presence** → require a per-package `typecheck` script in `check-standards.mjs`; run `turbo typecheck` as a PR gate.
- **Lint/format** → root-level Biome only (no per-package `lint`/`format` scripts — `check-standards.mjs` should forbid them); `turbo lint` + `biome ci` + `npm run format-check` as PR gates.
- **Type safety / lint rules** → flip the Biome `packages/*/src/**` overrides
  off → warn → error, package by package, until the blanket override is deleted.
- **Design tokens** → add a Biome (root) lint rule banning raw color literals in
  `.svelte`/`.css`, wired into root Biome + lefthook + CI (#1373).
- **Coverage** → HARD floor: any package touched by a PR must be ≥ its tier floor (T1 80 / T2 70 / T3 50) to merge — no grandfathering. Enforced by the `Coverage Gate` CI job (`scripts/check-coverage.mjs`, S6 #1411).
- **Secret scanning** → gitleaks in lefthook pre-commit + CI; blocks committed credentials.
- **Dependency risk** → `pnpm audit` / osv-scanner as a CI check for known-vuln deps.
- **Security/correctness lint** → the Biome `security` group (`noGlobalEval`,
  `noDangerouslySetInnerHtml`/`noDangerouslySetInnerHtmlWithChildren`,
  `noBlankTarget`) plus `suspicious.noDocumentCookie` are pinned to **error** in
  the root `biome.json` and enforced repo-wide by `biome ci` (S9, #1414). These
  are explicit (not just inherited from `recommended`) so they survive a future
  `recommended` change or a new package-scoped override.
  **Per-package rollout plan:** the heavier strictness rules — `noExplicitAny`
  (~3.1k sites), `noUnusedVariables`, `noUnusedImports` — remain relaxed by the
  `packages/*/src/**` override and are flipped off → warn → error *package by
  package* under the strictness ratchet (S4, two bullets up), not in one giant
  breakage. S9 ships only the security/correctness rules that are already
  repo-clean and can be enforced globally today.
- **Logging (dim 9)** → enable Biome `suspicious.noConsole`
  (`lint/suspicious/noConsole`) as an error in the root config for
  `packages/*/src/**` library code, with scoped overrides for tests, scripts,
  and CLI entrypoints. `@happyvertical/logger` is the sanctioned logger; the
  rule gates all `console.*` calls, including `console.info` and
  `console.debug`, instead of relying on the manual dim-9 `rg` proof. Migration
  tracked in S14 #1432.
- **Docs freshness** → `smrt dev:knowledge-check` as a PR gate.

A fix that is not gated will rot back. Gating is the difference between a cleanup
and a permanent standard.
