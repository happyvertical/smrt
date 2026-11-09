/** `GET /api/assistant/threads` -> { threads: { id, title, updatedAt }[] }. Owner only. */
import { assistantRoutes } from '$lib/server/assistant';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
  assistantRoutes.threads(event as never);
