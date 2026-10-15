# Customer and vendor UI

Import the provider-free surfaces from `@happyvertical/smrt-commerce/svelte`:

```svelte
<script lang="ts">
  import {
    CustomerDirectory,
    CustomerDetail,
    CustomerForm,
    VendorDirectory,
    VendorDetail,
    VendorForm,
    type CustomerDisplayData,
  } from '@happyvertical/smrt-commerce/svelte';

  let { data, form } = $props();
</script>

<CustomerForm
  mode="edit"
  values={form?.values ?? data.values}
  errors={form?.errors}
  transport={{
    action: '?/update',
    method: 'post',
    hiddenFields: {
      requestId: form?.values.requestId ?? data.requestId,
      expectedTenantId: data.tenantId,
    },
  }}
  labels={{ singular: 'Client', plural: 'Clients' }}
  cancelHref={`/clients/${data.customer.id}`}
/>
```

The caller owns action URLs, server authorization, tenancy checks, request tokens, persistence, and retry behavior. Capability props only decide whether an affordance is rendered. The components never create a Profile, Customer, Vendor, or contact relationship and never generate request tokens; the server writes posted contact rows with `savePartyContacts()` ([contact rows](#contact-rows-3501)).

`CustomerDisplayData.creditLimitMinor` and `VendorDisplayData.minimumOrderMinor` are integer currency minor units. Detail components convert them only for display and accept an explicit `minorUnitExponent`. Form values deliberately use retained strings such as `1250.00`; the server validates and converts those major-unit strings to the model's integer minor units.

`VendorFormValues.leadTimeDays` is also retained text. The control supplies a numeric keyboard hint without browser number-input sanitization, and the server must parse and validate the submitted non-negative integer.

Forms use the provider-free `Form`, `Input`, `Select`, `Textarea`, and `Checkbox` controls from `@happyvertical/smrt-ui/forms`. They default to native `POST` submission through `preventDefault={false}`. `transport.hiddenFields`, `transport.intentName`, and the field-name maps let an application preserve its existing payload contract. Repeatable contact rows submit repeated field names in DOM order. Add and remove controls are native submitters, so they work without JavaScript; the server returns the revised rows and retained values.

`CustomerForm` and `VendorForm` accept submit hooks so a host never has to find
the form after mount (#3501). `enhance` (`PartyFormEnhance`, action-shaped) is
applied to the mounted native `<form>` and destroyed with it; SvelteKit's
`enhance` from `$app/forms` fits directly, or wrap it to pass a submit callback.
An `ssr = false` app needs it, because a plain native post answers with the
empty shell. `onsubmit` receives the native submit event (submission stays
native unless it calls `preventDefault()`), and the `getFormElement()` instance
method returns the native element while mounted.

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
</script>

<VendorForm values={form?.values ?? data.values} errors={form?.errors} transport={{ action: '?/save' }} {enhance} />
```

Directory search forms accept `hiddenFields` as a string record for caller-owned GET state such as sort direction and page size. Fields whose names equal the resolved `queryName` or `statusName` are omitted so the visible search controls remain authoritative.

Customer shipping and billing addresses use the shared `CountrySelect` and
`ProvinceSelect`. The native names remain `shippingCountry`, `shippingState`,
`billingCountry`, and `billingState` unless `fieldNames` overrides them. Changing
country changes the region control without clearing its current string; CA and US
render localized subdivision choices, while unsupported countries render an
editable text field. Unknown values remain selectable/postable after a failed
submission. Use `countryOptions` or `provinceOptions` only when the caller must
restrict the choices. `VendorForm` has no structured address fields in its public
DTO and does not invent them.

Vendor currency uses the shared `CurrencySelect`. The raw retained string remains
the native `currency` payload, including unknown values returned after validation.
Use `currencyOptions` for caller-authorized restrictions; omitted options use the
shared currency catalog. Selector labels follow the active smrt-ui i18n locale.

The forms place a non-focusable default save submitter before contact row actions so Enter in a text field cannot accidentally add or remove a contact. This remains in place when the `actions` snippet customizes the visible action bar; set `transport.saveIntent` to the custom save intent.

Use the `extension` snippets for application fields such as construction roles and trades. Keep those fields and their policy in the application:

```svelte
<VendorForm values={data.values} transport={{ action: '?/save' }}>
  {#snippet extension(values)}
    <ConstructionVendorFields roles={values.roles} trades={values.trades} />
  {/snippet}
</VendorForm>
```

Directory entries carry caller-owned detail links and pagination links. Detail edit links and form submit buttons appear only when their capability props allow them; the server must still authorize every request.

`CustomerDirectory`, `CustomerDetail`, `VendorDirectory`, and `VendorDetail`
render a `PageHeader` (the page `h1`, a subtitle, and the add/edit action) by
default. A host that frames every page itself passes `headless` to render only
the body, then renders its own heading and create/edit affordance; or passes a
`header` snippet to replace the built-in header in place (#3501). `backHref`
stays independent of both.

Directory empty and filter behavior follows this contract:

| State | Empty guidance | Native form behavior |
| --- | --- | --- |
| No query, status, or caller filter is active | Explain that no records have been added; when `canCreate` and `addHref` are present, point to creating the first record | Search and status controls retain their normal names |
| Query or status is active | Suggest changing search or filters | Visible query/status controls remain authoritative over same-named `hiddenFields` |
| A caller-owned filter is active | Suggest changing search or filters | Render the `filters` snippet inside the directory form and list its names in `filterNames` so same-named hidden fields are omitted |
| Caller supplies `emptyDescription` | Render the supplied description | Submission behavior is unchanged |

The `filters` snippet is for domain-adjacent GET controls that belong beside
search and status, such as a trade classification. It does not move filtering
or authorization into the component. `hasAdditionalFilters` describes whether
those controls currently narrow the result, while `filterNames` prevents a
hidden/visible duplicate name from changing native form serialization.

The registry keys are `customer-directory`, `customer-detail`, `customer-form`, `vendor-directory`, `vendor-detail`, `vendor-form`, and `party-contact-fields`. Interactive examples are published by `@happyvertical/smrt-commerce/playground` and ship in the next generated Commerce package release. DomaCraft can replace its local routes incrementally by adapting its existing server DTOs and payload names; no identity or database migration is required.

The form playground previews handle save, add-contact, and remove-contact intents in memory. They deliberately return a simulated validation error on save so retained values and retry behavior can be inspected without a backend.

## Contact rows (#3501)

`Customer.contacts` / `Vendor.contacts` store `PartyContact` rows (JSON
column; additive schema, run `smrt db:migrate`). The root package exports the
server half of the form's contact payload:

| Export | Contract |
| --- | --- |
| `readPartyContactRows(form, fieldNames?)` | Zips the repeated `contactId`, `contactName`, `contactLabel`, `contactEmail`, `contactPhone`, `contactAddress` values (or the form's `fieldNames` overrides) in DOM order into raw `PartyContactInput` rows. The editable contact block always posts a hidden `contactCount` marker with its row count; a missing marker (`reason: 'missing'`) or any disagreeing count (`'misaligned'`) throws `PartyContactPayloadError`, so zero rows mean an empty list only when the block rendered. |
| `applyPartyContactIntent(rows, intent, intents?)` | `addContact` appends a blank row; `removeContact:<n>` (or a caller `parseRemoveIntent`) drops row `n`. `handled: true` means render the returned rows and do not save, including for a stale index. |
| `validatePartyContactRows(rows)` | Trims, drops blank rows, and returns `errors` aligned with the submitted rows using codes `too_long` (limits in `PARTY_CONTACT_MAX_LENGTHS`, matching the inputs) and `invalid_email`. |
| `savePartyContacts(collection, partyId, formOrRows, { fieldNames?, expectedTenantId? })` | Given the posted form, reads it with `readPartyContactRows` (marker enforced); an array is taken as rows already read that way. Loads the party with `collection.get()` (so the active tenant context scopes it) and replaces its contacts: posted ids are kept, new rows get a random id, unposted rows are removed. A posted id the party does not have is `unknown_contact` on `id`. Invalid input throws `PartyContactValidationError` (`errors`, nothing written); a missing or other-tenant party throws `PartyContactPartyNotFoundError`. |

Error codes are not messages: map `PartyContactValidationError.errors` to
localized strings for `PartyFormErrors.contacts`, and return the submitted
rows as retained `values.contacts`. A form with custom contact `fieldNames`
must pass the same names when reading; with mismatched names the marker is
not found and the read fails closed instead of removing every contact. Saves are a read-modify-write of the party
row (last writer wins). Map saved contacts to `CustomerDisplayData.contacts` /
`VendorDisplayData.contacts` for the detail screens.

## Selectors (#3602)

`CustomerSelect` and `VendorSelect` are field-sized pickers built on the shared
smrt-ui `RelationInput` (`@happyvertical/smrt-ui/forms`, ARIA 1.2 combobox),
through one internal `PartySelect` adapter that maps party DTOs to relation
options and localizes the field's text. Search, resolve, debounce, stale-result
and create handling live in `RelationInput`, not here.

| Prop | Meaning |
| --- | --- |
| `name`, `value` (bindable), `label`, `required`, `disabled`, `error`, `placeholder`, `description` | Field basics. `label` defaults to the localized "Customer"/"Vendor"; `error` renders a linked `role="alert"`. |
| `search(query)` | Caller-owned lookup returning party DTOs; called with `''` when the list opens and, debounced (`debounceMs`, default 250), as the person types. |
| `resolve(id)` | Caller-owned lookup of the current value's DTO when it has not been listed; without it a value stays blank until searched. |
| `onCreate(query)` | Optional. Renders "+ New customer/vendor" (`createLabel` overrides); a returned DTO is selected. |
| `onchange(id)`, `interaction` | Change callback (`''` when cleared) and agent-interaction options. |

Rows show `profile.name` with localized status and, for customers, type
(`Active · Wholesale`). Data never enters the component: no stores, no fetches,
no tenant logic. A failed `search` shows an inline status, not an exception;
a failed `onCreate` leaves the field as it was. Text comes from the
`commerce.select.*` messages. The selectors are registered as the
`customer-select` and `vendor-select` slots, whose `selects` qualified names
are emitted into the manifest's `uiSelectors`; keep `selects` a string literal
so the scanner can read it.

Widget hints (`@field({ ui: { widget } })`, #3599) are presentation-only and
the build rejects them on non-text fields; `currency` is a currency-code
picker for ISO 4217 strings and is never applied to minor-unit amounts;
amounts take `ui: { format: 'money' }` instead (#3718).
Behaviour tests run under jsdom: `pnpm exec vitest run --config
vitest.selects.config.ts` (also part of `pnpm test:ui`).

## Record page hints (#3718)

Minor-unit amounts on Contract, Invoice, their line items, Payment,
PaymentAllocation, `Customer.creditLimit` and `Vendor.minimumOrderAmount`
carry `ui: { format: 'money' }` (#3718; `widget: 'currency'` stays the
currency-code picker on the text `currency` field). That includes the
money-v2 fields (#4011): line `taxAmount`, `discountTotal` on Invoice and
Contract, `Invoice.creditedAmount`, and `DocumentTax` `taxableMinor` /
`taxMinor` / `recoverableMinor`; the test asserts every integer named
`*Amount`, `*Total`, `*Minor` or `subtotal` on those models (and Contract's
STI subtypes) is hinted. `legacyAmount` is `@internal` migration-rollback
state, not a user-facing amount, and stays unhinted. Payout and Payment's
native/USD drift amounts are not hinted: their currency is a payout rail or
fixed USD, not the record's `currency`. The line-item FKs
(`ContractLineItem.contractId`, `InvoiceLineItem.invoiceId`,
`FulfillmentLineItem.fulfillmentId`) carry `role: 'items'`, so record pages
render them as a line-items table with a totals block;
`src/__tests__/money-hints-manifest.test.ts` pins both.
