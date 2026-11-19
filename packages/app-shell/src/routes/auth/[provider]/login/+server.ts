import { createOidcLoginHandler } from '@happyvertical/smrt-users/sveltekit';

import { cloudSignInOptions } from '$lib/server/cloud-auth';
import { errorResponse } from '$lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Starts the hosted identity sign-in (cloud profile only; a 404 on the
 * desktop). Register `/auth/<provider>/login` as the client's landing URL.
 */
export const GET: RequestHandler = async (event) => {
  try {
    return await createOidcLoginHandler(await cloudSignInOptions())(
      event as never,
    );
  } catch (error) {
    return errorResponse(error);
  }
};
