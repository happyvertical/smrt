/**
 * `GET /api/events`: server-sent events for live updates. Owner session
 * required. Events (`event: shell`, `data` is JSON):
 *   { type: 'changed', version, summary }          the definition changed
 *   { type: 'records', model: string | null }      records changed
 *   { type: 'approval', id, status, summary }      an approval was created/decided
 * A `: ping` comment is sent every 25 s. The first message is `event: ready`.
 */

import { onStreamsClosed, streamsClosed, subscribe } from '$lib/server/events';
import { errorResponse, ownerOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  // Shutting down: no new stream; the client reconnects after the restart.
  if (streamsClosed()) {
    return new Response(null, {
      status: 503,
      headers: { 'retry-after': '5', connection: 'close' },
    });
  }
  let tenantId: string;
  try {
    tenantId = (await ownerOf(event)).tenantId;
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
      // Only this owner's tenant's events (the hosted app shares one bus).
      const off = subscribe(
        (e) => send(`event: shell\ndata: ${JSON.stringify(e)}\n\n`),
        tenantId,
      );
      const ping = setInterval(() => send(': ping\n\n'), 25_000);
      // Shutdown ends the stream (the listener cannot close while it is open).
      const offClose = onStreamsClosed(() => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      cleanup = () => {
        clearInterval(ping);
        off();
        offClose();
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
