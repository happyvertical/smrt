# Planner specs, labelled header, narrated guide, host reset (#4194)

Additive planner surface for an embedding host: a cookbook v1 `specs` string
(free-text build requirements) with `set_specs`/`append_specs` commands and a
Specs panel; an optional `headerNav: 'labelled'` mode that renders the existing
icon links as four toned, labelled buttons (Specs · Features · Styles · Build);
guide steps that can hold a spotlight until the host releases it (`holdMs`) and
target `specs`/`styles`; a spotlight arrow in smrt-ui; and `PlannerHandle.reset`
so a host can clear a saved plan. No schema version bump, no new persistence
executor, no authorization or tenancy surface.

| Behavior/invariant | Reachable trigger / positive | Negative/failure | Actor/context | Executor/runtime/external edge | Test level / command |
| --- | --- | --- | --- | --- | --- |
| Cookbook `specs` round-trips | `set_specs`/`append_specs` write the field; parse/assemble keep it; prompt step 5 emits it | Non-string or oversize input rejected by schema; absent field assembles to no step | Planner command executor on a visitor's plan | Pure engine + JSON schema; no SQL | `packages/core` engine tests; `packages/planner` cookbook-doc, core, export-prompt tests |
| Specs panel edits | Typing keeps a trailing space while drafting; blur commits to the cookbook | Empty draft clears the field | Visitor in the Specs panel | Svelte DOM | `specs-panel.dom.test.ts` |
| Labelled header | `headerNav: 'labelled'` renders four labelled links with distinct `data-tone`; default stays icon-only | Blank export label falls back to icon-only Build | Trusted embedding host | Svelte SSR/DOM | `header-nav.test.ts`, `header-nav.dom.test.ts`, `planner-mount.test.ts` |
| Held guide steps | `holdMs` keeps the spotlight until released or the hold elapses; `specs`/`styles` targets resolve | Unknown target or zero hold behaves as before | Host narration over the bridge | DOM timers | `planner-guide.dom.test.ts`, bridge tests |
| Spotlight arrow | Arrow points at the spotlit control and follows relayout | No target: no arrow | Any smrt-ui spotlight consumer | DOM geometry | `control-spotlight.test.ts` |
| Host reset | `handle.reset({ silent })` clears the saved plan and reports it through the lifecycle | Reset with no saved plan is a no-op | Trusted embedding host | Local storage only | `planner-mount.test.ts` |

Schema, authorization, tenancy, retries and mutations against shared state
are N/A: the plan is the visitor's own browser-local document and the host is
the trusted embedder. New text renders as escaped Svelte text/attributes.
