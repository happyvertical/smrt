---
'@happyvertical/smrt-core': patch
---

Saving one STI class no longer writes `''` into the TEXT columns another class in the hierarchy owns; they stay NULL (#3227). A class's own unset TEXT fields still serialize as `''`.

A database created by an old generator that made those TEXT columns
`NOT NULL` now rejects such inserts (`VALIDATION_REQUIRED_FIELD`) where `''`
used to pass: run `smrt db:status --parity` and relax them with
`smrt db:migrate --relax-columns`.
