---
'@happyvertical/smrt-ui': minor
---

`IconToggle` (`@happyvertical/smrt-ui/ui`): an icon-only toggle button for dense filter rows and view switchers. The icon is a snippet in any icon set; `label` is the accessible name and tooltip, `pressed` is `aria-pressed`, an optional `count` badge joins the name and tooltip, and the hit area is at least 44px. `CollectionList` gains a `gallery` layout (picture-first tiles with the selection box and `actions` floating over the corners), wraps the selection checkbox in a label, and lifts the checkbox and actions above an item's stretched link so an item can be one big link.

A pressed `IconToggle` is not told apart by colour alone: it also draws a 2px ring in its text colour (WCAG 1.4.1).
