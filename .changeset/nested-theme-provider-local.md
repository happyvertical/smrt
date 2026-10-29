---
'@happyvertical/smrt-ui': patch
---

A `ThemeProvider` nested inside another `ThemeProvider` now themes only its own wrapper and no longer writes `data-theme`, `data-color-scheme`, the `dark` class, `color-scheme`, `data-contrast`, `data-density` or `data-smrt-theme-changing` onto `<html>`, so an embedded widget (the planner `AppShell`) cannot retheme its host page. The new `scope` prop (`'document' | 'local'`) defaults to `document` for a root provider and `local` when nested.
