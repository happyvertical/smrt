// A small in-process event bus for live updates. Host events ('changed',
// 'records') and approval events are republished here; the SSE route
// (`/api/events`) and the MCP route (list_changed) subscribe.
//
// Every definition/record event says WHICH COPY changed (`target`), so a view
// of the live app never reloads for a draft's change and the reverse.
//
// In the hosted app the bus is shared by every tenant in the process, so each
// event carries the tenant it belongs to and a subscriber for a tenant only
// ever receives that tenant's events. An event with no tenant reaches nobody
// who asked for one (it fails closed); the desktop's single owner subscribes
// without a tenant and receives everything, as before.
import { EventEmitter } from 'node:events';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import type { Target } from './target.ts';

export type ShellEvent =
  | { type: 'changed'; target: Target; version: number; summary: string }
  | { type: 'records'; target: Target; model: string | null }
  | {
      type: 'approval';
      id: string;
      status: 'pending' | 'approved' | 'denied' | 'failed';
      summary: string;
    }
  | {
      /**
       * The draft's life changed. `started`: a draft is open (live structure
       * is now frozen); `published`: its changes are live and it is gone;
       * `discarded`: it is gone and live thawed; `unpublishable`: it was found
       * open but cannot be published (see `describe().draft.problem`).
       */
      type: 'draft';
      status: 'started' | 'published' | 'discarded' | 'unpublishable';
      id: string;
      name: string;
    }
  | {
      /**
       * Changes waiting moved (#5178): `changed` (a card came, went, was
       * edited or put back), `applied`, `discarded` or `undone`. `count` is
       * the active cards now; `generation` the batch's counter.
       */
      type: 'changes';
      status: 'changed' | 'applied' | 'discarded' | 'undone';
      batchId: string;
      count: number;
      generation: number;
    };

interface Envelope {
  tenantId: string | null;
  event: ShellEvent;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

/**
 * Publish an event. `tenantId` defaults to the tenant of the running request;
 * host events pass the tenant their host belongs to.
 */
export function publish(
  event: ShellEvent,
  tenantId: string | null = null,
): void {
  const envelope: Envelope = {
    tenantId: tenantId ?? getCurrentTenant()?.tenantId ?? null,
    event,
  };
  bus.emit('event', envelope);
}

let tenantScoped = false;

/** The hosted app turns this on once it knows its profile; the desktop never does. */
export function setTenantScopedEvents(on: boolean): void {
  tenantScoped = on;
}

/**
 * Subscribe; returns the unsubscribe function. In the hosted app only the
 * subscriber's tenant's events are delivered (`tenantId`, else the tenant of
 * the running request, else nothing at all). On the desktop every event is.
 */
export function subscribe(
  listener: (event: ShellEvent) => void,
  tenantId?: string | null,
): () => void {
  const wanted = tenantScoped
    ? (tenantId ?? getCurrentTenant()?.tenantId ?? '')
    : null;
  const on = (envelope: Envelope) => {
    if (wanted !== null && (!wanted || envelope.tenantId !== wanted)) return;
    listener(envelope.event);
  };
  bus.on('event', on);
  return () => bus.off('event', on);
}
