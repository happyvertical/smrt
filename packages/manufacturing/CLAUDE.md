# @happyvertical/smrt-manufacturing

Bills of materials, cost rollup, and production-order operations. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, food production, custom hardware, and any vertical that builds finished goods from a recipe.

Sits on top of `@happyvertical/smrt-inventory` (stock) and works alongside the `ProductionOrder` Contract STI subtype already shipped in `@happyvertical/smrt-commerce`.

## Models

| Model | Purpose |
|---|---|
| `BillOfMaterials` | Recipe for a finished product. `productId` (plain string) references the upstream `Product` or any STI subtype. Multiple revisions per product via `version` + `status` (`draft` / `active` / `superseded`). `conflictColumns: ['product_id', 'version', 'tenant_id']`. |
| `BomLine` | One component on a BOM. `bomId` (FK), `componentSkuId` (plain string ref to a `smrt-inventory` `Sku`), `qtyPerUnit`, `uom` (open-ended — `yards`, `each`, `grams`, `kg`, ...), `wastePercent`, `notes`. `conflictColumns: ['bom_id', 'component_sku_id', 'tenant_id']`. |

Both models are `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId` so they can be used either tenant-scoped or globally.

`RoutingStep` (labor cost) is intentionally out of scope for v1 — see issue [#1245](https://github.com/happyvertical/smrt/issues/1245) for the planned follow-up.

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

## Gotchas

- **`computeMaterialCost` without a resolver returns `$0`.** That is deliberate — manufacturing does not assume any particular cost source. A real wiring will plug in `@happyvertical/smrt-products` `Material.costPerUnit`, or a rolling average from purchase-order history, or a vendor price book. The `costUnavailable` flag tells UIs to surface "unknown cost" rather than silently rolling up zeros.
- **`explodeRequirements` does not call any stock APIs.** It is a planning helper. To check whether the materials are actually on hand, use `canProduce`. To actually deduct them, use `ProductionService.consumeMaterials`.
- **`canProduce` sums available stock across every location.** The planning question is "do we have it at all?". The operational question of "which warehouse do we pull from?" is left to the caller of `consumeMaterials`, which targets a single `locationId` per call.
- **`consumeMaterials` propagates `InsufficientStockError`.** If a line would drive `available` below zero, the underlying `StockService.adjust` throws. Pre-flight with `canProduce` before posting if you want to avoid partial-failure mid-run.
- **`consumeMaterials` is atomic across BOM lines.** All per-line deductions and their audit rows run inside a single `stockService.withTransaction(...)` scope (powered by `@happyvertical/sql >= 0.74.0`'s native `db.transaction()`). An `InsufficientStockError` on line N+1 rolls back lines 1..N so production-order posting never leaves materials half-consumed. The recommended pre-flight (`BomService.canProduce(orderId, qty)`) is still useful when you'd rather know upfront than discover the shortfall mid-run, but a missed pre-flight no longer corrupts state.
- **`consumeMaterials` + `produceFinishedGoods` are NOT jointly atomic.** Each opens its own transaction. A failure on the produce leg leaves materials deducted with no finished SKU receipt to balance it. Use `runProduction(order, { consume, produce })` when you need both legs to commit or roll back together.
- **Cross-package references are plain strings.** `productId`, `componentSkuId`, `bomId` (within this package) — all plain string ids, never `@foreignKey()`. Keeps the dependency graph DAG-shaped and lets each upstream package evolve independently.
- **`conflictColumns` include `tenant_id`** on both models. NULL-matching semantics are handled by `@happyvertical/sql >= 0.74.0`; two saves with the same `(product_id, version, NULL)` tuple merge in place.
- **Lazy table creation.** Like everything else in SMRT, the `manufacturing_boms` and `manufacturing_bom_lines` tables are created on first DB op via `syncSchema`. Safe for SSR.
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
| `@happyvertical/smrt-inventory` | StockService, Sku lookups, levels, movements |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/sql` | Database adapter |
