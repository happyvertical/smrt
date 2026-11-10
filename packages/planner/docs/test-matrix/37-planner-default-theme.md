# Planner defaults and Theme tab (#37)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Planner opens on Cookbooks with the Glass theme | Fresh local document and reload | Cookbooks selected; theme palette follows Glass and system appearance | An existing saved document retains its choices | Visitor | Cookbook store and browser storage; one document write | Browser / JSON | Built-in SMRT theme preset | Unit and live UI | `pnpm test`; clean-origin browser QA |
| Theme has its own tab while feature and layout behavior remains available | Open customization controls | Theme controls can set preset, appearance and brand; app shell retains edit controls | Existing feature commands and saved layout continue to work | Visitor | Cookbook store and AppShell layout state | Browser / Svelte | Planner tab and command ids | Component and live UI | `tests/planner-mount.test.ts`, `tests/theme.test.ts`, `pnpm build` |
