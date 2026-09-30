---
'@happyvertical/smrt-core': patch
---

Saving one STI class no longer writes `''` into the TEXT columns another class in the hierarchy owns; they stay NULL (#3227). A class's own unset TEXT fields still serialize as `''`.
