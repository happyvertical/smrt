import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCssTime, tokenDuration } from '../admin-shell/motion.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function stubReduced(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
  }));
  window.matchMedia = globalThis.matchMedia;
}

describe('parseCssTime', () => {
  it('reads ms and s, and is zero for anything else', () => {
    expect(parseCssTime('200ms')).toBe(200);
    expect(parseCssTime(' 0.25s ')).toBe(250);
    expect(parseCssTime('')).toBe(0);
    expect(parseCssTime('fast')).toBe(0);
    expect(parseCssTime('-5ms')).toBe(0);
  });
});

describe('tokenDuration', () => {
  it('reads the token off the element in milliseconds', () => {
    stubReduced(false);
    const el = document.createElement('div');
    el.style.setProperty('--smrt-duration-short4', '200ms');
    el.style.setProperty('--smrt-duration-medium1', '0.25s');
    document.body.append(el);
    expect(tokenDuration('--smrt-duration-short4', el)).toBe(200);
    expect(tokenDuration('--smrt-duration-medium1', el)).toBe(250);
  });

  it('is 0 for a missing token and under reduced motion', () => {
    stubReduced(false);
    const el = document.createElement('div');
    document.body.append(el);
    expect(tokenDuration('--smrt-duration-nope', el)).toBe(0);
    el.style.setProperty('--smrt-duration-short4', '200ms');
    stubReduced(true);
    expect(tokenDuration('--smrt-duration-short4', el)).toBe(0);
  });
});
