# Tax codes

`TaxComponent` owns an immutable percent and optional liability account. To
change a rate, archive the old component, create a replacement and update the
editable `TaxCode.components` list. Never edit a used component's percent.

Every tenant seeds `exempt`, `zero-rated`, and `out-of-scope`
(`STANDARD_TAX_CODES`, seeded by `ensureTenantTaxCodes(db, tenantId)` in
`src/tax/standard-codes.ts`). Those kinds have no components because they
report differently. `TaxCodeCollection.findByCode(code, tenantId?)` finds a
code by its tenant-unique `code`, optionally for an explicit tenant.
The [money data upgrade](money-upgrade.md) adds a one-component
`rate-<percent>` code for each nonzero rate it finds in earlier-version data.

`TaxSettings` owns tenant defaults, tax registrations, default line amount type
and rounding scope. Cookbook policies adapt the portable settings document;
they do not replace persisted tax settings. There is one settings row per
tenant, created once under a tenant lock (see
[document money](document-money.md#tenant-settings-and-bootstrap-4009)).

`applyCommerceCookbookSettings(db, tenantId, cookbook)` is the explicit
server-side activation boundary for core's portable `taxRate`, inclusion, and
rounding policies. A host calls it after schema setup, once it has the
authoritative tenant from its authenticated bootstrap flow:

```ts
import { applyCommerceCookbookSettings } from '@happyvertical/smrt-commerce';
import cookbook from './smrt.cookbook.json' with { type: 'json' };

await applyCommerceCookbookSettings(db, session.tenantId, cookbook);
```

`ensureCommerceTenant(db, tenantId, { cookbook })` wraps this call with the
settings row and standard code seed; prefer it for a newly created tenant
(#4009).

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
