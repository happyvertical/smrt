import { describe, expect, it } from 'vitest';
import { SseParser } from './stream.ts';

const frame = (data: unknown, event = 'turn') =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('SseParser', () => {
  it('parses whole frames', () => {
    const p = new SseParser();
    expect(
      p.push(
        frame({ type: 'text', delta: 'Hi' }) +
          frame({ type: 'done', stop: 'complete' }),
      ),
    ).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'done', stop: 'complete' },
    ]);
  });

  it('waits for the rest of a frame split across chunks, even mid-line', () => {
    const p = new SseParser();
    const whole = frame({ type: 'text', delta: 'split me' });
    expect(p.push(whole.slice(0, 20))).toEqual([]);
    expect(p.push(whole.slice(20, 40))).toEqual([]);
    expect(p.push(whole.slice(40))).toEqual([
      { type: 'text', delta: 'split me' },
    ]);
  });

  it('handles CRLF, comments, other events, bad JSON and unknown types', () => {
    const p = new SseParser();
    const out = p.push(
      ': ping\n\n' +
        frame({ type: 'text', delta: 'x' }, 'shell') +
        'event: turn\ndata: {nope\n\n' +
        frame({ type: 'mystery' }) +
        frame({ type: 'text', delta: 'ok' }).replace(/\n/g, '\r\n'),
    );
    expect(out).toEqual([{ type: 'text', delta: 'ok' }]);
  });
});
