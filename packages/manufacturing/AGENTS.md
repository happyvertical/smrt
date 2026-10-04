# @happyvertical/smrt-manufacturing

Bills of materials, operations and routing, cost and labour rollup, and production-order stock movement. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, food production, custom hardware, and any vertical that builds finished goods from a recipe.

Sits on top of `@happyvertical/smrt-inventory` (stock) and `@happyvertical/smrt-products` (catalog: `Product`, `Material`, `Sku`), and works alongside the `ProductionOrder` Contract STI subtype already shipped in `@happyvertical/smrt-commerce`.

## Models

| Model | Purpose |
|---|---|
| `Assembly` | The product that is **made**, counterpart to `Material`. Cross-package STI subtype of `smrt-products` `Product` (`productType: 'assembly'`, `_meta_type: '@happyvertical/smrt-manufacturing:Assembly'`) in the shared `products` table. Own columns: `estimatedLabourMinutes` (integer, per unit), `defaultOperationId` (`@foreignKey(Operation)`, nullable, RESTRICT like `RoutingStep.operationId`: the operation work on it is booked to by default), `partReference` (the organization's drawing/part number). Name, price, tags come from `Product`; part number and stock from its `Sku` and inventory; structure from its bill; documents from `ProductAsset`. Exposure matches `Product` (REST list/get/create/update, MCP list/get), as the issue asks: unlike `Operation`, the assembly row has no service-owned invariant that generated writes could bypass. |
| `BillOfMaterials` | Recipe for a finished product. `productId` (plain string) references the upstream `Product` or any STI subtype. Multiple revisions per product via `version` + `status` (`draft` / `active` / `superseded`). `conflictColumns: ['product_id', 'version', 'tenant_id']`. |
| `BomLine` | One component on a BOM. `bomId` (FK), `componentSkuId` (plain string ref — the `Sku` model lives in `@happyvertical/smrt-products`; inventory tracks stock motion against the id), `qtyPerUnit`, `uom` (open-ended — `yards`, `each`, `grams`, `kg`, ...), `wastePercent`, `notes`. `conflictColumns: ['bom_id', 'component_sku_id', 'tenant_id']`. |
| `Operation` | A kind of work (cut, weld, inspect), a managed list per tenant. `code` (unique per tenant; `conflictColumns: ['code', 'tenant_id']`, fixed once defined), `name`, `category`, `isActive` (retire/reinstate; never deleted, `delete()` throws), `requiredQualificationId` (nullable `@crossPackageRef('@happyvertical/smrt-human-resources:Qualification')`: metadata only, no dependency, unvalidated; an application reads it to gate who may start the operation). |
| `RoutingStep` | One operation in a BOM's optional routing. `bomId` (`@foreignKey(BillOfMaterials)`, CASCADE: a routing belongs to its bill), `operationId` (`@foreignKey(Operation)`, RESTRICT: operations are retired, never deleted), `sequence` (1..n, unique per bom), `estimatedMinutes` (decimal, per produced unit), `notes`. `conflictColumns: ['bom_id', 'sequence', 'tenant_id']`. |

All models are `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId` so they can be used either tenant-scoped or globally.

## Operations, routing and labour estimate

- `OperationService` maintains the list (`define` rejects a duplicate code, including a retired one's; `rename`, `update`, `retire`, `reinstate`). `RoutingService.replaceRouting(bomId, steps)` swaps a bill's whole routing in one transaction and numbers it 1..n; a retired operation may stay on a routing that has it but cannot be newly added.
- `BomService.computeLabourEstimate(bomId)` returns minutes and, only when the caller supplies `rateResolver` (hourly rate per `Operation`, mirroring `costResolver`), cost. No resolver means minutes only with `rateUnavailable` on each step. A bill with no routing returns an empty estimate; `computeMaterialCost` is unchanged.
- `Operation` and `RoutingStep` expose generated list/get only; writes go through the services (generated create/update would upsert on a duplicate code or rename the code). `replaceRouting` saves the bill row inside its transaction (row lock) and retries on a revision conflict, so concurrent replacements serialize.
- Deliberately absent: a default labour rate class (nothing here would use it; the resolver receives the whole `Operation` and can key on `code`/`category`), setup time, scheduling and work-centre capacity, and time recorded against an operation (that stays in `smrt-timesheets` or the application).
- `./svelte` exports `OperationList` and `OperationForm` (props-driven; hosts persist through `OperationService`). Messages live in `src/svelte/i18n.ts`; component tests use the shared jsdom harness with axe assertions.
- Tests: `operations-suite.ts` runs on SQLite (`operations.test.ts`) and PostgreSQL (`operations.optional.test.ts`, `pnpm test:postgres`; each test runs in its own tenant because PostgreSQL test data persists).

## Assemblies — nesting lives in the bill

A sub-assembly is a `BomLine` whose component SKU belongs to an `Assembly`; there is no children list on the model. `AssemblyService` is the one link from a line to what it names:

| Method | Behavior |
|---|---|
| `resolveComponent(skuId, { tenantId? })` | `{ kind, sku, product, assembly, activeBom, buildable }`. `kind` is `assembly`, `material` (`Material`), `bought` (any other `Product`), or `missing` (unknown SKU, SKU with no product, or a non-UUID id; never throws). `activeBom` is the assembly's highest active bill, `null` when it has none; `buildable` is `assembly && activeBom`. Multi-level explosion (#3444) recurses on `activeBom` and stops at every other kind. |
| `isAssembly(skuId)` | `resolveComponent(skuId).kind === 'assembly'`. |
| `findActiveBom(productId, { tenantId? })` | Highest active bill. With `tenantId` (including `null`), only that tenant's bills count, whatever the tenant context; the cycle walk and `getBillStructure` pass the bill's own tenant, so a shared assembly resolves to the right tenant's bill on writes made without `withTenant()`. |
| `getBillStructure(bomId)` | One level: the bill plus each line with its resolved component. Throws `BomNotFoundError`. |
| `findCycle(productId, componentSkuIds)` | The path by which those components would make `productId` contain itself, following sub-assemblies' **active** bills only; `null` when none. |
| `assertLineAcyclic(line)` / `assertBillAcyclic(bom)` | Throw `BomCycleError` (a `ValidationError`, code `MANUFACTURING_BOM_CYCLE`, `path` from the product back to itself). |

**Cycle refusal runs in the models.** `BomLine.validateBeforeSave` checks every line save (draft bills too, so a loop is refused when written); `BillOfMaterials.validateBeforeSave` checks every save of an `active` bill (activation), including the lines of a stored bill with the same `(productId, version, tenantId)` that the save would upsert onto. The generated REST routes go through `save()`, so they refuse cycles as well. Not covered: re-pointing a `Sku.productId` (owned by `smrt-products`) and two concurrent saves that each close half of a loop.

## Svelte components (`./svelte`)

Props-driven; the host loads and persists. `AssemblyList` (field policy drops hidden columns via `policyToVisibleColumnIds`), `AssemblyForm` (smrt-fields `ObjectForm` for `@happyvertical/smrt-manufacturing:Assembly`, so price and every other field follow the consumer's field policy), `BomEditor` (add/edit/remove lines through host handlers; a sub-assembly shows whether it has its own bill and expands read-only through `loadBill`), `BomStructureTree` (the read-only nested view). Adapters: `toAssemblyView`, `toBomEditorLines`. Strings are under `manufacturing.` in `src/svelte/i18n.ts`; the package is strict for raw primitives, hardcoded strings and JSDoc.


## BomService — planning helpers

```typescript
import { BomService } from '@happyvertical/smrt-manufacturing';

const bom = await BomService.create({
  db,
  // Optional. Resolve unit cost for a component SKU.
  // Without this, every line rolls up to $0 and `costUnavailable` is set.
  costResolver: async (componentSkuId) => fetchLatestCost(componentSkuId),
});

const rollup = await bom.computeMaterialCost(bomId);
//   { totalCost, currency, lineBreakdown, hasMissingCosts }

const requirements = await bom.explodeRequirements(bomId, 100);
//   [{ componentSkuId, totalQty, uom }, ...]

const check = await bom.canProduce(bomId, 100);
//   { ok: true } | { ok: false, shortages: [...] }
```

| Method | Behavior |
|---|---|
| `computeMaterialCost(bomId)` | Walks every BomLine, applies waste (`qtyPerUnit * (1 + wastePercent / 100)`), resolves unit costs via the optional `costResolver`, returns per-line breakdown plus rolled-up total. Lines with no cost set `costUnavailable: true` and contribute `0`. |
| `explodeRequirements(bomId, qty)` | Returns a "shopping list" of materials needed for `qty` units. Duplicates across lines are summed. Does NOT mutate stock. |
| `canProduce(bomId, qty)` | Calls `explodeRequirements`, then sums `available` stock across every location per component, returns `{ ok: true }` if everything's covered, else `{ ok: false, shortages: [...] }`. |

## ProductionService — consume / produce

```typescript
import { ProductionService } from '@happyvertical/smrt-manufacturing';

const production = await ProductionService.create({ db });

// Drain materials at the factory.
const consumed = await production.consumeMaterials(
  { id: order.id, productId: order.productId, bomId: order.bomId },
  { locationId: factory.id, qty: runQty },
);

// Receive finished goods.
const produced = await production.produceFinishedGoods(
  { id: order.id, productId: order.productId },
  { locationId: factory.id, qty: runQty, finishedSkuId: variant.id },
);

// Or run both in one transaction — see "Joint atomicity" below.
const { consumed, produced } = await production.runProduction(
  { id: order.id, productId: order.productId, bomId: order.bomId },
  {
    consume: { locationId: factory.id, qty: runQty },
    produce: { locationId: factory.id, qty: runQty, finishedSkuId: variant.id },
  },
);
```

All three methods write through `StockService` and stamp every emitted `StockMovement` with `sourceType: 'ProductionOrder'` + the production order id so audit queries can roll them up later.

### Joint atomicity — `runProduction` vs the two-call form

`consumeMaterials` and `produceFinishedGoods` are each individually atomic, but calling them as two separate awaits is NOT jointly atomic — each opens its own `stockService.withTransaction(...)` scope. If something goes wrong between the two calls (process crash, transient adapter failure on the produce leg), you can land in a state where materials are deducted but no finished SKU receipt balances them. The audit ledger stays consistent within each call; what's missing is the cross-call invariant.

When you need that invariant — typically make-to-stock flows where the factory step is invisible to the ledger — use `runProduction(order, { consume, produce })`. Both legs run inside one transaction; any failure (BOM shortage, adapter error, interceptor reject) rolls back both legs together.

When NOT to use it: workflows where consume and produce represent a real wall-clock gap that downstream observers need to see (WIP dashboards, partial-run reporting, separate "materials posted" and "production completed" events on the dispatch bus). There, the two-call form is the right shape — each call is its own ledger event.

### Location convention — explicit-arg design

The location where materials are consumed and finished goods are received is passed explicitly to `consumeMaterials` / `produceFinishedGoods`, not carried on the production order itself. Rationale:

- The commerce `ProductionOrder` is a `Contract` STI subtype owned by `@happyvertical/smrt-commerce`. Adding an `originLocationId` field there would either need a schema change in commerce (cross-cutting) or a meta field that only manufacturing knows about (leaky).
- Real shops often pick a location at run time (factory A is congested, route the run through factory B), so even if the order carried a default, the explicit-arg signature is the more flexible canonical form.
- Callers that want a default can stash a `locationId` on their own production-order helper and pass it through.

### Finished-SKU convention

A `ProductionOrder` references a `productId`, but a `Product` typically has multiple SKUs (one per variant). The caller of `produceFinishedGoods` picks the concrete `finishedSkuId` because the multi-SKU mapping is application-specific (size run, finish mix, kit variant).

## Opt-in DispatchBus hooks

Off by default. Wire them up explicitly in the application's `smrt.ts`:

```typescript
import { installManufacturingDispatchHandlers } from '@happyvertical/smrt-manufacturing';

const handlers = await installManufacturingDispatchHandlers({
  dispatchBus: bus,
  db,
  // Default: subscribe to production_order:posted, call consumeMaterials.
  installProductionPosted: true,
  // Default: don't auto-produce. Set to true if your shop emits a
  // separate production_order:completed event.
  installProductionCompleted: false,
  // Default: don't combine consume + produce on `posted`. Set to true
  // for make-to-stock-instantly workflows where the factory step is
  // invisible. Ignored when installProductionCompleted is true.
  producedOnPosted: false,
});
```

This subscribes to:

- `production_order:posted` → `production.consumeMaterials(...)`; when `producedOnPosted: true` the handler instead calls `production.runProduction(...)` so consume + produce share one transaction. Process crashes or adapter errors between the two legs can never leave materials deducted with no finished-goods receipt.
- `production_order:completed` → `production.produceFinishedGoods(...)` (opt-in)

The companion handlers for `contract:created` (reserve) and `fulfillment:shipped` (fulfil) live in `@happyvertical/smrt-inventory` — wire both packages' installers from `smrt.ts` to get the full lifecycle.

## Tests

`src/__tests__/assembly-suite.ts` runs on SQLite (`assembly.test.ts`) and on PostgreSQL (`assembly.optional.test.ts`, skipped without `DATABASE_URL`; `pnpm test:postgres` and the PostgreSQL CI lane run it on a transaction-scoped handle). Component tests under `src/svelte/__tests__` use jsdom and assert axe.

## Gotchas

- **`computeMaterialCost` without a resolver returns `$0`.** That is deliberate — manufacturing does not assume any particular cost source. A real wiring will plug in `@happyvertical/smrt-products` `Material.costPerUnit`, or a rolling average from purchase-order history, or a vendor price book. The `costUnavailable` flag tells UIs to surface "unknown cost" rather than silently rolling up zeros.
- **`explodeRequirements` does not call any stock APIs.** It is a planning helper. To check whether the materials are actually on hand, use `canProduce`. To actually deduct them, use `ProductionService.consumeMaterials`.
- **`canProduce` sums available stock across every location.** The planning question is "do we have it at all?". The operational question of "which warehouse do we pull from?" is left to the caller of `consumeMaterials`, which targets a single `locationId` per call.
- **`consumeMaterials` propagates `InsufficientStockError`.** If a line would drive `available` below zero, the underlying `StockService.adjust` throws. Pre-flight with `canProduce` before posting if you want to avoid partial-failure mid-run.
- **`consumeMaterials` is atomic across BOM lines.** All per-line deductions and their audit rows run inside a single `stockService.withTransaction(...)` scope (powered by `@happyvertical/sql >= 0.74.0`'s native `db.transaction()`). An `InsufficientStockError` on line N+1 rolls back lines 1..N so production-order posting never leaves materials half-consumed. The recommended pre-flight (`BomService.canProduce(orderId, qty)`) is still useful when you'd rather know upfront than discover the shortfall mid-run, but a missed pre-flight no longer corrupts state.
- **`consumeMaterials` + `produceFinishedGoods` are NOT jointly atomic.** Each opens its own transaction. A failure on the produce leg leaves materials deducted with no finished SKU receipt to balance it. Use `runProduction(order, { consume, produce })` when you need both legs to commit or roll back together.
- **Cross-package references are plain strings.** `productId`, `componentSkuId`, `bomId` (within this package) — all plain string ids, never `@foreignKey()`. The package does depend on `smrt-products` (for `Assembly` and the resolve helper), but the bill schema does not couple to the catalog's table layout.
- **`Assembly` fields are columns, not `Meta<T>`.** Unlike `Material`, its own fields are ordinary columns this package adds to `products` (filterable over REST). The PostgreSQL suite asserts they land there.
- **`AssemblyCollection` lists exact `Assembly` rows.** An application subtype (e.g. one adding a customer) has its own `_meta_type`; read it through its own collection or `ProductCollection` (`resolveComponent` uses `instanceof Assembly`, so subtypes resolve as assemblies).
- **`conflictColumns` include `tenant_id`** on both models. NULL-matching semantics are handled by `@happyvertical/sql >= 0.74.0`; two saves with the same `(product_id, version, NULL)` tuple merge in place.
- **Lazy table creation.** Like everything else in SMRT, the `manufacturing_boms` and `manufacturing_bom_lines` tables are created on first DB op via `syncSchema`. Safe for SSR. A `BomLine` save now reads `product_skus` and `products` for the cycle check.
- **Cross-industry constraint.** This package's vocabulary stays generic. Apparel-specific concepts (`Style`, `Makeup`, `Colorway`, `tech-pack`, fashion `Season`) and their analogues in furniture / automotive / CPG live in the relevant template package, never here. PRs that introduce industry vocabulary should be rejected.

## Source attribution

Every emitted `StockMovement` carries `sourceType: 'ProductionOrder'` plus `sourceId: order.id` so downstream queries can reconstruct "what caused this movement". Reason codes used:

| reasonCode | Emitter | Note |
|---|---|---|
| `production_consume` | `ProductionService.consumeMaterials` | One per BOM line per consume call |
| `production_produce` | `ProductionService.produceFinishedGoods` | One per produce call |

These join cleanly with the standard inventory reason codes (`receipt`, `reservation`, `release`, `fulfillment`, `transfer_out`, `transfer_in`, `adjustment`) defined in `@happyvertical/smrt-inventory`.

## Dependencies

| Package | Purpose |
|---|---|
| `@happyvertical/smrt-core` | SmrtObject / SmrtCollection / DispatchBus |
| `@happyvertical/smrt-inventory` | StockService, stock levels, movements (the `Sku` model itself lives in `@happyvertical/smrt-products`; inventory tracks stock motion against the id) |
| `@happyvertical/smrt-products` | `Product` (the `Assembly` STI base), `Material`, `Sku` for the resolve helper and cycle check |
| `@happyvertical/smrt-fields` | `ObjectForm` and field-policy column visibility for the Svelte components |
| `@happyvertical/smrt-ui` / `smrt-types` | Svelte controls, i18n, module UI slots |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/sql` | Database adapter |
