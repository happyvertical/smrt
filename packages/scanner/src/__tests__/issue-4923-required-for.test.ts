import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';

const SOURCE = `import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';

@smrt()
export class Account extends SmrtObject {
  @field({ required: true, requiredFor: 'identity' })
  slug: string = '';

  @field({ required: true })
  label: string = '';
}
`;

describe('requiredFor reaches the manifest (#4923)', () => {
  it('carries the reason under _meta and leaves an unexplained field without one', () => {
    const parsed = parseSource(SOURCE);
    expect(parsed.errors).toHaveLength(0);
    const resolver = new InheritanceResolver();
    resolver.addClasses(parsed.classes);
    const manifest = new ManifestAdapter().toManifest(resolver.resolveAll(), {
      packageName: '@test/pkg',
    });
    const fields = Object.values(manifest.objects).find(
      (o) => o.className === 'Account',
    )?.fields;
    expect(fields?.slug.required).toBe(true);
    expect(fields?.slug._meta?.requiredFor).toBe('identity');
    expect(fields?.label.required).toBe(true);
    expect(fields?.label._meta?.requiredFor).toBeUndefined();
  });
});

const RELATION_SOURCE = `import { SmrtObject, smrt, field, foreignKey, crossPackageRef, meta } from '@happyvertical/smrt-core';

@smrt()
export class Link extends SmrtObject {
  @foreignKey('Account', { required: true, requiredFor: 'identity' })
  accountId: string = '';

  @crossPackageRef('@test/other:Thing', { required: true, requiredFor: 'identity' })
  thingId: string = '';

  @foreignKey('Account', { required: true })
  plainId: string = '';
}
`;

describe('requiredFor on relationship fields reaches the manifest (#4935)', () => {
  it('carries the reason for foreignKey and crossPackageRef', () => {
    const parsed = parseSource(RELATION_SOURCE);
    expect(parsed.errors).toHaveLength(0);
    const resolver = new InheritanceResolver();
    resolver.addClasses(parsed.classes);
    const manifest = new ManifestAdapter().toManifest(resolver.resolveAll(), {
      packageName: '@test/pkg',
    });
    const fields = Object.values(manifest.objects).find(
      (o) => o.className === 'Link',
    )?.fields;
    expect(fields?.accountId._meta?.requiredFor).toBe('identity');
    expect(fields?.thingId._meta?.requiredFor).toBe('identity');
    expect(fields?.plainId._meta?.requiredFor).toBeUndefined();
  });
});
