# Cookbook font override (#3821)

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | External contract edge | Test level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Optional top-level font keeps preset styling | Import or set_theme with fontFamily | Preset palette and geometry unchanged; typography changes | Unknown font falls back when rendering, malformed type rejected on import | Cookbook author, Planner, generated host | Pure engine document; atomic batch follows existing engine semantics | Node engine and browser shell | New optional v1 key; legacy custom.fontFamily still reads | Unit and shell resolution | core cookbook and engine tests; smrt-svelte catalog tests |
| Font survives document operations | Import, set_theme, export, state restore | Independent font survives preset/scheme changes and canonical export | reset_theme removes font; invalid input rejected without mutation | Agent/tool caller | Engine command revision and existing rollback | Node engine, browser-compatible core | Tool schema and CookbookTheme type | Engine tests | core engine tests |

No auth, tenancy, database, retryable external call, or SQL dialect is involved. Built-in preset font rendering is tested through registered theme variables, while visual QA is performed in the Planner browser host.
