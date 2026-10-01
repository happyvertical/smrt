---
'@happyvertical/smrt-content': minor
---

`ContentBodyEditor` exposes `previewImage(index, src | null)` and `clearImagePreviews()`: show another picture in place in the story without changing it. A preview is never written to the body or reported by `onChange` (even when the person keeps typing), only same-origin paths are shown, `replaceImage` takes its place when the person accepts, and it goes away with the editor.
