# Project session/reset UI evidence

Risk: standard. The native planner exposes session persistence and an explicit project reset; no server mutation or authorization boundary changes.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime | External edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Reset requires explicit confirmation and canonical coordinator | Settings or Export → Reset project | Confirm invokes coordinator | Cancel invokes nothing; in-flight/unknown request disables | Visitor, native workspace | Client workspace coordinator; storage atomicity owned by storage suite | Browser / Svelte | Optional host callback | DOM | `pnpm --filter @happyvertical/smrt-planner exec vitest run tests/project-controls.dom.test.ts` |
| Remember is opt-in and reports failure | Settings → Remember this plan | Checked value passed to preference manager | Failed write shows error; prior preference remains | Visitor / device | Storage manager (migration rollback owned by storage suite) | Browser | Unavailable/quota storage handled by manager | DOM + storage suite | Same command |
| Pending manual settings cannot resurrect reset state | Type setting then reset elsewhere | Fresh defaults remain past debounce | Old draft never commits after replacement generation changes | Visitor / settings tab | Cookbook store replacement generation, synchronous commit guard | Browser | N/A: internal store | DOM | Same command |
| Reset retires old studio handoff without reusing IDs | Workspace reset message → parent handler | Pending seed/transcript cleared; future intent gets new ID | Old completion cannot retire future intent | Same-origin iframe | Visitor-local handoff store, synchronous | Browser; pure unit | Parent checks origin and source | Unit + browser QA | Website `pnpm --filter @happyvertical/www exec vitest run src/lib/happy/planner-handoff.test.ts` |
| Header and Export remain keyboard reachable | Header Project settings shortcut and existing Build it/Export | Native controls and confirmation receive keyboard focus | No hidden mobile duplicate | Visitor / desktop and mobile | N/A: navigation only | Browser | Native shell slots | Browser QA | Foreman coordinated `conversational-reset-qa` |

## Executed narrow evidence

- Node 26.8.1, `pnpm --filter @happyvertical/smrt-planner exec vitest run tests/project-controls.dom.test.ts tests/export-panel.dom.test.ts`: 12/12 passed. Subsequent failed-storage visual state regression added and corrected; final `tests/project-controls.dom.test.ts` rerun: 4/4 passed.
- Website Node 26.8.1, `pnpm --filter @happyvertical/www exec vitest run src/lib/happy/planner-handoff.test.ts`: 4/4 passed.
- Website owned files Prettier: unchanged/clean. Upstream owned source/test Biome formatting applied. Full coordinated typecheck/browser evidence remains with foreman.

The stale settings test verifies a typed value remains uncommitted before reset and never reaches the store after the debounce window. The Remember failure test verifies the actual checkbox returns to the saved preference as well as showing the failure alert.

