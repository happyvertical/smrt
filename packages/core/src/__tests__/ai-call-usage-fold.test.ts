/**
 * The fold that decides what a tracked call is charged (#5516, plan section
 * 3.3; test contract T9, T20): one pure function the handle runs in memory
 * and the ledger runs on the call's reservation. Parts are identified by the
 * producer; the amount is the sum of the distinct parts, final once the last
 * part is known and every part has counts. A client that does not identify
 * parts is billed in single mode.
 */

import { describe, expect, it } from 'vitest';
import {
  type CallUsageState,
  callUsageAmount,
  emptyCallUsage,
  foldCallUsage,
  parseUsagePart,
} from '../system/ai-call-ledger';

const counted = (total: number, prompt = Math.floor(total / 2)) => ({
  promptTokens: prompt,
  completionTokens: total - prompt,
  totalTokens: total,
});

function partsFold(
  inputs: Array<{
    index: number;
    last?: true;
    usage?: ReturnType<typeof counted>;
    call?: string;
    model?: string;
  }>,
  state: CallUsageState = emptyCallUsage('parts'),
) {
  const refused: string[] = [];
  let current = state;
  for (const input of inputs) {
    const result = foldCallUsage(current, {
      kind: 'part',
      part: {
        call: input.call ?? 'sdk-1',
        index: input.index,
        ...(input.last ? { last: true as const } : {}),
      },
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.model ? { model: input.model, provider: 'openai' } : {}),
    });
    if (result.refused) refused.push(result.refused);
    current = result.state;
  }
  return { state: current, refused };
}

const amount = (state: CallUsageState, reservedTokens = 100) =>
  callUsageAmount(state, { reservedTokens, rate: { input: 1, output: 2 } });

describe('foldCallUsage: parts mode (T20)', () => {
  it('bills the sum of two parts, complete once the last part is known', () => {
    const { state } = partsFold([
      { index: 0, usage: counted(10) },
      { index: 1, last: true, usage: counted(5) },
    ]);
    expect(amount(state)).toMatchObject({
      source: 'complete',
      tokens: 15,
      totalTokens: 15,
    });
  });

  it('a part without its last mark stays "parts" and can only grow', () => {
    const { state } = partsFold([{ index: 0, usage: counted(10) }]);
    expect(amount(state)).toMatchObject({ source: 'parts', tokens: 10 });
    const more = partsFold([{ index: 1, usage: counted(4) }], state).state;
    expect(amount(more)).toMatchObject({ source: 'parts', tokens: 14 });
  });

  it('two parts identical in every field but index are both billed', () => {
    const { state } = partsFold([
      { index: 0, usage: counted(7) },
      { index: 1, last: true, usage: counted(7) },
    ]);
    expect(amount(state).tokens).toBe(14);
  });

  it('a repeated part is not added again and reports no change', () => {
    const { state } = partsFold([{ index: 0, usage: counted(7) }]);
    const again = foldCallUsage(state, {
      kind: 'part',
      part: { call: 'sdk-1', index: 0 },
      usage: counted(7),
    });
    expect(again.changed).toBe(false);
    expect(amount(again.state).tokens).toBe(7);
  });

  it('a count-less part then its counts: counted wins once and keeps last', () => {
    const first = partsFold([{ index: 0, last: true }]).state;
    expect(amount(first)).toMatchObject({
      source: 'provisional',
      tokens: 100,
      totalTokens: null,
    });
    const promoted = partsFold([{ index: 0, usage: counted(9) }], first).state;
    expect(amount(promoted)).toMatchObject({ source: 'complete', tokens: 9 });
    const replay = foldCallUsage(promoted, {
      kind: 'part',
      part: { call: 'sdk-1', index: 0 },
      usage: counted(30),
    });
    expect(replay.changed).toBe(false);
    expect(amount(replay.state).tokens).toBe(9);
  });

  it('counted then count-less gives the same ledger as the other order', () => {
    const a = partsFold([
      { index: 0, last: true },
      { index: 0, usage: counted(9) },
    ]).state;
    const b = partsFold([
      { index: 0, last: true, usage: counted(9) },
      { index: 0 },
    ]).state;
    expect(amount(a)).toEqual(amount(b));
  });

  it('seventy parts are all billed and the state stays small', () => {
    const inputs = Array.from({ length: 70 }, (_, index) => ({
      index,
      ...(index === 69 ? { last: true as const } : {}),
      usage: counted(2),
    }));
    const { state } = partsFold(inputs);
    expect(amount(state)).toMatchObject({ source: 'complete', tokens: 140 });
    expect(state.counted).toEqual([[0, 69]]);
    expect(JSON.stringify(state).length).toBeLessThan(400);
  });

  it('refuses an index past a known last, a second different last, another call', () => {
    const base = partsFold([{ index: 1, last: true, usage: counted(3) }]).state;
    const { refused } = partsFold(
      [
        { index: 2, usage: counted(3) },
        { index: 0, last: true, usage: counted(3) },
        { index: 0, call: 'sdk-2', usage: counted(3) },
      ],
      base,
    );
    expect(refused).toEqual(['beyond_last', 'last_conflict', 'other_call']);
  });

  it('refuses more than 32 separate gaps', () => {
    const inputs = Array.from({ length: 34 }, (_, i) => ({
      index: i * 2,
      usage: counted(1),
    }));
    const { refused, state } = partsFold(inputs);
    expect(refused).toEqual(['gaps']);
    expect(amount(state).tokens).toBe(33);
  });

  it("model and provider are the highest reporting index's", () => {
    const { state } = partsFold([
      { index: 1, usage: counted(1), model: 'second' },
      { index: 0, usage: counted(1), model: 'first' },
    ]);
    expect(amount(state).model).toBe('second');
  });

  it('a response usageParts list folds like its parts', () => {
    const result = foldCallUsage(emptyCallUsage('parts'), {
      kind: 'parts',
      call: 'sdk-1',
      complete: true,
      parts: [
        { index: 0, usage: counted(4) },
        { index: 1, last: true, usage: counted(6) },
      ],
    });
    expect(amount(result.state)).toMatchObject({
      source: 'complete',
      tokens: 10,
    });
  });

  it('a counted zero-token last part is complete at zero', () => {
    const { state } = partsFold([{ index: 0, last: true, usage: counted(0) }]);
    expect(amount(state)).toMatchObject({ source: 'complete', tokens: 0 });
  });

  it('no part at all is a fallback charge of the reservation', () => {
    expect(amount(emptyCallUsage('parts'))).toMatchObject({
      source: 'fallback',
      tokens: 100,
      totalTokens: null,
    });
  });
});

describe('foldCallUsage: price from the reservation rate', () => {
  it('cost is prompt times input plus completion times output per 1K', () => {
    const { state } = partsFold([
      { index: 0, last: true, usage: counted(1000, 400) },
    ]);
    // 400 * 1 + 600 * 2 per 1K = 1.6
    expect(amount(state).cost).toBeCloseTo(1.6, 12);
  });

  it('a call reserved without a rate is uncosted', () => {
    const { state } = partsFold([{ index: 0, last: true, usage: counted(10) }]);
    expect(
      callUsageAmount(state, { reservedTokens: 10, rate: null }).cost,
    ).toBeNull();
  });

  it("an event's own estimatedCost is never an input", () => {
    const result = foldCallUsage(emptyCallUsage('parts'), {
      kind: 'part',
      part: { call: 'sdk-1', index: 0, last: true },
      usage: counted(1000, 400),
      estimatedCost: 999,
    } as never);
    expect(amount(result.state).cost).toBeCloseTo(1.6, 12);
  });
});

describe('foldCallUsage: single mode', () => {
  it('counts stated at closing come before a captured event', () => {
    let state = emptyCallUsage('single');
    state = foldCallUsage(state, { kind: 'event', usage: counted(7) }).state;
    state = foldCallUsage(state, { kind: 'stated', usage: counted(12) }).state;
    expect(amount(state)).toMatchObject({ source: 'response', tokens: 12 });
  });

  it('the last counted event wins without a stated amount', () => {
    let state = emptyCallUsage('single');
    state = foldCallUsage(state, { kind: 'event', usage: counted(10) }).state;
    state = foldCallUsage(state, { kind: 'event', usage: counted(15) }).state;
    state = foldCallUsage(state, { kind: 'event' }).state;
    expect(amount(state)).toMatchObject({ source: 'event', tokens: 15 });
  });

  it('a stated estimatedCost is the cost', () => {
    let state = emptyCallUsage('single');
    state = foldCallUsage(state, {
      kind: 'stated',
      usage: counted(10),
      estimatedCost: 0.25,
    }).state;
    expect(amount(state).cost).toBe(0.25);
  });

  it('only count-less events: provisional', () => {
    const state = foldCallUsage(emptyCallUsage('single'), {
      kind: 'event',
    }).state;
    expect(amount(state).source).toBe('provisional');
  });

  it('a part input is refused in single mode', () => {
    const result = foldCallUsage(emptyCallUsage('single'), {
      kind: 'part',
      part: { call: 'sdk-1', index: 0 },
      usage: counted(1),
    });
    expect(result.refused).toBe('no_part');
  });
});

describe('foldCallUsage: malformed and overflowing input (T9)', () => {
  it.each([
    ['negative', { promptTokens: -1, completionTokens: 1, totalTokens: 0 }],
    ['NaN', { promptTokens: Number.NaN, completionTokens: 1, totalTokens: 1 }],
    ['infinite', { totalTokens: Number.POSITIVE_INFINITY }],
    ['unsafe', { totalTokens: Number.MAX_SAFE_INTEGER + 2 }],
  ])('refuses %s counts and stays correctable', (_name, usage) => {
    const bad = foldCallUsage(emptyCallUsage('parts'), {
      kind: 'part',
      part: { call: 'sdk-1', index: 0 },
      usage: usage as never,
    });
    expect(bad.refused).toBe('malformed');
    expect(bad.changed).toBe(false);
    const good = foldCallUsage(bad.state, {
      kind: 'part',
      part: { call: 'sdk-1', index: 0, last: true },
      usage: counted(5),
    });
    expect(amount(good.state)).toMatchObject({ source: 'complete', tokens: 5 });
  });

  it('two safe parts whose sum is not safe: the second is refused as overflow', () => {
    const big = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 10;
    const { state, refused } = partsFold([
      {
        index: 0,
        usage: { promptTokens: big, completionTokens: 0, totalTokens: big },
      },
      {
        index: 1,
        usage: { promptTokens: big, completionTokens: 0, totalTokens: big },
      },
    ]);
    expect(refused).toEqual(['overflow']);
    expect(amount(state).tokens).toBe(big);
  });

  it.each([
    ['missing', undefined, undefined],
    ['not an object', 'p', null],
    ['no call', { index: 0 }, null],
    ['negative index', { call: 'c', index: -1 }, null],
    ['fractional index', { call: 'c', index: 1.5 }, null],
    ['last not true', { call: 'c', index: 0, last: false }, null],
  ])('parseUsagePart: %s', (_name, raw, expected) => {
    expect(parseUsagePart(raw)).toBe(expected);
  });

  it('parseUsagePart keeps a well-formed part', () => {
    expect(parseUsagePart({ call: 'c', index: 3, last: true })).toEqual({
      call: 'c',
      index: 3,
      last: true,
    });
  });
});
