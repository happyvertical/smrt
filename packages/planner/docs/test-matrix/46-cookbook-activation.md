# Visible cookbook application (#46)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Applying a cookbook reveals its new navigation | Select and apply a cookbook | Accessible success notice names cookbook and section count; left sidebar opens | Selecting another cookbook clears stale success text; apply failure shows an error | Visitor | Cookbook store replaces the document and resets demo data | Browser / Svelte | AppShell panel state and cookbook menu | Live UI | Planner Cookbooks QA; `pnpm build` |
