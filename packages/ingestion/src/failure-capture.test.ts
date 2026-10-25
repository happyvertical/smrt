import { describe, expect, it, vi } from 'vitest';
import {
  FAILURE_CAPTURE_DEFAULT_MAX_BYTES,
  prepareFailureCapture,
  storedFailureCapture,
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
    const redact = ({ text }: { text: string }) => text;
    expect(await prepareFailureCapture(undefined, candidate, bounds)).toBe(
      undefined,
    );
    expect(
      await prepareFailureCapture({ enabled: false }, candidate, bounds),
    ).toBe(undefined);
    expect(
      await prepareFailureCapture(
        { enabled: true, redact },
        { source: 'raw_response', text: () => '' },
        bounds,
      ),
    ).toBe(undefined);
    expect(
      await prepareFailureCapture({ enabled: true, redact }, candidate, bounds),
    ).toMatchObject({
      status: 'captured',
      text: 'body',
      redacted: true,
      maxBytes: FAILURE_CAPTURE_DEFAULT_MAX_BYTES,
    });
  });
  it.each([
    'raw_response',
    'generated_output',
  ] as const)('does not materialize %s without a redactor', async (source) => {
    const text = vi.fn(() => 'confidential model output');
    const capture = await prepareFailureCapture(
      { enabled: true },
      { source, text },
      bounds,
    );
    expect(capture).toEqual({
      version: 1,
      source,
      status: 'redaction_failed',
      truncated: false,
      redacted: false,
      maxBytes: FAILURE_CAPTURE_DEFAULT_MAX_BYTES,
      capturedAt: now.toISOString(),
    });
    expect(text).not.toHaveBeenCalled();
  });
  it('rejects unredacted persisted capture text', () => {
    const capture = {
      version: 1,
      source: 'raw_response',
      status: 'captured',
      text: 'host-redacted output',
      truncated: false,
      redacted: true,
      maxBytes: 16384,
      capturedAt: now.toISOString(),
    };
    expect(storedFailureCapture(capture)).toEqual(capture);
    expect(
      storedFailureCapture({ ...capture, redacted: false }),
    ).toBeUndefined();
  });
  it.each([
    -1,
    0,
    1.5,
    65_537,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects persisted capture cap %s for either status', (maxBytes) => {
    const capture = {
      version: 1,
      source: 'generated_output',
      status: 'captured',
      text: 'x',
      truncated: false,
      redacted: true,
      maxBytes,
      capturedAt: now.toISOString(),
    };
    expect(storedFailureCapture(capture)).toBeUndefined();
    expect(
      storedFailureCapture({
        ...capture,
        status: 'redaction_failed',
        text: undefined,
      }),
    ).toBeUndefined();
  });
  it.each([
    ['ASCII', 'a', 1],
    ['three-byte character', '€', 3],
    ['four-byte character', '😀', 4],
    ['maximum cap', 'x'.repeat(65_536), 65_536],
  ] as const)('enforces the exact UTF-8 boundary for %s', (_name, text, maxBytes) => {
    const capture = {
      version: 1,
      source: 'generated_output',
      status: 'captured',
      text,
      truncated: false,
      redacted: true,
      maxBytes,
      capturedAt: now.toISOString(),
    };
    expect(storedFailureCapture(capture)).toEqual(capture);
    expect(
      storedFailureCapture({ ...capture, text: `${text}x` }),
    ).toBeUndefined();
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
        { enabled: true, redact },
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
