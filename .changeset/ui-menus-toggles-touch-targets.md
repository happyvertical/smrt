---
'@happyvertical/smrt-ui': minor
---

Menus, toggles and phone sizing no longer need per-app overrides.

- `Dropdown` menu items take an `icon` snippet (shown before the label, hidden from assistive technology), rows are at least 44px tall, and `variant="icon"` with `triggerLabel` gives a borderless 44px round "more" trigger in the surrounding colour.
- `Popover` gets the same `variant="icon"` trigger, a panel clamped to the viewport width, and `--smrt-popover-panel-width` / `--smrt-popover-panel-padding` hooks.
- `IconToggle` takes a `tone` (a CSS colour): the glyph stays neutral until pressed, then wears the tone with a soft wash and a ring, in light and dark.
- On phones (48rem and under) every `Button` size and the `Switch` row are at least 44px tall; `TagsInput` remove buttons are 44px targets on phones and touch screens.
