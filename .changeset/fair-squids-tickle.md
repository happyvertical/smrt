---
"@happyvertical/smrt-core": patch
---

Prefer `@huggingface/transformers` for local embeddings and fall back to
`@xenova/transformers` only when the newer package is not installed. This
avoids the stale `sharp@0.32.x` runtime path on Node 24 while preserving
compatibility for older consumers.
