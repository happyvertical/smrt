# Overview defaults (#4184)

Default record widgets use the same business-field projection as Planner model
lists. Explicit widget columns remain authoritative. System fields, the current
parent reference, JSON fields and synthetic list-only calculations are not added
to the default overview table. Reference cells use the existing related-record
label resolver. Empty overview surfaces are quiet while reading; customization
mode retains its empty guidance and toolbar.

| Behavior/invariant | Reachable trigger / positive | Negative/failure | Actor/context | Executor / runtime / external edge | Test level / command |
| --- | --- | --- | --- | --- | --- |
| Stock identity and quantities | Default StockLevel records show SKU, location, state, quantity and reorder fields | No tenant/system fields or unsupported derived values | Planner visitor, browser-local samples | Existing DataSource reads; no transaction/mutation; Node26 Vitest, browser static Planner; catalog field metadata | Planner overview-default-columns test; full Planner test |
| Relation labels and parent exclusion | SKU/location cells resolve referenced display labels | No raw reference IDs; current parent reference omitted | Visitor viewing related records | Existing relationLabels/DataSource; no new API | Same regression test |
| Cross-model projection | Invoice, Payment, Product and ProductionOrder defaults show useful real business fields | JSON/system/unsupported synthetic fields excluded | Visitor, unchanged seeded data | Same read-only catalog/source path | Same regression test |
| Explicit columns | Custom qty/state order retained | Default policy cannot rewrite saved widget options | Visitor with existing customization | No persistence writes; existing widget options contract | Same regression test; existing cookbook-overviews suite |
| Empty surface presentation | Read mode has no empty-widget message | Edit mode retains guidance, toolbar and add control; nonempty widgets unchanged | Reader/customizer with existing customization capability | Svelte/happy-dom and maintained browser suites; no SQL/auth change | OverviewGrid test; full smrt-svelte test/e2e and Planner browser gates |

Auth/tenancy changes, retry/idempotent writes and SQL dialects are N/A: no new
actor permissions, database access, state mutation or controller lifecycle.
System/tenant exclusion is nevertheless asserted at the existing catalog boundary.
Fail-before and current-head command evidence is captured outside the worktree;
source fixtures establish behavior, not verification of the user's browser data.
