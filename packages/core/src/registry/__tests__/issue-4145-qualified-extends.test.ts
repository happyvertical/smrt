/**
 * #4145: `Agreement` is declared by two packages. A consumer subclass of one
 * of them must resolve its parent from the manifest's import-qualified
 * `extendsQualified`, in either registration order, and an unrelated STI
 * model's `toJSON()` — which walks every registered class's chain — must not
 * fail because of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject, smrt } from '../../index';
import { ObjectRegistry } from '../../registry';
import type { SmartObjectDefinition } from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';

const COMMERCE = '@test4145/commerce';
const SALES = '@test4145/sales';
const APP = '@test4145/app';

@smrt({ tableStrategy: 'sti' })
class Redirect4145 extends SmrtObject {
  target: string = '';
}

function register(
  packageName: string,
  className: string,
  extra: Partial<SmartObjectDefinition> = {},
): void {
  ObjectRegistry.registerFromManifest(
    `${packageName}:${className}`,
    {
      name: className.toLowerCase(),
      className,
      collection: `${className.toLowerCase()}s`,
      filePath: `/${packageName}/src/${className}.ts`,
      fields: { title: { type: 'text' } },
      methods: {},
      decoratorConfig: {},
      ...extra,
    } as SmartObjectDefinition,
    packageName,
  );
}

function registerParents(): void {
  register(COMMERCE, 'Agreement', {
    decoratorConfig: { tableStrategy: 'sti', tableName: 'contracts4145' },
  });
  register(SALES, 'Agreement', {
    decoratorConfig: { tableName: 'agreements4145' },
  });
}

function registerConsumer(extendsQualified?: string): void {
  register(APP, 'AdvertisingProductContract', {
    extends: 'Agreement',
    ...(extendsQualified ? { extendsQualified } : {}),
    decoratorConfig: { tableStrategy: 'sti', tableName: 'contracts4145' },
  });
}

describe('#4145 qualified parent of a same-named class', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restore();
  });

  for (const order of ['parents-first', 'consumer-first'] as const) {
    it(`resolves the imported package's parent (${order})`, () => {
      if (order === 'parents-first') registerParents();
      registerConsumer(`${COMMERCE}:Agreement`);
      if (order === 'consumer-first') registerParents();

      expect(
        ObjectRegistry.getInheritanceChain(`${APP}:AdvertisingProductContract`),
      ).toEqual([`${COMMERCE}:Agreement`, `${APP}:AdvertisingProductContract`]);
      expect(ObjectRegistry.getDescendants(`${COMMERCE}:Agreement`)).toContain(
        `${APP}:AdvertisingProductContract`,
      );
      expect(ObjectRegistry.getDescendants(`${SALES}:Agreement`)).toEqual([]);

      const redirect = new Redirect4145();
      expect(redirect.toJSON()._meta_type).toMatch(/:Redirect4145$/);
    });
  }

  it('names the subclass when an unqualified parent is ambiguous', () => {
    registerParents();
    registerConsumer();

    let thrown: unknown;
    try {
      new Redirect4145().toJSON();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'CONFIG_AMBIGUOUS_CLASS',
      details: {
        subclass: `${APP}:AdvertisingProductContract`,
        subclassPackage: APP,
      },
    });
    expect(String((thrown as Error).message)).toContain(
      `Subclass ${APP}:AdvertisingProductContract declares \`extends Agreement\``,
    );
  });
});
