# smrt-planner

The smrt planner: a visitor picks recipes from every package's manifest and an
app mock-up assembles around them, showing what smrt generates from a decorated
model, then exports the plan as a **cookbook**. Everything runs in the browser;
there is no server, database or smrt runtime. It ships as a mountable Svelte
component with a typed command set (`.`, `./commands`), a Node-safe `./core`,
and the prebuilt static app plus its MCP widget (`./app`, `app/mcp.html`).

It was `happyvertical/smrt-planner` (own 0.1.x line, archived); it now releases
in lockstep with every other smrt package.

## The rule this package exists for

This package holds **planner application logic only**. If the shell, a package
manifest or the generated surfaces are wrong or missing something, that is a
framework gap: fix it in the owning package in this monorepo, in the same pull
request where you can, and delete the workaround here. Never add a shim or a
hand-maintained copy of what a manifest says (`src/lib/upstream/` holds the
tracked stand-ins; each names its issue).

## Modules

| Module | Reference |
| --- | --- |
| Catalog generation, recipes, Features tab | [agents/catalog.md](agents/catalog.md) |
| Cookbook document, theme, settings, library cookbooks | [agents/cookbook.md](agents/cookbook.md) |
| Command set and the `./core` / `./app` exports, packaging | [agents/commands.md](agents/commands.md) |
| Assistant, inference hosts, Send to kitchen, AI setup | [agents/assistant.md](agents/assistant.md) |
| Sections, overviews, forms, fields, sample data, components, routes | [agents/shell.md](agents/shell.md) |

Longer references: `docs/plan-app.md`, `docs/inference-host.md`,
`docs/mcp-widget.md`; `docs/test-matrix/` holds the per-issue test matrices
from the planner's own repository (issue links there point at it).

## Invariants

- Fully static: `adapter-static`, `prerender = true`, `trailingSlash = 'always'`.
  Never read `url.searchParams` during prerender; the selection is read in the
  browser after navigation.
- Forced colours (Windows High Contrast): where a custom style shows selected, pressed, current or
  disabled state only by colour or background, add an `@media (forced-colors: active)` rule using
  `Highlight` / `HighlightText` (selected, current) or `GrayText` (disabled); colour swatches use
  `forced-color-adjust: none`. Use rem lengths there: the style-literal allowlist counts px.
- Money fields are integer minor units everywhere (fakes, form state, storage);
  they are formatted as currency only for display.
- Fakes are deterministic: seeded, fixed clock, no `Math.random()`/`Date.now()`.
- The catalog generator is deterministic: sorted output, no timestamps. Packages
  are excluded only through `exclusions.ts`, and a listed package that declares
  recipes stays in the catalog.
- Depend on `@happyvertical/smrt-*` packages through `workspace:*`; every package the catalog
  reads is a devDependency (`tests/catalog-sources.test.ts`).
- Never commit `src/lib/catalog/catalog.json` or `src/lib/smrt-version.ts`: both are build
  outputs, so the released planner cannot drift from the packages released beside it.

## Validation

From the monorepo root:

```bash
pnpm turbo run build --filter=@happyvertical/smrt-planner...   # catalog sources first
pnpm --filter @happyvertical/smrt-planner typecheck
pnpm --filter @happyvertical/smrt-planner test   # incl. library cookbooks vs the workspace catalog
pnpm lint                                        # root Biome and the --smrt-* gates
```

`*.dom.test.ts` run in the `dom` Vitest project (happy-dom). Changes to the
hosted planner, the MCP widget or the Kitchen bridge also run
`test:mcp-browser` and `test:live-preview-browser` (Chrome, Chromium, or
Playwright's Chromium); PR CI runs both when planner paths change. A packed
tarball is exercised with `test:package -- <tarball>`; the release pipeline
runs it, the browser suites and a real `smrt cookbook apply` against the
release's own tarballs before publishing (`scripts/planner-release-gate.mjs`).

Exempt from `smrtVitestPlugin()` (`scripts/check-standards.mjs`): the planner
declares no `@smrt()` classes and its tests must consume the built packages as a
consumer does. `app` in `files` is a build output for the same reason as above.
