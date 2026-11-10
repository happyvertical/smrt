/**
 * #4176: a consumer collection whose import-qualified parent is a collection
 * base of package A stays a collection when package B also declares a
 * same-named, non-collection class that holds the class-name slot of the
 * generator's lookup map. A collection keeps no independent schema.
 */
import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type { SmartObjectDefinition, SmartObjectManifest } from '../types';

function definition(
  packageName: string,
  className: string,
  extra: Partial<SmartObjectDefinition>,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    packageName,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${packageName}/src/${className}.ts`,
    fields: { title: { type: 'text' } },
    methods: {},
    decoratorConfig: {},
    ...extra,
  } as SmartObjectDefinition;
}

describe('#4176 qualified collection parent beside a same-named class', () => {
  it('keeps the consumer collection schema-less', () => {
    const manifest = {
      version: '1.0.0',
      packageName: '@test4176/app',
      objects: {
        '@test4176/a:BaseCollection': definition(
          '@test4176/a',
          'BaseCollection',
          { extends: 'SmrtCollection', fields: {} },
        ),
        // Declared after A's, so it takes the `BaseCollection` name slot.
        '@test4176/b:BaseCollection': definition(
          '@test4176/b',
          'BaseCollection',
          { extends: 'SmrtObject' },
        ),
        '@test4176/app:ThingCollection': definition(
          '@test4176/app',
          'ThingCollection',
          {
            extends: 'BaseCollection',
            extendsQualified: '@test4176/a:BaseCollection',
            fields: {},
          },
        ),
      },
    } as unknown as SmartObjectManifest;

    new ManifestGenerator().generateSchemas(manifest);

    expect(
      manifest.objects['@test4176/app:ThingCollection']?.schema,
    ).toBeUndefined();
  });
});
