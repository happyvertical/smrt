import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { DesktopContractError } from './errors.js';
import { SecretString } from './secret-string.js';

const SECRET = 'smrt_mcp_sEcReT-vAlUe_0123456789';

function dumps(secret: SecretString): string[] {
  return [
    String(secret),
    `${secret}`,
    `${secret}x` + secret,
    secret.toString(),
    JSON.stringify(secret),
    JSON.stringify({ nested: { secret }, list: [secret] }),
    inspect(secret),
    inspect({ secret }, { depth: 5, showHidden: true }),
    JSON.stringify(structuredClone(secret)),
    JSON.stringify({ ...secret }),
    JSON.stringify(Object.assign({}, secret)),
    JSON.stringify(Object.getOwnPropertyNames(secret)),
    Object.prototype.toString.call(secret),
  ];
}

describe('SecretString', () => {
  it('reveals the value only through reveal()', () => {
    const secret = new SecretString(SECRET);
    expect(secret.reveal()).toBe(SECRET);
    expect(secret.length).toBe(SECRET.length);
  });

  it('never leaks through string, JSON, inspect, spread or clone', () => {
    for (const text of dumps(new SecretString(SECRET))) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('sEcReT');
    }
    expect(String(new SecretString(SECRET))).toBe('[REDACTED]');
    expect(inspect(new SecretString(SECRET))).toBe('SecretString([REDACTED])');
  });

  it('does not leak through console output', () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(args.map((arg) => inspect(arg)).join(' '));
        }),
    );
    try {
      const secret = new SecretString(SECRET);
      console.log(secret, { secret });
      console.error('x', secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines.join('\n')).not.toContain('sEcReT');
  });

  it('exposes no own properties', () => {
    const secret = new SecretString(SECRET);
    expect(Reflect.ownKeys(secret)).toEqual([]);
    expect(Object.isFrozen(secret)).toBe(true);
    expect(structuredClone(secret)).toEqual({});
  });

  it('coerces to a redaction for every primitive hint', () => {
    const secret = new SecretString(SECRET);
    expect(`${secret}`).toBe('[REDACTED]');
    expect(secret + '').toBe('[REDACTED]');
    expect(Number.isNaN(Number(secret))).toBe(true);
  });

  it.each([
    '',
    'a\0b',
    '\0',
    '\ud800',
    42,
    null,
    undefined,
    {},
  ])('rejects %j', (value) => {
    let thrown: unknown;
    try {
      new SecretString(value as string);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DesktopContractError);
    expect((thrown as DesktopContractError).code).toBe('invalid_secret');
  });

  describe('equals', () => {
    it('compares values, not identity', () => {
      expect(new SecretString(SECRET).equals(new SecretString(SECRET))).toBe(
        true,
      );
      expect(
        new SecretString(SECRET).equals(new SecretString(`${SECRET}x`)),
      ).toBe(false);
      expect(new SecretString('a').equals(new SecretString('b'))).toBe(false);
    });

    it('is false for anything that is not a SecretString', () => {
      const secret = new SecretString(SECRET);
      expect(secret.equals(SECRET)).toBe(false);
      expect(secret.equals(null)).toBe(false);
      expect(secret.equals({ reveal: () => SECRET })).toBe(false);
    });

    it('does not depend on length or common prefix (digest comparison)', () => {
      // Different lengths must still go through the same hashed path and
      // return false rather than throwing from timingSafeEqual.
      expect(
        new SecretString('a').equals(new SecretString('a'.repeat(500))),
      ).toBe(false);
      expect(
        new SecretString('é🪴'.repeat(10)).equals(
          new SecretString('é🪴'.repeat(10)),
        ),
      ).toBe(true);
    });
  });
});
