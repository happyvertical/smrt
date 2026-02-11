# @happyvertical/smrt-types

Shared TypeScript type definitions for the SMRT framework. Prevents circular dependencies by centralizing types used across packages.

## Architecture

```
src/
  index.ts      # Export barrel (type re-exports only)
  signals.ts    # Universal Signaling System types
  module.ts     # Module metadata types for UI integration
  user.ts       # User status enums
```

## Key Exports

### Signal Types (`signals.ts`)

- `Signal` — Core signal payload with type, source, timestamp, data
- `SignalType` — Enumeration of signal types (method calls, lifecycle events)
- `SignalAdapter` — Adapter interface for logging, metrics, pub/sub integration

### Module Types (`module.ts`)

- `SmrtModuleMeta` — Module metadata for registration and discovery
- `ModuleUISlot` — UI slot definitions for admin panel integration
- `ModuleUIBaseProps` — Base props for UI components
- `ModuleComponentType` — Component type enumeration
- `ModuleUIRegistryInterface` — Registry interface for module UI registration

### User Status Enums (`user.ts`)

- `UserStatus` — User account status
- `TenantStatus` — Tenant status
- `MembershipStatus` — Tenant membership status
- `SessionStatus` — Session status
- `OverrideEffect`, `TenantPermissionEffect` — Permission effect enums

## Key Patterns

- **Zero runtime dependencies**: This package only contains type definitions
- **Use `import type`**: Always use `import type { ... }` to avoid runtime imports
- **Prevent circular deps**: Types shared across packages live here instead of in `smrt-core`

## Usage

```typescript
import type { Signal, SignalType, SignalAdapter } from '@happyvertical/smrt-types';
import type { SmrtModuleMeta, ModuleUISlot } from '@happyvertical/smrt-types';
import { UserStatus, TenantStatus } from '@happyvertical/smrt-types';
```
