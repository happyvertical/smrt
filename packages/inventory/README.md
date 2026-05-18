# @happyvertical/smrt-inventory

Multi-location stock tracking for the SMRT framework. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, and any other vertical that counts discrete units across locations.

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
  SkuCollection,
} from '@happyvertical/smrt-inventory';

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

All five models use `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId`. Wrap mutations in `withTenant()` from `@happyvertical/smrt-tenancy` to scope queries automatically.

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
| `Sku` | Smallest sellable / countable unit. `productId` is a plain string reference to upstream catalog. |
| `Variant` | Declarative axis definition driving form / UI choices. |
| `InventoryLocation` | Physical or virtual stocking site with open-ended `kind`. |
| `StockLevel` | Materialized `(skuId, locationId, state) → qty` row. **Never mutate directly — use `StockService`.** |
| `StockMovement` | Append-only audit row. One per mutation; two for transfers. |

### Collections

| Export | Description |
|---|---|
| `SkuCollection` | `findByCode`, `findByBarcode`, `findByProduct`, `findByParent`, `findActive` |
| `VariantCollection` | `findByProduct`, `findByAxis` |
| `InventoryLocationCollection` | `findByCode`, `findByKind`, `findByPlace`, `findActive` |
| `StockLevelCollection` | `getLevel`, `findBySku`, `findByLocation`, `totalForSku`, `totalForLocation` |
| `StockMovementCollection` | `findBySku`, `findByLocation`, `findBySource`, `findByReason` |

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
