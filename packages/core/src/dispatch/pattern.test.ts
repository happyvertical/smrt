/**
 * Dispatch pattern compiler (P6 T22): `matches()` and the SQL forms come from
 * one compiler and select identical sets on every adapter, including
 * embedded, repeated and leading stars, case and SQL metacharacters.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  dispatchTestEngines,
  openDispatchTestDatabase,
  PATTERN_PROBE_PATTERNS,
  PATTERN_PROBE_TYPES,
  patternSqlMismatches,
} from '../__tests__/fixtures/dispatch-test-db';
import { DispatchSubscription } from './models/DispatchSubscription.js';
import {
  compileDispatchPattern,
  dispatchPatternSql,
  matchesDispatchPattern,
} from './pattern.js';

describe('compileDispatchPattern', () => {
  it('compiled SQL and matches() agree on embedded, repeated and leading stars, case and metachars', () => {
    const matching = (pattern: string) =>
      PATTERN_PROBE_TYPES.filter((t) => matchesDispatchPattern(pattern, t));
    expect(matching('invoice.v*')).toEqual(['invoice.v2']);
    expect(matching('a*b.c')).toEqual(['axb.c', 'axxb.c']);
    expect(matching('campaign.*')).toEqual(['campaign.started', 'campaign.X']);
    expect(matching('campaign.*.completed')).toEqual([
      'campaign.summer.completed',
    ]);
    expect(matching('*.done')).toEqual(['job.done']);
    expect(matching('x.y')).toEqual(['x.y']);
    expect(matching('weird%_\\.*')).toEqual(['weird%_\\.z']);
    expect(matching('g[l]ob?.*')).toEqual(['g[l]ob?.q']);
    expect(matching('pct.%')).toEqual(['pct.%']);
    expect(matching('under_score.*')).toEqual(['under_score.a']);
    expect(matchesDispatchPattern('**', 'ab')).toBe(true);
    expect(matchesDispatchPattern('**', 'a')).toBe(false);
    expect(matchesDispatchPattern('*', 'a.b')).toBe(false);
    expect(matchesDispatchPattern('*', 'multi\nline')).toBe(true);
  });

  it('keeps DispatchSubscription.matches() on the compiled pattern', () => {
    for (const pattern of PATTERN_PROBE_PATTERNS) {
      const subscription = new DispatchSubscription({ signal_type: pattern });
      for (const type of PATTERN_PROBE_TYPES) {
        expect(
          subscription.matches(type),
          `${JSON.stringify(pattern)} vs ${JSON.stringify(type)}`,
        ).toBe(matchesDispatchPattern(pattern, type));
      }
    }
    const disabled = new DispatchSubscription({
      signal_type: 'x.y',
      enabled: 0,
    });
    expect(disabled.matches('x.y')).toBe(false);
  });

  it('uses an exact predicate for literal patterns', () => {
    expect(compileDispatchPattern('x.y').exact).toBe('x.y');
    expect(compileDispatchPattern('x.*').exact).toBeUndefined();
    const params: unknown[] = [];
    const sql = dispatchPatternSql('x.y', 'glob', 'type', (v) => {
      params.push(v);
      return `$${params.length}`;
    });
    expect(sql).toBe('type = $1');
    expect(params).toEqual(['x.y']);
  });
});

describe.each(dispatchTestEngines)('dispatch pattern SQL on %s', (engine) => {
  let ctx: DispatchTestDatabase;

  beforeAll(async () => {
    ctx = await openDispatchTestDatabase(engine as 'sqlite');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('compiled SQL and matches() agree on embedded, repeated and leading stars, case and metachars', async () => {
    expect(await patternSqlMismatches(ctx.db, engine)).toEqual([]);
  });
});
