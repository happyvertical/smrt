---
'@happyvertical/smrt-ui': minor
'@happyvertical/smrt-chat': minor
---

Dictation records when the browser cannot recognise speech. Give `Dictation`
a `transcribe(audio, { mimeType, language, durationMs, signal })` function
(new `createHttpTranscriber(url)` posts the raw audio to your own server
route and reads `{ text }`). When there is no speech source or no Web Speech
API (Firefox), or the recogniser fails with `network` /
`service-not-allowed` / ends straight away before hearing anything (Brave),
it records the message with `MediaRecorder` instead (WebM/Opus, MP4 on
Safari; `maxDurationMs` default 2 minutes, after which it is written down,
and `maxBytes` default 10 MB, past which it fails as too long). Stopping
moves to the new `transcribing` state ("Writing it down…" in
`DictationStatus`; the microphone is busy meanwhile), then the text goes in
at the cursor. After one such failure the same `Dictation` records straight
away. New error kinds with plain messages: `too-long`, `not-transcribed`,
`unavailable` (not set up), `forbidden`. New `recording` flag,
`DictationError`, `createMediaRecorderCapture` (injectable as `capture`),
`pickDictationMimeType`, `canCaptureDictationAudio`. Log events carry
`fallback: 'recording'` when it carried on by recording.

`AssistantComposer` and `AssistantDock` take a `transcribe` prop for the
same fallback; with only `transcribe` the microphone shows and always
records.
