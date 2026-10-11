# Assets and chat recipe metadata — #3769

Risk: standard; presentation metadata only. Persistence, tenant authorization,
read-only chat operations, field defaults, and public component contracts stay
unchanged. The invalid chat playground surface names a registry object rather
than a mountable component; remove that placement and retain its fixture seed.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime/dialect | External edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Unique asset navigation | Enable both asset recipes | Library and attachments have separate stable identities | Duplicate model/key pair fails | Visitor/catalog | N/A: static metadata | Node scanner; SQL N/A | Emitted recipe nav | Scanner integration | `pnpm --dir packages/chat exec vitest run src/__tests__/recipe-glossary.test.ts` |
| Sentence case chat navigation | Enable chat.rooms | Chat rooms emitted | Title case fails | Visitor/catalog | N/A: static metadata | Node scanner; SQL N/A | Emitted label | Scanner integration | Same command |
| Complete useful glossary | Render each asset/chat recipe, including advanced fields | Every shown field has contextual prose, inherited fields included | Missing/blank descriptions and technical shorthand fail; hidden fields excluded | Visitor/help | N/A: no data writes | Node scanner + real renderer; SQL N/A | Manifest fields and recipe options | Scanner/renderer integration | Same command |
| Mountable declared surfaces | Discover chat.rooms | ChatLayout is the route component; seed stays data | Registry default is not advertised as a component | Host/catalog | N/A: no mutation | Node scanner; browser harness below | Public Svelte export and fixture export | Scanner/export integration | Same command |
| Existing runtime/security behavior | Full package release gates | Current suites pass | Existing negative authorization/tenancy assertions remain | Existing suite actors | Existing suite executors | Package-supported lanes | Existing public APIs | Full package/UI/browser | Package build, test, typecheck, test:e2e |

## Evidence

Toolchain: Node 26.9.0 and official pnpm 11.25.0 (Node 26 parent and children).
Scratch variables `TMPDIR`, `TMP`, `TEMP`, and `CI_TEST_TMPDIR` use
`/home/will/Work/tmp/smrt-ui`. Browser tests run sequentially with the maintained
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium` option.

Logs: `/home/will/Work/tmp/smrt-3719-evidence/assets-chat/`.

- `install.log`: worktree dependency install passed.
- `assets-test.log`: all 172 package tests and 7 attachment UI tests passed.
- `assets-typecheck.log`: TypeScript/Svelte passed, zero errors/warnings.
- `assets-e2e.log`: 2 passed, including JavaScript-enabled and native multipart flows.
- `chat-typecheck.log`: TypeScript/Svelte passed, zero errors; one existing dependency CSS warning.
- `chat-e2e.log`: 33 passed; 2 existing opt-in photographic model tests skipped.
- `schema-parity.log`: all 30 production objects/collections compared against base;
  no changes to field types, defaults, constraints, generated schemas, validation
  rules, or exposure. Descriptions and their otherwise empty metadata wrappers
  are excluded from this comparison. No database writes occur in this change,
  so repeating the same metadata-only comparison per SQL dialect is unnecessary.

- `chat-test.log`: 77 files / 862 tests passed; 3 files / 16 tests skipped by
  existing optional lanes.
- `regression-base.log`: the final regression test revision fails all 6 cases
  against production sources from `be21c622f6e04ab2bb501d1a730c49eb7ab34d9b`.
- `regression-head.log`: the same 6 scanner/generation/renderer cases pass on
  the changed sources. The replay restores source files in a `finally` block.
- `biome.log`: changed TypeScript files pass (two existing non-null assertion warnings).

- `assets-build.log` and `chat-build.log`: both complete package builds passed
  on the documented toolchain; touched manifests and knowledge artifacts regenerated.
- `knowledge-graph.log`: regenerated the cross-package graph (53 packages,
  628 objects, 356 edges). Dependency artifacts were copied only from identical
  source packages in the coordinator checkout; they are validation inputs, not
  committed changes. The ingestion artifact was regenerated against this
  worktree's baseline after freshness correctly rejected its copied README hash
  (`ingestion-artifact-refresh.log`); no ingestion source changed.
- `knowledge-check.log`: `pnpm knowledge:check --changed --strict --format markdown`
  passed with zero errors (six existing ingestion scanner warnings).



