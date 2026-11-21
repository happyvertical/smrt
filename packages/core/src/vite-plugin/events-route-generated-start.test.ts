/**
 * The generated SvelteKit `_events` route, executed (#5291): how it opens a
 * stream whose start cannot be resolved, or whose client goes away while the
 * start is resolved. The emitted source is compiled and run against core's
 * real stream functions and a real SQLite database.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  changeSignalSubscriberCount,
  resetChangeSignals,
} from '../change-signals';
import { resolveDispatchTenantScope } from '../dispatch/tenant-resolver';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import {
  buildChangeEventStream,
  eventStreamCapacityExceededResponse,
  eventStreamStartFailedResponse,
  resolveChangeEventStartCursor,
  tryReserveChangeEventSubscriberSlot,
} from '../generators/events-route';
import type { SmartObjectManifest } from '../scanner/types';
import { getTestDatabase } from '../testing/database';
import { generateEventsRoute } from './events-route';
import { RouteFilePlan } from './generated-route-files';
import type { SvelteKitOptions } from './sveltekit-generator';

type GetHandler = (event: {
  locals: unknown;
  url: URL;
  request: Request;
}) => Promise<Response>;

const TABLE = 'generated_start_items';

const manifest = {
  objects: {
    Item: {
      className: 'Item',
      name: 'Item',
      filePath: '',
      collection: 'items',
      fields: {},
      methods: {},
      decoratorConfig: { api: true },
    },
  },
} as unknown as SmartObjectManifest;

/** Generate the route into a scratch project and load its `GET` handler. */
function loadGeneratedGet(
  db: DatabaseInterface,
  options: Partial<SvelteKitOptions> = {},
): GetHandler {
  const plan = new RouteFilePlan();
  generateEventsRoute(
    '/generated-start-project',
    manifest,
    {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      ...options,
    },
    plan,
  );
  const source = String(plan.entries().at(-1)?.content);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const modules: Record<string, unknown> = {
    '@sveltejs/kit': {
      error: (status: number, message: string) =>
        Object.assign(new Error(message), { status }),
    },
    '@happyvertical/smrt-core': {
      buildChangeEventStream,
      eventStreamCapacityExceededResponse,
      eventStreamStartFailedResponse,
      resolveChangeEventStartCursor,
      resolveDispatchTenantScope,
      tryReserveChangeEventSubscriberSlot,
      createGeneratedCollectionAccess: () => ({
        getCollection: async () => ({ db }),
      }),
    },
  };
  const exports: Record<string, unknown> = {};
  const load = new Function('require', 'exports', outputText) as (
    require: (id: string) => unknown,
    exports: Record<string, unknown>,
  ) => void;
  load((id) => modules[id] ?? {}, exports);
  return exports.GET as GetHandler;
}

function open(get: GetHandler, init: RequestInit = {}): Promise<Response> {
  const url = new URL('http://x/api/_events');
  return get({
    locals: { user: { id: 'u1' } },
    url,
    request: new Request(url, init),
  });
}

async function waitUntil(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('generated SvelteKit _events route: start resolution (#5291)', () => {
  let db: DatabaseInterface;

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
    await appendChange(db, { table: TABLE, rowId: 'before-1' });
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  it('opens a stream from the sampled head', async () => {
    const response = await open(loadGeneratedGet(db));
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(value)).toBe('retry: 3000\nid: 1\n\n');
    await waitUntil(() => changeSignalSubscriberCount(db) === 0);
  });

  it('answers a start that cannot be resolved with a retryable stream and releases the slot', async () => {
    const get = loadGeneratedGet(db);
    const response = await withEmbeddedWriteTransaction(db, true, () =>
      open(get),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(await response.text()).toMatch(
      /^retry: \d+\nid: resync\nevent: unavailable\n/,
    );
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('gives the retryable stream the allow-listed origin headers', async () => {
    const get = loadGeneratedGet(db, {
      eventsRoute: {
        allowedOrigins: ['https://app.example'],
        allowCredentials: true,
      },
    });
    const response = await withEmbeddedWriteTransaction(db, true, () =>
      open(get, { headers: { Origin: 'https://app.example' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example',
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true',
    );
    await response.text();
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });

  it('the reconnect after a response without a start opens at the head and resyncs first', async () => {
    const response = await open(loadGeneratedGet(db), {
      headers: { 'Last-Event-ID': 'resync' },
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: resync')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toBe('retry: 3000\nid: 1\nevent: resync\ndata: {}\n\n');
  });

  it('releases the slot when the request is aborted while its start waits', async () => {
    const get = loadGeneratedGet(db);
    let releaseTransaction: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transaction = withEmbeddedWriteTransaction(db, true, async (tx) => {
      await appendChange(tx, { table: TABLE, rowId: 'in-transaction' });
      entered();
      await gate;
    });
    await inside;
    const client = new AbortController();
    const pending = open(get, { signal: client.signal });
    await waitUntil(() => changeSignalSubscriberCount(db) === 1);
    client.abort();
    releaseTransaction();
    await transaction;
    await pending;
    expect(changeSignalSubscriberCount(db)).toBe(0);
  });
});
