# s-m-r-t Playground test host

Private SvelteKit application used by the `@happyvertical/smrt-playground` Playwright suite. It is a workspace fixture, not a published package or application template.

## Validation

```bash
pnpm --dir packages/smrt-playground/host build
pnpm --dir packages/smrt-playground/host test:e2e
```

To run against an already-built or external host, set `PLAYWRIGHT_BASE_URL`.
Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the Playwright-managed Chromium
binary is unavailable.

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

Playground runtime and component documentation lives in the [parent package README](../README.md).
