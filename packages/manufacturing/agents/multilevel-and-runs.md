# Multi-level walks and production runs

Detail for `services/structure-walk.ts`, the multi-level forms of `BomService`, and `ProductionRunService`. Orientation and gotchas stay in the package [AGENTS.md](../AGENTS.md).

## Multi-level walks (sub-assemblies)

Every `BomService` method takes `{ levels }` (`1` by default: the single-level behaviour, unchanged; a number up to `MAX_EXPLOSION_DEPTH` = 32; or `'all'`). The walk is `services/structure-walk.ts`, shared by all of them: resolve each line through `AssemblyService.resolveComponent` (in the top bill's tenant), open an assembly's active bill while `levels` allows, stop at materials, bought items, missing components and assemblies without an active bill.

| Method | Multi-level behaviour |
|---|---|
| `explode(bomId, qty, { levels })` | Gross: every line depth first with `level`, `path` (bills from the top), `totalQty` (waste compounds: a child is the parent line's quantity times its own effective quantity), `buildable`, `expanded`; `totals` sums the lines not opened per SKU (first unit kept, as before). |
| `planRequirements(bomId, qty, { levels })` | Net: per line, `available` stock not yet allocated to an earlier line and `short`; a short buildable sub-assembly is opened for the shortfall only. Lines short and not opened are `shortages`, each at its own level. Facts only: no make-or-buy policy. |
| `explodeRequirements` / `canProduce` | `explode().totals` / the plan's shortages (`level`, `path`, `uom`, `buildable` added). |
| `computeMaterialCost` | An opened sub-assembly is costed from its bill (`subBomId`, nested `components`); a missing price below marks it. |
| `computeLabourEstimate` | Adds each opened sub-assembly's routing times its units per top unit (`subAssemblies`); `steps` stays the top routing. |

Safety: a loop already in stored data (written around the save-time refusal) fails with `BomStructureCycleError` (a `BomCycleError`) naming it; `'all'` past 32 levels or a walk past `MAX_EXPLOSION_LINES` (10,000, counted per use of a shared sub-assembly) fails with `BomExplosionLimitError`. Stock reads in a plan are summed across locations, as in `canProduce`.

## Production runs

`ProductionRunService` (`createRun({ bomId } | { productId }, targetQty)`, `start`, `recordCompletion`, `finish`, `cancel`, `setTarget`, `get`, `listCompletions`). Every write is one transaction that saves the run row first; the revision-guarded save locks it, and a concurrent writer's conflict reruns its whole transaction (up to 10 attempts), so concurrent completions all count and never pass the target. The service refuses an adapter without `transaction()`; it never falls back to step-by-step writes.

- A completion moves no stock unless asked. With `consume` / `produce` it calls `ProductionService` (`runProduction` for both) on the transaction's stock service, stamping movements `sourceType: 'ProductionRunCompletion'` with the completion id; a shortfall rolls the completion back. Consumption is the run's bill's own lines: a sub-assembly is taken from stock, and building it is its own run.
- Reaching the target marks the run `done`; `finish` closes it short; `cancel` keeps its completions; `setTarget` cannot go below what is done.
- Why not commerce `ProductionOrder`: that is a `Contract` (terms, money, customer or vendor, a contract status flow), owned by `smrt-commerce`, which this package does not depend on. A run is the shop-floor record of building; one order may need several runs, and make-to-stock needs none. An application that has both links them.
- Deliberately absent (nothing here would use them): a link to an order, who did the work, a location on the run (passed per call, as in `ProductionService`).
