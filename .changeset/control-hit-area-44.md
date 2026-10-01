---
'@happyvertical/smrt-ui': minor
---

`Checkbox`, `Radio` and `Switch` get an invisible 44x44px hit area by default.
The visible box is unchanged (about 18px) and no layout shifts: a transparent
`::before` on the wrapping label enlarges the clickable region, while the box
and label text sit above every hit area so neighbouring controls never steal
each other's clicks. In table cells the area never leaves the cell: it fills
the cell when the checkbox is its only content, otherwise it grows vertically
only. Set `--smrt-control-hit-size` to resize it (`0px` turns it off).
