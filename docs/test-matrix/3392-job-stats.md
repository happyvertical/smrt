# #3392 JobStats published declaration

Risk: standard. The runtime component is unchanged; the public Svelte declaration
must bind `stats` to the data interface rather than its generated component type.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Supported runtime/dialect | External contract edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Built public export accepts stats and remains a runtime component value | Consumer imports `@happyvertical/smrt-jobs/svelte` | Namespace and named component imports accept a full stats object with nullable metrics and omitted optional props | Missing counters and string counters must remain type errors (`@ts-expect-error`) | TypeScript/Svelte application using verbatimModuleSyntax | N/A: compile-only, no persistence | Svelte 5 / TypeScript 6; SQL N/A | Published declaration/export map, no source alias | Built declaration consumer via svelte-check | `pnpm --filter @happyvertical/smrt-jobs build && pnpm --filter @happyvertical/smrt-jobs verify:pack` |

The fixture lives outside `src` and resolves the package's own export map to
`dist/svelte/index.d.ts`. It cannot accidentally pass against the source .svelte
file. `verify:pack` runs it after the existing packed type/export checks.

Base evidence: the unchanged component built successfully, but this consumer
failed with three diagnostics: a type-only named import and two `stats`
component-instance mismatches. After aliasing the data import, the same
consumer passes with zero errors and zero warnings.
The change only aliases a type import: runtime rendering is unchanged. The
consumer regression directly exercises the failing published type boundary.
