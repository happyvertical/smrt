---
'@happyvertical/smrt-content': patch
---

`Contents.mirror()` derives the slug from the file name instead of setting it,
so two mirrored URLs that end in the same file name (`index.html`) are two
rows (`index`, `index-2`) instead of the second overwriting the first.
