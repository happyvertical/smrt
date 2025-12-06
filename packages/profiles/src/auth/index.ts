/**
 * Auth module exports for smrt-profiles
 *
 * Provides identity resolution and authentication primitives.
 * Apps configure auth (OIDC providers), modules receive resolved profiles.
 */

export {
  type AuthContext,
  createProfileFromOidc,
  type ResolveIdentityResult,
  resolveIdentity,
} from './resolveIdentity';
