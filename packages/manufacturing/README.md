# @happyvertical/smrt-manufacturing

Bills of materials, cost rollup, and production-order operations for the s-m-r-t framework. Strictly industry-neutral — the same primitives serve apparel, furniture, automotive, CPG, electronics, food production, custom hardware, and any other vertical that builds finished goods from a recipe.

## Installation

```bash
pnpm add @happyvertical/smrt-manufacturing
```

This package depends on `@happyvertical/smrt-inventory` for stock operations and on `@happyvertical/smrt-products` for the catalog: `Assembly` is a `Product` subtype, and bill lines point at `Sku` ids.

## Usage

### Define an assembly and its bill

An `Assembly` is a product that is made, the counterpart to `Material`. It lives in the shared `products` table (`productType: 'assembly'`) and adds three fields of its own: `estimatedLabourMinutes`, `defaultOperationId` and `partReference`. Its part number and stock come from its `Sku`; what it is made of comes from its bill. A sub-assembly is simply a bill line whose SKU belongs to another assembly.

```typescript
import { SkuCollection } from '@happyvertical/smrt-products/collections';
import {
  AssemblyCollection,
  BillOfMaterialsCollection,
  BomLineCollection,
} from '@happyvertical/smrt-manufacturing';

const assemblies = await AssemblyCollection.create({ db });
const skus = await SkuCollection.create({ db });
const boms = await BillOfMaterialsCollection.create({ db });
const lines = await BomLineCollection.create({ db });

const panel = await assemblies.create({ name: 'Side panel', partReference: 'DWG-200' });
const panelSku = await skus.create({ productId: panel.id!, code: 'SP-100' });

const frame = await assemblies.create({
  name: 'Frame',
  partReference: 'DWG-100',
  estimatedLabourMinutes: 95,
});
const frameBom = await boms.create({ productId: frame.id!, version: 1, status: 'active' });

// Two side panels per frame: a sub-assembly line.
await lines.create({ bomId: frameBom.id!, componentSkuId: panelSku.id!, qtyPerUnit: 2 });
```

### Resolve a component, and refused cycles

```typescript
import { AssemblyService, BomCycleError } from '@happyvertical/smrt-manufacturing';

const assemblyService = await AssemblyService.create({ db });

const component = await assemblyService.resolveComponent(panelSku.id!);
// component.kind: 'assembly' | 'material' | 'bought' | 'missing'
// component.activeBom: the sub-assembly's active bill, or null when it has none
// component.buildable: true only for an assembly with an active bill

const frameSku = await skus.create({ productId: frame.id!, code: 'FR-100' });
const panelBom = await boms.create({ productId: panel.id!, version: 1, status: 'active' });
try {
  // The frame contains the panel, so the panel may not contain the frame.
  await lines.create({ bomId: panelBom.id!, componentSkuId: frameSku.id!, qtyPerUnit: 1 });
} catch (error) {
  if (error instanceof BomCycleError) {
    console.log(error.message);
    // Refused: "Side panel" would contain itself: Side panel → Frame → Side panel
  }
}
```

Every `BomLine` save, and every save of an `active` bill, runs this check, so the generated REST routes refuse a cycle too. Only active bills of sub-assemblies count; a draft or superseded bill is not part of the structure.

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

### Walk sub-assemblies

Every `BomService` method reads one level by default. Pass `{ levels }` (a number of bill levels, or `'all'`) to open each sub-assembly that has an active bill. Waste compounds down the levels; units stay as each line declares them.

```typescript
const service = await BomService.create({ db });

// Gross: every line with its level and path, plus the rolled-up totals.
const explosion = await service.explode(frameBom.id!, 10, { levels: 'all' });
// explosion.lines:  [{ level: 1, name: 'Side panel', totalQty: 20, expanded: true, ... },
//                    { level: 2, name: 'Steel tube', totalQty: 44, uom: 'm', ... }, ...]
// explosion.totals: [{ componentSkuId: tubeSku.id, totalQty: 44, uom: 'm' }]

// Net of stock: what is available, what is short, and what building the
// shortfall of each sub-assembly takes. Facts only; you decide build or buy.
const plan = await service.planRequirements(frameBom.id!, 10, { levels: 'all' });
// plan.lines:     [{ name: 'Side panel', totalQty: 20, available: 5, short: 15, expanded: true }, ...]
// plan.shortages: [{ componentSkuId: tubeSku.id, requested: 33, available: 0, level: 2, path: [...] }]

await service.canProduce(frameBom.id!, 10, { levels: 'all' }); // shortages at their own level
await service.computeMaterialCost(frameBom.id!, { levels: 'all' }); // sub-assemblies costed from their bills
await service.computeLabourEstimate(frameBom.id!, { levels: 'all' }); // adds sub-assembly routings
```

A walk stops at materials, bought items, assemblies without an active bill and the `levels` limit. It refuses a structure deeper than `MAX_EXPLOSION_DEPTH` (32) levels or larger than `MAX_EXPLOSION_LINES`, and a loop already present in stored data fails with `BomStructureCycleError` naming it.

### Record a production run

A `ProductionRun` is a build of a target quantity against one bill, reported as it happens.

```typescript
import { ProductionRunService } from '@happyvertical/smrt-manufacturing';

const runs = await ProductionRunService.create({ db });
const run = await runs.createRun({ productId: frame.id!, targetQty: 25 }); // pins the active bill

await runs.recordCompletion(run.id!, { qty: 12 }); // 25 to build, 12 done; no stock moves

// Optionally consume the bill and receive the finished units in the same transaction.
await runs.recordCompletion(run.id!, {
  qty: 13,
  consume: { locationId: factory.id! },
  produce: { locationId: factory.id!, finishedSkuId: frameSku.id! },
}); // the run is now done
```

`start`, `finish` (done short of the target), `cancel` and `setTarget` move the run through `planned`, `in_progress`, `done` and `cancelled`. Concurrent reports all count and never pass the target. Quantities are decimals kept to six places and summed exactly, so `0.1 + 0.2` completes a target of `0.3`; a run accepts quantities up to `MAX_QUANTITY` (999,999,999).

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

`Assembly`, `BillOfMaterials` and `BomLine` use `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId`. Wrap mutations in `withTenant()` from `@happyvertical/smrt-tenancy` to scope queries automatically.

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

### Svelte components

`@happyvertical/smrt-manufacturing/svelte` ships props-driven components; the host loads data and saves it.

```svelte
<script lang="ts">
  import {
    AssemblyForm,
    AssemblyList,
    BomEditor,
    ProductionRunList,
    RequirementsTree,
    toRequirementTotals,
    toRequirementTree,
  } from '@happyvertical/smrt-manufacturing/svelte';

  let { assemblies, policy, assembly, operations, lines, components, runs, plan } = $props();
</script>

<AssemblyList {assemblies} {policy} onselect={(id) => goto(`/assemblies/${id}`)} />
<AssemblyForm {assembly} {operations} hiddenFields={['price']} onsubmit={save} />
<BomEditor {lines} {components} onadd={addLine} loadBill={loadLines} error={saveError} />
<ProductionRunList
  {runs}
  oncomplete={(runId, qty) => report(runId, qty)}
  onsettarget={(run, target) => runService.setTarget(run.id, target)}
  onfinish={(run) => runService.finish(run.id)}
  oncancel={(run) => runService.cancel(run.id)}
/>
<RequirementsTree lines={toRequirementTree(plan)} totals={toRequirementTotals(plan)} />
```

`AssemblyList` takes the resolved field `policy` for Assembly and drops the columns it hides (a hidden price is not shown). `AssemblyForm` is a plain form on smrt-ui controls: name, description, category, part reference, price (typed in major units, checked against the `currency` prop's minor-unit exponent, handed over as integer minor units; a field the reader leaves untouched keeps its stored value exactly), estimated labour (whole minutes, zero or more), a default-operation picker over the `operations` you pass (pass the active ones; a retired or unlisted current operation stays selected, marked, and can be cleared) and tags. Pass the `assembly` being edited (omit to add), and map the reader's field policy onto `hiddenFields` (not rendered) and `readonlyFields` (shown, not editable); both carry their initial value through `onsubmit` unchanged, so save only what the reader may write. `onsubmit(values, formData)` receives checked values and the form's `FormData`; the form never persists. `showSkuCode` adds a required part-number field (the code of the assembly's `Sku`; trimmed into `values.skuCode`, absent from `values` when not shown; give the stored code as `assembly.skuCode`); report a duplicate code from your save with `errors={{ fields: { skuCode: 'FR-100 is already in use.' } }}` (`errors.form` shows a whole-form message). `extraFields` is a snippet rendered inside the form before its actions, so a host's own named controls submit with it and arrive in `formData`. Build rows with `toAssemblyView` and editor lines with `toBomEditorLines(await assemblyService.getBillStructure(bomId))`. A sub-assembly line in `BomEditor` says whether it has its own bill and expands read-only through `loadBill`. `ProductionRunList` shows each run's progress and status and, with `oncomplete`, a field to report finished units (rows from `toProductionRunView`). `onsettarget(run, target)`, `onfinish(run)` and `oncancel(run)` each add their own control to open runs, and only when given: a target field (checked above zero and not below what is done), and Finish and Cancel run buttons that ask through a `ConfirmDialog` first. A handler that returns `false` or throws keeps the input and shows a failure message; the host calls `ProductionRunService.setTarget`, `finish` or `cancel` and refreshes `runs`. `RequirementsTree` shows an `explode` or `planRequirements` result by level, with available and short per line for a plan.

### Component-free view adapters

`@happyvertical/smrt-manufacturing/views` exports `toBomEditorLine`, `toBomEditorLines`, `toRequirementTree` and `toRequirementTotals` (and their `BomEditorLine`, `RequirementLineView` and `RequirementTotalView` types) from a module that imports no component, so a server load can adapt service results without compiling any `.svelte` file. `./svelte` re-exports the same functions unchanged.

## API

### Models

| Export | Description |
|---|---|
| `Assembly` | A product that is made: `Product` STI subtype with `estimatedLabourMinutes`, `defaultOperationId`, `partReference`. |
| `BillOfMaterials` | Recipe for one finished product. Versioned with a `draft` / `active` / `superseded` lifecycle. |
| `BomLine` | One component on a BOM. `effectiveQtyPerUnit()` returns the qty including waste. |
| `Operation` | A kind of work: `code` (unique per tenant), `name`, `category`, `isActive` (retired operations stay on history, never deleted), optional `requiredQualificationId` (plain string id of a `smrt-human-resources` qualification). |
| `RoutingStep` | One operation in a BOM's optional routing: `bomId`, `operationId`, `sequence` (1..n), `estimatedMinutes`, `notes`. |
| `ProductionRun` | A build against one bill: `bomId`, `targetQty`, `completedQty`, `status` (`planned` / `in_progress` / `done` / `cancelled`). Written through `ProductionRunService`. |
| `ProductionRunCompletion` | One dated report of finished units on a run: `runId`, `qty`, `completedAt`. |

### Collections

| Export | Description |
|---|---|
| `AssemblyCollection` | Assembly rows of the shared `products` table. |
| `BillOfMaterialsCollection` | `findByProduct`, `findActiveForProduct`, `findByStatus` |
| `BomLineCollection` | `findByBom`, `findByComponent` |
| `OperationCollection` | `findByCode`, `listOperations({ includeRetired? })` |
| `RoutingStepCollection` | `findByBom` (in step order), `findByOperation` |
| `ProductionRunCollection` | `findByBom`, `findByStatus` |
| `ProductionRunCompletionCollection` | `findByRun` (in completion order) |

### Services

| Export | Description |
|---|---|
| `AssemblyService` | `resolveComponent`, `findActiveBom`, `isAssembly`, `getBillStructure`, `findCycle`, `assertLineAcyclic`, `assertBillAcyclic`. Pass `{ tenantId }` to read one tenant's structure. |
| `createAssemblyService({ db })` | Convenience factory. |
| `BomCycleError` | A `ValidationError` naming the `path` by which a save would make a product contain itself. |
| `BomService` | Cost rollup, requirements explosion, can-produce check; `{ levels }` walks sub-assemblies. `explode` (gross lines and totals) and `planRequirements` (net of stock). |
| `BomStructureCycleError`, `BomExplosionLimitError` | A walk met a loop in stored data, or exceeded `MAX_EXPLOSION_DEPTH` / `MAX_EXPLOSION_LINES`. |
| `ProductionRunService` / `createProductionRunService({ db })` | `createRun`, `get`, `listCompletions`, `start`, `recordCompletion`, `finish`, `cancel`, `setTarget`. |
| `ProductionRunNotFoundError`, `ProductionRunStateError`, `ProductionRunOverCompletionError`, `InvalidProductionRunInputError` | Production run errors. |
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
| `ComponentKind` | `'assembly' \| 'material' \| 'bought' \| 'missing'` |
| `ResolvedComponent` | Return shape of `resolveComponent`. |
| `BillStructure` | Return shape of `getBillStructure`. |
| `BomCostRollup` | Return shape of `computeMaterialCost`. |
| `BomLineCost` | Per-line entry inside a `BomCostRollup`. |
| `MaterialRequirement` | Entry returned by `explodeRequirements`. |
| `MaterialShortage` | Entry returned by `canProduce` when stock is insufficient. |
| `CanProduceResult` | `{ ok: true; shortages: [] } \| { ok: false; shortages: [...] }` |
| `ExplosionLevels`, `ExplosionOptions` | `levels`: a number of bill levels or `'all'`. |
| `Explosion`, `ExplodedLine`, `ExplosionPathEntry` | Return shape of `explode`. |
| `RequirementsPlan`, `PlannedLine` | Return shape of `planRequirements`. |
| `SubAssemblyLabour` | One sub-assembly in a multi-level `LabourEstimate`. |
| `CreateProductionRunInput`, `RecordCompletionInput`, `RecordCompletionResult` | Production run inputs and results. |
| `ComponentCostResolver` | Async (or sync) callback returning unit cost or `null`. |
| `OperationRateResolver` | Async (or sync) callback returning an operation's hourly rate or `null`. |
| `LabourEstimate`, `RoutingStepEstimate` | Return shape of `computeLabourEstimate`. |
| `DefineOperationInput`, `RoutingStepInput` | Inputs to `define` and `replaceRouting`. |

## Dependencies

| Package | Purpose |
|---|---|
| `@happyvertical/smrt-core` | SmrtObject / SmrtCollection / DispatchBus |
| `@happyvertical/smrt-inventory` | StockService (consume / produce target) |
| `@happyvertical/smrt-products` | `Product` (base of `Assembly`), `Material`, `Sku` |
| `@happyvertical/smrt-ui` | Svelte controls and i18n |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/smrt-ui` / `@happyvertical/smrt-types` | Operation list and form (`./svelte`), module slots (`./ui`); `svelte` is an optional peer |
| `@happyvertical/sql` | Database adapter |

## License

MIT
