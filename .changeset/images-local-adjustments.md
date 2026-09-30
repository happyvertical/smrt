---
'@happyvertical/smrt-images': minor
---

Local picture adjustments, no GPU: brightness, contrast, colour,
black-and-white, rotate, flip, zoom (region crop) and resize, rendered with
sharp (`applyImageAdjustments`). `imageAdjustVariants(operation)` gives two to
four versions to offer ("10%, 20%, 30% brighter"), and
`encodeImageAdjustments` / `decodeImageAdjustments` turn adjustments into a
short URL-safe spec (`b1.2,g,r90`) a preview route can render; decoding refuses
anything it did not write. `ImageEditor.adjust()` saves one as a derivative.

`ImageEditor.crop(image, x, y, w, h)` now keeps the region at `x`/`y` (it was a
centred cover resize that ignored them). The region is measured on the picture
as it is seen (after its EXIF orientation) and clamped to it.
