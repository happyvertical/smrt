# Invoice preparation UI

Import `InvoiceEditor`, `InvoiceReview`, `InvoiceEditorProps`,
`InvoiceAllocationDraft`, `InvoicePreparationSource`,
`InvoicePreparationReview`, `InvoicePreparationFields` and
`InvoicePreparationHiddenField` from `@happyvertical/smrt-commerce/svelte`.
The import registers `invoice-editor` and `invoice-review` in ModuleUIRegistry.
The shared Commerce playground includes interactive invoice preparation.

```svelte
<script lang="ts">
  import { InvoiceEditor } from '@happyvertical/smrt-commerce/svelte';
  let { data, form } = $props();
</script>
<InvoiceEditor
  action="?/save"
  currency={data.currency}
  allocations={form?.allocations ?? data.allocations}
  sources={data.authorizedSources}
  mayReadSources={data.mayReadSources}
  canEdit={data.mayPrepare}
  message={form?.message}
  review={data.review}
  hiddenFields={[
    { name: 'requestId', value: form?.requestId ?? data.requestId },
    { name: 'tenantId', value: data.tenantId },
    { name: 'currency', value: data.currency },
  ]}
/>
```

Each allocation has a stable unique `key`, `sourceId`, and `amount` text.
Draft amounts are **lossless currency-unit text**, for example `'125.00'` is CAD 125.00.
Source `availableMinor` values and public model amounts remain integer minor units.
Keep invalid entered strings intact in action failure results; parse currency precision into safe integer minor units and enforce availability
on the server (CAD two decimals; JPY zero; KWD three). No rounding or
currency conversion happens here. Existing `LineItem`/`UnbilledItem` components
retain their published decimal-dollar contracts.

A source projection contains `id`, `label`, `availableMinor`, and optional
`selectable`. The caller supplies only authorized reviewed sources and computes
availability including this invoice's own reservation when editing. The UI does
not query, reserve, validate money, or mutate Commerce models. Adapt public
Invoice/InvoiceLineItem records into the explicit draft contract; reservation
sources are caller-defined, not a new persistence model. `mayReadSources=false`
uses free-text references and never renders source labels/balances. An existing
reference absent from the list is retained as an option; a now-unselectable
reference already selected remains postable for server reconciliation.

Native payload defaults: repeated `sourceId` and `allocationAmount` fields
in row order; checked `removeRow` fields contain zero-based row positions;
clicked `intent` is `save` or `addAllocation`. Override names with `fields` and
submit values with `saveIntent`/`addIntent`. Hidden fields preserve repetition,
values and caller ownership. Avoid name collisions with row/submitter names.
Additional domain fields may be provided through the `children` snippet.

The add button posts every current value with `formnovalidate`, including without
JavaScript. Handle `addAllocation` as a structural action: return the submitted
rows plus one blank row; do not persist or rotate the request key. Saving may
apply checked removals after validating/authorizing the complete request. On any
failure (including denied or uncertain outcomes), rerender all submitted rows,
removal flags, field errors and tokens. The editor never resets or invents keys.

`review` is a caller-localized `{ label, message? }` server snapshot, supporting
unknown future states. Render updated invalidation/expiry messages when the
server provides them; the editor never infers approval from local fields.
`canEdit` and `mayReadSources` are presentation only: recheck tenant/actor,
source ownership, stale approval fingerprints and every mutation server-side.
Read-only mode disables row fields and hides mutation buttons.

For enhancement, pass `onsubmit`; default transport remains native. Supply an
existing `smrt-ui/form-retry` controller's `retryStatus` to present in-flight and
uncertain states. The component does not instantiate a controller or call its
reset/rotation methods. The application owns server idempotency and retained
values; pass caller-supplied retry messages through `message`. Native form ids
can be supplied with `id` for attaching an enhancement adapter.

Focused validation (full release suites run once on the release branch):

```sh
pnpm --filter @happyvertical/smrt-commerce exec vitest run --config vitest.invoices.config.ts
pnpm --filter @happyvertical/smrt-commerce exec playwright test -c e2e/invoices/playwright.config.ts
pnpm --filter @happyvertical/smrt-commerce typecheck
pnpm --filter @happyvertical/smrt-commerce build
```
