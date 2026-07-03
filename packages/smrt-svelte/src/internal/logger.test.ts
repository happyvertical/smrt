/**
 * Regression coverage for the "process is not defined" hydration killer.
 *
 * `internal/logger` is browser-reachable through Provider and the form
 * components, and `@happyvertical/logger`'s `createLogger()` eagerly reads
 * `process.env` (HAVE_LOGGER_LEVEL). Constructing the logger at module scope
 * therefore threw during Vite dev pre-bundle evaluation in browsers and killed
 * client-side hydration for every consuming app.
 *
 * vite-node's module runner itself needs `process.platform` to load inline
 * modules, so the test cannot delete `process` outright the way a real browser
 * lacks it. Stubbing it to an object without a usable `env` reproduces the
 * same failure mode: the pre-fix module init still blows up at import time
 * (`Object.keys(process.env)`), and the fixed guard must route to the plain
 * console logger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('internal/logger', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('imports and logs without a usable process.env (browser)', async () => {
    vi.stubGlobal('process', {});

    const { logger } = await import('./logger.js');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('mic permission denied');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('mic permission denied');
  });

  it('filters below the warn level in the browser fallback', async () => {
    vi.stubGlobal('process', {});

    const { logger } = await import('./logger.js');

    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.debug('below threshold');
    logger.info('below threshold');
    logger.error('stt init failed');

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('logs through the env-aware logger when process exists (node/SSR)', async () => {
    const { logger } = await import('./logger.js');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('stt init failed', { adapter: 'whisper-cpp' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('stt init failed');
  });
});
