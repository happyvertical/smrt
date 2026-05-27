---
'@happyvertical/smrt-content': patch
---

ContentReferencesPanel: accept an optional `children` snippet so host
applications can inject a richer picker (browsing a tenant asset pool,
searching an external archive, etc.) inside the panel without forking
the component. The snippet renders below the existing references list
and add-reference input; the host is responsible for calling
`onReferenceIdsChange` (or otherwise mutating parent state) when the
user picks an entry. Unblocks `anytown/anytown.ai#462` (Ergot tenant
asset pool integration in the article editor).
