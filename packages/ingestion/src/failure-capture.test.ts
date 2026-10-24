import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_CAPTURE_DEFAULT_MAX_BYTES,
  prepareFailureCapture,
  truncateUtf8,
} from './failure-capture.js';

const now = new Date('2026-10-23T00:00:00Z');
const bounds = { inputBytes: 60000, timeoutMs: 1000, now };

describe('failed-attempt capture bounds (#4285)', () => {
  it.each([
    ['3-byte euro', '€'],
    ['4-byte emoji', '\u{1F600}'],
  ])('never splits a %s at the byte boundary', (_label, char) => {
    const width = Buffer.byteLength(char);
    const text = `ab${char}cd`;
    // Every cut inside the character drops it whole; a cut after keeps it.
    for (let cut = 2; cut < 2 + width; cut++)
      expect(truncateUtf8(text, cut)).toEqual({ text: 'ab', truncated: true });
    expect(truncateUtf8(text, 2 + width)).toEqual({
      text: `ab${char}`,
      truncated: true,
    });
    expect(truncateUtf8(text, Buffer.byteLength(text))).toEqual({
      text,
      truncated: false,
    });
    expect(truncateUtf8(char.repeat(3), width * 2 + 1)).toEqual({
      text: char.repeat(2),
      truncated: true,
    });
    expect(truncateUtf8(char, width - 1)).toEqual({
      text: '',
      truncated: true,
    });
  });
  it('caps the stored text after redaction, multi-byte safe', async () => {
    const stored = await prepareFailureCapture(
      {
        enabled: true,
        maxBytes: 10,
        redact: ({ text }) => text.replaceAll('x', '€'),
      },
      { source: 'raw_response', text: () => 'xxxxx' },
      bounds,
    );
    // Five euros are 15 bytes; three fit in 10.
    expect(stored).toMatchObject({
      status: 'captured',
      text: '€€€',
      truncated: true,
      redacted: true,
      maxBytes: 10,
      capturedAt: now.toISOString(),
    });
  });
  it('is off unless enabled, skips empty text and defaults its cap', async () => {
    const candidate = { source: 'raw_response' as const, text: () => 'body' };
    expect(await prepareFailureCapture(undefined, candidate, bounds)).toBe(
      undefined,
    );
    expect(
      await prepareFailureCapture({ enabled: false }, candidate, bounds),
    ).toBe(undefined);
    expect(
      await prepareFailureCapture(
        { enabled: true },
        { source: 'raw_response', text: () => '' },
        bounds,
      ),
    ).toBe(undefined);
    expect(
      await prepareFailureCapture({ enabled: true }, candidate, bounds),
    ).toMatchObject({
      status: 'captured',
      text: 'body',
      redacted: false,
      maxBytes: FAILURE_CAPTURE_DEFAULT_MAX_BYTES,
    });
  });
  it('never calls the hook without time left and never throws', async () => {
    const redact = vi.fn(({ text }: { text: string }) => text);
    expect(
      await prepareFailureCapture(
        { enabled: true, redact },
        { source: 'generated_output', text: () => 'secret' },
        { ...bounds, timeoutMs: 0 },
      ),
    ).toMatchObject({ status: 'redaction_failed', truncated: false });
    expect(redact).not.toHaveBeenCalled();
    expect(
      await prepareFailureCapture(
        { enabled: true },
        {
          source: 'generated_output',
          text: () => {
            throw new Error('unserializable');
          },
        },
        bounds,
      ),
    ).toBe(undefined);
  });
});
