/**
 * `GET /api/events`: server-sent events for live updates. Owner session
 * required. Events (`event: shell`, `data` is JSON):
 *   { type: 'changed', version, summary }          the definition changed
 *   { type: 'records', model: string | null }      records changed
 *   { type: 'approval', id, status, summary }      an approval was created/decided
 * A `: ping` comment is sent every 25 s. The first message is `event: ready`.
 */

import { subscribe } from '$lib/server/events';
import { errorResponse, ownerOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  try {
    await ownerOf(event);
  } catch (error) {
    return errorResponse(error);
  }
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      send('event: ready\ndata: {}\n\n');
      const off = subscribe((e) =>
        send(`event: shell\ndata: ${JSON.stringify(e)}\n\n`),
      );
      const ping = setInterval(() => send(': ping\n\n'), 25_000);
      cleanup = () => {
        clearInterval(ping);
        off();
      };
      event.request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
    },
  });
};
