---
'@happyvertical/smrt-ui': minor
---

`WorkingStrip` covers a supervised run: new phases `paused`, `waiting` (the
person is needed; prominent Review button, announced assertively), `failed`
(error colors, announced assertively) and `cancelled`, and `done` now uses
the success colors. Every phase shows an icon and text, never color alone.
New `floating` variant (a pill the host places over the page) shows the
optional `status.goal` above the current step. New props: `onpause` (also
Escape inside the strip), `onresume`, `onreview`, `ondismiss`, their labels,
and `announceIntervalMs` (polite step announcements are throttled, 2 s
default). Controls are 44px; the strip never takes focus by itself; reduced
motion stops the spinner. Existing `idle | working | done` callers are
unchanged.
