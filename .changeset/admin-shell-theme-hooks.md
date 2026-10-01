---
'@happyvertical/smrt-svelte': minor
---

`AdminShell` is themeable without reaching into its classes:

- `--smrt-admin-shell-background` sets the page background (default `--smrt-color-surface`).
- Every scroller inside the shell gets themed thin scrollbars; retint with `--smrt-admin-shell-scrollbar-track`, `-thumb` and `-thumb-hover`.
- A right rail collapsed to `0` no longer paints padding (the rail never pads wider than its track).
- `ShellTitle` reads `--smrt-shell-title-font-family` (a serif masthead, say), falling back to the theme's title font.
