/**
 * The live subscriber against core's real `_events` route when a connection's
 * start cannot be resolved (#5291). A cursor-less open whose head sample fails
 * still fires `onopen` (the response is a retryable 200), so the client may
 * load its state then. A change committed before the reconnect samples its
 * own head must still reach the client: the subscriber ends with that table
 * invalidated.
 *
 * Only the network boundary is stood in for: a small EventSource that speaks
 * the SSE wire format over the REST generator's fetch handler (same field
 * rules as the browser: `id:` sets the last event id even on a frame with no
 * data, named events dispatch to their listeners, the reconnect sends
 * `Last-Event-ID`). The route, the stream and the database are real.
 */
import {
  appendChange,
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
  resetChangeSignals,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSmrtWebEventSubscriber,
  type SmrtWebEventSource,
} from './index.js';

const TABLE = 'start_failure_items';

type Listener = (ev: { data: string; lastEventId: string }) => void;

/** EventSource over a fetch handler; `beforeReconnect` runs in the retry gap. */
class HandlerEventSource implements SmrtWebEventSource {
  onopen: SmrtWebEventSource['onopen'] = null;
  onerror: SmrtWebEventSource['onerror'] = null;
  onmessage: SmrtWebEventSource['onmessage'] = null;
  readyState = 0;
  opens = 0;
  private lastEventId = '';
  private closed = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    private readonly url: string,
    private readonly handler: (req: Request) => Promise<Response>,
    private readonly beforeReconnect: (attempt: number) => Promise<void>,
    /** Drop this connection (by attempt) right after its first SSE block. */
    private readonly dropAfterFirstBlockOn?: number,
  ) {
    void this.run();
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
    void this.reader?.cancel().catch(() => {});
  }

  private async run(): Promise<void> {
    for (let attempt = 0; !this.closed; attempt++) {
      if (attempt > 0) await this.beforeReconnect(attempt);
      if (this.closed) return;
      const headers: Record<string, string> = {};
      if (this.lastEventId !== '') headers['Last-Event-ID'] = this.lastEventId;
      const response = await this.handler(new Request(this.url, { headers }));
      const type = response.headers.get('Content-Type') ?? '';
      if (response.status !== 200 || !type.startsWith('text/event-stream')) {
        this.readyState = 2;
        this.onerror?.call(this, {});
        return;
      }
      this.readyState = 1;
      this.opens += 1;
      this.onopen?.call(this, {});
      await this.consume(
        response.body as ReadableStream<Uint8Array>,
        attempt === this.dropAfterFirstBlockOn,
      );
      if (this.closed) return;
      this.readyState = 0;
      this.onerror?.call(this, {});
    }
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    dropAfterFirstBlock: boolean,
  ): Promise<void> {
    this.reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data: string[] = [];
    let idBuffer = this.lastEventId;
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') {
            this.lastEventId = idBuffer;
            if (data.length > 0) {
              const ev = { data: data.join('\n'), lastEventId: idBuffer };
              for (const listener of this.listeners.get(event || 'message') ??
                [])
                listener(ev);
            }
            event = '';
            data = [];
            if (dropAfterFirstBlock) {
              // The connection drops right after its first block.
              await this.reader.cancel().catch(() => {});
              return;
            }
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const fieldValue =
            colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = fieldValue;
          else if (field === 'data') data.push(fieldValue);
          else if (field === 'id' && !fieldValue.includes('\0'))
            idBuffer = fieldValue;
        }
      }
    } catch {
      // cancelled
    } finally {
      this.reader = null;
    }
  }
}

describe('live subscriber: a connection whose start could not be resolved (#5291)', () => {
  let db: DatabaseInterface;
  let source: HandlerEventSource | null = null;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await ensureChangeFeedTable(db);
    await appendChange(db, { table: TABLE, rowId: 'before' });
  });

  afterEach(async () => {
    source?.close();
    source = null;
    resetChangeSignals();
    await db.close?.();
  });

  async function changeInTheGapIsInvalidated(
    dropReconnectAfterFirstBlock: boolean,
  ) {
    const handler = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: () => async (req: Request) => req,
      },
      { db },
    ).generateHandler();

    // The first open's head sample fails, as a statement timeout would.
    let failing = true;
    const query = db.query.bind(db);
    (db as { query: unknown }).query = async (
      sql: string,
      ...args: unknown[]
    ) => {
      if (failing) throw new Error('statement timeout');
      return query(sql, ...(args as []));
    };

    let committed = false;
    let invalidatedAfterCommit = 0;
    const subscriber = createSmrtWebEventSubscriber({
      eventsUrl: 'http://x/api/v1/_events',
      changesUrl: 'http://x/api/v1/_changes',
      fetchFn: async () => {
        throw new Error('polling is not expected');
      },
      eventSourceFactory: (url) => {
        source = new HandlerEventSource(
          url,
          handler,
          async (attempt) => {
            if (attempt === 1) {
              // The retry gap: the database recovers and a change commits
              // with no signal; then the client reconnects.
              failing = false;
              await appendChange(db, { table: TABLE, rowId: 'in-the-gap' });
              committed = true;
              return;
            }
            // After a dropped reconnect the client resumes once more.
            if (attempt === 2 && dropReconnectAfterFirstBlock) return;
            await new Promise(() => {}); // stay on the last connection
          },
          dropReconnectAfterFirstBlock ? 1 : undefined,
        );
        return source;
      },
    });
    subscriber.registerTable(TABLE, () => {
      if (committed) invalidatedAfterCommit += 1;
    });

    const deadline = Date.now() + 5000;
    while (invalidatedAfterCommit === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    subscriber.close();
    expect(source?.opens ?? 0).toBeGreaterThanOrEqual(2);
    expect(subscriber.transport).not.toBe('polling');
    expect(invalidatedAfterCommit).toBeGreaterThan(0);
  }

  it('invalidates a table changed while it had no start, though no frame names the change', async () => {
    await changeInTheGapIsInvalidated(false);
  });

  it('still invalidates it when the reconnect drops right after its first block', async () => {
    await changeInTheGapIsInvalidated(true);
  });
});
