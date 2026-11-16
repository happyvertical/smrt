/**
 * #4935: the reason vocabulary for `requiredFor`. Seven values, each exported
 * from both entries, listed in the docs, read by the lint check, and carried
 * into the manifest as `_meta.requiredFor`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_FOR_REASONS as BROWSER_REASONS } from '../browser';
import { REQUIRED_FOR_REASONS } from '../index';
import { ManifestGenerator } from '../scanner/manifest-generator';
import type { FieldDefinition } from '../scanner/types';

const EXPECTED = [
  'identity',
  'tenant-scope',
  'idempotency',
  'workflow-state',
  'system-table',
  'integrity',
  'authentication',
];

const REPO_ROOT = resolve(__dirname, '../../../..');

describe('requiredFor reason values (#4935)', () => {
  it('has exactly the seven agreed values', () => {
    expect([...REQUIRED_FOR_REASONS]).toEqual(EXPECTED);
  });

  it('exports the same values from the browser entry', () => {
    expect([...BROWSER_REASONS]).toEqual([...REQUIRED_FOR_REASONS]);
  });

  it('is the list the lint check accepts', async () => {
    const modulePath = resolve(REPO_ROOT, 'scripts/check-required-reasons.mjs');
    const script = (await import(/* @vite-ignore */ modulePath)) as {
      REQUIRED_FOR_VALUES: string[];
    };
    expect(script.REQUIRED_FOR_VALUES).toEqual([...REQUIRED_FOR_REASONS]);
  });

  it('lists every value in the docs', () => {
    for (const file of ['docs/content/core.md']) {
      const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      for (const value of EXPECTED) expect(text).toContain(`\`${value}\``);
    }
    const rules = readFileSync(
      resolve(REPO_ROOT, 'packages/core/agents/data-shape-rules.md'),
      'utf8',
    );
    expect(rules).toContain('digests');
    expect(rules).toContain('authenticat');
  });

  it.each(EXPECTED)('carries %s into the manifest field meta', (reason) => {
    const field: FieldDefinition = {
      type: 'text',
      required: true,
      _meta: { requiredFor: reason as never },
    };
    const manifest = new ManifestGenerator().generateManifest(
      [
        {
          filePath: 'src/thing.ts',
          objects: [
            {
              name: 'thing',
              className: 'Thing',
              collection: 'things',
              filePath: 'src/thing.ts',
              fields: { digest: field },
              methods: {},
              decoratorConfig: { tableName: 'things' },
              exportName: 'Thing',
              collectionExportName: 'ThingCollection',
            },
          ],
          errors: [],
        },
      ],
      { packageName: '@example/reasons' },
    );
    const object = Object.values(manifest.objects)[0];
    expect(object.fields.digest._meta?.requiredFor).toBe(reason);
  });
});
