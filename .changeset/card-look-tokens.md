---
'@happyvertical/smrt-ui': minor
---

Cards are themeable: `Card` and `CollectionList` rows read `--smrt-card-border`,
`--smrt-card-background`, `--smrt-card-shadow` and `--smrt-card-divider`, so an
app can make its cards borderless (or tinted, or shadowed) once in its theme
layer. Unset, the stock look is unchanged; the `outlined` variant always keeps
its outline.
