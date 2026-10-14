---
'@happyvertical/smrt-timesheets': minor
---

`AttendanceService.replay()` gains a time-resolution hook (`resolveAt`), replayable work actions (`startWork`, `switchWork`, `stopWork`, `resumeWork`) and stored refusal codes (`AttendanceReplayOutcome.code`, `AttendanceConflict.code`, `refusal` hook). Adds `AttendanceSegment.reviewRequired`.
