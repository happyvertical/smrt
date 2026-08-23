# @happyvertical/smrt-types

Shared TypeScript type definitions. Prevents circular dependencies between packages.

## Exports

| File | Types |
|------|-------|
| `signals.ts` | `Signal`, `SignalType`, `SignalAdapter` — universal signaling system |
| `module.ts` | `SmrtModuleMeta`, `ModuleUISlot`, `ModuleComponentType` — module registration and UI slots |
| `user.ts` | `UserStatus`, `TenantStatus`, `MembershipStatus`, `SessionStatus`, `OverrideEffect` — status enums |
| `identity.ts` | `User`, `Tenant`, `Role`, `Membership`, `SmrtEntityFields` — cross-package identity data contracts (runtime classes live in smrt-users, which `implements` these) |
| `knowledge.ts` | Additive schema-version-1 domain knowledge contracts shared by core generation and development tooling |
| `data-query.ts` | Serializable bounded query request/result envelope, allowlisted schema, filters, paging, totals, freshness, and facets |

## Rules

- **Zero runtime code**: only type definitions and enums
- **Always `import type`**: use `import type { Signal }` to avoid runtime imports (except enums which have runtime values)
- **Add shared types here**: if two+ packages need the same type, put it here instead of in `smrt-core`
- **Knowledge compatibility**: keep `DomainKnowledgeManifest.schemaVersion` at 1 for additive optional facts and preserve `DomainKnowledgeObject.methods: string[]`; structured signatures live in the optional `methodSignatures` sibling. Generators set `sensitiveFieldsExcluded: true`; readers must treat its absence as a legacy artifact that needs raw-manifest corroboration.
