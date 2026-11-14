/**
 * `POST /api/shell/onboarding/connect` { tool: 'claude-code' | 'codex' } ->
 * { result: 'ready' | 'login_started' | 'login_running' | 'missing' }. Uses the
 * CLI already on this computer; when signed out it starts the CLI's OWN
 * sign-in. Owner only.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
  onboardingRoutes.connect(event as never);
