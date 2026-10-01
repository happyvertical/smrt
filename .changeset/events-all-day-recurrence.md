---
'@happyvertical/smrt-events': minor
---

- `Event` gains `allDay` and `timeZone` (IANA). **New columns: run
  `smrt db:migrate`.**
- `expandRecurrence()` expands a `RecurrencePattern` (daily/weekly/monthly/
  yearly, interval, byDay with monthly ordinals, byMonthDay, byMonth, bySetPos,
  until, count) into occurrence instants within a window, keeping the first
  occurrence's wall-clock time in its zone across daylight-saving changes;
  `EventSeries.getOccurrences()` wraps it, and the zoned wall-time helpers are
  exported.
- A wall time skipped by a spring-forward jump resolves forward (02:30 →
  03:30), and a repeated fall-back hour resolves to its first occurrence.
