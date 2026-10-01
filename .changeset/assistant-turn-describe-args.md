---
'@happyvertical/smrt-chat': minor
---

`runAssistantTurn`'s `describeTool(name, args)` now also gets the tool call's
arguments on a call step and on the status line while the browser runs it,
so a host can label a step by its target ("Opening Events"). A one-argument
callback is unchanged.
