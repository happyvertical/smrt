/**
 * The package entry is the only path a consumer has: the exports map offers
 * `.`, `./svelte`, `./manifest` and `./manifest.json`, and nothing else. A
 * symbol that exists in `prompt-settings.ts` but is missing from `index.ts` is
 * therefore unreachable, and nothing else in the repo notices — the package
 * typechecks through relative imports, the suites import relative paths,
 * `verify:pack` validates the export *map* rather than named exports, and
 * `verify-manifest-exports.mjs` only resolves manifest objects.
 *
 * This suite pins the surface the README recipe tells consumers to import
 * (mirrors `packages/features/src/public-surface.test.ts`, #3052).
 */
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

describe('package entry', () => {
  it('exports every error the documented consumer recipe catches', () => {
    for (const name of [
      'UnknownPromptKeyError',
      'InvalidPromptScopeError',
      'PromptFieldNotEditableError',
      'PromptOverrideAuthorizationError',
    ]) {
      expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports the management surface the recipe builds on', () => {
    for (const name of [
      'PromptSettingsService',
      'PromptOverrideService',
      'PromptOverrideCollection',
      'definePrompt',
      'PromptRegistry',
      'resolvePrompt',
      'APP_PROMPT_SCOPE_ID',
    ]) {
      expect((entry as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('keeps the entry free of Svelte components', () => {
    // The root export must stay importable by a server-only consumer that has
    // no `svelte` installed; `svelte` is an optional peer dependency.
    expect(Object.keys(entry)).not.toContain('PromptSettingsPanel');
  });
});
