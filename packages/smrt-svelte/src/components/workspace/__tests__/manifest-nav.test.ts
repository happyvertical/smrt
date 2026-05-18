/**
 * Tests for `navTreeFromManifest` — the pure manifest → NavSection[]
 * adapter. The helper has no Svelte runtime, no SSR coupling, and no
 * SvelteKit imports, so these are vanilla data-in / data-out tests.
 *
 * Brief: happyvertical/smrt#1248 (parent epic #1245). Covers empty
 * manifest, full pass-through, filtered subset, sectionHints application,
 * deterministic ordering, missing api/collection fallback, and the optional
 * `@smrt({ ui: { icon, label } })` decorator field.
 */

import { describe, expect, it } from 'vitest';
import {
  navTreeFromManifest,
  pluralizeClassName,
  type SmrtManifestLike,
} from '../manifest-nav.js';

// ────────────────────────────────────────────────────────────────────────
// Test fixtures — hand-built manifests that mimic the shape produced by
// `ManifestBuilder.generate()`. Keep these small and focused; building a
// realistic-looking manifest from one of the consumer packages would
// drag a workspace dependency in.
// ────────────────────────────────────────────────────────────────────────

const EMPTY_MANIFEST: SmrtManifestLike = { objects: {} };

const TWO_PACKAGE_MANIFEST: SmrtManifestLike = {
  objects: {
    '@happyvertical/smrt-content:Article': {
      qualifiedName: '@happyvertical/smrt-content:Article',
      className: 'Article',
      packageName: '@happyvertical/smrt-content',
      collection: 'articles',
      extends: 'SmrtObject',
      decoratorConfig: {},
    },
    '@happyvertical/smrt-content:Document': {
      qualifiedName: '@happyvertical/smrt-content:Document',
      className: 'Document',
      packageName: '@happyvertical/smrt-content',
      collection: 'documents',
      extends: 'SmrtObject',
      decoratorConfig: {},
    },
    '@happyvertical/smrt-content:ArticleCollection': {
      qualifiedName: '@happyvertical/smrt-content:ArticleCollection',
      className: 'ArticleCollection',
      packageName: '@happyvertical/smrt-content',
      collection: 'articles',
      extends: 'SmrtCollection',
      decoratorConfig: {},
    },
    '@happyvertical/smrt-commerce:Invoice': {
      qualifiedName: '@happyvertical/smrt-commerce:Invoice',
      className: 'Invoice',
      packageName: '@happyvertical/smrt-commerce',
      collection: 'invoices',
      extends: 'SmrtObject',
      decoratorConfig: {},
    },
    '@happyvertical/smrt-commerce:Customer': {
      qualifiedName: '@happyvertical/smrt-commerce:Customer',
      className: 'Customer',
      packageName: '@happyvertical/smrt-commerce',
      collection: 'customers',
      extends: 'SmrtObject',
      decoratorConfig: {},
    },
  },
};

describe('navTreeFromManifest', () => {
  it('returns an empty array for an empty manifest', () => {
    expect(navTreeFromManifest(EMPTY_MANIFEST)).toEqual([]);
  });

  it('returns an empty array when permittedResources filters out everything', () => {
    expect(
      navTreeFromManifest(TWO_PACKAGE_MANIFEST, {
        permittedResources: ['@some/other-package:Foo'],
      }),
    ).toEqual([]);
  });

  it('emits one section per package with all SmrtObjects when permittedResources is omitted', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST);
    expect(result.map((s) => s.label)).toEqual([
      'smrt-commerce',
      'smrt-content',
    ]);
    expect(result[0].children?.map((c) => c.label)).toEqual([
      'Customers',
      'Invoices',
    ]);
    expect(result[1].children?.map((c) => c.label)).toEqual([
      'Articles',
      'Documents',
    ]);
  });

  it('drops collection classes (extends SmrtCollection or *Collection suffix)', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST);
    const allItemLabels = result.flatMap(
      (s) => s.children?.map((c) => c.label) ?? [],
    );
    // No `ArticleCollection` should appear anywhere.
    expect(allItemLabels).not.toContain('ArticleCollections');
    expect(allItemLabels).not.toContain('Articlecollections');
  });

  it('honours permittedResources by qualified class name', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST, {
      permittedResources: [
        '@happyvertical/smrt-content:Article',
        '@happyvertical/smrt-commerce:Invoice',
      ],
    });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.label)).toEqual([
      'smrt-commerce',
      'smrt-content',
    ]);
    expect(
      result.flatMap((s) => s.children?.map((c) => c.label) ?? []),
    ).toEqual(['Invoices', 'Articles']);
  });

  it('applies sectionHints to override the default section title', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST, {
      sectionHints: {
        '@happyvertical/smrt-content': 'Content',
        '@happyvertical/smrt-commerce': 'Commerce',
      },
    });
    expect(result.map((s) => s.label)).toEqual(['Commerce', 'Content']);
  });

  it('groups multiple packages under a single section when a sectionHint catches both', () => {
    const manifest: SmrtManifestLike = {
      objects: {
        '@happyvertical/smrt-content:Article': {
          qualifiedName: '@happyvertical/smrt-content:Article',
          className: 'Article',
          packageName: '@happyvertical/smrt-content',
          collection: 'articles',
          decoratorConfig: {},
        },
        '@happyvertical/smrt-messages:Email': {
          qualifiedName: '@happyvertical/smrt-messages:Email',
          className: 'Email',
          packageName: '@happyvertical/smrt-messages',
          collection: 'emails',
          decoratorConfig: {},
        },
      },
    };
    const result = navTreeFromManifest(manifest, {
      sectionHints: {
        // Catch both content + messages with the @happyvertical org prefix.
        '@happyvertical/': 'Content & Messaging',
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Content & Messaging');
    expect(result[0].children?.map((c) => c.label)).toEqual([
      'Articles',
      'Emails',
    ]);
  });

  it('produces deterministic ordering (sorted by label) regardless of input order', () => {
    // Build the same manifest twice, with reversed key insertion order.
    const a: SmrtManifestLike = {
      objects: {
        'pkg:Banana': {
          qualifiedName: 'pkg:Banana',
          className: 'Banana',
          packageName: 'pkg',
          collection: 'bananas',
          decoratorConfig: {},
        },
        'pkg:Apple': {
          qualifiedName: 'pkg:Apple',
          className: 'Apple',
          packageName: 'pkg',
          collection: 'apples',
          decoratorConfig: {},
        },
      },
    };
    const b: SmrtManifestLike = {
      objects: {
        'pkg:Apple': a.objects['pkg:Apple'],
        'pkg:Banana': a.objects['pkg:Banana'],
      },
    };
    const fromA = navTreeFromManifest(a);
    const fromB = navTreeFromManifest(b);
    expect(fromA).toEqual(fromB);
    expect(fromA[0].children?.map((c) => c.label)).toEqual([
      'Apples',
      'Bananas',
    ]);
  });

  it('uses /api/v1/{collection} as the default href for an entry', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST, {
      permittedResources: ['@happyvertical/smrt-content:Article'],
    });
    expect(result[0].children?.[0].href).toBe('/api/v1/articles');
  });

  it('falls back to a kebab-cased class slug when collection is missing', () => {
    const manifest: SmrtManifestLike = {
      objects: {
        'pkg:OrderLine': {
          qualifiedName: 'pkg:OrderLine',
          className: 'OrderLine',
          packageName: 'pkg',
          // collection intentionally omitted
          decoratorConfig: {},
        },
      },
    };
    const result = navTreeFromManifest(manifest, { basePath: '' });
    expect(result[0].children?.[0].href).toBe('/order-line');
  });

  it('honours a custom basePath (e.g. "" for unprefixed hrefs)', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST, {
      basePath: '',
      permittedResources: ['@happyvertical/smrt-content:Article'],
    });
    expect(result[0].children?.[0].href).toBe('/articles');
  });

  it('passes the ui.icon decorator field through to NavItem.icon', () => {
    const manifest: SmrtManifestLike = {
      objects: {
        'pkg:Article': {
          qualifiedName: 'pkg:Article',
          className: 'Article',
          packageName: 'pkg',
          collection: 'articles',
          decoratorConfig: { ui: { icon: 'newspaper' } },
        },
      },
    };
    const result = navTreeFromManifest(manifest);
    expect(result[0].children?.[0].icon).toBe('newspaper');
  });

  it('uses ui.label to override the auto-pluralised label', () => {
    const manifest: SmrtManifestLike = {
      objects: {
        'pkg:Person': {
          qualifiedName: 'pkg:Person',
          className: 'Person',
          packageName: 'pkg',
          collection: 'people',
          // Use a custom label rather than relying on the simple pluralizer
          // (which would emit "Persons").
          decoratorConfig: { ui: { label: 'People' } },
        },
      },
    };
    const result = navTreeFromManifest(manifest);
    expect(result[0].children?.[0].label).toBe('People');
  });

  it('omits NavItem.icon when ui.icon is absent (no empty-string leakage)', () => {
    const result = navTreeFromManifest(TWO_PACKAGE_MANIFEST, {
      permittedResources: ['@happyvertical/smrt-content:Article'],
    });
    expect(result[0].children?.[0]).not.toHaveProperty('icon');
  });

  it('falls back to packageName-based section title when no hint matches', () => {
    const manifest: SmrtManifestLike = {
      objects: {
        '@acme/widgets:Sprocket': {
          qualifiedName: '@acme/widgets:Sprocket',
          className: 'Sprocket',
          packageName: '@acme/widgets',
          collection: 'sprockets',
          decoratorConfig: {},
        },
      },
    };
    const result = navTreeFromManifest(manifest, {
      sectionHints: { '@nonmatching/foo': 'Foo' },
    });
    expect(result[0].label).toBe('widgets');
  });

  it('matches sectionHints by substring (first match wins)', () => {
    const manifest: SmrtManifestLike = {
      objects: {
        '@happyvertical/smrt-content:Article': {
          qualifiedName: '@happyvertical/smrt-content:Article',
          className: 'Article',
          packageName: '@happyvertical/smrt-content',
          collection: 'articles',
          decoratorConfig: {},
        },
      },
    };
    // Iteration order on an object literal preserves insertion order in
    // modern engines — `@happyvertical/` is checked first and wins.
    const result = navTreeFromManifest(manifest, {
      sectionHints: {
        '@happyvertical/': 'HV',
        'smrt-content': 'Content',
      },
    });
    expect(result[0].label).toBe('HV');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Pluralization unit tests — the helper is exported for completeness; most
// callers should rely on `navTreeFromManifest` to apply it under the hood
// and override exotic plurals via `@smrt({ ui: { label } })`.
// ────────────────────────────────────────────────────────────────────────

describe('pluralizeClassName', () => {
  it('handles simple consonant suffixes', () => {
    expect(pluralizeClassName('Article')).toBe('Articles');
    expect(pluralizeClassName('Product')).toBe('Products');
  });

  it('handles consonant + y → ies', () => {
    expect(pluralizeClassName('Category')).toBe('Categories');
    expect(pluralizeClassName('Currency')).toBe('Currencies');
  });

  it('handles vowel + y → s (no -ies)', () => {
    expect(pluralizeClassName('Survey')).toBe('Surveys');
  });

  it('handles s, x, z, ch, sh suffixes → es', () => {
    expect(pluralizeClassName('Box')).toBe('Boxes');
    expect(pluralizeClassName('Dish')).toBe('Dishes');
    expect(pluralizeClassName('Watch')).toBe('Watches');
  });

  it('passes already-plural words through', () => {
    expect(pluralizeClassName('Articles')).toBe('Articles');
    expect(pluralizeClassName('Categories')).toBe('Categories');
  });

  it('returns empty string unchanged', () => {
    expect(pluralizeClassName('')).toBe('');
  });
});
