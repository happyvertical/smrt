---
'@happyvertical/smrt-content': minor
---

`ContentBodyEditor` hides its "Save as" HTML/Markdown picker by default. Pass
`showFormatPicker` (or `showBodyFormatPicker` on `ContentEditor`) to show it.
The storage format is a technical choice most editors should not face; the
body keeps the `format` it was given either way.
