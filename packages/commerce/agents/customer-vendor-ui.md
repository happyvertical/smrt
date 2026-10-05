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

The registry keys are `customer-directory`, `customer-detail`, `customer-form`, `vendor-directory`, `vendor-detail`, `vendor-form`, and `party-contact-fields`. Interactive examples are published by `@happyvertical/smrt-commerce/playground` and ship in the next generated Commerce package release. DomaCraft can replace its local routes incrementally by adapting its existing server DTOs and payload names; no identity or database migration is required.

The form playground previews handle save, add-contact, and remove-contact intents in memory. They deliberately return a simulated validation error on save so retained values and retry behavior can be inspected without a backend.
