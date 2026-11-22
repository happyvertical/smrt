import { createOidcCallbackHandler } from '@happyvertical/smrt-users/sveltekit';

import { cloudSignInOptions } from '$lib/server/cloud-auth';
import { errorResponse } from '$lib/server/http';
import type { RequestHandler } from './$types';

/**
 * The hosted identity provider's redirect target (cloud profile only; a 404 on
 * the desktop). Verifies the response, creates or finds the account, creates
 * its workspace on the first sign-in, and mints a NEW session for it.
 */
export const GET: RequestHandler = async (event) => {
  try {
    return await createOidcCallbackHandler(await cloudSignInOptions())(
      event as never,
    );
  } catch (error) {
    return errorResponse(error);
  }
};
