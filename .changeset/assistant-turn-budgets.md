---
'@happyvertical/smrt-chat': minor
---

`runAssistantTurn` takes a per-turn token budget (`maxTurnTokens`) and a
wall-clock budget (`maxTurnMs`), both spanning every browser round trip (the
continuation now carries `tokens` and `startedAt`). When either runs out, the
model gets one last round without tools and the turn ends with the new
`stoppedReason: 'budget'` (also on `runToolLoop`: `maxTotalTokens`,
`initialTokens`, `deadline`). Unset, nothing changes.
