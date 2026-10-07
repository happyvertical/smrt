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

The caller owns action URLs, server authorization, tenancy checks, request tokens, persistence, and retry behavior. Capability props only decide whether an affordance is rendered. The components never create a Profile, Customer, Vendor, or contact relationship and never generate request tokens.

`CustomerDisplayData.creditLimitMinor` and `VendorDisplayData.minimumOrderMinor` are integer currency minor units. Detail components convert them only for display and accept an explicit `minorUnitExponent`. Form values deliberately use retained strings such as `1250.00`; the server validates and converts those major-unit strings to the model's integer minor units.

`VendorFormValues.leadTimeDays` is also retained text. The control supplies a numeric keyboard hint without browser number-input sanitization, and the server must parse and validate the submitted non-negative integer.

Forms use the provider-free `Form`, `Input`, `Select`, `Textarea`, and `Checkbox` controls from `@happyvertical/smrt-ui/forms`. They default to native `POST` submission through `preventDefault={false}`. `transport.hiddenFields`, `transport.intentName`, and the field-name maps let an application preserve its existing payload contract. Repeatable contact rows submit repeated field names in DOM order. Add and remove controls are native submitters, so they work without JavaScript; the server returns the revised rows and retained values.

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
picker for ISO 4217 strings and is never applied to minor-unit amounts.
Behaviour tests run under jsdom: `pnpm exec vitest run --config
vitest.selects.config.ts` (also part of `pnpm test:ui`).
