---
'@happyvertical/smrt-chat': minor
---

The assistant dock waits for the page to settle before it resumes a turn
after a step's browser tools ran: the host's new `settle` hook (option and
`AssistantDock` prop, e.g. "SvelteKit is no longer navigating"), then the
navigations tracked on the registry and a quiet period for the registry and
the page tools, bounded by `settleTimeoutMs` (default 5 s). The resumed step
is offered the new page's tools instead of the old page's or none.
`matchesToolAllowList` moves to a browser-safe module and is also exported
from `@happyvertical/smrt-chat/svelte` and `/assistant-turn`, so a host can
narrow the tools it declares with the server's own matcher.
