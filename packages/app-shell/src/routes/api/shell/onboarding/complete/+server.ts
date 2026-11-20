/**
 * `POST /api/shell/onboarding/complete` { start: 'fresh' } -> { onboarding }.
 * 409 until the assistant is ready; any other `start` is 400. Owner only.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
  onboardingRoutes.complete(event as never);
