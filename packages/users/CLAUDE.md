# @happyvertical/smrt-users

Multi-tenant user management for the SMRT framework - users, tenants, roles, permissions, groups.

## Svelte Components

This package includes Svelte 5 UI components for user and tenant management.

### Installation

```bash
npm install @happyvertical/smrt-users
```

### Usage

```typescript
import {
  UserCard,
  UserList,
  UserForm,
  UserAvatar,
  UserMenu,
  InviteUserModal,
} from '@happyvertical/smrt-users/svelte';
```

### Components

- **UserCard** - Compact user information display
- **UserList** - List of users with selection support
- **UserForm** - Form for creating or editing users
- **UserAvatar** - User profile image or initials display
- **UserMenu** - User profile menu dropdown
- **InviteUserModal** - Modal for inviting new users

### Types

```typescript
import type {
  UserCardProps,
  UserListProps,
  UserFormProps,
  UserAvatarProps,
  UserMenuProps,
  InviteUserModalProps,
} from '@happyvertical/smrt-users/svelte';
```

### Auto-registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/smrt-users/svelte'; // Auto-registers all components

// Later, retrieve from registry
const Component = ModuleUIRegistry.get('@happyvertical/smrt-users', 'user-card');
```
