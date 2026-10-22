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
| Specs panel edits | Every input event commits to the cookbook; a trailing space survives while drafting | Blank text clears the field | Visitor in the Specs panel | Svelte DOM | `specs-panel.dom.test.ts` |
| Labelled header | `headerNav: 'labelled'` renders four labelled links with distinct `data-tone`; default stays icon-only | Blank export label falls back to icon-only Build | Trusted embedding host | Svelte SSR/DOM | `header-nav.test.ts`, `header-nav.dom.test.ts`, `planner-mount.test.ts` |
| Held guide steps | `holdMs` keeps the spotlight until released or the hold elapses, clamped to 1–30 s; `specs`/`styles` targets resolve | Bridge refuses non-number, non-finite or negative `holdMs`; unknown target refused as before | Host narration over the bridge | DOM timers | `planner-guide.dom.test.ts`; `planner-bridge.dom.test.ts` (holdMs forwarding and refusal) |
| Spotlight arrow | Arrow points at the spotlit control and follows relayout | No target: no arrow | Any smrt-ui spotlight consumer | DOM geometry | `control-spotlight.test.ts` |
| Host reset | `handle.reset()` clears the saved plan and calls the host `onreset`; `{ silent: true }` clears without the callback | Reset with nothing saved still completes and returns true (no special case); storage failure returns false | Trusted embedding host | Local storage only | `planner-guide.dom.test.ts` (host reset) |

Schema, authorization, tenancy, retries and mutations against shared state
are N/A: the plan is the visitor's own browser-local document and the host is
the trusted embedder. New text renders as escaped Svelte text/attributes.
