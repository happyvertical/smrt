---
'@happyvertical/smrt-chat': minor
---

Choice offers can arrive a little at a time. A source's `offer` may return
`pending: { message, expected, fill(update, signal) }`: the cards show the
plain progress line and "Making…" placeholders, `fill` adds options as they
finish, and the person can pick any that arrived. The model is told right away
(`stillMaking`, `progress`) so it can say how long it takes. A failure is shown
in plain words (a note under the cards, or the new `unavailable` status when
nothing arrived). Picking, "None of these" or clearing the conversation aborts
`signal`, and the person's next message does not replace such an offer. The
dock status is `working` with the progress line while nothing is ready.
