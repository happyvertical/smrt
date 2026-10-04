# Multi-level walks and production runs

Detail for `services/structure-walk.ts`, the multi-level forms of `BomService`, and `ProductionRunService`. Orientation and gotchas stay in the package [AGENTS.md](../AGENTS.md).

## Multi-level walks (sub-assemblies)

Every `BomService` method takes `{ levels }` (`1` by default: the single-level behaviour, unchanged; a number up to `MAX_EXPLOSION_DEPTH` = 32; or `'all'`). The walk is `services/structure-walk.ts`, shared by all of them: resolve each line through `AssemblyService.resolveComponent` (in the top bill's tenant), open an assembly's active bill while `levels` allows, stop at materials, bought items, missing components and assemblies without an active bill.

| Method | Multi-level behaviour |
|---|---|
| `explode(bomId, qty, { levels })` | Gross: every line depth first with `level`, `path` (bills from the top), `totalQty` (waste compounds: a child is the parent line's quantity times its own effective quantity), `buildable`, `expanded`; `totals` sums the lines not opened per SKU (first unit kept, as before). |
| `planRequirements(bomId, qty, { levels })` | Net: per line, `available` stock not yet allocated to an earlier line and `short`; a short buildable sub-assembly is opened for the shortfall only. Lines short and not opened are `shortages`, each at its own level. Facts only: no make-or-buy policy. |
| `explodeRequirements` / `canProduce` | `explode().totals` / the plan's shortages (`level`, `path`, `uom`, `buildable` added). |
| `computeMaterialCost` | An opened sub-assembly is costed from its bill (`subBomId`, nested `components`); a missing price below marks it. A sub-assembly bill in another currency is not added: its line is priced through the resolver. |
| `computeLabourEstimate` | Adds each opened sub-assembly's routing times its units per top unit (`subAssemblies`); `steps` stays the top routing. Minutes always count; cost from a bill in another currency does not, and sets `hasMissingRates`. |

Safety: a loop already in stored data (written around the save-time refusal) fails with `BomStructureCycleError` (a `BomCycleError`) naming it; `'all'` past 32 levels or a walk past `MAX_EXPLOSION_LINES` (10,000, counted per use of a shared sub-assembly) fails with `BomExplosionLimitError`. Stock in a plan is summed across locations, as in `canProduce`, counting only the top bill's tenant's rows and global ones (like the lines the walk reads), whatever tenant context is active.

## Production runs

`ProductionRunService` (`createRun({ bomId } | { productId }, targetQty)`, `start`, `recordCompletion`, `finish`, `cancel`, `setTarget`, `get`, `listCompletions`). Every write is one transaction that saves the run row first; the revision-guarded save locks it, and a concurrent writer's conflict reruns its whole transaction (up to 10 attempts), so concurrent completions all count and never pass the target. The service refuses an adapter without `transaction()`; it never falls back to step-by-step writes.

- Tenant: every structure read goes through `src/tenant-scope.ts`: list reads run in `withTenantGlobalRead` for the owning tenant (its rows plus global rows; a tenant context alone would hide global rows, no context would show every tenant's) and keep own-or-global rows. `createRun` reads the active tenant's bills and global ones (no context: global bills only, by `productId` or `bomId`). The run takes its bill's tenant; a completion takes the run's; stock legs run inside `withTenant(run.tenantId)`, so the bill's lines and the levels read and written are that tenant's whatever the caller's context. `ProductionService` consumes only a bill's own tenant's lines and global ones (a global bill: global lines only), for every caller; a global run's stock legs run in the caller's context.
- A completion moves no stock unless asked. With `consume` / `produce` it calls `ProductionService` (`runProduction` for both) on the transaction's stock service, stamping movements `sourceType: 'ProductionRunCompletion'` with the completion id; a shortfall rolls the completion back. Consumption is the run's bill's own lines: a sub-assembly is taken from stock, and building it is its own run.
- Quantities are kept to `QUANTITY_DECIMALS` (6) places, never compared with a tolerance. A run's target, completed quantity and each report are summed and compared as whole millionths, exactly; a run accepts quantities up to `MAX_QUANTITY` (999,999,999, so every value has at most 15 significant digits and survives a double exactly) and refuses one that rounds to zero. A plan's `short` is rounded with `roundQuantity`.
- Reaching the target marks the run `done`; `finish` closes it short; `cancel` keeps its completions; `setTarget` cannot go below what is done.
- Why not commerce `ProductionOrder`: that is a `Contract` (terms, money, customer or vendor, a contract status flow), owned by `smrt-commerce`, which this package does not depend on. A run is the shop-floor record of building; one order may need several runs, and make-to-stock needs none. An application that has both links them.
- Deliberately absent (nothing here would use them): a link to an order, who did the work, a location on the run (passed per call, as in `ProductionService`).
