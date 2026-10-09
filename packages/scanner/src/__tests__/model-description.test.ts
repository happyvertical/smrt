import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';

const HEAD = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';\n`;

function describeOf(source: string, index = 0): string | undefined {
  const result = parseSource(HEAD + source);
  expect(result.errors).toHaveLength(0);
  return result.classes[index].description;
}

describe('model description from class JSDoc', () => {
  it('strips a "ClassName - " / "ClassName:" prefix', () => {
    expect(
      describeOf(`/** Order - Customer purchase order */
@smrt()
export class Order extends SmrtObject { name = ''; }`),
    ).toBe('Customer purchase order');
    expect(
      describeOf(`/** Order: Customer purchase order. */
@smrt()
export class Order extends SmrtObject { name = ''; }`),
    ).toBe('Customer purchase order.');
  });

  it('uses only the first paragraph and ignores tags and markup', () => {
    expect(
      describeOf(`/**
 * A \`Widget\` with {@link Gadget} parts and **bold** words
 * continued here.
 *
 * Second paragraph is not included.
 *
 * @example
 * const w = 1;
 */
@smrt()
class Widget extends SmrtObject { name = ''; }`),
    ).toBe('A Widget with Gadget parts and bold words continued here.');
  });

  it('finds JSDoc above export + decorators, and ignores non-JSDoc comments', () => {
    expect(
      describeOf(`/** Decorated model. */
@smrt()
export default class Dec extends SmrtObject { name = ''; }`),
    ).toBe('Decorated model.');
    expect(
      describeOf(`// not a doc
@smrt()
class Plain extends SmrtObject { name = ''; }`),
    ).toBeUndefined();
    expect(
      describeOf(
        `/** Only tags */
@smrt()
class Tagged extends SmrtObject { name = ''; }`.replace(
          'Only tags',
          '@deprecated nope',
        ),
      ),
    ).toBeUndefined();
  });

  it('skips @internal classes and does not leak onto the next class', () => {
    const result = parseSource(`${HEAD}
/**
 * Hidden thing.
 * @internal
 */
@smrt()
class Hidden extends SmrtObject { name = ''; }

@smrt()
class Next extends SmrtObject { name = ''; }`);
    expect(result.classes[0].description).toBeUndefined();
    expect(result.classes[1].description).toBeUndefined();
  });

  it('caps at 200 chars on a sentence boundary', () => {
    const long = `${'First sentence is here. '}${'word '.repeat(60)}`;
    const text = describeOf(`/** ${long} */
@smrt()
class Long extends SmrtObject { name = ''; }`);
    expect(text).toBe('First sentence is here.');
  });

  it('lets an explicit @smrt({ description }) win', () => {
    expect(
      describeOf(`/** Doc summary. */
@smrt({ description: 'Explicit words' })
class Exp extends SmrtObject { name = ''; }`),
    ).toBe('Explicit words');
  });

  it('is emitted on the manifest object only when present', () => {
    const parsed = parseSource(`${HEAD}
/** Order - Customer purchase order */
@smrt()
export class Order extends SmrtObject { name = ''; }
@smrt()
export class Bare extends SmrtObject { name = ''; }`);
    const manifest = new ManifestAdapter().toManifest(
      parsed.classes.map((c) => ({
        ...c,
        allFields: c.fields,
        ancestors: [],
      })) as never,
      { packageName: '@test/pkg' } as never,
    );
    const objects = Object.values(manifest.objects);
    expect(objects.find((o) => o.className === 'Order')?.description).toBe(
      'Customer purchase order',
    );
    expect('description' in objects.find((o) => o.className === 'Bare')!).toBe(
      false,
    );
  });
});
