import { describe, expect, it } from 'vitest';
import {
  ALL_KEYS,
  announcement,
  DEPENDS,
  keysFor,
  parseShellEvent,
  reconnectDelay,
  reduceKeys,
} from './events.ts';

describe('events', () => {
  it('parses the three event kinds and drops junk', () => {
    expect(
      parseShellEvent('{"type":"changed","version":4,"summary":"x"}'),
    ).toEqual({
      type: 'changed',
      version: 4,
      summary: 'x',
    });
    expect(parseShellEvent('{"type":"records","model":null}')).toEqual({
      type: 'records',
      model: null,
    });
    expect(
      parseShellEvent(
        '{"type":"approval","id":"a","status":"denied","summary":"s"}',
      ),
    ).toMatchObject({ type: 'approval', status: 'denied' });
    expect(parseShellEvent('not json')).toBeNull();
    expect(parseShellEvent('{"type":"other"}')).toBeNull();
    expect(parseShellEvent('{"type":"approval"}')).toBeNull();
  });

  it('maps events to what must reload', () => {
    expect(keysFor({ type: 'records', model: 'A' })).toEqual([DEPENDS.records]);
    expect(
      keysFor({ type: 'approval', id: 'a', status: 'pending', summary: '' }),
    ).toEqual([DEPENDS.shell, DEPENDS.approvals]);
    expect(
      new Set(keysFor({ type: 'changed', version: 1, summary: '' })),
    ).toEqual(new Set(ALL_KEYS));
  });

  it('folds a burst into one set', () => {
    let s = new Set<(typeof ALL_KEYS)[number]>();
    s = reduceKeys(s, { type: 'records', model: 'A' });
    s = reduceKeys(s, { type: 'records', model: 'B' });
    expect(s.size).toBe(1);
    s = reduceKeys(s, {
      type: 'approval',
      id: 'a',
      status: 'approved',
      summary: '',
    });
    expect(s).toEqual(
      new Set([DEPENDS.records, DEPENDS.shell, DEPENDS.approvals]),
    );
  });

  it('announces definition and approval changes only', () => {
    expect(announcement({ type: 'records', model: null })).toBeNull();
    expect(
      announcement({
        type: 'approval',
        id: 'a',
        status: 'pending',
        summary: 'add x',
      }),
    ).toBe('Needs approval: add x');
    expect(
      announcement({ type: 'changed', version: 2, summary: 'add x' }),
    ).toBe('App changed: add x');
  });

  it('backs off with jitter and a cap', () => {
    const low = () => 0;
    const high = () => 0.999;
    expect(reconnectDelay(0, low)).toBe(500);
    expect(reconnectDelay(0, high)).toBeLessThanOrEqual(1000);
    expect(reconnectDelay(2, low)).toBe(2000);
    expect(reconnectDelay(20, high)).toBeLessThanOrEqual(30_000);
    expect(reconnectDelay(20, low)).toBe(15_000);
  });
});
