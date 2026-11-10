/**
 * `POST /api/assistant/turn` body `{ message, threadId? }`: one assistant
 * turn as server-sent events (`event: turn`, JSON `TurnEvent`, see
 * `$lib/assistant/events`). 503 `{ type: 'unavailable', ... }` when the
 * assistant is not configured. Owner session required, same-origin.
 */
import { assistantRoutes } from '$lib/server/assistant';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
  assistantRoutes.turn(event as never);
