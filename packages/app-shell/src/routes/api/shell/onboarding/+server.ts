/**
 * `GET /api/shell/onboarding[?fresh=1]` -> { onboarding: 'fresh' | 'skipped' |
 * null, engine, apiReady, tools: [{ tool, label, installed, version?,
 * signedIn, installUrl, login }] }. Owner only. `fresh=1` asks the CLIs again.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
  onboardingRoutes.state(event as never);
