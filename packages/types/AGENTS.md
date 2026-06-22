# @happyvertical/smrt-types

Shared TypeScript type definitions. Prevents circular dependencies between packages.

## Exports

| File | Types |
|------|-------|
| `signals.ts` | `Signal`, `SignalType`, `SignalAdapter` — universal signaling system |
| `module.ts` | `SmrtModuleMeta`, `ModuleUISlot`, `ModuleComponentType` — module registration and UI slots |
| `user.ts` | `UserStatus`, `TenantStatus`, `MembershipStatus`, `SessionStatus`, `OverrideEffect` — status enums |
| `identity.ts` | `User`, `Tenant`, `Role`, `Membership`, `SmrtEntityFields` — cross-package identity data contracts (runtime classes live in smrt-users, which `implements` these) |

## Rules

- **Zero runtime code**: only type definitions and enums
- **Always `import type`**: use `import type { Signal }` to avoid runtime imports (except enums which have runtime values)
- **Add shared types here**: if two+ packages need the same type, put it here instead of in `smrt-core`
