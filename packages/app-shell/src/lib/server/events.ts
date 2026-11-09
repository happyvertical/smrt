// A small in-process event bus for live updates. Host events ('changed',
// 'records') and approval events are republished here; the SSE route
// (`/api/events`) and the MCP route (list_changed) subscribe.
import { EventEmitter } from 'node:events';

export type ShellEvent =
  | { type: 'changed'; version: number; summary: string }
  | { type: 'records'; model: string | null }
  | {
      type: 'approval';
      id: string;
      status: 'pending' | 'approved' | 'denied' | 'failed';
      summary: string;
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
