/**
 * Service exports for smrt-users
 * @packageDocumentation
 */

export {
  MagicLinkError,
  type MagicLinkResult,
  MagicLinkService,
  type MagicLinkServiceOptions,
  type MagicLinkVerifyResult,
} from './MagicLinkService.js';

export {
  type PermissionResolutionResult,
  PermissionResolver,
  type TenantPermissionInheritanceResult,
} from './PermissionResolver.js';

export {
  type SessionContext,
  SessionService,
  type SessionServiceOptions,
} from './SessionService.js';

export {
  type EnsureTenantResult,
  TenantService,
  type TenantWithOwnershipResult,
} from './TenantService.js';
