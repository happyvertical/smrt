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
