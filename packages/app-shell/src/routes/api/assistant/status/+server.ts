/**
 * `GET /api/assistant/status` -> { configured: boolean, code?, message? }.
 * Owner session required. Never carries a key, provider or endpoint.
 */
import { assistantRoutes } from '$lib/server/assistant';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
  assistantRoutes.status(event as never);
