---
'@happyvertical/smrt-svelte': patch
---

The browser speech-to-text adapter puts the Web Speech error code on every
error it reports (`speechError`: `network`, `service-not-allowed`,
`not-allowed`, …), and reports an `aborted` it did not cause itself instead of
dropping it, so callers can tell Brave's missing speech service from a blocked
microphone.
