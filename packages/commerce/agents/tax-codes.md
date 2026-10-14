# Tax codes

`TaxComponent` owns an immutable percent and optional liability account. To
change a rate, archive the old component, create a replacement and update the
editable `TaxCode.components` list. Never edit a used component's percent.

Every tenant seeds `exempt`, `zero-rated`, `out-of-scope`, and
`legacy-unreconciled`. Those kinds have no components because they report
differently. A legacy zero rate means out-of-scope unless the linked customer
was explicitly exempt; malformed or out-of-range legacy rates stay visible
through `legacy-unreconciled` and the mapping report.

`TaxSettings` owns tenant defaults, tax registrations, default line amount type
and rounding scope. Cookbook policies adapt the portable settings document;
they do not replace persisted tax settings. The per-tenant migration marker is
owned by the money-snapshot migration.

`applyCommerceCookbookSettings(db, tenantId, cookbook)` is the explicit
server-side activation boundary for core's portable `taxRate`, inclusion, and
rounding policies. A host calls it after schema setup, once it has the
authoritative tenant from its authenticated bootstrap flow:

```ts
import { applyCommerceCookbookSettings } from '@happyvertical/smrt-commerce';
import cookbook from './smrt.cookbook.json' with { type: 'json' };

await applyCommerceCookbookSettings(db, session.tenantId, cookbook);
```

`smrt cookbook apply` writes project files and does not have a database or
tenant, so it deliberately performs no storage writes. Activation creates or
reuses a component and default tax code, then updates tenant `TaxSettings` in
one transaction. A zero default rate selects `out-of-scope`; inclusion remains
the cookbook's explicit inclusive/exclusive choice because individual lines can
still override the default code.

`COMMON_TAX_CODE_EXAMPLE_PACK` demonstrates Canada GST, BC GST+PST, Ontario
HST, UK VAT, Australian GST and New Zealand GST. Import it idempotently with
`applyTaxCodeExamplePack(db, tenantId)`, then review local applicability and
assign liability accounts before selecting a code for production documents.
The pack supplies examples, not jurisdiction determination.
