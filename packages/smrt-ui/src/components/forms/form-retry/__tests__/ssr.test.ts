/**
 * Off the browser (SSR), the helper must never share a key between requests:
 * no module-level memory, and not Node 25+'s process-wide `sessionStorage`
 * global either. The package's test setup needs jsdom, so SSR is simulated by
 * removing `window` — the signal the helper uses to tell it is off the browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormRetry } from '../controller.js';
import { readSubmissionKey } from '../submission-key.js';
import { memoryStorage } from './storage.js';

beforeEach(() => {
  vi.stubGlobal('window', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('form retry during SSR', () => {
  it('mints an unshared key per read, never from a process-wide store', () => {
    const processWide = memoryStorage();
    vi.stubGlobal('sessionStorage', processWide);
    const one = readSubmissionKey({ form: 'po' });
    const two = readSubmissionKey({ form: 'po' });
    expect(one).not.toBe(two);
    expect(processWide.store.size).toBe(0);
  });

  it('creates a controller that renders a key and restores nothing', () => {
    const retry = createFormRetry({ form: 'po', restore: { owner: 'u1' } });
    expect(retry.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry.restored).toBeNull();
    expect(retry.state).toMatchObject({
      status: 'idle',
      persistent: false,
      restored: false,
    });
    expect(createFormRetry({ form: 'po' }).token).not.toBe(retry.token);
  });
});
