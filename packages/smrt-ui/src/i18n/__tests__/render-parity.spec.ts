/**
 * Pins the client's inlined `renderTemplate` (src/i18n/render.ts) against the
 * canonical `@happyvertical/smrt-languages` implementation so the two
 * interpolation contracts never drift (S13 #1418). The client keeps its own
 * copy to avoid bundling the heavy languages package; this test is the guard.
 *
 * Importing the languages root triggers its `__smrt-register__` manifest
 * side-effect, which throws under vitest's source-alias (dev-server URL, not a
 * file) — unrelated to the pure `renderTemplate`. Record-not-throw via
 * SMRT_STRICT_REGISTRY=false set before a dynamic import.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderTemplate as clientRender } from '../render.js';

let languagesRender: (
  template: string,
  vars?: Record<string, unknown>,
) => string;

beforeAll(async () => {
  vi.stubEnv('SMRT_STRICT_REGISTRY', 'false');
  ({ renderTemplate: languagesRender } = await import(
    '@happyvertical/smrt-languages'
  ));
});

const NOW = new Date('2026-06-17T12:00:00.000Z');

const cases: Array<[string, Record<string, unknown> | undefined]> = [
  ['No interpolation here', undefined],
  ['No interpolation here', {}],
  ['Showing {count} of {total}', { count: 3, total: 9 }],
  ['Hi {name}{title}', { name: 'Ada' }], // missing → empty
  ['Null is {x} here', { x: null }],
  ['Date: {when}', { when: NOW }],
  ['List: {items}', { items: [1, 2, 3] }],
  ['Obj: {meta}', { meta: { a: 1 } }],
  ['Trim {  spaced  } key', { spaced: 'ok' }],
  ['Number {n}', { n: 0 }],
  ['Bool {b}', { b: false }],
];

describe('renderTemplate parity with @happyvertical/smrt-languages', () => {
  it.each(cases)('renders %j identically', (template, vars) => {
    expect(clientRender(template, vars)).toBe(languagesRender(template, vars));
  });
});
