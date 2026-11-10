# Data-surface refusals (#4387)

Module doc for `src/data-surface.ts`, linked from `packages/agents/AGENTS.md`.

a surface visible for a lesser action (`discover`/`inspect`)
but not the requested one gets `DataSurfaceActionDeniedError` naming the action
and that visible id; an invisible surface keeps the generic
`DataSurfaceDeniedError`. A function catalog receives `{ action }` (the report
tools forward it to a `reports` function); on the denial path only, it is
re-evaluated for the lesser actions (at most two calls, once each, a throw
reported to `onFailure`), and a lesser action counts only when its own tool is
allowed. Limit an action through the per-action catalog, never by leaving out
the executor: a visible surface with no executor is a configuration failure
(`onFailure`, `DataSurfaceQueryError`). Allow-list refusals and surface denials
go to `onDenied` (action, visible surface id only, the model's `requestId`,
the run's user when it has one, `reason`: `not_visible` |
`action_not_permitted` | `tool_not_allowed`) and to the audit sink as an
entry with `denied: true` and the same `action` as a call — audit consumers
must branch on `denied`. A run without a user gets no audit entry (as on
success); a throwing audit sink is reported to `onFailure` and the refusal
stands. `onDenied` is separate from `onFailure`: a denial is an authorization
outcome, not a server error. Request errors (including hidden fields, which
get `DATA_QUERY_FIELD_NOT_ALLOWED`) are not denials.
