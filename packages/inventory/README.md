# @happyvertical/smrt-inventory

Multi-location stock tracking for the s-m-r-t framework. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, and any other vertical that counts discrete units across locations.

## Installation

```bash
pnpm add @happyvertical/smrt-inventory
```

## Usage

### Set up SKUs, locations, and a stock service

```typescript
import {
  createStockService,
  InventoryLocationCollection,
} from '@happyvertical/smrt-inventory';
// The `@happyvertical/smrt-products` root entry pulls in Vite virtual
// modules (`@smrt/client` etc.) and won't resolve under plain Node /
// tsx. Import from the `/collections` subpath for server-side scripts,
// tests, and SSR runtimes that don't run the Vite plugin.
import { SkuCollection } from '@happyvertical/smrt-products/collections';

const db = { type: 'sqlite', url: 'app.db' };
const skus = await SkuCollection.create({ db });
const locations = await InventoryLocationCollection.create({ db });
const stock = await createStockService({ db });

const widget = await skus.create({
  productId: 'prod-1',
  code: 'WIDGET-001',
  barcode: '0123456789012',
  attributes: { finish: 'matte' },
});
await widget.save();

const warehouse = await locations.create({
  code: 'WH-EAST',
  name: 'Warehouse East',
  kind: 'warehouse',
});
await warehouse.save();
```

### Move stock through its lifecycle

Every method writes one (or two, for transfers) `StockMovement` audit rows so the ledger stays in lockstep with the materialized levels.

```typescript
// Inbound receipt — +qty available.
await stock.receive(widget.id!, warehouse.id!, 100, {
  sourceType: 'PurchaseOrder',
  sourceId: po.id,
});

// Reserve against an order — available → allocated.
// Throws InsufficientStockError if there isn't enough available.
await stock.reserve(widget.id!, warehouse.id!, 10, {
  sourceType: 'Contract',
  sourceId: order.id,
});

// Ship — removes from allocated, leaves the building.
await stock.fulfill(widget.id!, warehouse.id!, 10, {
  sourceType: 'Fulfillment',
  sourceId: shipment.id,
});

// Cycle count caught five extra units — non-zero signed delta.
await stock.adjust(widget.id!, warehouse.id!, 5, {
  sourceType: 'CycleCount',
  sourceId: count.id,
});

// Move stock between locations — writes transfer_out + transfer_in legs.
await stock.transfer(widget.id!, warehouse.id!, store.id!, 12, {
  sourceType: 'TransferOrder',
  sourceId: xfer.id,
});
```

### Query balances and the audit log

```typescript
import {
  StockLevelCollection,
  StockMovementCollection,
} from '@happyvertical/smrt-inventory';

const levels = await StockLevelCollection.create({ db });
const movements = await StockMovementCollection.create({ db });

// What's on hand at this location across every state?
const here = await levels.findByLocation(warehouse.id!);

// What's the available total for a SKU across all locations?
const availableTotal = await levels.totalForSku(widget.id!, 'available');

// What movements were caused by a particular contract?
const audit = await movements.findBySource('Contract', order.id);
```

### Catch the insufficient-stock error

```typescript
import { InsufficientStockError } from '@happyvertical/smrt-inventory';

try {
  await stock.reserve(widget.id!, warehouse.id!, 9999);
} catch (err) {
  if (err instanceof InsufficientStockError) {
    console.log(
      `Only ${err.available} available for ${err.skuId} at ${err.locationId}, requested ${err.requested}`,
    );
  } else {
    throw err;
  }
}
```

### Multi-tenancy

The three inventory models (`InventoryLocation`, `StockLevel`, `StockMovement`) use `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId`. The catalog shapes (`Sku`, `Product`, `ProductVariant`, `Material`) live in `@happyvertical/smrt-products` and carry their own tenant decoration there; the cross-package id refs flow through unchanged. Wrap mutations in `withTenant()` from `@happyvertical/smrt-tenancy` to scope queries automatically.

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-a' }, async () => {
  // Every read/write through skus, locations, levels, movements, and the
  // StockService is filtered by tenant_id = 'tenant-a'.
  await stock.receive(widget.id!, warehouse.id!, 100);
});
```

### Opt-in DispatchBus wiring

The package ships handlers that bridge `contract:created` → `reserve()` and `fulfillment:shipped` → `fulfill()`. Off by default; install them explicitly in your `smrt.ts` to enable automatic stock motion:

```typescript
import { createDispatchBus } from '@happyvertical/smrt-core';
import { installInventoryDispatchHandlers } from '@happyvertical/smrt-inventory';

const bus = await createDispatchBus({ db });
const handlers = await installInventoryDispatchHandlers({
  dispatchBus: bus,
  db,
});

// In smrt-commerce (or your own code):
await bus.emit('contract:created', {
  contractId: order.id,
  lines: [{ skuId, locationId, qty }],
});

// Later, on shipment:
await bus.emit('fulfillment:shipped', {
  fulfillmentId: shipment.id,
  lines: [{ skuId, locationId, qty }],
});
```

Per-handler toggles (`installContractReserved`, `installFulfillmentShipped`) let consumers pick exactly the signals they care about. The `production_order:posted` handler is intentionally *not* installed here; that bridge lives in `@happyvertical/smrt-manufacturing`.

## API

### Models

| Export | Description |
|---|---|
| `InventoryLocation` | Physical or virtual stocking site with open-ended `kind`. |
| `StockLevel` | Materialized `(skuId, locationId, state) → qty` row. **Never mutate directly — use `StockService`.** |
| `StockMovement` | Append-only audit row. One per mutation; two for transfers. |

### Collections

| Export | Description |
|---|---|
| `InventoryLocationCollection` | `findByCode`, `findByKind`, `findByPlace`, `findActive` |
| `StockLevelCollection` | `getLevel`, `findBySku`, `findByLocation`, `totalForSku`, `totalForLocation` |
| `StockMovementCollection` | `findBySku`, `findByLocation`, `findBySource`, `findByReason` |

All catalog shapes (`Product`, `Material`, `ProductVariant`, `Sku`) live in [`@happyvertical/smrt-products`](../products). This package adds the stock-motion layer (`InventoryLocation`, `StockLevel`, `StockMovement`, `StockService`) on top.

### Service

| Export | Description |
|---|---|
| `StockService` | The only sanctioned mutation surface. Six methods: `receive`, `reserve`, `release`, `fulfill`, `transfer`, `adjust`. |
| `createStockService({ db })` | Convenience factory. |
| `InsufficientStockError` | Thrown by `reserve` / `fulfill` / `transfer` / negative `adjust` when stock would go negative. Carries `skuId`, `locationId`, `state`, `requested`, `available`. |
| `installInventoryDispatchHandlers({ dispatchBus, db })` | Opt-in DispatchBus wiring for `contract:created` and `fulfillment:shipped`. |

### Types

| Export | Description |
|---|---|
| `StockState` | `'available' \| 'allocated' \| 'wip' \| 'qc_hold' \| 'damaged'` |
| `InventoryLocationKind` | Open-ended classifier string |
| `StockMovementReason` | Canonical reason vocabulary (`'receipt'`, `'reservation'`, `'release'`, `'fulfillment'`, `'transfer_out'`, `'transfer_in'`, `'adjustment'`, `'production_consume'`, `'production_produce'`) plus free-form strings |

## Dependencies

| Package | Purpose |
|---|---|
| `@happyvertical/smrt-core` | SmrtObject / SmrtCollection / DispatchBus |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/sql` | Database adapter |

## License

MIT

### Database initialization

`StockService.create()` and transaction-scoped service construction initialize
their three collections sequentially. Each initialization checks framework
system tables on the shared connection; parallel probes can interfere on
DuckDB. This ordering does not change the single-transaction stock/audit contract
or provision application schema at runtime.

The package test suite covers cold SQLite/DuckDB initialization and repeated
transaction rollback. Set `SMRT_TEST_POSTGRES_URL` to an isolated PostgreSQL
database to exercise the same fixture on PostgreSQL.

### Reorder policies and movement actors

`stock.setReorderPolicy(skuId, locationId, reorderPoint, reorderQuantity?)`
sets nullable decimal metadata on the **available** stock row. It creates a
zero-balance row if necessary without inventing an audit movement. Values must
be finite and non-negative; `null` disables monitoring, and omitting the reorder
quantity clears its suggestion. Stock mutations preserve these settings.
`stock.levels.findBelowReorderPoint(locationId?)` returns visible available rows
whose quantity is **strictly less** than their configured point. Equality, unset
thresholds, and other states do not count. Both methods retain normal tenant
scoping and the setter participates in `stock.withTransaction()`.

Every mutation accepts `actorProfileId` alongside source attribution. It is a
nullable qualified reference to `@happyvertical/smrt-profiles:Profile`, copied to
every ledger row including both transfer legs. Omission records `null` for
legacy callers and unattended automation. Supply the profile ID from trusted
server context; this attribution field does not authorize the caller.

Existing deployments must generate and apply their normal SMRT schema migration
before using these fields: add nullable decimal `reorder_point` and
`reorder_quantity` to `inventory_stock_levels`, and nullable profile-reference
`actor_profile_id` to `inventory_stock_movements` (UUID on PostgreSQL/DuckDB,
text on SQLite). Existing rows remain unset; runtime reads do not migrate tables.

### Svelte components

The optional `@happyvertical/smrt-inventory/svelte` entry exports:

| Component | Data / callback contract |
| --- | --- |
| `StockLevels` | `levels`, optional `locationId`; shows balance, reorder settings and low-stock status |
| `MovementHistory` | `movements`; read-only history with actor, source and note |
| `AdjustStockForm` | `skuId`, `locationId`, `onsubmit({ skuId, locationId, delta, reasonCode, note })` |
| `LocationList` | `locations`, optional `onedit(location)`; includes inactive locations |
| `LocationForm` | optional `location`, `onsubmit({ id?, code, name, kind, placeId, active })` |

The entry also exports structural browser-safe data types. Hosts load authorized
records and implement callbacks; components do not import database models, fetch
endpoints, or manage authentication. Route adjustment submissions through
`StockService.adjust`, attaching the trusted actor on the server. Save location
forms through `InventoryLocationCollection`; deactivate using `active: false`
rather than deleting history. Both forms accept `disabled`, prevent duplicate
submissions while awaiting callbacks, and display callback failures. Reorder
policy editing uses the service method above; stock quantities and movements
remain read-only outside the adjustment workflow.
