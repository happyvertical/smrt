---
'@happyvertical/smrt-ui': minor
---

`Checkbox`, `Radio` and `Switch` get an invisible 44x44px hit area by default.
The visible box is unchanged (about 18px) and no layout shifts: a transparent
`::before` on the wrapping label enlarges the clickable region. The box and
label text sit above every hit area, so one control's hit area never takes a
click from another control's box or text.

The hit area paints above plain content around it, so it is constrained:

- A `Checkbox` or `Radio` beside other content in its parent (a row title, a
  link, a group's other options) grows vertically only, in the box's own
  column; only a control that stands alone gets the full 44x44. Content
  directly above or below a box, closer than 13px, is still covered: give it
  room or shrink the area.
- In table cells the area never leaves the cell; a `Checkbox` that is the
  cell's only content fills the cell. The cell is given `position: relative`
  at zero specificity, so sticky headers and pinned columns keep their own
  positioning.

Set `--smrt-control-hit-size` to resize it (`0px` turns it off).
