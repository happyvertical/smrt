---
'@happyvertical/smrt-svelte': minor
---

Lazy-load the browser-ai subsystem in `Provider`. The AI adapter factories
(`getSTT`/`getTTS`/`getLLM`) and `AILoadingOverlay` were statically imported,
which pulled the whisper/STT/TTS/LLM adapter layer into the initial bundle of
every page mounting a `Provider` — including pages that never configure AI.
Adapters and the overlay are now dynamically imported only when AI is actually
used; capability detection remains synchronous and cheap.

Measured on a consumer production build (anytown dashboard, Vite manifest
static-import closure of the app entry plus root layout): the browser-ai
adapter layer leaves the shell entirely. This is a deferral rather than a
deletion — the chunk it lived in also carried shared app code, so the shell
drops ~22 KB and total client JS is unchanged. The win is that pages which
never configure AI no longer download, parse, and execute the adapter layer on
first load.
