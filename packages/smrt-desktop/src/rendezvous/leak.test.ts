import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  encodeControlRequest,
  encodeControlResponse,
  parseControlRequest,
  parseControlResponse,
} from './control-protocol.js';
import { deriveControlEndpoint, parseControlEndpoint } from './endpoint.js';
import {
  parseInstanceRecord,
  serializeInstanceRecord,
} from './instance-record.js';

const TOKEN = 'smrt_mcp_LEAKCANARY0123456789';
const PATH = '/Users/someone/Library/Application Support/com.example.app';
const ORIGIN = 'http://127.0.0.1:49152';
const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** Inputs that embed a token, a path, an origin and a pid in every position. */
const hostile: string[] = [
  TOKEN,
  `{"v":1,"op":"${TOKEN}"}`,
  `{"v":"${TOKEN}","op":"status"}`,
  `{"v":1,"op":"status","${TOKEN}":"${PATH}"}`,
  `{"v":1,"op":"status","${TOKEN}":1,"${TOKEN}":2}`,
  `{"v":1,"op":"ensure-ready","timeoutMs":"${TOKEN}"}`,
  `{"v":1,"ok":true,"state":"ready","instanceNonce":"${TOKEN}","productId":"smrt-notes","origin":"${ORIGIN}"}`,
  `{"v":1,"ok":true,"state":"ready","instanceNonce":"${NONCE}","productId":"${TOKEN}","origin":"${ORIGIN}"}`,
  `{"v":1,"ok":true,"state":"ready","instanceNonce":"${NONCE}","productId":"smrt-notes","origin":"${ORIGIN}/${TOKEN}"}`,
  `{"v":1,"ok":true,"state":"failed","instanceNonce":"${NONCE}","productId":"smrt-notes","code":"${TOKEN}"}`,
  `{"v":1,"ok":false,"code":"${TOKEN}"}`,
  `{"v":1,"ok":false,"code":"internal","detail":"${TOKEN}"}`,
  `{"version":1,"productId":"${TOKEN}"}`,
  `{"version":1,"control":{"kind":"unix","path":"${PATH}/${TOKEN}"}}`,
  `{"version":1,"pid":"${TOKEN}","origin":"${ORIGIN}"}`,
  `${'x'.repeat(5000)}${TOKEN}`,
];

function messagesOf(fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    const e = error as DesktopContractError;
    return [
      e.message,
      e.stack ?? '',
      e.field ?? '',
      String(e),
      JSON.stringify(e),
    ];
  }
}

describe('rendezvous leak checks', () => {
  it('keeps token, path and origin out of every parser error', () => {
    const parsers: Array<(input: string) => unknown> = [
      parseInstanceRecord,
      parseControlRequest,
      (input) => parseControlResponse('status', input),
      (input) => parseControlResponse('ensure-ready', input),
      (input) => parseControlEndpoint(input),
      (input) => parseControlEndpoint({ kind: 'unix', path: input }),
      (input) => parseControlEndpoint({ kind: 'pipe', name: input }),
      (input) =>
        deriveControlEndpoint({
          platform: 'linux',
          bundleId: 'com.example.app',
          directory: input,
        }),
      (input) => encodeControlRequest(input as never),
      (input) => encodeControlResponse(input as never),
      (input) => serializeInstanceRecord(input as never),
    ];
    let thrown = 0;
    for (const parse of parsers) {
      for (const input of hostile) {
        for (const text of messagesOf(() => parse(input))) {
          thrown++;
          expect(text).not.toContain(TOKEN);
          expect(text).not.toContain(PATH);
          expect(text).not.toContain('Application Support');
          expect(text).not.toContain('49152');
        }
      }
    }
    expect(thrown).toBeGreaterThan(100);
  });

  it('gives every error a message that is independent of the input', () => {
    const a = messagesOf(() => parseControlRequest('{"v":1,"op":"a"}'));
    const b = messagesOf(() => parseControlRequest(`{"v":1,"op":"${TOKEN}"}`));
    expect(a[0]).toBe(b[0]);
  });
});
