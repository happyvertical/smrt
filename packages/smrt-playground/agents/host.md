# host

Private SvelteKit fixture that hosts the shared playground for the
`@happyvertical/smrt-playground` Playwright suite. It is a workspace test
fixture — not a published package and not an application template.

It is registered as the `smrt-playground-host` workspace package but is
documented here: instruction chains are additive, so a nested `AGENTS.md` under
`host/` would load on top of this package's own and is prohibited.

## Layout

Paths are relative to `host/`.

- `src/routes/+page.svelte` — the single route; renders `PlaygroundHost` from the
  parent package against every discovered `./playground` module
- `src/app.html` — SvelteKit document shell
- `svelte.config.js` — `adapter-static` with `strict: false`, because the
  playground routes are discovered at build time rather than prerendered
- `vite.config.ts` — wires the parent package's playground vite plugin
- `src/routes/theme-gallery/+page.svelte` — theme identity page (`?theme=&scheme=`); `e2e/theme-gallery.spec.ts` holds its visual baselines
- `e2e/shared-playground.spec.ts` — asserts the host boots and that no page or
  console errors surface from any discovered playground entry

## Validation

```bash
pnpm --dir packages/smrt-playground/host build
pnpm --dir packages/smrt-playground/host test:e2e
```

## Theme gallery and visual baselines

`/theme-gallery?theme=<preset>&scheme=light|dark` composes one screen (app shell with nav, account
menu and a dock tool, a form card, data table with a selected row, tabs, chips, badges, four alerts,
an open menu, a toast, heading stack and tabular figures) so every preset is reviewed on the same
content. `e2e/theme-gallery.spec.ts` screenshots five presets x light/dark at 1280 px plus five
phone (375 px, dark) variants and compares them (`maxDiffPixelRatio` 0.01).

Update baselines after an intentional visual change:

```bash
pnpm --filter smrt-playground-host test:e2e:update-snapshots
```

Baselines in `e2e/theme-gallery.spec.ts-snapshots/` are Chromium on macOS (`*-darwin.png`). CI runs
on Linux, where text rendering differs, so the spec only asserts the page renders there and skips
pixel comparison when `process.platform !== 'darwin'`. Set `THEME_GALLERY_SHOTS_DIR` to also write
readable `<preset>-<scheme>-<width>.png` copies.

## Gotchas

- **Private and unpublished**: `private: true` at version `0.0.0`. It carries no
  `files` allowlist because it ships nothing; the knowledge checker exempts
  private packages from packaging rules for this reason (#2143).
- **Declared as a literal workspace glob**: `pnpm-workspace.yaml` lists
  `packages/smrt-playground/host` explicitly because it is nested one level
  deeper than `packages/*`. Tooling that assumes a flat `packages/*` layout will
  miss it — that assumption is what #2143 fixed in `smrt-dev-mcp`.
- **Nested members carry no canonical docs**: because it sits inside another
  workspace package, the freshness checker exempts it from `missing-agents-md`
  and `missing-claude-shim`, and reports `nested-agents-md` if one reappears.
- **Discovery is the contract under test**: the suite exercises the parent
  package's discovery and runtime, so a failure here usually means a
  `./playground` export in some other package regressed, not the host.
