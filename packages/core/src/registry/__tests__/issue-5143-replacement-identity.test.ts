/**
 * #5143: a replacement replaces exactly one model, the one it registers under
 * the name of. A class that extends a same-named ancestor through a registered
 * class of another name (`Customer extends Root`, an app's `class Root extends
 * Customer` exported as `Customer`) never replaces that ancestor too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';

const PROVIDER = '@fixture/provider';
const APP = '@fixture/app';
const ROOT = `${PROVIDER}:Root`;
const CUSTOMER = `${PROVIDER}:Customer`;

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('a model exported under the name of a class that extends a same-named ancestor', () => {
  it('replaces the model it registers under, never the same-named ancestor above it', () => {
    class Root extends SmrtObject {
      title = '';
    }
    class Customer extends Root {
      tier = '';
    }
    ObjectRegistry.register(Root, {
      name: 'Root',
      packageName: PROVIDER,
      tableName: 'roots',
      tableStrategy: 'sti',
    });
    ObjectRegistry.register(Customer, {
      name: 'Customer',
      packageName: PROVIDER,
      tableName: 'roots',
    });
    expect(ObjectRegistry.getClass(ROOT)?.constructor).toBe(Root);

    const CustomerBase = Customer;
    // The app's class is named `Root` but is exported as `Customer`.
    class AppRoot extends CustomerBase {
      extra = '';
    }
    Object.defineProperty(AppRoot, 'name', { value: 'Root' });
    smrt({ replaceParent: true, packageName: APP })(AppRoot);
    expect(ObjectRegistry.getClass(ROOT)?.constructor).toBe(Root);
    ObjectRegistry.register(AppRoot, {
      name: 'Customer',
      packageName: APP,
      replaceParent: true,
      tableName: 'roots',
      _manifestKey: `${APP}:Customer`,
      _manifest: {
        version: '1',
        timestamp: 0,
        packageName: APP,
        objects: {
          [`${APP}:Customer`]: {
            name: 'customer',
            collection: 'customers',
            className: 'Customer',
            qualifiedName: `${APP}:Customer`,
            packageName: APP,
            filePath: 'src/models/customer.ts',
            extends: 'Customer',
            extendsQualified: CUSTOMER,
            fields: { title: { type: 'text', _meta: {} } },
            methods: {},
            decoratorConfig: { replaceParent: true, tableName: 'roots' },
            schema: { tableName: 'roots', ddl: '', columns: {} },
          } as never,
        },
      },
    });
    expect(ObjectRegistry.getClass(ROOT)?.constructor).toBe(Root);
    expect(ObjectRegistry.getClass(CUSTOMER)?.constructor).toBe(AppRoot);
    expect(ObjectRegistry.getClass(`${APP}:Customer`)?.constructor).toBe(
      AppRoot,
    );
  });
});
