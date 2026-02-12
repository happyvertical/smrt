# @happyvertical/smrt-tenancy

Production-ready multi-tenancy framework for SMRT with automatic tenant isolation and enforcement.

## Svelte Components

This package includes Svelte 5 UI components for tenant management.

### Installation

```bash
npm install @happyvertical/smrt-tenancy
```

### Usage

```typescript
import {
  TenantCard,
  TenantSwitcher,
} from '@happyvertical/smrt-tenancy/svelte';
```

### Components

- **TenantCard** - Tenant information and management card
- **TenantSwitcher** - Dropdown for switching between tenants

### Types

```typescript
import type {
  TenantCardProps,
  TenantSwitcherProps,
} from '@happyvertical/smrt-tenancy/svelte';
```

### Auto-registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/smrt-tenancy/svelte'; // Auto-registers all components

// Later, retrieve from registry
const Component = ModuleUIRegistry.get('@happyvertical/smrt-tenancy', 'tenant-card');
```
