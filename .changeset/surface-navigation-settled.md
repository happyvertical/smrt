---
'@happyvertical/smrt-ui': minor
---

Navigation surfaces can be awaited. `registerLinkSurface` now tracks the
promise its `navigate` returns on the registry (the command itself still
answers at once, since the new page may unmount the surface), and
`whenSurfaceNavigationSettled(registry, { quietMs, timeoutMs, alsoWatch })`
resolves once every tracked navigation finished and the registry has been
quiet, so the next step sees the new page's surfaces and tools. A bespoke
surface whose command navigates calls `trackSurfaceNavigation(registry, promise)`.
Exported from `@happyvertical/smrt-ui/data` and `/data-surface`.
