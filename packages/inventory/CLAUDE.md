# @happyvertical/smrt-inventory

Multi-location stock tracking. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, and any other vertical that counts discrete units across locations.

## Models

| Model | Purpose |
|---|---|
| _(catalog shapes — `Product`, `Material`, `ProductVariant`, `Sku` — live in `@happyvertical/smrt-products`)_ | Sku is the smallest sellable / countable unit; its `attributes` JSON carries axis-value pins. ProductVariant is the per-product axis declaration. Import either from `@happyvertical/smrt-products` directly. |
| `InventoryLocation` | Warehouse / factory / retail / in-transit / virtual. Open-ended `kind` string. Optional `placeId` references `@happyvertical/smrt-places`. `conflictColumns: ['code', 'tenant_id']`. |
| `StockLevel` | Materialized `qty` for a `(skuId, locationId, state)` tuple. Upserted in place. **Mutated only by `StockService`.** States: `available`, `allocated`, `wip`, `qc_hold`, `damaged`. |
| `StockMovement` | Append-only audit log. Every `StockService` mutation writes one (or two for `transfer`). `sourceType` + `sourceId` carry cross-package attribution. |

All five models use `@TenantScoped({ mode: 'optional' })` + nullable `tenantId` so they can be used either tenant-scoped or globally.

## StockService — the only sanctioned way to mutate stock

```typescript
import { createStockService } from '@happyvertical/smrt-inventory';

const service = await createStockService({ db });
await service.receive(skuId, locationId, qty, { sourceType, sourceId });
await service.reserve(skuId, locationId, qty, { sourceType, sourceId });
await service.release(skuId, locationId, qty, { sourceType, sourceId });
await service.fulfill(skuId, locationId, qty, { sourceType, sourceId });
await service.transfer(skuId, fromLocId, toLocId, qty, { sourceType, sourceId });
await service.adjust(skuId, locationId, delta, { sourceType, sourceId });
```

| Method | Behavior | Movement reason |
|---|---|---|
| `receive` | +qty available — purchase receipt, return, production produce | `receipt` |
| `reserve` | available → allocated. Throws `InsufficientStockError` on overdraw | `reservation` |
| `release` | allocated → available (order cancel) | `release` |
| `fulfill` | -qty allocated. Stock leaves the building | `fulfillment` |
| `transfer` | move stock between locations (writes two movements) | `transfer_out`, `transfer_in` |
| `adjust` | signed delta — cycle counts and one-off corrections | `adjustment` |

All methods reject zero / negative / non-finite quantities except `adjust`, which accepts non-zero signed deltas. Negative deltas that would drive a state below zero throw `InsufficientStockError`.

## Opt-in DispatchBus hooks

Off by default. Wire them up explicitly in the application's `smrt.ts`:

```typescript
import { installInventoryDispatchHandlers } from '@happyvertical/smrt-inventory';

const handlers = await installInventoryDispatchHandlers({
  dispatchBus: bus,
  db, // or stockService: existingService
});
```

This subscribes to:
- `contract:created` → calls `service.reserve()` for every line, attributed to `('Contract', payload.contractId)`
- `fulfillment:shipped` → calls `service.fulfill()` for every line, attributed to `('Fulfillment', payload.fulfillmentId)`

Per-handler toggles: `installContractReserved`, `installFulfillmentShipped`. The `production_order:posted` hook is deliberately not installed here — it depends on the BOM model and ships in `@happyvertical/smrt-manufacturing` (issue #1250).

## Schema migration (Phase 1 release)

The `Sku` model moved out of this package and into `@happyvertical/smrt-products`. Previously it lived in this package's `inventory_skus` table; it now lives in `product_skus` over there.

**Upgrade procedure** for deployed consumers:

1. **Let the framework create the destination table first.** Boot the new version once with `@happyvertical/smrt-products` registered in your `SmrtClassOptions`; the lazy `syncSchema` path will create `product_skus` with the right primary key, NOT NULL, UNIQUE (`code`, `tenant_id`), and indexes — they're derived from the `Sku` model decorators and would be stripped by a raw `CREATE TABLE AS SELECT`.

2. **Idempotently copy rows across.** SQLite + Postgres:

   ```sql
   BEGIN;
   INSERT INTO product_skus (
     id, slug, context, created_at, updated_at,
     tenant_id, product_id, code, barcode, name,
     attributes, weight_grams, parent_sku_id, active
   )
   SELECT
     id, slug, context, created_at, updated_at,
     tenant_id, product_id, code, barcode, name,
     attributes, weight_grams, parent_sku_id, active
   FROM inventory_skus
   WHERE NOT EXISTS (
     SELECT 1 FROM product_skus p WHERE p.id = inventory_skus.id
   );
   COMMIT;
   ```

3. **Drop the legacy table** once you've verified row counts match:

   ```sql
   DROP TABLE IF EXISTS inventory_skus;
   ```

`StockLevel.skuId` and `StockMovement.skuId` carry plain string ids that still resolve to the same rows after the rename, so no inventory data has to move.

## Gotchas

- **Movements are append-only.** The materialized `StockLevel` row is derived state; the `StockMovement` ledger is the source of truth. Never let CRUD UIs expose update/delete on the movement table. If you find yourself wanting to "fix" a movement row, write a compensating `adjust()` call instead.
- **Never call `StockLevel.create()` or `save()` directly.** Going around `StockService` silently desyncs the audit log and breaks cycle counts.
- **Cross-industry constraint.** This package's vocabulary stays generic: `InventoryLocation`, `StockLevel`, `StockMovement`. Apparel-specific concepts (`Style`, `Makeup`, `Colorway`, fashion `Season`, tech-pack metadata) and their analogues in furniture / automotive / CPG live in the relevant template package, never here. PRs that introduce industry vocabulary should be rejected.
- **Cross-package references are plain strings.** `skuId`, `placeId`, `sourceId` — all plain string ids, never `@foreignKey()`. Inventory's stock-motion logic only ever reads StockLevel/StockMovement; it doesn't follow `skuId` back to the catalog's Sku table, so the layering stays loose.
- **`conflictColumns` include `tenant_id`** on `InventoryLocation` and `StockLevel`. NULL-matching semantics (`(code, NULL) IS NOT DISTINCT FROM (code, NULL)`) are handled by `@happyvertical/sql >= 0.74.0` natively, so two saves with the same `(code, NULL)` tuple correctly merge in place. Pass `nullsDistinct: true` at the sql layer to opt back into NULL-distinct semantics.
- **Atomic per-method, transactional across composition.** Each `StockService` mutation (`receive` / `reserve` / `release` / `fulfill` / `transfer` / `adjust`) wraps every write in a single `db.transaction(...)` (via `@happyvertical/sql >= 0.74.0`). Partial failure rolls the whole call back — level writes and the matching `StockMovement` audit row commit together or not at all. `transfer` writes both legs (source decrement, destination increment, and both audit rows) inside one tx, so a failure mid-`transfer` is fully reverted.
  Callers composing multiple `StockService` calls into one logical unit (e.g. consuming materials line-by-line for a production order) should wrap them in `await stockService.withTransaction(async (tx) => { ... })` — `tx` is a tx-bound `StockService` with the same public API; mutation calls inside the callback share one transaction and either all commit or all roll back.
  If the underlying SQL adapter does not expose `transaction()` (extremely rare — all four built-in `@happyvertical/sql >= 0.74.0` adapters implement it), the service degrades to non-atomic serial writes and emits a one-time `console.warn`.
- **Concurrent reservations: tightened, not bulletproof.** `@happyvertical/sql >= 0.74.0` serialises null-aware upserts via a per-key in-process lock (SQLite) or advisory lock (Postgres), so concurrent saves on the same row no longer race at the storage layer. But each `StockService` method is still a read-modify-write across multiple statements (`SELECT` current level → compute → `UPDATE`), and that compound sequence is not held in a single transaction. Under high concurrency a `Promise.all([reserve, reserve, ...])` against the same `(skuId, locationId)` can still over-allocate. Awaited (serial) calls always behave correctly. Use a job queue (e.g. `@happyvertical/smrt-jobs`) or your own mutex when you need hard atomicity across concurrent callers. Wrapping each method in `BEGIN TRANSACTION ... SELECT FOR UPDATE` would close this fully; deferred until we see a real high-contention workload that warrants it.

## Source attribution

Every `StockMovement` carries `sourceType` + `sourceId` so downstream queries can reconstruct "what caused this movement". Conventions used by the built-in dispatch handlers:

| sourceType | Emitter | Note |
|---|---|---|
| `Contract` | `smrt-commerce` `contract:created` | All reservation/release/fulfilment legs caused by a contract |
| `Fulfillment` | `smrt-commerce` `fulfillment:shipped` | Outbound shipment |
| `PurchaseOrder` | (your code) | Inbound receipt |
| `CycleCount` | (your code) | Adjustments from physical counts |
| `TransferOrder` | (your code) | Both legs of a transfer |
| `ProductionOrder` | `smrt-manufacturing` (issue #1250) | Materials consumed + finished goods produced |
