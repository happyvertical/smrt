---
'@happyvertical/smrt-languages': minor
---

Add `@happyvertical/smrt-languages` — code-first language strings with file/config + tenant overrides and an AI auto-translation pipeline backed by `smrt-jobs`. Mirrors the architecture of `smrt-prompts`, plus a deterministic-job-ID dedup so concurrent locale misses collapse into one translation. Honors a `smrt-features` kill switch (`smrt-languages.auto_translate`), a per-tenant daily budget, and an optional locale allowlist; never overwrites human-edited rows.
