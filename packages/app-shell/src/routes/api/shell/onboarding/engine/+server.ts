/**
 * `POST /api/shell/onboarding/engine` { engine: 'api' | 'claude-code' |
 * 'codex' } -> { engine }. A CLI engine must be installed and signed in (409
 * otherwise). Owner only.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
  onboardingRoutes.engine(event as never);
