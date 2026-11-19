// Sign-in for the cloud profile: the hosted identity provider (OIDC, the
// providers configured under `packages.users.auth.oidc` in smrt.config).
//
// `smrt-users` verifies the provider's response (state, nonce, issuer, signed
// claims) and finds or creates the user. This module only decides WHICH TENANT
// the new session is for: the account's own workspace, created with its owner
// membership on the first sign-in (`accounts.ts`). The session is minted fresh
// by `smrt-users` for that tenant on every sign-in; a presented session cookie
// is never reused, and the tenant never comes from the request.
//
// The routes exist only in the cloud profile: on the desktop they are a 404.
import type { OidcSvelteKitOptions } from '@happyvertical/smrt-users/sveltekit';
import { ownerTenantFor } from './accounts.ts';
import { getAccountsDb, requireCloudProfile } from './host.ts';

/** Where a signed-in person lands, and where a failed sign-in returns. */
const SUCCESS_PATH = '/';
const FAILURE_PATH = '/?signin=failed';

export async function cloudSignInOptions(): Promise<OidcSvelteKitOptions> {
  await requireCloudProfile('Sign-in with an account');
  const db = await getAccountsDb();
  return {
    db,
    tenantId: async (result) =>
      ownerTenantFor(db, {
        id: result.user.id as string,
        name: (result.claims as { name?: string }).name,
        email: (result.claims as { email?: string }).email,
      }),
    successRedirect: SUCCESS_PATH,
    failureRedirect: FAILURE_PATH,
  };
}
