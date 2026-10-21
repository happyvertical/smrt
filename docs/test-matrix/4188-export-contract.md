# Planner host export contract (#4188)

Additive host capabilities: optional `exportLabel` reuses the existing native
export action, showing nonblank supplied text beside its icon and using it for
accessible name, tooltip and slot/menu metadata. Omitted/blank stays icon-only.
Root and Node-safe core expose the identical existing typed `buildAgentPrompt`.
No prompt generator, command execution, cookbook mutation or new controller.

| Behavior/invariant | Reachable trigger / positive | Negative/failure | Actor/context | Executor/runtime/external edge | Test level / command |
| --- | --- | --- | --- | --- | --- |
| Native export label | Host passes Build; visible text + matching aria/title/slot menu metadata and one existing Export route | Omitted/blank retains icon-only Export the app; host action remains separate | Trusted embedding host; visitor clicks/focuses existing link | Svelte SSR/DOM + Chrome at305/390/desktop; no persistence executor | planner-mount/header tests + external canonical component browser proof; fullPlanner and maintained browser gates |
| Canonical public prompt | Root/core exports same builder identity; options and Unicode cookbook produce identical result | No cloned builder; existing heredoc collision/UTF8/CLI/version tests retained | Host given current exported cookbook | Pure function; Node26 and browser, no SQL/transaction/network | public-agent-prompt + export-prompt tests; core-package bareNode consumer; fullPlanner/typecheck/build |
| Node-safe typed API | AgentPrompt and AgentPromptOptions emitted in both public barrels; core import executes in bareNode | No Svelte compiler/DOM needed by core; browser root remains Svelte entry | Node embedding server or browser host | Existing Cookbook input/output contract; errors/options unchanged | core-package test, packed consumer gate/typecheck |

Schema, authorization, tenancy, retries and mutations are N/A: this is label
presentation and re-export of an existing pure function. Non-string props are
outside the declared string contract; blank valid strings have a tested fallback.
The new label is rendered as escaped Svelte text/attributes. No website aliases,
pins, stored plans or user browser data are involved. Captured fail-before shows
old mounted label and missing public builder; current evidence is external.
