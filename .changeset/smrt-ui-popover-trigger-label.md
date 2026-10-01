---
'@happyvertical/smrt-ui': minor
---

`Popover` gains `triggerLabel`: the accessible name (`aria-label`) of the trigger button when it shows only an icon (via the `trigger` snippet), so an icon-only popover button reads as e.g. "3 issues" instead of an empty button.

An icon trigger without `triggerLabel` falls back to `label` (`Popover` and
`Dropdown`); a `Dropdown` icon trigger with neither logs a console warning.
The `Popover` icon trigger keeps the standard primary focus ring.
