---
title: The M5 reference fixture gate
---

# The M5 reference fixture gate

M5 is the milestone that answers one question with evidence instead of
assertion: **does a generated s-m-r-t application keep the same domain,
the same generated surface, the same policy, and the same agent-addressable
behaviour when it moves between runtime profiles — and does a real browser
actually see that surface?**

The gate is a single CI job, `M5 Reference Fixture Gate`, in
[`test-suite.yml`](https://github.com/happyvertical/smrt/blob/main/.github/workflows/test-suite.yml).
It runs the completed M5 scenarios together so they cannot drift apart, and it
fails when a case is *missing* as loudly as when a case fails.

Tracking: [#2547][m5] (milestone), [#2542][m5-parent] (programme),
[#2574][m5-context] (context), and [#2533][pr2533] (browser lifecycle,
authenticated REST, namespace, exposure and consent semantics).

[m5]: https://github.com/happyvertical/smrt/issues/2547
[m5-parent]: https://github.com/happyvertical/smrt/issues/2542
[m5-context]: https://github.com/happyvertical/smrt/issues/2574
[pr2533]: https://github.com/happyvertical/smrt/pull/2533

## What M5 proves

- A **clean temporary copy** of the published SvelteKit template, plus a
  representative application overlay, builds, migrates, and starts from a
  state root that lives entirely outside the checkout.
- Owner onboarding completes through the application's own `/setup` form with
  a real single-use bootstrap invitation, and the invitation is consumed: the
  on-disk handoff is removed and the token appears in no test output or
  retained artifact.
- A **fresh browser context** receives exactly one deterministic test
  boundary, `document.modelContext`. The database is file-backed SQLite on
  disk, the collections and REST handlers are the generated ones, the session
  is a real cookie issued by the application, and every WebMCP registration
  is the page's own.
- Discovery returns a **bounded domain inventory** plus exactly one
  authenticated read-only diagnostic tool
  (`smrt.runtime.diagnostics.read`), with effects and approval metadata
  matching the cross-profile parity snapshots.
- A permitted read **executes through WebMCP as the page user** and observes
  state that was persisted through the ordinary REST path.
- Write, external, and destructive operations stay behind their declared
  consent boundary: the template's Provider declares a read-only exposure
  policy, so they are never registered, and the harness has no confirmation
  path that could approve one.
- Anonymous and forged sessions **fail closed** at both boundaries — the
  generated REST surface and WebMCP — with no projection leaking before
  authorization.
- Client-side navigation and reload **leak no duplicate registrations** and
  nothing accumulates: every registration in this application is owned by the
  root layout, so navigating between routes must neither tear one down nor
  register it again, and a reload starts from an empty model context.
- Captured responses and retained artifacts carry none of the prohibited
  diagnostic fields, tokens or hashes, PII, absolute paths, database URLs, or
  stack traces.
- The same generated surface, policy, and job behaviour hold across the
  **local, self-hosted, and cloud** profile compositions, and the fixture
  schema migrates on **real PostgreSQL**.

## What M5 does not prove

- **Nothing is deployed.** The cloud profile is a *configuration snapshot*:
  the composition is resolved and its generated surface compared. No hosted
  provisioning, credentials, billing, or control plane is involved, and a
  green cloud case is not evidence that a deployment works.
- **No production browser polyfill.** `document.modelContext` does not exist
  in headless Chromium; the gate installs a deterministic host for it. That
  boundary forwards `execute()` straight to the page's own tool, so what is
  proven is the application's behaviour, not a browser vendor's.
- **Registration failure is not exercised.** The real WebMCP contract lets a
  browser reject a tool, which rejects the disposer's `ready` and aborts its
  siblings. The harness's `registerTool` always resolves, so that path is
  covered by unit tests in `smrt-web`, not here.
- **The production web writer is not exercised.** The gate serves the app with
  `vite dev`, a supported local writer, rather than `app:start`'s adapter-node
  build. The operation lock, PID record, and stale-process rejection in
  `scripts/smrt-app.mjs start()` are therefore out of scope; `app:setup`'s
  build, migrate, and bootstrap pass is in scope and does run.
- **No model in the loop.** No external AI model, no principal-bound server
  tool, and no mocked REST handler participates.
- **Response redaction covers the runtime namespace's JSON contract**, not
  SvelteKit's HTML fallback page. The gate serves the app under `vite dev`, so
  the browser sees real unbundled sources — and the dev-mode error page embeds
  module URLs from the app root by design. `e2e/redaction.spec.ts` therefore
  scans JSON responses and skips the HTML fallback. Retained artifacts are
  scanned unconditionally.
- **The redaction perimeter is the artifact, not the job log.** A failing run
  deliberately puts vitest and Playwright reporter output — assertion text,
  stack frames, runner paths — on stderr, because a required check that failed
  with nothing but a case id is not diagnosable. The bootstrap token is the one
  value held to the stricter standard: the harness registers it with
  `::add-mask::` before any fixture can echo it, so it is redacted in the log
  as well. The uploaded artifact remains summary-only.
- **Not a performance or load result.** The gate is about determinism.
- **Not full permission coverage.** The onboarded owner's role does not grant
  the template's authored `items.read` page permission, so the example page
  renders its access notice. The generated REST surface and the WebMCP read
  tools are exercised instead.
- **Generated list tools are not exercised end to end.** The generated REST
  list route answers `{ items, count, limit, offset }` while
  `unwrapListResult()` in `@happyvertical/smrt-web` accepts only a bare array
  or `{ data: [...] }`, so a `*_list` WebMCP call fails on payload shape. The
  gate executes `*_get` instead. This is a real defect in the generated
  client/route contract, tracked as #2639; it is outside the M5 ownership
  boundary.

## Running it locally

The gate needs a PostgreSQL service and a Chromium build. From the repository
root:

`CI_POSTGRES_BASE_URL` is not optional. The gate refuses to run against an
unmanaged `DATABASE_URL`, because only a managed base URL makes the test
wrapper create and drop a disposable database.

```bash
# Once: browsers and workspace dependencies.
pnpm install
pnpm exec playwright install --with-deps chromium

# Build the packages the copied application resolves against.
pnpm turbo run build --filter='@happyvertical/smrt-template-sveltekit...'

# The whole gate, exactly as CI runs it.
CI_POSTGRES_BASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm --filter @happyvertical/smrt-template-sveltekit test:m5
```

The browser half alone, which needs no PostgreSQL:

```bash
pnpm --filter @happyvertical/smrt-template-sveltekit test:e2e
```

### Recovery

| Symptom | Cause | Recovery |
| --- | --- | --- |
| `PostgreSQL tests require CI_POSTGRES_BASE_URL, …, or DATABASE_URL` | No PostgreSQL service, and no `DATABASE_URL` in the environment | Start a service and set `CI_POSTGRES_BASE_URL`. |
| `Refusing an unmanaged PostgreSQL target` | `DATABASE_URL` is exported but `CI_POSTGRES_BASE_URL` is not | Set `CI_POSTGRES_BASE_URL`. Only a managed base URL makes the wrapper create and drop a uniquely named database; an unmanaged `DATABASE_URL` would have the M5 fixture schema migrated into your real database and left there, so the gate refuses it rather than running. |
| `required browser case … did not run` | A browser spec was skipped or renamed | The gate matches browser cases by title, exactly as it does the vitest cases. Restore the spec or update its entry in `e2e/support/gate.mjs`. |
| `required case … did not run` | A prerequisite issue has not landed | The message names the issue. Land it; do not weaken the gate. |
| `Application state path component is unsafe` | The temporary root resolves through a symlink (macOS `/var`) | Already handled by the harness; if it reappears, check `TMPDIR`. |
| `The reference app exited before becoming ready` | The workspace build is stale | Re-run the `turbo run build` filter above. |
| `A different server answered on the reserved port` | Port reuse race | Re-run; the harness reserves a fresh ephemeral loopback port each time. |
| `The served runtime configuration fingerprint does not match the harness expectation` | The right process answered with an unexpected configuration — usually a new provider override or runtime field in the template's `smrt.config.ts` | Not a race; re-running will not help. Update the harness's expectation in `e2e/support/referenceApp.ts` to match the new configuration. |
| Leftover temporary roots | A run was killed between provisioning and cleanup | `rm -rf "${TMPDIR:-/tmp}"/smrt-m5-*` |

## The diagnostic allowlist

`/api/_runtime/diagnostics` requires a direct active tenant membership plus
either the owner role or the explicit `runtime_diagnostics.read` permission,
and projects onto a fixed public shape before returning anything:

- `schemaVersion`, `profile`, `health`
- `schema.status`, `schema.migrations`
- `capabilities[].id`, `capabilities[].status`
- `tools.names`, `tools.count`, `tools.digest`
- `operationalDifferences`, `worker.*`, `recentErrors[].code`,
  `recentErrors[].at`

Everything else is prohibited and asserted against in
`e2e/redaction.spec.ts`: database URLs and connection strings, data/state
directories, secrets, tokens and token hashes, password hashes, session ids,
stack traces, cookies, request headers, environment dumps, absolute
filesystem paths, and bearer credentials. `tools.digest` is the one long hex
value the projection may carry — it exists so a caller can detect surface
drift without being told the surface.

## Dependency order

M5 lands in order, and each step is a prerequisite of the next:

1. **[#2575][] M5a** — the reusable runtime-profile reference workload fixture.
2. **[#2576][] M5b** — verified asset manifests migrating across profiles.
3. **[#2577][] M5c** — authenticated redacted runtime diagnostics over WebMCP.
4. **[#2578][] M5d** — generated-surface, policy, and job parity across
   profiles, including the canonical inventory helpers this gate compares
   against.
5. **[#2579][] M5e** — this gate: the fresh-browser WebMCP pass and the
   cross-profile CI aggregation.

[#2575]: https://github.com/happyvertical/smrt/issues/2575
[#2576]: https://github.com/happyvertical/smrt/issues/2576
[#2577]: https://github.com/happyvertical/smrt/issues/2577
[#2578]: https://github.com/happyvertical/smrt/issues/2578
[#2579]: https://github.com/happyvertical/smrt/issues/2579

## Downstream gate

**A green M5 CI run is the gate before the Iolaus extraction in
[`willgriffin.dev#364`](https://github.com/willgriffin/willgriffin.dev/issues/364).**
That extraction assumes a generated application can be lifted between runtime
profiles without its domain, generated surface, policy, or agent behaviour
changing underneath it. M5 is the evidence for that assumption. Do not start
the extraction against a red or partially-skipped gate: a skipped profile
case is exactly the failure mode the extraction would inherit.

## Artifact policy

The gate uploads one file: `packages/template-sveltekit/m5-gate-summary.json`,
a sanitized JSON summary of case ids and booleans, written by
`e2e/support/gate.mjs` itself. Vitest and Playwright reporters go to stderr, so
their assertion text, absolute paths, and stack frames never reach the
summary, and the script refuses to write a summary containing any value
outside its fixed vocabulary.
Playwright tracing, video, and screenshots are disabled for every step —
onboarding carries a single-use token in a URL, and a trace would capture it.
The harness also masks that token with `::add-mask::` before onboarding runs,
so a failed navigation cannot echo it into the job log either.
Databases, export bundles, browser profiles, cookies, bootstrap artifacts,
and raw traces are never uploaded, and every temporary root is removed when
its worker finishes. Retention is seven days.
