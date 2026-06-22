# @happyvertical/smrt-subscriptions

Tenant subscriptions, plan features, usage thresholds, and entitlement
resolution for SMRT applications.

## Validation

```bash
pnpm --filter @happyvertical/smrt-subscriptions test
pnpm --filter @happyvertical/smrt-subscriptions typecheck
pnpm --filter @happyvertical/smrt-subscriptions build
```

## Notes

- Keep Stripe-specific fields as provider binding metadata. Runtime Stripe API
  calls belong in the HappyVertical SDK accounting provider.
- Thresholds are evaluated from tenant usage metrics and optional AI usage
  summaries. Resolve multiple thresholds with the batch usage path where
  available; do not bypass tenant context in application code.
- Subscription UI components should stay provider-neutral and receive actions
  from the host app.
