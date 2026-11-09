/** `GET /api/assistant/threads/<id>` -> { thread, messages }. Owner only; 404 for another user's thread. */
import { assistantRoutes } from '$lib/server/assistant';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
  assistantRoutes.thread(event as never);
