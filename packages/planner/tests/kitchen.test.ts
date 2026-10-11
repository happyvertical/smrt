import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import ExportPanel from '../src/lib/components/ExportPanel.svelte';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import { parseInferenceConfig } from '../src/lib/inference/config.ts';
import {
  KITCHEN_TOKEN_HEADER,
  parseKitchenConfig,
  sendToKitchen,
} from '../src/lib/kitchen/client.ts';
import { readKitchenFragment } from '../src/lib/kitchen/fragment.ts';
import { KitchenState, kitchenState } from '../src/lib/kitchen/state.svelte.ts';
import { startStub } from './stub-server.ts';

const endpoint = { endpoint: '/api/kitchen/cookbook' };
const kitchen = { ...endpoint, token: 'abc123' };

describe('the kitchen block of planner.config.json', () => {
  it('is read next to the inference block', () => {
    const result = parseInferenceConfig(
      JSON.stringify({
        inference: { mode: 'host', host: { endpoint: '/api/planner/chat' } },
        kitchen: endpoint,
      }),
    );
    expect(result.config.mode).toBe('host');
    expect(result.kitchen).toEqual(endpoint);
  });

  it('never yields a token, even from a server that still sends one', () => {
    const result = parseInferenceConfig(
      JSON.stringify({ kitchen: { ...endpoint, token: 'leaked-token' } }),
    );
    // Reported (an older CLI), never kept.
    expect(result.kitchen).toEqual({ ...endpoint, tokenInConfig: true });
    expect(JSON.stringify(result)).not.toContain('leaked-token');
    expect(parseKitchenConfig({ ...endpoint, token: 'x' })).not.toHaveProperty(
      'token',
    );
  });

  it('is absent, with no notice, when the file has none', () => {
    const result = parseInferenceConfig(JSON.stringify({}));
    expect(result.kitchen).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it.each([
    ['a missing endpoint', { token: 't' }],
    [
      'a protocol-relative endpoint',
      { endpoint: '//evil.example/x', token: 't' },
    ],
    ['a non-http endpoint', { endpoint: 'ftp://h/x', token: 't' }],
    ['a non-object', 'kitchen'],
  ])('is ignored with %s', (_name, value) => {
    expect(parseKitchenConfig(value)).toBeUndefined();
  });
});

describe('sendToKitchen', () => {
  const cookbook = cookbookStore.snapshot();

  it('POSTs the cookbook with the token and reads the result', async () => {
    const stub = await startStub(() => ({
      body: {
        ok: true,
        dir: '/work/my-app',
        mode: 'new',
        installed: false,
        added: ['@happyvertical/smrt-commerce'],
        nextSteps: ['cd my-app', 'pnpm install'],
      },
    }));
    try {
      const outcome = await sendToKitchen(
        { endpoint: `${stub.origin}/api/kitchen/cookbook`, token: 'tok' },
        cookbook,
      );
      expect(outcome).toEqual({
        ok: true,
        result: {
          dir: '/work/my-app',
          mode: 'new',
          installed: false,
          added: ['@happyvertical/smrt-commerce'],
          nextSteps: ['cd my-app', 'pnpm install'],
        },
      });
      const [request] = stub.requests;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/kitchen/cookbook');
      expect(request.headers[KITCHEN_TOKEN_HEADER]).toBe('tok');
      expect(request.headers['content-type']).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual(cookbook);
    } finally {
      await stub.close();
    }
  });

  it('reports the kitchen refusing the cookbook', async () => {
    const stub = await startStub(() => ({
      status: 422,
      body: { ok: false, errors: ['recipe "x.y" does not exist'] },
    }));
    try {
      const outcome = await sendToKitchen(
        { endpoint: `${stub.origin}/k`, token: 't' },
        cookbook,
      );
      expect(outcome).toEqual({
        ok: false,
        errors: ['recipe "x.y" does not exist'],
      });
    } finally {
      await stub.close();
    }
  });

  it('names the status when the answer is not the contract', async () => {
    const stub = await startStub(() => ({
      status: 500,
      raw: true,
      body: 'boom',
    }));
    try {
      const outcome = await sendToKitchen(
        { endpoint: `${stub.origin}/k`, token: 't' },
        cookbook,
      );
      expect(outcome).toEqual({
        ok: false,
        errors: ['The kitchen answered 500.'],
      });
    } finally {
      await stub.close();
    }
  });

  it('reports an unreachable kitchen instead of throwing', async () => {
    const outcome = await sendToKitchen(kitchen, cookbook, (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]).toMatch(/smrt kitchen/);
  });
});

describe('KitchenState', () => {
  it('tracks a send from idle to sent, and ignores a send with no kitchen', async () => {
    const state = new KitchenState();
    await state.send(cookbookStore.snapshot());
    expect(state.status).toBe('idle');
    state.configure(endpoint, 'abc123');
    await state.send(
      cookbookStore.snapshot(),
      (async () =>
        new Response(JSON.stringify({ ok: true, dir: '/d', mode: 'update' }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    expect(state.status).toBe('sent');
    expect(state.outcome?.ok).toBe(true);
    state.configure(undefined);
    expect(state.status).toBe('idle');
    expect(state.outcome).toBeUndefined();
  });
});

// The panel only reads a data source to reset it; any object will do for render.
const context = new Map<unknown, unknown>();
context.set(DATA_SOURCE_KEY, {});

describe('the kitchen token in the address fragment', () => {
  it('reads it, strips it, and keeps other parameters', () => {
    expect(readKitchenFragment('#kitchen=abc_DEF-123.~x')).toEqual({
      token: 'abc_DEF-123.~x',
      present: true,
      hash: '',
    });
    expect(readKitchenFragment('#a=1&kitchen=tok&b=2')).toEqual({
      token: 'tok',
      present: true,
      hash: '#a=1&b=2',
    });
    expect(readKitchenFragment('kitchen=tok')).toMatchObject({ token: 'tok' });
  });

  it('leaves the rest of the fragment exactly as it was', () => {
    expect(readKitchenFragment('#foo&kitchen=tok&bar=a%20b+c')).toEqual({
      token: 'tok',
      present: true,
      hash: '#foo&bar=a%20b+c',
    });
    expect(readKitchenFragment('#section-2&kitchen=tok').hash).toBe(
      '#section-2',
    );
  });

  it('leaves an address with no kitchen parameter alone', () => {
    expect(readKitchenFragment('')).toEqual({ present: false, hash: '' });
    expect(readKitchenFragment('#')).toEqual({ present: false, hash: '' });
    expect(readKitchenFragment('#section-2')).toEqual({
      present: false,
      hash: '#section-2',
    });
  });

  it.each([
    ['empty', '#kitchen='],
    ['with a space', '#kitchen=a%20b'],
    ['with a slash', '#kitchen=a%2Fb'],
    ['too long', `#kitchen=${'a'.repeat(257)}`],
  ])('strips a token that is %s but does not use it', (_name, hash) => {
    const read = readKitchenFragment(hash);
    expect(read.token).toBeUndefined();
    expect(read.present).toBe(true);
    expect(read.hash).toBe('');
  });

  it('reads only the kitchen key, and the first of a repeated one', () => {
    expect(readKitchenFragment('#kitchenx=1')).toMatchObject({
      present: false,
    });
    const twice = readKitchenFragment('#kitchen=one&kitchen=two');
    expect(twice.token).toBe('one');
    expect(twice.hash).toBe('');
  });
});

describe('the export panel', () => {
  beforeEach(() => kitchenState.configure(undefined));

  it('offers Export cookbook alone without a kitchen', () => {
    const { body } = render(ExportPanel, { context });
    expect(body).toContain('Export cookbook');
    expect(body).not.toContain('Send to kitchen');
    expect(body).not.toContain('Download cookbook');
  });

  it('puts Send to kitchen first and keeps Download as the secondary option', () => {
    kitchenState.configure(endpoint, kitchen.token);
    const { body } = render(ExportPanel, { context });
    expect(body).toContain('Send to kitchen');
    expect(body).toContain('Download cookbook');
    expect(body.indexOf('Send to kitchen')).toBeLessThan(
      body.indexOf('Download cookbook'),
    );
    expect(body).not.toContain('Export cookbook');
    expect(body).not.toContain('needs its link');
  });

  it('stays off, and says why, when the CLI serves its token in the config', () => {
    kitchenState.configure({ ...endpoint, tokenInConfig: true }, 'abc123');
    expect(kitchenState.config).toBeUndefined();
    expect(kitchenState.needsLink).toBe(false);
    const { body } = render(ExportPanel, { context });
    expect(body).toContain('Send to kitchen is off');
    expect(body).toContain('Export cookbook');
    expect(body).not.toContain('needs its link');
  });

  it('says what is missing when the page has no token, and offers only Export', () => {
    kitchenState.configure(endpoint);
    expect(kitchenState.config).toBeUndefined();
    expect(kitchenState.needsLink).toBe(true);
    const { body } = render(ExportPanel, { context });
    expect(body).toContain('needs its link');
    expect(body).toContain('#kitchen=');
    expect(body).toContain('Export cookbook');
    expect(body).not.toContain('Send to kitchen</button>');
  });
});
