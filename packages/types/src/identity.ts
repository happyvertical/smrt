/**
 * Cross-package identity & tenancy data contracts.
 *
 * These interfaces are the structural shape that the identity model classes
 * expose to *other* packages:
 *
 * - `User`, `Tenant`, `Role`, `Membership` — runtime classes in
 *   `@happyvertical/smrt-users`
 *
 * They live here — in the zero-runtime types leaf — so a package that needs only
 * the *type* of an identity record never has to take a package dependency on the
 * implementation package. Importing these upward (e.g. `smrt-tenancy` reaching
 * into `smrt-users`) is what fabricated the peer-dependency cycle the leaf
 * removes. The runtime classes `implements` these interfaces, so the contract
 * stays honest (the class is checked to be a superset of the interface at
 * compile time).
 *
 * Scope: these cover the persisted, cross-package-visible fields only — not the
 * full class surface (methods, relationship accessors). Widen an interface when
 * a genuine cross-package consumer needs more; the `implements` clause guarantees
 * the class already provides it.
 *
 * @packageDocumentation
 */

import type { MembershipStatus, TenantStatus, UserStatus } from './user.js';

/**
 * Fields every persisted SMRT entity exposes — a subset of `SmrtObject`'s public
 * surface. `id`/`slug` are `null`/`undefined` before the first persist, matching
 * the base getters.
 */
export interface SmrtEntityFields {
  /** UUID, assigned on first persist. */
  id: string | null | undefined;
  /** URL-safe slug, when the model maintains one. */
  slug: string | null | undefined;
  /** Creation timestamp; `null`/`undefined` before first persist. */
  created_at: Date | null | undefined;
  /** Last-update timestamp; `null`/`undefined` before first persist. */
  updated_at: Date | null | undefined;
}

/** Auth identity record. Runtime class: `@happyvertical/smrt-users:User`. */
export interface User extends SmrtEntityFields {
  /** Plain-string reference to the owning `Profile` (not a DB foreign key). */
  profileId: string;
  /** Lower-cased email; globally unique. */
  email: string;
  status: UserStatus;
  lastLoginAt: Date | null;
}

/** Hierarchical tenant. Runtime class: `@happyvertical/smrt-users:Tenant`. */
export interface Tenant extends SmrtEntityFields {
  name: string;
  status: TenantStatus;
  description: string;
  parentTenantId?: string | null;
  hierarchyLevel: number;
  hierarchyPath: string;
  cascadePermissions: boolean;
  inheritPermissions: boolean;
}

/** RBAC role. Runtime class: `@happyvertical/smrt-users:Role`. */
export interface Role extends SmrtEntityFields {
  /** `null` → system role available to every tenant. */
  tenantId?: string | null;
  name: string;
  description: string;
  isSystem: boolean;
}

/** User↔Tenant↔Role junction. Runtime class: `@happyvertical/smrt-users:Membership`. */
export interface Membership extends SmrtEntityFields {
  userId?: string;
  tenantId?: string;
  roleId?: string;
  status: MembershipStatus;
}
