# Planner sidebar footer defaults (#44)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fresh Planner keeps inference and user controls in the left sidebar footer | Load a new standalone or hosted Planner | Left sidebar starts expanded; footer controls stay visible; bottom panel starts hidden | Visitor can still collapse and reopen the sidebar | Visitor | Shell panel state, no database transaction | Browser / Svelte | AppShell slot and panel defaults | Unit and live UI | `tests/planner-shell.test.ts`; standalone and hosted app QA |
