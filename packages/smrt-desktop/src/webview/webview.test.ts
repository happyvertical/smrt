import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  FUTURE,
  leaks,
  mintBody,
  SLOT_ID,
  SLOT_ID_2,
  thrown,
} from '../testing/credentials.js';
import {
  connectDesktopAssistant as connectRaw,
  DESKTOP_CREDENTIAL_COMMANDS,
  DESKTOP_CREDENTIAL_ENDPOINT,
  disconnectDesktopAssistant as disconnectRaw,
  type MintFetch,
  type MintFetchResponse,
  getDesktopAssistantStatus as statusRaw,
  type TauriInvoke,
} from './index.js';

const slot = (
  slotId = SLOT_ID,
  state: 'minted' | 'revoking' | 'revoked' = 'minted',
  expiresAt: string | null = null,
) => ({ slotId, state, scopes: ['notes.read'], expiresAt });

const response = (status: number, text = '{}'): MintFetchResponse => ({
  status,
  text: async () => text,
});

interface Harness {
  readonly calls: string[];
  readonly invoke: TauriInvoke;
  readonly fetch: MintFetch;
  readonly requests: Array<{ url: string; init: Parameters<MintFetch>[1] }>;
  readonly invocations: Array<{
    command: string;
    args: Record<string, unknown> | undefined;
  }>;
}

/** Scripted fetch/invoke. Every call is also appended to `calls` in order. */
function harness(options: {
  fetches: Array<MintFetchResponse | Error>;
  slots?: unknown[];
  put?: unknown[];
  status?: unknown;
  forget?: unknown[];
}): Harness {
  const calls: string[] = [];
  const requests: Harness['requests'] = [];
  const invocations: Harness['invocations'] = [];
  const fetches = [...options.fetches];
  const slots = [...(options.slots ?? [slot()])];
  const puts = [
    ...(options.put ?? [
      { status: 'active', scopes: ['notes.read'], expiresAt: FUTURE },
    ]),
  ];
  const forgets = [...(options.forget ?? [{ status: 'revoked' }])];
  const invoke: TauriInvoke = async (command, args) => {
    invocations.push({ command, args });
    calls.push(`invoke:${command}`);
    switch (command) {
      case DESKTOP_CREDENTIAL_COMMANDS.slot: {
        const next = slots.length > 1 ? slots.shift() : slots[0];
        return next;
      }
      case DESKTOP_CREDENTIAL_COMMANDS.put: {
        const next = puts.length > 1 ? puts.shift() : puts[0];
        if (next instanceof Error) throw next;
        return next;
      }
      case DESKTOP_CREDENTIAL_COMMANDS.status:
        return options.status ?? null;
      case DESKTOP_CREDENTIAL_COMMANDS.forget: {
        const next = forgets.length > 1 ? forgets.shift() : forgets[0];
        if (next instanceof Error) throw next;
        return next;
      }
      default:
        throw new Error('unexpected command');
    }
  };
  const fetch: MintFetch = async (url, init) => {
    requests.push({ url, init });
    calls.push(`fetch:${JSON.parse(init.body).action}`);
    const next = fetches.shift();
    if (next === undefined) throw new Error('no scripted response');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, invoke, fetch, requests, invocations };
}

const base = {
  scopes: ['notes.read'],
  expiresInSeconds: 3600,
  sleep: async () => undefined,
};

// Globals a hostile or careless helper could use to persist or leak a body.
const WATCHED = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document',
  'location',
  'history',
  'caches',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'BroadcastChannel',
  'postMessage',
  'URL',
  'URLSearchParams',
] as const;

const touched: string[] = [];

/** Run `fn` with every watched global booby-trapped, then restore them. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of WATCHED) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        throw new Error('forbidden global');
      },
    });
  }
  try {
    return await fn();
  } finally {
    for (const name of WATCHED) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

type Connect = typeof connectRaw;
type Disconnect = typeof disconnectRaw;
type Status = typeof statusRaw;
const connectDesktopAssistant: Connect = (o) => guarded(() => connectRaw(o));
const disconnectDesktopAssistant: Disconnect = (o) =>
  guarded(() => disconnectRaw(o));
const getDesktopAssistantStatus: Status = (o) => guarded(() => statusRaw(o));

describe('webview helper', () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
  const output: string[] = [];

  beforeEach(() => {
    touched.length = 0;
    output.length = 0;
    for (const method of [
      'log',
      'info',
      'warn',
      'error',
      'debug',
      'trace',
      'dir',
    ] as const) {
      consoleSpies.push(
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          output.push(args.map(String).join(' '));
          touched.push(`console.${method}`);
        }),
      );
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  });

  it('mints with a same-origin POST and passes the RAW response text only to the put command', async () => {
    const body = mintBody();
    const h = harness({ fetches: [response(200, body)] });
    const status = await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });

    expect(status).toEqual({
      state: 'connected',
      slotId: SLOT_ID,
      scopes: ['notes.read'],
      expiresAt: FUTURE,
    });
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0];
    expect(request?.url).toBe(DESKTOP_CREDENTIAL_ENDPOINT);
    expect(request?.url).toBe('/api/local/mcp-credentials');
    expect(request?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(JSON.parse(request?.init.body ?? '')).toEqual({
      action: 'put',
      id: SLOT_ID,
      scopes: ['notes.read'],
      expiresInSeconds: 3600,
    });

    // The body travels, byte for byte, to exactly one native command.
    const withBody = h.invocations.filter((call) =>
      JSON.stringify(call.args).includes(CANARY_BODY),
    );
    expect(withBody).toHaveLength(1);
    expect(withBody[0]?.command).toBe('desktop-credential-put');
    expect(withBody[0]?.args).toEqual({ slotId: SLOT_ID, body });
    // ... and never comes back out.
    expect(JSON.stringify(status)).not.toContain(CANARY_BODY);
    expect(h.calls).toEqual([
      'invoke:desktop-credential-slot',
      'fetch:put',
      'invoke:desktop-credential-put',
    ]);
  });

  it('T6: touches no storage, cookie, console, URL or location API', async () => {
    const h = harness({
      fetches: [
        new TypeError('network'),
        response(500),
        response(200, mintBody()),
      ],
    });
    await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    await disconnectDesktopAssistant({
      invoke: async (command, args) =>
        command === 'desktop-credential-status'
          ? slot(SLOT_ID, 'minted', FUTURE)
          : h.invoke(command, args),
      fetch: async () => response(200, '{"status":"revoked"}'),
      sleep: async () => undefined,
    });
    await getDesktopAssistantStatus({ invoke: async () => null });
    expect(touched).toEqual([]);
    expect(output).toEqual([]);
  });

  it('T6: has no path to those APIs in its source or its import closure', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const seen = new Set<string>();
    const queue = [join(root, 'webview/index.ts')];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      const uncommented = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const code = uncommented.replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
      expect(uncommented, file).not.toMatch(
        /from\s+['"]node:|require\(|process\./,
      );
      expect(code, file).not.toMatch(
        /\b(localStorage|sessionStorage|indexedDB|document\.|location\b|history\.|console\.|new URL|URLSearchParams|XMLHttpRequest|WebSocket|postMessage|globalThis|window\.|self\.)/,
      );
      for (const match of uncommented.matchAll(/from\s+'(\.[^']+)'/g)) {
        queue.push(
          join(file, '..', (match[1] as string).replace(/\.js$/, '.ts')),
        );
      }
    }
    // Only pure modules are reachable: nothing that imports Node built-ins.
    const names = [...seen].map((file) => file.slice(root.length));
    expect(names.sort()).toEqual(
      [
        'credentials/grammar.ts',
        'errors.ts',
        'internal/grammar.ts',
        'internal/strict-json.ts',
        'webview/index.ts',
      ].sort(),
    );
    expect(
      readdirSync(join(root, 'webview')).filter((f) => !f.endsWith('.test.ts')),
    ).toEqual(['index.ts']);
  });

  it('retries the PUT with the SAME slot id after a network error', async () => {
    const h = harness({
      fetches: [
        new TypeError('Failed to fetch'),
        new TypeError('Failed to fetch'),
        response(200, mintBody()),
      ],
    });
    const status = await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    expect(status.state).toBe('connected');
    const ids = h.requests.map((r) => JSON.parse(r.init.body).id);
    expect(ids).toEqual([SLOT_ID, SLOT_ID, SLOT_ID]);
    // Only one slot was ever requested: no new id for an unknown outcome.
    expect(
      h.invocations.filter((c) => c.command === 'desktop-credential-slot'),
    ).toHaveLength(1);
  });

  it('retries when reading the response body fails (outcome unknown)', async () => {
    const lost: MintFetchResponse = {
      status: 200,
      text: async () => {
        throw new TypeError(`stream died ${CANARY_TOKEN}`);
      },
    };
    const h = harness({ fetches: [lost, response(200, mintBody())] });
    await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    expect(h.requests.map((r) => JSON.parse(r.init.body).id)).toEqual([
      SLOT_ID,
      SLOT_ID,
    ]);
  });

  it('retries on 5xx and 429 but not on 400', async () => {
    const h = harness({
      fetches: [response(503), response(429), response(200, mintBody())],
    });
    await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    expect(h.requests).toHaveLength(3);

    const bad = harness({ fetches: [response(400)] });
    const error = await thrown(() =>
      connectDesktopAssistant({
        ...base,
        invoke: bad.invoke,
        fetch: bad.fetch,
      }),
    );
    expect((error as DesktopContractError).code).toBe('credential_rejected');
    expect(bad.requests).toHaveLength(1);
  });

  it('gives up after the attempt budget with a fixed code', async () => {
    const h = harness({
      fetches: [new Error('a'), new Error('b'), new Error('c')],
    });
    const error = await thrown(() =>
      connectDesktopAssistant({ ...base, invoke: h.invoke, fetch: h.fetch }),
    );
    expect((error as DesktopContractError).code).toBe(
      'credential_request_failed',
    );
    expect(h.requests).toHaveLength(3);
  });

  it('maps 403 to credential_forbidden without retrying', async () => {
    const h = harness({ fetches: [response(403)] });
    const error = await thrown(() =>
      connectDesktopAssistant({ ...base, invoke: h.invoke, fetch: h.fetch }),
    );
    expect((error as DesktopContractError).code).toBe('credential_forbidden');
    expect(h.requests).toHaveLength(1);
  });

  it('a 409 slot_unavailable moves to a NEW slot id', async () => {
    const h = harness({
      fetches: [
        response(409, '{"code":"slot_unavailable"}'),
        response(200, mintBody({}, SLOT_ID_2)),
      ],
      slots: [slot(SLOT_ID), slot(SLOT_ID_2)],
    });
    const status = await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    expect(status).toMatchObject({ state: 'connected', slotId: SLOT_ID_2 });
    expect(h.requests.map((r) => JSON.parse(r.init.body).id)).toEqual([
      SLOT_ID,
      SLOT_ID_2,
    ]);
    expect(h.invocations.map((c) => c.args)).toContainEqual({
      action: 'replace',
    });
    expect(
      h.invocations.find((c) => c.command === 'desktop-credential-put')?.args
        ?.slotId,
    ).toBe(SLOT_ID_2);
  });

  it('stops replacing slots after a bounded number of 409s', async () => {
    const h = harness({
      fetches: [response(409), response(409), response(409), response(409)],
    });
    const error = await thrown(() =>
      connectDesktopAssistant({ ...base, invoke: h.invoke, fetch: h.fetch }),
    );
    expect((error as DesktopContractError).code).toBe('slot_unavailable');
    expect(h.requests).toHaveLength(3);
  });

  it('starts a fresh slot when the persisted one is revoked', async () => {
    const h = harness({
      fetches: [response(200, mintBody({}, SLOT_ID_2))],
      slots: [slot(SLOT_ID, 'revoked'), slot(SLOT_ID_2)],
    });
    const status = await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    expect(status).toMatchObject({ slotId: SLOT_ID_2 });
    expect(h.requests).toHaveLength(1);
  });

  it('finishes a pending revoke before reconnecting on a new slot', async () => {
    const h = harness({
      fetches: [
        response(200, '{"status":"revoked"}'),
        response(200, mintBody({}, SLOT_ID_2)),
      ],
      slots: [slot(SLOT_ID, 'revoking'), slot(SLOT_ID_2)],
      forget: [{ status: 'revoked' }],
    });
    await connectDesktopAssistant({
      ...base,
      invoke: h.invoke,
      fetch: h.fetch,
    });
    expect(h.calls).toEqual([
      'invoke:desktop-credential-slot',
      'fetch:revoke',
      'invoke:desktop-credential-forget',
      'invoke:desktop-credential-slot',
      'fetch:put',
      'invoke:desktop-credential-put',
    ]);
  });

  it('retries the native put when it fails, then reports native_rejected', async () => {
    const reject = new Error(`rejected ${CANARY_TOKEN}`);
    const h = harness({
      fetches: [
        response(200, mintBody()),
        response(200, mintBody()),
        response(200, mintBody()),
      ],
      put: [reject],
    });
    const error = await thrown(() =>
      connectDesktopAssistant({ ...base, invoke: h.invoke, fetch: h.fetch }),
    );
    expect((error as DesktopContractError).code).toBe('native_rejected');
    expect(h.requests).toHaveLength(3);
    expect(
      h.requests.every((r) => JSON.parse(r.init.body).id === SLOT_ID),
    ).toBe(true);
    expect(leaks(error)).toBe(false);
    expect((error as Error).cause).toBeUndefined();
  });

  it('does not re-mint a committed credential because the native reply is odd', async () => {
    const h = harness({
      fetches: [response(200, mintBody())],
      put: [{ status: 'active' }],
    });
    const error = await thrown(() =>
      connectDesktopAssistant({ ...base, invoke: h.invoke, fetch: h.fetch }),
    );
    expect((error as DesktopContractError).code).toBe(
      'invalid_native_response',
    );
    expect(h.requests).toHaveLength(1);
  });

  it('T11: a token-bearing malformed body yields a fixed-code error without the token', async () => {
    const malformed = `{"id":"${SLOT_ID}","token":"${CANARY_TOKEN}"`;
    const nativeError = Object.assign(new Error(`bad body: ${malformed}`), {
      cause: malformed,
      body: malformed,
    });
    const h = harness({
      fetches: [response(200, malformed)],
      put: [nativeError],
    });
    const error = await thrown(() =>
      connectDesktopAssistant({
        ...base,
        invoke: h.invoke,
        fetch: h.fetch,
        maxAttempts: 1,
      }),
    );
    expect(error).toBeInstanceOf(DesktopContractError);
    expect((error as DesktopContractError).code).toBe('native_rejected');
    expect(leaks(error)).toBe(false);
    expect(touched).toEqual([]);
  });

  it('rejects hostile native replies without echoing them', async () => {
    for (const reply of [
      null,
      'x',
      { ...slot(), token: CANARY_TOKEN },
      { ...slot(), slotId: 'nope' },
      { ...slot(), state: 'active' },
      { ...slot(), scopes: [] },
    ]) {
      const h = harness({ fetches: [], slots: [reply] });
      const error = await thrown(() =>
        connectDesktopAssistant({ ...base, invoke: h.invoke, fetch: h.fetch }),
      );
      expect((error as DesktopContractError).code).toBe(
        'invalid_native_response',
      );
      expect(leaks(error)).toBe(false);
    }
  });

  it('validates its own inputs before any call', async () => {
    const h = harness({ fetches: [] });
    for (const patch of [
      { scopes: [] },
      { scopes: ['a b'] },
      { expiresInSeconds: 59 },
      { expiresInSeconds: 31_536_001 },
      { expiresInSeconds: 1.5 },
    ]) {
      const error = await thrown(() =>
        connectDesktopAssistant({
          ...base,
          ...patch,
          invoke: h.invoke,
          fetch: h.fetch,
        }),
      );
      expect((error as DesktopContractError).code).toBe('credential_rejected');
    }
    expect(h.calls).toEqual([]);
  });

  it('honors an abort signal', async () => {
    const h = harness({ fetches: [new Error('x')] });
    const controller = new AbortController();
    controller.abort();
    const error = await thrown(() =>
      connectDesktopAssistant({
        ...base,
        invoke: h.invoke,
        fetch: h.fetch,
        signal: controller.signal,
      }),
    );
    expect((error as DesktopContractError).code).toBe(
      'credential_request_failed',
    );
    expect(h.requests).toHaveLength(0);
  });

  describe('disconnect: revoke on the server, then forget', () => {
    const status = slot(SLOT_ID, 'minted', FUTURE);

    it('revokes first, then forgets, then reports revoked', async () => {
      const h = harness({
        fetches: [response(200, '{"status":"revoked"}')],
        status,
        forget: [{ status: 'revoked' }],
      });
      const result = await disconnectDesktopAssistant({
        invoke: h.invoke,
        fetch: h.fetch,
        sleep: async () => undefined,
      });
      expect(result).toEqual({ state: 'revoked', slotId: SLOT_ID });
      expect(h.calls).toEqual([
        'invoke:desktop-credential-status',
        'fetch:revoke',
        'invoke:desktop-credential-forget',
      ]);
      expect(JSON.parse(h.requests[0]?.init.body ?? '')).toEqual({
        action: 'revoke',
        id: SLOT_ID,
      });
      expect(h.invocations.at(-1)?.args).toEqual({
        slotId: SLOT_ID,
        revoked: true,
      });
    });

    it('treats 409 as already revoked', async () => {
      const h = harness({ fetches: [response(409)], status });
      const result = await disconnectDesktopAssistant({
        invoke: h.invoke,
        fetch: h.fetch,
        sleep: async () => undefined,
      });
      expect(result.state).toBe('revoked');
      expect(h.invocations.at(-1)?.args).toEqual({
        slotId: SLOT_ID,
        revoked: true,
      });
    });

    it('retries the revoke on an unknown outcome with the same id', async () => {
      const h = harness({
        fetches: [
          new TypeError('offline'),
          response(200, '{"status":"revoked"}'),
        ],
        status,
      });
      await disconnectDesktopAssistant({
        invoke: h.invoke,
        fetch: h.fetch,
        sleep: async () => undefined,
      });
      expect(h.requests.map((r) => JSON.parse(r.init.body).id)).toEqual([
        SLOT_ID,
        SLOT_ID,
      ]);
    });

    it('never forgets as revoked when the server could not be reached', async () => {
      const h = harness({
        fetches: [new Error('a'), new Error('b'), new Error('c')],
        status,
        forget: [{ status: 'revoking' }],
      });
      const result = await disconnectDesktopAssistant({
        invoke: h.invoke,
        fetch: h.fetch,
        sleep: async () => undefined,
      });
      expect(result).toEqual({ state: 'revoking', slotId: SLOT_ID });
      expect(h.invocations.at(-1)?.args).toEqual({
        slotId: SLOT_ID,
        revoked: false,
      });
      // Ordering: every revoke attempt precedes the local forget.
      expect(h.calls.at(-1)).toBe('invoke:desktop-credential-forget');
      expect(h.calls.slice(1, -1).every((c) => c === 'fetch:revoke')).toBe(
        true,
      );
    });

    it('does not retry a 403 and marks the slot revoking', async () => {
      const h = harness({
        fetches: [response(403)],
        status,
        forget: [{ status: 'revoking' }],
      });
      const result = await disconnectDesktopAssistant({
        invoke: h.invoke,
        fetch: h.fetch,
        sleep: async () => undefined,
      });
      expect(result.state).toBe('revoking');
      expect(h.requests).toHaveLength(1);
    });

    it('is a no-op without a slot and for an already revoked slot', async () => {
      const none = harness({ fetches: [], status: null });
      expect(
        await disconnectDesktopAssistant({
          invoke: none.invoke,
          fetch: none.fetch,
        }),
      ).toEqual({ state: 'none' });
      expect(none.requests).toHaveLength(0);

      const done = harness({
        fetches: [],
        status: slot(SLOT_ID, 'revoked', FUTURE),
      });
      expect(
        await disconnectDesktopAssistant({
          invoke: done.invoke,
          fetch: done.fetch,
        }),
      ).toEqual({ state: 'revoked', slotId: SLOT_ID });
      expect(done.requests).toHaveLength(0);
    });

    it('revokes a minted-but-never-committed slot too', async () => {
      const h = harness({
        fetches: [response(200)],
        status: slot(SLOT_ID, 'minted', null),
      });
      const result = await disconnectDesktopAssistant({
        invoke: h.invoke,
        fetch: h.fetch,
      });
      expect(result.state).toBe('revoked');
      expect(h.requests).toHaveLength(1);
    });
  });

  describe('status', () => {
    it('reports none, connected, revoking and revoked without a token', async () => {
      const get = (status: unknown) =>
        getDesktopAssistantStatus({ invoke: async () => status });
      expect(await get(null)).toEqual({ state: 'none' });
      expect(await get(slot(SLOT_ID, 'minted', null))).toEqual({
        state: 'none',
      });
      expect(await get(slot(SLOT_ID, 'minted', FUTURE))).toEqual({
        state: 'connected',
        slotId: SLOT_ID,
        scopes: ['notes.read'],
        expiresAt: FUTURE,
      });
      expect(await get(slot(SLOT_ID, 'revoking', FUTURE))).toEqual({
        state: 'revoking',
        slotId: SLOT_ID,
      });
      expect(await get(slot(SLOT_ID, 'revoked', FUTURE))).toEqual({
        state: 'revoked',
        slotId: SLOT_ID,
      });
    });

    it('maps a failing invoke to native_rejected', async () => {
      const error = await thrown(() =>
        getDesktopAssistantStatus({
          invoke: async () => {
            throw new Error(CANARY_TOKEN);
          },
        }),
      );
      expect((error as DesktopContractError).code).toBe('native_rejected');
      expect(leaks(error)).toBe(false);
    });
  });
});
