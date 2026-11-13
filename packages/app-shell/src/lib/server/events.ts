// A small in-process event bus for live updates. Host events ('changed',
// 'records') and approval events are republished here; the SSE route
// (`/api/events`) and the MCP route (list_changed) subscribe.
//
// Every definition/record event says WHICH COPY changed (`target`), so a view
// of the live app never reloads for a draft's change and the reverse.
import { EventEmitter } from 'node:events';
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
    };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(event: ShellEvent): void {
  bus.emit('event', event);
}

/** Subscribe; returns the unsubscribe function. */
export function subscribe(listener: (event: ShellEvent) => void): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
