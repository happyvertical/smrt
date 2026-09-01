import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import {
  applicationRuntime,
  getLocalApplicationRuntime,
} from '$lib/server/application-runtime';
import {
  resolveApplicationId,
  resolveApplicationStateRoot,
} from '../../../scripts/smrt-runtime-identity.mjs';

export const load: PageServerLoad = async ({ url, locals }) => {
  if (locals.user) throw redirect(303, '/');
  if (applicationRuntime.profile !== 'local') {
    return { available: false, token: '' };
  }
  const runtime = await getLocalApplicationRuntime();
  const diagnostics = await runtime.diagnostics();
  return {
    available: diagnostics.bootstrap.status !== 'claimed',
    token: url.searchParams.get('token') || '',
  };
};

export const actions: Actions = {
  default: async (event) => {
    if (applicationRuntime.profile !== 'local') {
      return fail(404, { message: 'Local owner setup is disabled.' });
    }
    const form = await event.request.formData();
    const token = String(form.get('token') || '');
    const name = String(form.get('name') || '');
    const email = String(form.get('email') || '');
    if (!token || !name.trim() || !email.includes('@')) {
      return fail(400, { message: 'Name, email, and a valid setup token are required.' });
    }
    try {
      const runtime = await getLocalApplicationRuntime();
      const result = await runtime.claimOwner({
        token,
        name,
        email,
        userAgent: event.request.headers.get('user-agent') || undefined,
        ipAddress: event.getClientAddress(),
      });
      event.cookies.set('sid', result.sessionId, {
        path: '/',
        httpOnly: true,
        secure: event.url.protocol === 'https:',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60,
      });
      const appId = resolveApplicationId({
        sourceRoot: process.cwd(),
        explicitId: process.env.SMRT_APP_ID,
      });
      rmSync(
        join(
          resolveApplicationStateRoot({
            appId,
            dataDirectory: process.env.SMRT_DATA_DIR,
            sourceRoot: process.cwd(),
          }),
          'onboarding.json',
        ),
        { force: true },
      );
      rmSync(
        join(
          resolveApplicationStateRoot({
            appId,
            dataDirectory: process.env.SMRT_DATA_DIR,
            sourceRoot: process.cwd(),
          }),
          'onboarding-launch.html',
        ),
        { force: true },
      );
    } catch {
      return fail(400, {
        message: 'The setup invitation is invalid, expired, or already used. Run pnpm app:recover, then pnpm app:open.',
      });
    }
    throw redirect(303, '/');
  },
};
