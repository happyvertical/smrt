# @happyvertical/smrt-affiliates

> **DEPRECATED** — this package is a compatibility shim over
> [`@happyvertical/smrt-sales`](https://github.com/happyvertical/smrt/tree/main/packages/sales)
> and will be removed in a future major release.

The affiliate models that used to live here (`Partner`, `Commission`,
`Payout`) were generalized into the neutral commissions core of
`@happyvertical/smrt-sales`. This package now declares **no models and owns no
persistence** — it only re-exports the new classes under the legacy names so
existing imports keep compiling while you migrate:

| Legacy import (this package) | Actual class (`@happyvertical/smrt-sales`) |
|---|---|
| `Partner` / `PartnerCollection` | `Earner` / `EarnerCollection` |
| `Commission` / `CommissionCollection` | `Commission` / `CommissionCollection` (new shape) |
| `Payout` / `PayoutCollection` | `CommissionPayout` / `CommissionPayoutCollection` |
| `PartnerStatus`, `PartnerType`, `CommissionType`, `CommissionStatus`, `PayoutStatus`, `PayoutMethod` | frozen legacy-shaped const objects (see notes in `AGENTS.md`) |

## Migrating

- **New code**: import from `@happyvertical/smrt-sales` directly — `Earner`,
  `CommissionPlan`, `EarningEvent`, `Commission`, `CommissionAdjustment`,
  `CommissionPayout`, the collections, services, and money helpers.
- **Partner roles**: publisher/salesperson/referrer role flags are replaced by
  first-class role models — `Referrer` (`@happyvertical/smrt-sales/referrals`)
  and `SalesRepresentative` (`@happyvertical/smrt-sales/crm`) — each holding an
  `earnerId` that points at the shared financial account.
- **Data**: the full table/column/status mapping, behavioral changes (tenancy,
  lifecycle, rate representation), and SQL migration sketches live in
  [`MIGRATION.md`](./MIGRATION.md).

## Installation (legacy consumers)

```bash
pnpm add @happyvertical/smrt-affiliates
```

```typescript
// Still compiles — these are the smrt-sales classes under their old names.
import { Partner, PartnerCollection, Payout } from '@happyvertical/smrt-affiliates';
```

## License

MIT
