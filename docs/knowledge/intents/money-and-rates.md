---
type: Capability
title: "Money, rates and confidence fields"
description: "Declare money as integer minor units and rates as decimals through the core numeric-default rule instead of floats or custom decimal columns."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/ui-metadata.ts
    path: packages/core/src/ui-metadata.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/ui-metadata.ts (FIELD_UI_FORMAT_TYPES)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/scanner/manifest-generator.ts
    path: packages/core/src/scanner/manifest-generator.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/scanner/manifest-generator.ts (ui.format validation against field type)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/migrations/minor-units.ts
    path: packages/core/src/migrations/minor-units.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/migrations/minor-units.ts (preflightMinorUnitsRescale, rescaleMoneyColumnsToMinorUnits)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/subscriptions/src/index.ts
    path: packages/subscriptions/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/subscriptions/src/index.ts (migrateSubscriptionsMoneyToMinorUnits)"
---

# Money, rates and confidence fields

# Entry point

The rule is in the field default: `price = 0` is an integer column holding minor units (`1999` for $19.99), `rate = 0.0` is a decimal for rates and confidence. Mark presentation with `@field({ ui: { format: 'money' } })` (integer only) or `'percent'` (decimal or integer); a currency code is a separate text field. To convert a legacy floating-point money column, use `preflightMinorUnitsRescale()` then `rescaleMoneyColumnsToMinorUnits()` from `@happyvertical/smrt-core/migrations` (per-package wrappers such as `migrateSubscriptionsMoneyToMinorUnits` exist).[^s4]

# Why not hand-roll it

`FIELD_UI_FORMAT_TYPES` in `ui-metadata.ts` lists the only field type each presentation format may sit on (`money: ['integer']`), and the manifest generator fails the build when a `money` format is put on a non-integer field.[^s1][^s2] Converting an existing float column is deliberately not an automatic type change, because `ALTER ... TYPE BIGINT` would truncate `19.99` to `19`; `minor-units.ts` instead provides a read-only preflight that lists rows that would lose information (half-cents, values beyond the JavaScript safe-integer range once scaled) and a rescale guarded by a `BackfillTracker` marker so a re-run can never multiply a table by 100 twice.[^s3] Float money fields and `toFixed(2)` rounding lose exactly these cases silently.

# Component pages

- [smrt-core](/components/smrt-core.md)
- [smrt-subscriptions](/components/smrt-subscriptions.md)

# Detection signals

- `regex:\.toFixed\(2\)`
- `regex:price\w*\s*=\s*0\.0`
- `regex:DECIMAL\(\d+,\s*2\)`
- `decimal-field:*_cents`
- `decimal-field:*_amount`

[^s1]: `packages/core/src/ui-metadata.ts` at `478ae36900`: FIELD_UI_FORMAT_TYPES.
[^s2]: `packages/core/src/scanner/manifest-generator.ts` at `478ae36900`: ui.format validation against field type.
[^s3]: `packages/core/src/migrations/minor-units.ts` at `478ae36900`: preflightMinorUnitsRescale, rescaleMoneyColumnsToMinorUnits.
[^s4]: `packages/subscriptions/src/index.ts` at `478ae36900`: migrateSubscriptionsMoneyToMinorUnits.
