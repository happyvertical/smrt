---
'@happyvertical/smrt-ui': minor
---

Static-first theme delivery in ThemeProvider

ThemeProvider no longer renders the full ~200-variable inline `style`
string (with `--smrt-bootstrap-*` indirection) on its wrapper for built-in
presets. Built-in presets now rely on the static per-preset stylesheets
(`themes/styles/<preset>.css`) selected by the `data-theme` /
`data-color-scheme` attributes, so first paint is pure static CSS and theme
switching is an attribute flip. `primaryColor`/`overrides` still apply as a
small inline variable set.

- New `inlineVariables` prop opts a built-in preset back into legacy runtime
  variable generation. Custom registered themes (no static stylesheet
  possible) keep runtime generation automatically.
- `themeScript()` is now a ~400-byte attribute stamper (no more inline
  preset×scheme variable matrix); persisted preference still applies
  pre-paint with no FOUC as long as the static stylesheet is imported.
- New `pnpm generate:themes` script regenerates the token blocks in
  `themes/styles/*.css` from the theme definitions, and a lockstep test now
  covers every preset (material/glass/studio/smrt were regenerated — values
  unchanged, missing tokens added). `generateThemeVariables` is deprecated
  for new use but remains for custom themes.

Migration: apps using ThemeProvider with a built-in preset should import
the preset stylesheet (e.g.
`import '@happyvertical/smrt-ui/themes/styles/smrt.css'`) or
`themes/styles/all.css` for runtime theme switching.
