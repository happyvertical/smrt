---
'@happyvertical/smrt-chat': minor
---

The assistant dock keeps a supervised run for "watch it work" hosts:
`controller.run` (and the `onRun` option / `onrun` prop) gives the goal (the
person's message, one line), the current step, the step count, the browser
tools that ran, and a state — `running`, `paused`, `waiting` (with
`waitingFor.kind`: `confirm`, `choice`, `review` or `continue`), `done`,
`failed` or `cancelled`, plus `stoppedReason` (`max_steps`, `budget`,
`paused_too_long`, `user`, `error`). New controls: `pauseRun()` /
`continueRun()` (the next step waits, bounded by `maxPauseMs`, default
15 min), `acknowledgeRun()`, `dismissRun()`, and `holdForUser({ id, kind,
label })`, the generic seam for "the assistant presents choices, the person
picks": while a hold is registered the run is `waiting`. A run that staged a
proposal ends `waiting` for review; propose/apply is unchanged. New
`clientToolFilter` option/prop: a tool it rejects is never declared to the
model, and a call to one is refused as `not_available`.
