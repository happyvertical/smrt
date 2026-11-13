/**
 * `POST /api/shell/onboarding/complete` { start: 'fresh' } -> { onboarding }.
 * 409 until the assistant is ready; `wizard` is 400 (coming soon). Owner only.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
  onboardingRoutes.complete(event as never);
