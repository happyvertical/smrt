---
'@happyvertical/smrt-ui': minor
'@happyvertical/smrt-svelte': minor
---

Speak into text fields. `@happyvertical/smrt-ui/forms` adds `Dictation` (the
listening state machine over any speech source), `DictationButton` (a 44px
microphone toggle) and `DictationStatus` (listening and plain-words errors:
unsupported browser, blocked microphone, nothing heard), `insertTextAtCursor`,
a Web Audio "ready" beep (`playReadyBeep`, no sound files), and `longPress` /
`createLongPress` (hold ~500ms; moving past 10px is a drag, not a long press).
`@happyvertical/smrt-svelte/browser-ai` adds `createSttDictationSource`, which
lends `Dictation` the existing speech-to-text adapters (browser speech by
default), created lazily on first use.

`DictationStatus` takes no room while it has nothing to say.
