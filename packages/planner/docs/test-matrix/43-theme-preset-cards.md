# Planner Theme preset cards (#43)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Planner Theme presents large preset choices with previews | Open Theme and select a preset | Card shows the preset palette, icon and label; selected state updates on click or keyboard | Narrow layouts wrap cards and retain visible focus | Visitor | Cookbook theme stored in local document | Browser / Svelte | Theme provider preset id | Component and live UI | Theme tab QA; `pnpm build` |
