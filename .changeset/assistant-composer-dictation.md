---
'@happyvertical/smrt-chat': minor
---

Speak to the assistant. `AssistantDock` and `AssistantComposer` take a
`dictation` speech source (for example smrt-svelte's
`createSttDictationSource()`): the composer then shows a microphone button,
and pressing and holding the message box starts listening too; heard words go
in at the cursor, and Send or Escape stops listening. The offered-options cards
are now their own component, `AssistantChoiceCards`, so a host can show a
second, focused conversation's options next to the page.
