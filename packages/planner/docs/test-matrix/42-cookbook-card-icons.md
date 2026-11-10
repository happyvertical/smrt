# Cookbook card icon layout (#42)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cookbook cards show icon beside title | Open Cookbooks | Icon and title form one row and remain readable | Narrow width wraps card layout without stacking the icon over the title | Visitor | N/A: presentation only | Browser / Svelte | Shared theme primary token | Live UI | Planner Cookbooks QA; `pnpm build` |
