/**
 * `GET /api/events`: server-sent events for live updates. The owner, or staff
 * (#5197), who hear ONLY `records` events of models they may read, re-checked
 * against their grants per event; the stream ends once they are no longer
 * active staff. Events (`event: shell`, `data` is JSON):
 *   { type: 'changed', version, summary }          the definition changed
 *   { type: 'records', model: string | null }      records changed
 *   { type: 'approval', id, status, summary }      an approval was created/decided
 * A `: ping` comment is sent every 25 s. The first message is `event: ready`.
 */

import type { ShellEvent } from '$lib/server/events';
import { onStreamsClosed, streamsClosed, subscribe } from '$lib/server/events';
import { callerOf, errorResponse } from '$lib/server/http';
import { staffEventVerdict, stillStaff } from '$lib/server/staff-access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  // Shutting down: no new stream; the client reconnects after the restart.
  if (streamsClosed()) {
    return new Response(null, {
      status: 503,
      headers: { 'retry-after': '5', connection: 'close' },
    });
  }
  let who: Awaited<ReturnType<typeof callerOf>>;
  try {
    who = await callerOf(event);
  } catch (error) {
    return errorResponse(error);
  }
  const tenantId = who.principal.tenantId;
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
      // Shutdown began while the owner check ran: end at once, or this stream
      // would hold the listener open to the deadline.
      if (streamsClosed()) {
        controller.close();
        return;
      }
      send('event: ready\ndata: {}\n\n');
      // Only this owner's tenant's events (the hosted app shares one bus).
      const deliver = (e: ShellEvent) =>
        send(`event: shell\ndata: ${JSON.stringify(e)}\n\n`);
      const end = () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      };
      // Staff: each event is judged against the grants as they are now, one
      // at a time so the order holds. The owner's events go out unchanged.
      let judging: Promise<void> = Promise.resolve();
      const off = subscribe(
        who.kind === 'owner'
          ? deliver
          : (e) => {
              judging = judging.then(async () => {
                const verdict = await staffEventVerdict(who.principal, e);
                if (verdict === 'send') deliver(e);
                else if (verdict === 'close') end();
              });
            },
        tenantId,
      );
      const ping = setInterval(() => {
        send(': ping\n\n');
        if (who.kind === 'staff')
          void stillStaff(who.principal).then((ok) => {
            if (!ok) end();
          });
      }, 25_000);
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
