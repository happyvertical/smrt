# M5 browser gate (#2579)

`e2e/` holds the milestone-M5 acceptance gate (#2579): a Playwright pass that
provisions a fresh copy of the generated app into a temporary root, runs its
own `app:setup` build/migrate/bootstrap, serves it on an ephemeral loopback
port, and drives WebMCP discovery, execution, authorization, consent, disposal,
and redaction in a real browser. The only fabricated thing is
`document.modelContext`, which no headless browser exposes; database,
collections, handlers, session, and every registration are the application's
own. Never add a mocked REST handler, an in-memory database, or DOM automation
presented as WebMCP execution.

- `@happyvertical/smrt-cli` is a devDependency **because the gate needs it**:
  the harness runs the app's own `smrt app setup` and `smrt app dev` from the
  linked CLI, and setup's `pnpm build` is `smrt app build`. The copied app
  deliberately never runs `pnpm install`, so `smrt` has to arrive through the
  linked `node_modules`. The harness pins the app's own `.bin` ahead of `PATH`
  and fails with a named error if the binary is missing, so a host-global
  `smrt` cannot make a local run pass where CI fails. Identity and state-root
  values it checks come from `@happyvertical/smrt-app-runtime`.
- `pnpm test:e2e` runs the browser half. `e2e/typecheck.spec.ts` also runs the
  copied app's own `svelte-kit sync` + `svelte-check` after setup, because the
  package `typecheck` (`tsc` over `tsconfig.fixture.json`) never sees the
  template's `.svelte` files; `svelte-check` is a devDependency so the harness
  links it into the copy (#3860).
- `pnpm test:m5` runs the whole aggregate gate through
  `e2e/support/gate.mjs`, which requires a PostgreSQL service and fails when a
  required profile case is missing rather than merely absent from the log.
- Tracing, video, and screenshots stay off: onboarding carries a single-use
  bootstrap token in a URL.
- `m5-gate-summary.json` is the one file the gate writes inside the package;
  it is gitignored, overwritten every run, and is what CI uploads. Everything
  else it generates stays in a test-owned temporary root. Playwright's
  `outputDir` is `$TMPDIR/smrt-m5-artifacts`, emptied by
  `e2e/support/globalTeardown.ts`; `e2e/redaction.spec.ts` reads that path back
  from `testInfo.project.outputDir` and asserts it is outside the repository.
  The harness gives the copied app a real `node_modules` directory of
  individually symlinked entries rather than one symlink to this package's, so
  the served app's `node_modules/.vite` cache cannot land in the checkout.
  Scope directories (`@happyvertical/`) and `.bin/` are real directories of
  per-entry links too: the copy ships `pnpm-workspace.yaml` and setup runs
  `pnpm build` in it, so anything pnpm relinks must land in the copy, never in
  this package's `node_modules`. Never replace either loop with a
  whole-directory symlink.
- `e2e/` is outside `biome.json`'s include globs, as every package's `e2e/` is,
  so a green `Lint` job says nothing about this tree. `pnpm typecheck` covers
  the `.ts` files (`tsconfig.fixture.json` includes `e2e/**/*.ts`) but NOT
  `e2e/support/gate.mjs`, which no static analysis reaches. Its `emit()`
  vocabulary guard is the runtime backstop; edit it carefully and run
  `pnpm test:m5` after any change to it.

See [the M5 reference fixture gate](../../docs/content/m5-reference-fixture.md)
for what the milestone proves, what it does not, and the recovery commands.

Runtime report confirmation mounts the reports-owned Fetch handler at
`/api/_reports/runtime/confirm`. It passes verified locals and the request's
collection database; smrt-app-runtime has no reports dependency. The template
consumes the reports manifest for migrations and explicitly hosts only
`@happyvertical/smrt-reports:RuntimeReport` through the Vite preset’s `expose` option. Apps enabling
`reports.runtime` configure `packages.reports.runtime.sources`; the default
empty allow-list exposes no report sources. The authored route is preserved by
the template's `.gitignore` exception.
