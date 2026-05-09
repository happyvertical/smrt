import { describe, expect, it } from 'vitest';
import {
  buildLocaleFallbackChain,
  buildTranslationJobId,
  computeSourceHash,
  normalizeLocale,
  renderTemplate,
} from './utils.js';

describe('utils', () => {
  describe('normalizeLocale', () => {
    it('lowercases language and uppercases region', () => {
      expect(normalizeLocale('EN')).toBe('en');
      expect(normalizeLocale('en-us')).toBe('en-US');
      expect(normalizeLocale('Fr-Ca')).toBe('fr-CA');
    });

    it('preserves bare language tags', () => {
      expect(normalizeLocale('es')).toBe('es');
    });

    it('returns empty string for empty input', () => {
      expect(normalizeLocale('')).toBe('');
      expect(normalizeLocale('   ')).toBe('');
    });
  });

  describe('buildLocaleFallbackChain', () => {
    it('walks region down to language down to default', () => {
      expect(buildLocaleFallbackChain('fr-CA', 'en')).toEqual([
        'fr-CA',
        'fr',
        'en',
      ]);
    });

    it('drops duplicates when default equals requested', () => {
      expect(buildLocaleFallbackChain('en', 'en')).toEqual(['en']);
    });

    it('handles three-segment tags', () => {
      // Behavior: each `-` strip is one segment.
      expect(buildLocaleFallbackChain('zh-Hans-CN', 'en')).toEqual([
        'zh-HANS-CN',
        'zh-HANS',
        'zh',
        'en',
      ]);
    });

    it('returns just the default when no requested locale', () => {
      expect(buildLocaleFallbackChain('', 'en')).toEqual(['en']);
    });
  });

  describe('renderTemplate', () => {
    it('substitutes {var} placeholders', () => {
      expect(renderTemplate('Hello {name}', { name: 'Will' })).toBe(
        'Hello Will',
      );
    });

    it('treats missing variables as empty strings when other vars are passed', () => {
      // The fast-path returns the template unchanged when the variable bag is
      // empty — callers that pass at least one var still get every placeholder
      // expanded, with missing ones collapsed to ''.
      expect(renderTemplate('Hello {name} ({title})', { title: 'Mx.' })).toBe(
        'Hello  (Mx.)',
      );
    });

    it('returns the template untouched when no variables are passed', () => {
      expect(renderTemplate('Hello {name}', {})).toBe('Hello {name}');
      expect(renderTemplate('Hello {name}')).toBe('Hello {name}');
    });

    it('serializes objects and arrays as JSON', () => {
      expect(renderTemplate('{x}', { x: { a: 1 } })).toBe('{"a":1}');
      expect(renderTemplate('{x}', { x: [1, 2] })).toBe('[1,2]');
    });

    it('renders Date as ISO string', () => {
      const date = new Date('2026-05-09T00:00:00.000Z');
      expect(renderTemplate('{when}', { when: date })).toBe(
        '2026-05-09T00:00:00.000Z',
      );
    });
  });

  describe('computeSourceHash', () => {
    it('is deterministic', () => {
      expect(computeSourceHash('hello')).toBe(computeSourceHash('hello'));
    });

    it('changes when input changes', () => {
      expect(computeSourceHash('hello')).not.toBe(computeSourceHash('hello!'));
    });
  });

  describe('buildTranslationJobId', () => {
    it('is a deterministic string keyed by (key, locale)', () => {
      expect(buildTranslationJobId('users.role.member', 'es')).toBe(
        'smrt-languages.translate:users.role.member:es',
      );
      expect(buildTranslationJobId('users.role.member', 'ES')).toBe(
        'smrt-languages.translate:users.role.member:es',
      );
    });
  });
});
