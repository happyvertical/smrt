---
'@happyvertical/smrt-svelte': minor
---

Lazy-load the browser-ai subsystem in `Provider`. The AI adapter factories
(`getSTT`/`getTTS`/`getLLM`) and `AILoadingOverlay` were statically imported,
which pulled the whisper/STT/TTS/LLM adapter layer into the initial bundle of
every page mounting a `Provider` — including pages that never configure AI.
Adapters and the overlay are now dynamically imported only when AI is actually
used; capability detection remains synchronous and cheap.
