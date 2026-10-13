# Recipe route and emitted-model corrections (#3769)

Release scope: finish the declared feature catalogue in #3719. Ingestion's
authenticated review-host implementation remains with #3767. No generated
ingestion or webhook operation is enabled by this change.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ingestion recipes offer authenticated routes instead of inaccessible generic model navigation | A catalogue builds menus from emitted recipes | Both existing route surfaces survive scanning and manifest generation | No menu entry targets an unexposed model; generated operations stay disabled | Host supplies an authenticated review host; no authority is accepted from recipe metadata | N/A: declaration-only change does not execute or mutate records | Build-time Node; route components remain browser-capable; SQL dialect N/A because no persistence changes | Each route export and path is retained; model CRUD is not substituted for host callbacks | Scanner/manifest integration and package regression | `pnpm --filter @happyvertical/smrt-ingestion exec vitest run src/recipes.test.ts`; `pnpm --filter @happyvertical/smrt-scanner exec vitest run src/__tests__/workspace-recipes.test.ts` |
| Every model named by the webhook recipe exists in the built and packed manifest | A host loads the released catalogue | The delivery task and other recipe models resolve by qualified identity | Missing declared models fail the regression and prepack completeness gate | N/A: artifact validation neither authenticates nor dispatches a task | N/A: no database executor or mutation | Build-time Node; SQL dialect N/A because only artifact membership is tested | Source scanner, generated manifest, package tarball | Build/packed-artifact regression | `pnpm --filter @happyvertical/smrt-webhooks build`; `pnpm --filter @happyvertical/smrt-webhooks exec pnpm pack` plus manifest membership inspection |

Bug regression evidence must be captured before correcting declarations and
again on the release head. If the webhook omission is not reproducible from
current source, retain the verified built/packed evidence and report the
published artifact discrepancy rather than inventing a scanner fix.

## Established evidence

- The ingestion regression fails on the original advertised navigation and
  passes after removing it (three tests); all model exposure flags stay false.
  The package typecheck passes. Final full-package and combined release gates
  are captured by the coordinator before publication.
- Fresh webhook build and `pnpm pack` both contain every recipe model,
  including `WebhookDeliveryTask` and its schema. The planner's field-based
  classifier drops this fieldless model; its owning correction and base-failing
  regression are tracked as `happyvertical/smrt-planner#25`. No placeholder
  field is added and no task is removed from the recipe or manifest.
- SQL/dialect, rollback, retry, and actor-isolation mutation tests are N/A for
  these declaration-only changes: authenticated host callbacks and database
  implementation are unchanged. Existing package suites remain release gates.
