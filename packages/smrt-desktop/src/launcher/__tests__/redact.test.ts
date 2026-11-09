import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '../redact.js';

async function redact(secret: string, chunks: string[]): Promise<string> {
  const redactor = new SecretRedactor(secret);
  const out: Buffer[] = [];
  redactor.on('data', (chunk: Buffer) => out.push(chunk));
  for (const chunk of chunks) redactor.write(chunk);
  redactor.end();
  await new Promise((resolve) => redactor.on('end', resolve));
  return Buffer.concat(out).toString('utf8');
}

describe('SecretRedactor', () => {
  const secret = 'smrt_mcp_abcdefghij';

  it('redacts at every possible split point', async () => {
    const text = `before ${secret} after ${secret}\n`;
    const expected = 'before [REDACTED] after [REDACTED]\n';
    for (let index = 0; index <= text.length; index += 1) {
      expect(
        await redact(secret, [text.slice(0, index), text.slice(index)]),
      ).toBe(expected);
    }
  });

  it('catches a copy in JSON or a URL as written, and only that exact string', async () => {
    const json = JSON.stringify({ authorization: `Bearer ${secret}` });
    expect(await redact(secret, [json])).toBe(
      '{"authorization":"Bearer [REDACTED]"}',
    );
    expect(
      await redact(secret, [`GET /x?t=${encodeURIComponent(secret)}`]),
    ).toBe('GET /x?t=[REDACTED]');
    // Other encodings are documented as not caught (README, Credential
    // redaction): the filter matches one exact byte string.
    const base64 = Buffer.from(secret).toString('base64');
    const hex = Buffer.from(secret).toString('hex');
    const escaped = [...secret]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const spaced = secret.replace('_', ' ');
    for (const copy of [base64, hex, escaped, spaced, secret.toUpperCase()]) {
      expect(await redact(secret, [`seen ${copy}`])).toBe(`seen ${copy}`);
    }
  });

  it('redacts one byte at a time', async () => {
    const text = `x${secret}y`;
    expect(await redact(secret, [...text])).toBe('x[REDACTED]y');
  });

  it('does not hold back ordinary newline-terminated output', async () => {
    const redactor = new SecretRedactor(secret);
    const seen: string[] = [];
    redactor.on('data', (chunk: Buffer) => seen.push(chunk.toString()));
    redactor.write('{"jsonrpc":"2.0"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.join('')).toBe('{"jsonrpc":"2.0"}\n');
  });

  it('flushes a short trailing partial prefix unchanged', async () => {
    expect(await redact(secret, ['ok s'])).toBe('ok s');
  });

  it('withholds a long partial prefix when the stream ends inside the secret', async () => {
    expect(await redact(secret, ['ok smrt_mcp_abc'])).toBe('ok [REDACTED]');
    expect(await redact(secret, ['ok smrt_mcp_abc', ''])).toBe('ok [REDACTED]');
  });

  it('releases a held prefix that turns out not to be the secret', async () => {
    expect(await redact(secret, ['ok smrt_mcp_abc', 'x done'])).toBe(
      'ok smrt_mcp_abcx done',
    );
  });

  it('handles overlapping prefixes', async () => {
    expect(await redact('aab', ['aaab', 'aa', 'ab'])).toBe(
      'a[REDACTED]a[REDACTED]',
    );
  });
});
