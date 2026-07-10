# @happyvertical/smrt-sales

Tenant-scoped CRM primitives for lead acquisition, ownership, qualification, configurable pipelines, opportunities, activities, and merge/conversion audit trails.

## Validation

```bash
pnpm --filter @happyvertical/smrt-sales test
pnpm --filter @happyvertical/smrt-sales typecheck
pnpm --filter @happyvertical/smrt-sales build
```

Lead acquisition and activity history are append-only. Lead conversion is idempotent by `leadId`; referral and commission policy belongs outside this package.