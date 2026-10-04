# @happyvertical/smrt-manufacturing

Bills of materials, cost rollup, and production-order operations for the s-m-r-t framework. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, food production, custom hardware, and any other vertical that builds finished goods from a recipe.

## Installation

```bash
pnpm add @happyvertical/smrt-manufacturing
```

This package depends on `@happyvertical/smrt-inventory` (peer-installed via your workspace) for stock operations.

## Usage

### Define a BOM with components

```typescript
import {
  BillOfMaterialsCollection,
  BomLineCollection,
} from '@happyvertical/smrt-manufacturing';

const db = { type: 'sqlite', url: 'app.db' };
const boms = await BillOfMaterialsCollection.create({ db });
const lines = await BomLineCollection.create({ db });

const bom = await boms.create({
  productId: shirt.id, // upstream Product or any STI subtype
  version: 1,
  status: 'active',
  currency: 'USD',
  notes: 'Initial revision',
});
await bom.save();

const fabric = await lines.create({
  bomId: bom.id!,
  componentSkuId: fabricSku.id!,
  qtyPerUnit: 2.0,
  uom: 'yards',
  wastePercent: 10, // 10% cutting waste
});
await fabric.save();

const buttons = await lines.create({
  bomId: bom.id!,
  componentSkuId: buttonSku.id!,
  qtyPerUnit: 4,
  uom: 'each',
});
await buttons.save();
```

### Roll up material cost with waste

```typescript
import { BomService } from '@happyvertical/smrt-manufacturing';

const service = await BomService.create({
  db,
  // Plug in any cost source: smrt-products Material.costPerUnit,
  // a purchase-order rolling average, a vendor price book, anything.
  costResolver: async (componentSkuId) => {
    const sku = await skus.get(componentSkuId);
    return sku?.attributes ? Number(JSON.parse(sku.attributes).cost ?? 0) : null;
  },
});

const rollup = await service.computeMaterialCost(bom.id!);
console.log(rollup.totalCost, rollup.currency);
// Walks lines, applies waste, surfaces a per-line breakdown.
```

### Operations, routing and estimated labour

An `Operation` is a kind of work (cut, weld, inspect) kept as a managed list per
tenant. A bill of materials may carry a routing: an ordered list of operations,
each with an estimated duration in minutes for one unit. A bill with no routing
works exactly as before.

```typescript
import {
  BomService,
  OperationService,
  RoutingService,
} from '@happyvertical/smrt-manufacturing';

const operations = await OperationService.create({ db });
const cut = await operations.define({ code: 'CUT', name: 'Cutting', category: 'fabrication' });
const weld = await operations.define({
  code: 'WELD',
  name: 'Welding',
  // Plain id of a smrt-human-resources Qualification; an application reads it
  // to decide who may start the operation. Not validated here.
  requiredQualificationId: qualificationId,
});
await operations.rename(cut.id!, 'Plasma cutting');
await operations.retire(weld.id!); // leaves pickers, stays on history
await operations.reinstate(weld.id!);

const routing = await RoutingService.create({ db });
await routing.replaceRouting(bom.id!, [
  { operationId: cut.id!, estimatedMinutes: 30 },
  { operationId: weld.id!, estimatedMinutes: 90, notes: 'tack first' },
]);

const service = await BomService.create({
  db,
  // Optional, like costResolver: hourly rate for an operation, or null.
  rateResolver: (operation) => (operation.code === 'WELD' ? 80 : 60),
});
const labour = await service.computeLabourEstimate(bom.id!);
console.log(labour.totalMinutes, labour.totalCost, labour.steps);
```

`replaceRouting` swaps the whole routing in one transaction (steps are numbered
1..n in the order given; an empty list removes it). A retired operation can stay
on a routing that already has it but cannot be newly added. Without a
`rateResolver` the estimate reports minutes only and flags each step
`rateUnavailable`.

### Operation list and form

`@happyvertical/smrt-manufacturing/svelte` exports props-driven `OperationList`
(with optional edit, retire and reinstate actions) and `OperationForm` (add, or
edit name, category and required qualification; the code is fixed once set).
They register with `ModuleUIRegistry` on import. Hosts load rows through
`OperationService` and perform the actions themselves.

### Plan a production run

```typescript
const requirements = await service.explodeRequirements(bom.id!, 100);
// [{ componentSkuId: fabricSku.id, totalQty: 220, uom: 'yards' },
//  { componentSkuId: buttonSku.id, totalQty: 400, uom: 'each' }]

const check = await service.canProduce(bom.id!, 100);
if (!check.ok) {
  for (const shortage of check.shortages) {
    console.log(
      `Need ${shortage.requested} of ${shortage.componentSkuId}, have ${shortage.available}`,
    );
  }
}
```

### Execute consume / produce against a production order

The `ProductionOrder` row itself lives in `@happyvertical/smrt-commerce` as a `Contract` STI subtype. This package mutates the inventory ledger on its behalf.

```typescript
import { ProductionService } from '@happyvertical/smrt-manufacturing';

const production = await ProductionService.create({ db });

// Pull materials from the factory.
const consumed = await production.consumeMaterials(
  {
    id: order.id, // ProductionOrder.id
    productId: order.productId,
  },
  {
    locationId: factory.id, // explicit — not stored on the order
    qty: 100,
  },
);

// Receive finished goods.
const produced = await production.produceFinishedGoods(
  { id: order.id, productId: order.productId },
  {
    locationId: factory.id,
    qty: 100,
    finishedSkuId: finishedVariant.id, // explicit — one productId can have many SKUs
  },
);
```

Every emitted `StockMovement` is stamped with `sourceType: 'ProductionOrder'` plus `sourceId: order.id` so audit queries can reconstruct what happened later via `StockMovementCollection.findBySource('ProductionOrder', order.id)`.

### Multi-tenancy

Both `BillOfMaterials` and `BomLine` use `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId`. Wrap mutations in `withTenant()` from `@happyvertical/smrt-tenancy` to scope queries automatically.

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-a' }, async () => {
  const requirements = await service.explodeRequirements(bom.id!, 50);
  // Reads are auto-filtered by tenant_id = 'tenant-a'.
});
```

### Opt-in DispatchBus wiring

The package ships handlers that bridge production-order lifecycle events to the consume / produce flow. Off by default; install them explicitly in your `smrt.ts`:

```typescript
import { createDispatchBus } from '@happyvertical/smrt-core';
import { installInventoryDispatchHandlers } from '@happyvertical/smrt-inventory';
import { installManufacturingDispatchHandlers } from '@happyvertical/smrt-manufacturing';

const bus = await createDispatchBus({ db });

// Inventory handlers bridge contract:created and fulfillment:shipped.
await installInventoryDispatchHandlers({ dispatchBus: bus, db });

// Manufacturing handlers bridge production_order:posted (and optionally
// production_order:completed) to consume / produce.
await installManufacturingDispatchHandlers({
  dispatchBus: bus,
  db,
  // Consume and produce in one shot when posted (make-to-stock).
  producedOnPosted: true,
});

// Later, when a production order is posted:
await bus.emit('production_order:posted', {
  productionOrderId: order.id,
  productId: order.productId,
  locationId: factory.id,
  qty: 100,
  finishedSkuId: finishedVariant.id, // only needed when producedOnPosted: true
});
```

Per-handler toggles (`installProductionPosted`, `installProductionCompleted`) let consumers pick exactly the legs they want. The companion `contract:created` and `fulfillment:shipped` handlers live in `@happyvertical/smrt-inventory`.

## API

### Models

| Export | Description |
|---|---|
| `BillOfMaterials` | Recipe for one finished product. Versioned with a `draft` / `active` / `superseded` lifecycle. |
| `BomLine` | One component on a BOM. `effectiveQtyPerUnit()` returns the qty including waste. |
| `Operation` | A kind of work: `code` (unique per tenant), `name`, `category`, `isActive` (retired operations stay on history, never deleted), optional `requiredQualificationId` (plain string id of a `smrt-human-resources` qualification). |
| `RoutingStep` | One operation in a BOM's optional routing: `bomId`, `operationId`, `sequence` (1..n), `estimatedMinutes`, `notes`. |

### Collections

| Export | Description |
|---|---|
| `BillOfMaterialsCollection` | `findByProduct`, `findActiveForProduct`, `findByStatus` |
| `BomLineCollection` | `findByBom`, `findByComponent` |
| `OperationCollection` | `findByCode`, `listOperations({ includeRetired? })` |
| `RoutingStepCollection` | `findByBom` (in step order), `findByOperation` |

### Services

| Export | Description |
|---|---|
| `BomService` | Cost rollup, requirements explosion, can-produce check. |
| `createBomService({ db, costResolver?, rateResolver? })` | Convenience factory. `computeLabourEstimate(bomId)` rolls up routing minutes and, with a `rateResolver`, cost. |
| `OperationService` / `createOperationService({ db })` | `define`, `get`, `list`, `rename`, `update`, `retire`, `reinstate`. |
| `RoutingService` / `createRoutingService({ db })` | `list(bomId)`, `replaceRouting(bomId, steps)`. |
| `OperationNotFoundError`, `DuplicateOperationCodeError`, `OperationRetiredError`, `InvalidOperationInputError` | Operation and routing errors. |
| `ProductionService` | Operational consume / produce against a production order. |
| `createProductionService({ db })` | Convenience factory. |
| `installManufacturingDispatchHandlers({ dispatchBus, db })` | Opt-in bus wiring. |
| `BomNotFoundError` | Thrown when a BOM id cannot be resolved. |
| `NoActiveBomForProductError` | Thrown by `ProductionService` when neither an explicit `bomId` nor an active BOM is available for a production order. |

### Types

| Export | Description |
|---|---|
| `BomStatus` | `'draft' \| 'active' \| 'superseded'` |
| `BomCostRollup` | Return shape of `computeMaterialCost`. |
| `BomLineCost` | Per-line entry inside a `BomCostRollup`. |
| `MaterialRequirement` | Entry returned by `explodeRequirements`. |
| `MaterialShortage` | Entry returned by `canProduce` when stock is insufficient. |
| `CanProduceResult` | `{ ok: true; shortages: [] } \| { ok: false; shortages: [...] }` |
| `ComponentCostResolver` | Async (or sync) callback returning unit cost or `null`. |
| `OperationRateResolver` | Async (or sync) callback returning an operation's hourly rate or `null`. |
| `LabourEstimate`, `RoutingStepEstimate` | Return shape of `computeLabourEstimate`. |
| `DefineOperationInput`, `RoutingStepInput` | Inputs to `define` and `replaceRouting`. |

## Dependencies

| Package | Purpose |
|---|---|
| `@happyvertical/smrt-core` | SmrtObject / SmrtCollection / DispatchBus |
| `@happyvertical/smrt-inventory` | StockService (consume / produce target) |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/smrt-ui` / `@happyvertical/smrt-types` | Operation list and form (`./svelte`), module slots (`./ui`); `svelte` is an optional peer |
| `@happyvertical/sql` | Database adapter |

## License

MIT
