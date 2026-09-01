import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveApplicationId } from '../../../../../scripts/smrt-runtime-identity.mjs';
import {
  applicationRuntime,
  applicationRuntimeConfiguration,
} from '$lib/server/application-runtime';

const applicationId = resolveApplicationId({
  sourceRoot: process.cwd(),
  explicitId: process.env.SMRT_APP_ID,
});

export const GET: RequestHandler = async () =>
  json({
    schemaVersion: 1,
    status: 'ready',
    application: applicationId,
    instance: process.env.SMRT_PROCESS_INSTANCE || null,
    profile: applicationRuntime.profile,
    configuration: applicationRuntimeConfiguration,
  });
