# Issue 3807: overview shortcut icon treatment

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Runtime/dialect | External contract edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shortcut icon and title share a line and use the active theme's primary color | Open a section overview with shortcuts in dark or light theme | Inline heading, primary token, readable description | Long title wraps without overlapping icon or leaving card | App visitor | N/A: display only | Svelte/browser | Host icon component still renders | Native Planner app QA | Rebuild Planner MCP artifact with local SMRT aliases and inspect the native tab |
| Section menu cards retain the documented matching appearance | Render `ShellSectionMenu layout="cards"` | Inline icon/title and primary token match shortcuts | List layout and edit controls remain as before | App visitor/admin | N/A: display only | Svelte/browser | Icon override remains supported | Component build and visual QA | `pnpm --filter @happyvertical/smrt-svelte typecheck`; native Planner app QA |

This is a visual default change, with no data contract or persistence. Full package gates and independent review are part of the batch's shipping gate.
