import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  FUTURE,
  leaks,
  mintBody,
  NOW,
  SLOT_ID,
  SLOT_ID_2,
  thrown,
} from '../testing/credentials.js';
import { MAX_MINT_RESPONSE_BYTES, parseMintResponse } from './mint-response.js';

const options = { now: () => NOW };

function parse(body: string, slot = SLOT_ID) {
  return parseMintResponse(body, slot, options);
}

async function failure(body: string, slot = SLOT_ID) {
  const error = await thrown(() => parse(body, slot));
  expect(error).toBeInstanceOf(DesktopContractError);
  return error as DesktopContractError;
}

describe('parseMintResponse', () => {
  it('accepts the #4726 success reply and wraps the token at once', () => {
    const credential = parse(mintBody());
    expect(credential.slotId).toBe(SLOT_ID);
    expect(credential.token).toBeInstanceOf(SecretString);
    expect(credential.token.reveal()).toBe(CANARY_TOKEN);
    expect(credential.scopes).toEqual(['notes.read']);
    expect(credential.expiresAt).toBe(FUTURE);
    expect(Object.isFrozen(credential)).toBe(true);
    expect(JSON.stringify(credential)).not.toContain(CANARY_BODY);
  });

  it('requires the id to equal the slot the request used', async () => {
    const error = await failure(mintBody({}, SLOT_ID_2));
    expect(error.code).toBe('invalid_mint_response');
    expect(error.field).toBe('id');
  });

  it.each([
    ['wrong prefix', `smrt_xxx_${'A'.repeat(43)}`],
    ['too short', `smrt_mcp_${'A'.repeat(42)}`],
    ['too long', `smrt_mcp_${'A'.repeat(44)}`],
    ['bad alphabet', `smrt_mcp_${'A'.repeat(42)}+`],
    ['empty', ''],
    ['number', 5],
    ['trailing newline', `${CANARY_TOKEN}\n`],
  ])('rejects a token that is %s', async (_name, token) => {
    const error = await failure(mintBody({ token }));
    expect(error.field).toBe('token');
  });

  it('requires the expiry to be at least 60 seconds ahead', async () => {
    const soon = new Date(NOW + 59_000).toISOString();
    const ok = new Date(NOW + 60_000).toISOString();
    expect((await failure(mintBody({ expiresAt: soon }))).field).toBe(
      'expiresAt',
    );
    expect(parse(mintBody({ expiresAt: ok })).expiresAt).toBe(ok);
    const past = new Date(NOW - 1000).toISOString();
    expect((await failure(mintBody({ expiresAt: past }))).field).toBe(
      'expiresAt',
    );
    expect((await failure(mintBody({ expiresAt: 'tomorrow' }))).field).toBe(
      'expiresAt',
    );
    expect(
      (await failure(mintBody({ expiresAt: '2026-12-01T12:00:00+00:00' })))
        .field,
    ).toBe('expiresAt');
  });

  it('rejects invalid scopes', async () => {
    for (const scopes of [[], ['a', 'a'], ['has space'], 'notes.read', [1]]) {
      expect((await failure(mintBody({ scopes }))).field).toBe('scopes');
    }
  });

  it('rejects extra and missing keys', async () => {
    expect((await failure(mintBody({ status: 'ok' }))).field).toBe('body');
    expect((await failure(mintBody({ extra: CANARY_TOKEN }))).field).toBe(
      'body',
    );
    const { id: _id, ...missing } = JSON.parse(mintBody());
    expect((await failure(JSON.stringify(missing))).field).toBe('body');
  });

  it('rejects non-objects, bad JSON, duplicate keys and oversize bodies', async () => {
    for (const body of [
      '[]',
      '"x"',
      'null',
      '{',
      `{"id":"${SLOT_ID}","id":"${SLOT_ID}","token":"${CANARY_TOKEN}","scopes":["a"],"expiresAt":"${FUTURE}"}`,
      ' '.repeat(MAX_MINT_RESPONSE_BYTES + 1),
    ]) {
      expect((await failure(body)).code).toBe('invalid_mint_response');
    }
    expect(
      (await thrown(() =>
        parseMintResponse(5 as unknown as string, SLOT_ID),
      )) instanceof DesktopContractError,
    ).toBe(true);
    expect((await failure(mintBody(), 'not-a-uuid')).field).toBe('id');
  });

  it('T11: never echoes the body or the token in any failure', async () => {
    const hostile = [
      mintBody({}, SLOT_ID_2),
      mintBody({ extra: 1 }),
      mintBody({ scopes: [] }),
      mintBody({ expiresAt: '1999-01-01T00:00:00Z' }),
      `{"id":"${SLOT_ID}","token":"${CANARY_TOKEN}"`,
      `${mintBody()} trailing ${CANARY_TOKEN}`,
      `[${mintBody()}]`,
      mintBody({ token: `${CANARY_TOKEN}x` }),
    ];
    for (const body of hostile) {
      const error = await failure(body);
      expect(leaks(error)).toBe(false);
      expect(error.message).toBe(
        'Credential response does not match the documented success reply',
      );
    }
  });
});
