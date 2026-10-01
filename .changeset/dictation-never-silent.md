---
'@happyvertical/smrt-ui': patch
---

Dictation never stops silently. Every speech error shows a plain message in
place of "Listening" and is logged (`log` option, default `console.warn`):
`network` and `service-not-allowed` (Brave has no speech service) say speech
recognition isn't available in this browser; `not-allowed` says the
microphone is blocked; `no-speech`, `audio-capture` (new `microphone` kind)
and an unexpected `aborted` (new `interrupted` kind) each get their own
words. A recogniser that ends by itself within `earlyEndMs` (default 1s)
without hearing anything is an error too. On first use `Dictation` asks for
the microphone and waits for the answer before starting the recogniser
(`requestMicrophone`, default on). New `errorCode` (the raw code) and
`dictationErrorCode`.
