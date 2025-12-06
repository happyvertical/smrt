/**
 * Auth module exports for smrt-profiles
 *
 * Provides identity resolution and authentication primitives.
 * Apps configure auth (OIDC providers), modules receive resolved profiles.
 */

export {
  resolveIdentity,
  createProfileFromOidc,
  type AuthContext,
  type ResolveIdentityResult,
} from './resolveIdentity';
