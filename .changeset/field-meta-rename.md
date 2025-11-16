---
"@happyvertical/smrt-core": patch
---

Fix field name conflict by renaming internal metadata property from `field.options` to `field._meta`

This resolves issue #319 where users could not define fields named "options" due to conflicts with the internal field metadata structure. Users can now safely use "options" as a field name.

**Breaking change:** External code accessing `field.options` must update to `field._meta`
