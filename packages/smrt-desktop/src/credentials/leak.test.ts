import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopContractError,
  type DesktopContractErrorCode,
  desktopContractErrorMessage,
} from '../errors.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  FUTURE,
  leaks,
  mintBody,
  NONCE,
  NOW,
  ORIGIN,
  renderings,
  SLOT_ID,
  thrown,
} from '../testing/credentials.js';
import {
  connectDesktopAssistant,
  disconnectDesktopAssistant,
  getDesktopAssistantStatus,
} from '../webview/index.js';
import { spawnBridgeWithCredential } from './bridge-spawn.js';
import {
  createCredentialControlHandler,
  encodeAcquireCredentialResponse,
  parseAcquireCredentialResponse,
} from './control-handler.js';
import {
  createCredentialCustody,
  createMemorySecretItemStore,
  type SecretItemStore,
} from './custody.js';
import {
  encodeHandoffFrame,
  type HandoffFrame,
  HandoffFrameDecoder,
  parseHandoffFrame,
} from './handoff-frame.js';
import { parseMintResponse, type StoredCredential } from './mint-response.js';
import { createControlChannelCredentialProvider } from './provider.js';
import { parseSlotRecord, serializeSlotRecord } from './slot-record.js';

/**
 * Canary tests: every exported parser, handler and helper is fed
 * token-bearing invalid input, and every failure must be free of the token in
 * every rendering a log line, crash report or JSON response could contain.
 */

const credential = (): StoredCredential => ({
  slotId: SLOT_ID,
  token: new SecretString(CANARY_TOKEN),
  scopes: ['notes.read'],
  expiresAt: FUTURE,
});

/** Token-bearing strings in many malformed shapes. */
const hostileTexts: string[] = [
  CANARY_TOKEN,
  `${CANARY_TOKEN}\n`,
  `{"token":"${CANARY_TOKEN}"`,
  `{"token":"${CANARY_TOKEN}"}`,
  `["${CANARY_TOKEN}"]`,
  `{"id":"${SLOT_ID}","token":"${CANARY_TOKEN}","token":"${CANARY_TOKEN}"}`,
  mintBody({ extra: CANARY_TOKEN }),
  mintBody({ scopes: [CANARY_TOKEN] }),
  mintBody({ expiresAt: CANARY_TOKEN }),
  mintBody({ id: CANARY_TOKEN }),
  mintBody({ version: CANARY_TOKEN }),
  `${mintBody()}${' '.repeat(13_000)}`,
  JSON.stringify({
    v: 1,
    type: 'credential',
    seq: CANARY_TOKEN,
    token: CANARY_TOKEN,
  }),
  JSON.stringify({ v: CANARY_TOKEN, type: 'credential' }),
  JSON.stringify({ v: 1, type: CANARY_TOKEN }),
  JSON.stringify({ version: 1, slotId: CANARY_TOKEN, scopes: [CANARY_TOKEN] }),
  JSON.stringify({ v: 1, ok: true, origin: CANARY_TOKEN, token: CANARY_TOKEN }),
  JSON.stringify({ v: 1, ok: false, code: CANARY_TOKEN }),
  `${CANARY_TOKEN}`.repeat(200),
];

const hostileObjects: unknown[] = [
  { token: CANARY_TOKEN },
  {
    v: 1,
    ok: true,
    origin: ORIGIN,
    token: `${CANARY_TOKEN}x`,
    expiresAt: FUTURE,
  },
  {
    v: 1,
    ok: true,
    origin: ORIGIN,
    token: CANARY_TOKEN,
    expiresAt: FUTURE,
    extra: CANARY_TOKEN,
  },
  { v: 1, ok: false, code: 'credential_invalid', token: CANARY_TOKEN },
  [CANARY_TOKEN],
  CANARY_TOKEN,
];

describe('leak canary (T5, T11)', () => {
  describe('SecretString and StoredCredential never serialize the token', () => {
    it('T5: SecretString is not serialized by JSON, inspect, String, template, structuredClone or console', () => {
      const secret = new SecretString(CANARY_TOKEN);
      const stored = credential();
      const lines: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (method) =>
          vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            lines.push(args.map((arg) => inspect(arg, { depth: 8 })).join(' '));
          }),
      );
      try {
        console.log(secret, stored, { nested: { secret } });
        console.error('x', stored);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const everything = [
        JSON.stringify(secret),
        JSON.stringify(stored),
        JSON.stringify({ a: [secret, stored] }),
        inspect(secret, { depth: 10, showHidden: true }),
        inspect(stored, { depth: 10, showHidden: true, showProxy: true }),
        String(secret),
        String(stored.token),
        `${secret}`,
        // biome-ignore lint/style/useTemplate: exercises concatenation coercion
        'x' + secret,
        JSON.stringify(structuredClone(secret)),
        JSON.stringify(structuredClone(stored)),
        JSON.stringify({ ...secret }),
        JSON.stringify(Object.assign({}, secret)),
        JSON.stringify(Object.getOwnPropertyNames(secret)),
        JSON.stringify(Object.getOwnPropertySymbols(secret).map(String)),
        Object.prototype.toString.call(secret),
        lines.join('\n'),
      ];
      for (const text of everything) {
        expect(text).not.toContain(CANARY_BODY);
        expect(text).not.toContain('CANARYLEAK');
      }
      expect(String(secret)).toBe('[REDACTED]');
      expect(inspect(secret)).toBe('SecretString([REDACTED])');
    });

    it('T5: errors built with secrets in their context do not retain them', () => {
      const secret = new SecretString(CANARY_TOKEN);
      const hostileOptions = {
        field: 'token',
        cause: CANARY_TOKEN,
        token: CANARY_TOKEN,
        value: secret,
        context: { token: CANARY_TOKEN, secret },
        message: CANARY_TOKEN,
      } as unknown as ConstructorParameters<typeof DesktopContractError>[1];
      const codes: DesktopContractErrorCode[] = [
        'invalid_mint_response',
        'invalid_handoff_frame',
        'credential_invalid',
        'native_rejected',
      ];
      for (const code of codes) {
        const error = new DesktopContractError(code, hostileOptions);
        expect(error.message).toBe(desktopContractErrorMessage(code));
        expect((error as Error).cause).toBeUndefined();
        expect(Object.keys(error).sort()).toEqual(['code', 'field', 'name']);
        expect(leaks(error)).toBe(false);
        expect(leaks(error, 'CANARYLEAK')).toBe(false);
      }
    });

    it('T5: every credential error message is fixed, value-free text', () => {
      const codes: DesktopContractErrorCode[] = [
        'credential_unavailable',
        'credential_invalid',
        'instance_mismatch',
        'invalid_mint_response',
        'invalid_handoff_frame',
        'handoff_frame_too_large',
        'handoff_failed',
        'slot_unavailable',
        'credential_forbidden',
        'credential_rejected',
        'credential_request_failed',
        'native_rejected',
        'invalid_native_response',
      ];
      const messages = codes.map(desktopContractErrorMessage);
      expect(new Set(messages).size).toBe(codes.length);
      for (const message of messages) {
        expect(message.length).toBeGreaterThan(10);
        expect(message).not.toMatch(/[/\\]|\d{2,}|https?:|smrt_mcp|%s|\$\{/);
      }
    });
  });

  describe('T5/T11: every exported parser and handler, fed token-bearing invalid input', () => {
    const parsers: Array<[string, (input: string) => unknown]> = [
      [
        'parseMintResponse',
        (input) => parseMintResponse(input, SLOT_ID, { now: () => NOW }),
      ],
      [
        'parseMintResponse (wrong slot)',
        (input) =>
          parseMintResponse(input, '7f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5'),
      ],
      ['parseSlotRecord', parseSlotRecord],
      [
        'parseHandoffFrame to-bridge',
        (input) => parseHandoffFrame(input, 'to-bridge'),
      ],
      [
        'parseHandoffFrame to-launcher',
        (input) => parseHandoffFrame(input, 'to-launcher'),
      ],
      [
        'HandoffFrameDecoder',
        (input) => new HandoffFrameDecoder('to-bridge').push(`${input}\n`),
      ],
      ['parseAcquireCredentialResponse (text)', parseAcquireCredentialResponse],
    ];

    for (const [name, parse] of parsers) {
      it(`${name} never echoes the input`, async () => {
        for (const text of hostileTexts) {
          const error = await thrown(() => parse(text));
          if (error === undefined) continue; // not every text is invalid for every parser
          expect(error, name).toBeInstanceOf(DesktopContractError);
          expect(leaks(error), `${name}: ${text.slice(0, 40)}`).toBe(false);
          expect(renderings(error).join('\n')).not.toContain('CANARYLEAK');
        }
      });
    }

    it('parseAcquireCredentialResponse never echoes parsed objects', async () => {
      for (const value of hostileObjects) {
        const error = await thrown(() => parseAcquireCredentialResponse(value));
        expect(error).toBeInstanceOf(DesktopContractError);
        expect(leaks(error)).toBe(false);
      }
    });

    it('encodeHandoffFrame never echoes a rejected frame', async () => {
      const bad: unknown[] = [
        {
          v: 1,
          type: 'credential',
          seq: 0,
          origin: 'http://localhost:1',
          token: new SecretString(CANARY_TOKEN),
          expiresAt: FUTURE,
        },
        {
          v: 1,
          type: 'credential',
          seq: -1,
          origin: ORIGIN,
          token: new SecretString(CANARY_TOKEN),
          expiresAt: FUTURE,
        },
        {
          v: 1,
          type: 'credential',
          seq: 0,
          origin: ORIGIN,
          token: CANARY_TOKEN,
          expiresAt: FUTURE,
        },
        {
          v: 1,
          type: 'credential',
          seq: 0,
          origin: ORIGIN,
          token: new SecretString(`${CANARY_TOKEN}!`),
          expiresAt: FUTURE,
        },
        { v: 1, type: CANARY_TOKEN },
        null,
      ];
      for (const frame of bad) {
        const error = await thrown(() =>
          encodeHandoffFrame(frame as HandoffFrame, 'to-bridge'),
        );
        expect(error).toBeInstanceOf(DesktopContractError);
        expect(leaks(error)).toBe(false);
      }
    });

    it('serializeSlotRecord never echoes a rejected record', async () => {
      const error = await thrown(() =>
        serializeSlotRecord({
          version: 1,
          slotId: CANARY_TOKEN,
          scopes: [CANARY_TOKEN],
          expiresAt: null,
          state: 'minted',
        }),
      );
      expect(error).toBeInstanceOf(DesktopContractError);
      expect(leaks(error)).toBe(false);
    });

    it('custody never echoes malformed stored items or store errors', async () => {
      const name = `mcp-credential.${SLOT_ID}`;
      for (const text of hostileTexts) {
        const inner = createMemorySecretItemStore();
        await inner.set(name, new TextEncoder().encode(text));
        const error = await thrown(() =>
          createCredentialCustody(inner).get(SLOT_ID),
        );
        expect(error).toBeInstanceOf(DesktopContractError);
        expect(leaks(error)).toBe(false);
      }
      const failing: SecretItemStore = {
        get: async () => {
          throw new Error(CANARY_TOKEN);
        },
        set: async () => {
          throw new Error(CANARY_TOKEN);
        },
        delete: async () => {
          throw new Error(CANARY_TOKEN);
        },
      };
      const custody = createCredentialCustody(failing);
      for (const run of [
        () => custody.get(SLOT_ID),
        () => custody.put(credential()),
        () => custody.delete(SLOT_ID),
      ]) {
        expect(leaks(await thrown(run))).toBe(false);
      }
    });

    it('the control handler turns every custody failure into a code-only result', async () => {
      const failures: Array<() => Promise<Uint8Array | null>> = [
        async () => {
          throw new Error(CANARY_TOKEN);
        },
        async () => new TextEncoder().encode(`{"token":"${CANARY_TOKEN}"`),
        async () => new TextEncoder().encode(mintBody({ extra: CANARY_TOKEN })),
      ];
      for (const get of failures) {
        const store: SecretItemStore = {
          get,
          set: async () => undefined,
          delete: async () => undefined,
        };
        const handler = createCredentialControlHandler({
          custody: createCredentialCustody(store),
          slot: async () => ({
            version: 1,
            slotId: SLOT_ID,
            scopes: ['a'],
            expiresAt: FUTURE,
            state: 'minted',
          }),
          current: () => ({ instanceNonce: NONCE, origin: ORIGIN }),
          now: () => NOW,
        });
        const result = await handler({
          v: 1,
          op: 'acquire-credential',
          instanceNonce: NONCE,
          origin: ORIGIN,
        });
        expect(result.ok).toBe(false);
        expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
        expect(JSON.stringify(result)).not.toContain(CANARY_BODY);
        expect(inspect(result)).not.toContain(CANARY_BODY);
        expect(encodeAcquireCredentialResponse(result)).not.toContain(
          CANARY_BODY,
        );
      }
    });

    it('the control handler survives hostile requests and throwing collaborators', async () => {
      const handler = createCredentialControlHandler({
        custody: createCredentialCustody(createMemorySecretItemStore()),
        slot: async () => {
          throw new Error(CANARY_TOKEN);
        },
        current: () => ({ instanceNonce: NONCE, origin: ORIGIN }),
        now: () => NOW,
      });
      for (const request of [
        null,
        { token: CANARY_TOKEN },
        {
          v: 1,
          op: 'acquire-credential',
          instanceNonce: CANARY_TOKEN,
          origin: CANARY_TOKEN,
        },
        {
          v: 1,
          op: 'acquire-credential',
          instanceNonce: NONCE,
          origin: ORIGIN,
        },
      ]) {
        const result = await handler(request as never);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain(CANARY_BODY);
      }
    });

    it('the provider never echoes transport errors or hostile replies', async () => {
      const replies: Array<() => Promise<unknown>> = [
        async () => {
          throw new Error(`socket ${CANARY_TOKEN}`);
        },
        ...hostileTexts.map((text) => async () => text),
        ...hostileObjects.map((value) => async () => value),
      ];
      for (const reply of replies) {
        const provider = createControlChannelCredentialProvider({
          send: reply,
          now: () => NOW,
        });
        const error = await thrown(() =>
          provider.acquire({ instanceNonce: NONCE, origin: ORIGIN }),
        );
        expect(error).toBeInstanceOf(DesktopContractError);
        expect(leaks(error)).toBe(false);
        expect((error as Error).cause).toBeUndefined();
      }
      const provider = createControlChannelCredentialProvider({
        send: async () => undefined,
      });
      for (const request of [
        { instanceNonce: CANARY_TOKEN, origin: ORIGIN },
        { instanceNonce: NONCE, origin: CANARY_TOKEN },
      ]) {
        expect(leaks(await thrown(() => provider.acquire(request)))).toBe(
          false,
        );
      }
    });

    it('spawnBridgeWithCredential never echoes the token it refused to spawn with', async () => {
      const error = await thrown(() =>
        spawnBridgeWithCredential({
          command: process.execPath,
          args: [`--token=${CANARY_TOKEN}`],
          env: { LEAK: CANARY_TOKEN },
          lease: {
            token: new SecretString(CANARY_TOKEN),
            origin: ORIGIN,
            expiresAt: FUTURE,
          },
          spawn: (() => {
            throw new Error('must not spawn');
          }) as never,
        }),
      );
      expect(error).toBeInstanceOf(DesktopContractError);
      expect(leaks(error)).toBe(false);
    });

    it('the webview helper maps token-bearing failures to fixed codes', async () => {
      const bearers = [
        Object.assign(new Error(CANARY_TOKEN), {
          cause: CANARY_TOKEN,
          body: CANARY_TOKEN,
        }),
        CANARY_TOKEN,
        { token: CANARY_TOKEN },
      ];
      for (const rejection of bearers) {
        const slot = {
          slotId: SLOT_ID,
          state: 'minted',
          scopes: ['a'],
          expiresAt: null,
        };
        const common = { sleep: async () => undefined, maxAttempts: 2 };
        const failing = [
          connectDesktopAssistant({
            ...common,
            scopes: ['a'],
            expiresInSeconds: 3600,
            invoke: async (command) => {
              if (command === 'desktop-credential-slot') return slot;
              throw rejection;
            },
            fetch: async () => ({ status: 200, text: async () => mintBody() }),
          }),
          connectDesktopAssistant({
            ...common,
            scopes: ['a'],
            expiresInSeconds: 3600,
            invoke: async () => {
              throw rejection;
            },
            fetch: async () => {
              throw rejection;
            },
          }),
          connectDesktopAssistant({
            ...common,
            scopes: ['a'],
            expiresInSeconds: 3600,
            invoke: async () => slot,
            fetch: async () => {
              throw rejection;
            },
          }),
          disconnectDesktopAssistant({
            ...common,
            invoke: async () => {
              throw rejection;
            },
            fetch: async () => {
              throw rejection;
            },
          }),
          getDesktopAssistantStatus({
            invoke: async () => {
              throw rejection;
            },
          }),
          getDesktopAssistantStatus({
            invoke: async () => ({ token: CANARY_TOKEN }),
          }),
        ];
        for (const promise of failing) {
          const error = await thrown(() => promise);
          expect(error).toBeInstanceOf(DesktopContractError);
          expect(leaks(error)).toBe(false);
          expect((error as Error).cause).toBeUndefined();
        }
      }
    });
  });

  describe('where the bearer may be revealed', () => {
    it('reveal() is called only by custody serialization, the wire encoders and the secret guard', () => {
      const root = fileURLToPath(new URL('..', import.meta.url));
      const callers: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) {
            if (entry !== 'testing') walk(path);
          } else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
            const code = readFileSync(path, 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/^\s*\/\/.*$/gm, '');
            if (/\.reveal\(\)/.test(code))
              callers.push(path.slice(root.length));
          }
        }
      };
      walk(root);
      expect(callers.sort()).toEqual([
        'credentials/control-handler.ts',
        'credentials/custody.ts',
        'credentials/handoff-frame.ts',
      ]);
    });
  });
});
