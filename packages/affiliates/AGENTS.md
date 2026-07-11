# @happyvertical/smrt-affiliates

**DEPRECATED compatibility shim** over the `@happyvertical/smrt-sales`
commissions core. This package declares **no models and owns no persistence**
— every export is a re-export (or a legacy-shaped alias) of the sales
package's neutral commissions module, kept so existing imports compile while
consumers migrate. It will be removed in a future major release.

- Migration path (tables, columns, statuses, SQL sketches): `MIGRATION.md`
  in this package.
- The real API: `packages/sales/AGENTS.md` (`commissions` module).

## What the shim exports

| Shim export | Actual thing |
|---|---|
| `Partner` / `PartnerCollection` | `Earner` / `EarnerCollection` from `@happyvertical/smrt-sales` (same class references) |
| `Commission` / `CommissionCollection` | `Commission` / `CommissionCollection` from `@happyvertical/smrt-sales` (new shape) |
| `Payout` / `PayoutCollection` | `CommissionPayout` / `CommissionPayoutCollection` from `@happyvertical/smrt-sales` |
| `PartnerOptions` / `CommissionOptions` / `PayoutOptions` | `EarnerOptions` / `CommissionOptions` / `CommissionPayoutOptions` type aliases |
| `PartnerStatus`, `PartnerType`, `CommissionType`, `CommissionStatus`, `PayoutStatus`, `PayoutMethod` | frozen `as const` objects preserving the exact legacy enum members/values, each with a matching derived type |

The shim deliberately does **not** re-export the rest of the new surface
(no `Earner`-named exports, no plans/events/adjustments/services) — new code
imports `@happyvertical/smrt-sales` directly.

## Name/value mapping notes

- `PartnerStatus` values align exactly with the `EarnerStatus` union.
- `PayoutStatus` values align exactly with the `CommissionPayoutStatus`
  union; `PayoutMethod` values align with the new `PayoutMethod` union
  (which adds `'other'`).
- `CommissionStatus.INCLUDED` (`'included'`) has **no direct equivalent**;
  the nearest new state is `'payable'` with `payoutId` set. `PENDING`/`PAID`
  align.
- `PartnerType` has no equivalent — roles are first-class models now:
  `Referrer` (`@happyvertical/smrt-sales/referrals`) and
  `SalesRepresentative` (`@happyvertical/smrt-sales/crm`), each holding an
  `earnerId`.
- `CommissionType` is superseded by `CommissionPlan` component keys.

## Gotchas

- **No manifest, no tables**: the package emits no SMRT objects; there is no
  `./manifest` export anymore. Data lives in the sales tables (`earners`,
  `commissions`, `commission_payouts`).
- **Tenancy stance changed**: the legacy models were intentionally NOT
  tenant-scoped; the sales models are `@TenantScoped({ mode: 'optional' })`.
  Legacy rows migrate with `tenant_id = NULL` (global) — see `MIGRATION.md`.
- **Do not add models here**: new commission features belong in
  `packages/sales/src/commissions/`.
