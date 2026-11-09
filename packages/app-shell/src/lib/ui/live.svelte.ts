// Browser store for `/api/events`: one EventSource, politely reconnected,
// turning server events into `invalidate()` calls and screen-reader text.
import { invalidate } from '$app/navigation';
import {
  ALL_KEYS,
  announcement,
  type DependsKey,
  parseShellEvent,
  reconnectDelay,
  reduceKeys,
} from './events.ts';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

const BATCH_MS = 150;

export class LiveUpdates {
  status = $state<LiveStatus>('connecting');
  /** The latest thing worth saying aloud (for an aria-live region). */
  announcement = $state('');

  #source: EventSource | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #batch: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #lost = false;
  #stopped = true;
  #keys = new Set<DependsKey>();

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#source?.close();
    this.#source = null;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#batch) clearTimeout(this.#batch);
    this.#timer = this.#batch = null;
  }

  #connect(): void {
    if (this.#stopped || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    this.#source = source;
    source.addEventListener('ready', () => {
      this.status = 'live';
      // After a gap we may have missed events: reload everything once.
      if (this.#lost) this.#schedule(new Set(ALL_KEYS));
      this.#lost = false;
      this.#attempt = 0;
    });
    source.addEventListener('shell', (message) => {
      const event = parseShellEvent((message as MessageEvent<string>).data);
      if (!event) return;
      const say = announcement(event);
      if (say) this.announcement = say;
      this.#schedule(reduceKeys(new Set(), event));
    });
    source.addEventListener('error', () => {
      // EventSource would retry at once and forever; take over instead.
      source.close();
      if (this.#source === source) this.#source = null;
      if (this.#stopped) return;
      this.status = 'reconnecting';
      this.#lost = true;
      const wait = reconnectDelay(this.#attempt++);
      this.#timer = setTimeout(() => this.#connect(), wait);
    });
  }

  #schedule(keys: Set<DependsKey>): void {
    for (const k of keys) this.#keys.add(k);
    if (this.#batch) return;
    this.#batch = setTimeout(() => {
      this.#batch = null;
      const run = [...this.#keys];
      this.#keys.clear();
      for (const k of run) void invalidate(k);
    }, BATCH_MS);
  }
}
