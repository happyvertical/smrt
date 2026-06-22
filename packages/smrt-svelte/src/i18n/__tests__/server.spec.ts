/**
 * Integration coverage for the server snapshot builder (S13 #1418): it seeds the
 * languages registry from smrt-svelte's English defaults and resolves them into
 * a template dictionary the client renders synchronously. Exercises the real
 * `@happyvertical/smrt-languages` resolver (no DB → code-default layer only).
 *
 * `server.ts` imports the languages package root, whose `__smrt-register__`
 * manifest side-effect throws under vitest's source-alias (it resolves
 * `manifest.json` via the dev-server URL, not a file). That manifest is the
 * ObjectRegistry's, unrelated to string resolution (which uses the separate
 * LanguageRegistry), so we record-not-throw via SMRT_STRICT_REGISTRY=false set
 * before a dynamic import of the module under test.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let buildI18nSnapshot: typeof import('../server.js').buildI18nSnapshot;
let defineMessages: typeof import('@happyvertical/smrt-ui/i18n').defineMessages;
let clearRegisteredMessages: typeof import('@happyvertical/smrt-ui/i18n').clearRegisteredMessages;

beforeAll(async () => {
  vi.stubEnv('SMRT_STRICT_REGISTRY', 'false');
  ({ buildI18nSnapshot } = await import('../server.js'));
  ({ defineMessages, clearRegisteredMessages } = await import(
    '@happyvertical/smrt-ui/i18n'
  ));
});

afterEach(() => {
  clearRegisteredMessages();
});

describe('buildI18nSnapshot', () => {
  it('resolves registered English defaults into a template dictionary', async () => {
    defineMessages({
      'ui.snapshot_test.empty': 'No data available',
      'ui.snapshot_test.range': 'Showing {count} of {total}',
    });

    const snapshot = await buildI18nSnapshot({ locale: 'en' });

    expect(snapshot.locale).toBe('en');
    expect(snapshot.messages['ui.snapshot_test.empty']).toBe(
      'No data available',
    );
    // Templates are shipped un-rendered; the client interpolates at call time.
    expect(snapshot.messages['ui.snapshot_test.range']).toBe(
      'Showing {count} of {total}',
    );
  });

  it('honors an explicit key subset', async () => {
    defineMessages({
      'ui.snapshot_test.a': 'Alpha',
      'ui.snapshot_test.b': 'Beta',
    });

    const snapshot = await buildI18nSnapshot({
      locale: 'en',
      keys: ['ui.snapshot_test.a'],
    });

    expect(snapshot.messages['ui.snapshot_test.a']).toBe('Alpha');
    expect(snapshot.messages['ui.snapshot_test.b']).toBeUndefined();
  });
});
