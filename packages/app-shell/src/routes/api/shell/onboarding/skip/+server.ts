/**
 * `POST /api/shell/onboarding/skip` -> { onboarding: 'skipped' }. Owner only.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
  onboardingRoutes.skip(event as never);
