import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveApplicationId } from '../../../../../scripts/smrt-runtime-identity.mjs';

export const GET: RequestHandler = async () =>
  json({
    schemaVersion: 1,
    status: 'ready',
    application: resolveApplicationId({
      sourceRoot: process.cwd(),
      explicitId: process.env.SMRT_APP_ID,
    }),
    instance: process.env.SMRT_PROCESS_INSTANCE || null,
  });
