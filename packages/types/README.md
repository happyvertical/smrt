# @happyvertical/smrt-types

Shared TypeScript type definitions for the SMRT framework. Prevents circular dependencies by centralizing types that multiple packages need.

## Installation

```bash
pnpm add @happyvertical/smrt-types
```

## Usage

```typescript
// Import types (use `import type` for type-only imports)
import type { Signal, SignalType, SignalAdapter } from '@happyvertical/smrt-types';
import type { SmrtModuleMeta, ModuleUISlot } from '@happyvertical/smrt-types';

// Enums have runtime values — use regular import
import { UserStatus, TenantStatus, MembershipStatus } from '@happyvertical/smrt-types';
```

## Exports

### Signal System (types)

| Export | Description |
|--------|------------|
| `Signal` | Signal payload with lifecycle info (id, className, method, duration, etc.) |
| `SignalType` | Signal lifecycle stage: `'start'` \| `'step'` \| `'end'` \| `'error'` |
| `SignalAdapter` | Interface for signal processors (logging, metrics, pub/sub) |

### Module UI (types)

| Export | Description |
|--------|------------|
| `SmrtModuleMeta` | Module metadata (name, version, description) |
| `ModuleUISlot` | UI slot definition for module admin panels |
| `ModuleComponentType` | Component type classification |
| `ModuleUIBaseProps` | Base props interface for module UI components |
| `ModuleUIRegistryInterface` | Registry interface for module UI registration |

### User/Tenant Status (enums — runtime values)

| Export | Description |
|--------|------------|
| `UserStatus` | User lifecycle status |
| `TenantStatus` | Tenant lifecycle status |
| `MembershipStatus` | Membership lifecycle status |
| `SessionStatus` | Session lifecycle status |
| `OverrideEffect` | Permission override effect |
| `TenantPermissionEffect` | Tenant-level permission effect |

## Rules

- **Zero runtime code** except enums (which require runtime values)
- **Use `import type`** for non-enum imports to avoid unnecessary runtime dependencies
- **Add shared types here** if two or more packages need the same type definition

## Dependencies

None. This is a leaf package with zero dependencies.
