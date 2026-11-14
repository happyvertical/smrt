/**
 * Sign in with ChatGPT (a preview for open source apps). Owner only.
 *
 * `GET` -> { chatgpt: { signedIn, signingIn, account?, error? }, model,
 * models? }. `POST` { action: 'start' } opens OpenAI's page in the system
 * browser (desktop wrapper) or returns its address -> { result, opened,
 * authorizationUrl? }; { action: 'sign-out' }; { action: 'model', model }.
 * No token is ever returned.
 */
import { onboardingRoutes } from '$lib/server/onboarding';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
  onboardingRoutes.chatgptState(event as never);

export const POST: RequestHandler = (event) =>
  onboardingRoutes.chatgpt(event as never);
