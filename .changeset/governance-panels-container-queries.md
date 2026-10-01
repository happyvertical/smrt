---
'@happyvertical/smrt-content': patch
---

The governance panels (claim audit, corrections, versions, transparency, the factual workflow panel and the transparency report) lay themselves out by their own width instead of the viewport, so they fit a full page, a side panel, the assistant dock or a phone without host overrides. Each is a size container; narrow toolbars and card footers stack with full-width 44px actions, the claim checkbox and publish toggle have 44px targets, and cards read the shared `--smrt-card-border`, `--smrt-card-background` and `--smrt-card-shadow` tokens.
