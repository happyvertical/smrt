---
"@happyvertical/smrt-commerce": minor
---

Add a `PaymentInstrument` model + `PaymentInstrumentCollection` for saved payment methods ("card on file"). It stores only reusable references (`providerCustomerId`, `providerPaymentMethodId`), the backend id, and non-sensitive display fields (brand / last4 / expiry) — never card data — plus a `PaymentInstrumentStatus` lifecycle (`active`/`expired`/`removed`) and single-default-per-customer support via `setDefaultForCustomer`.

Named `PaymentInstrument` (not `PaymentMethod`) to avoid clashing with the existing `PaymentMethod` payment-rail enum.
