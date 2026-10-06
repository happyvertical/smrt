import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';
import { OxcScanner } from '../scanner.js';

const CORE = '@happyvertical/smrt-core';

const ORDER_MODEL = `
import { SmrtObject, smrt, field } from '${CORE}';
@smrt({ api: { include: ['list', 'get'] } })
export class Order extends SmrtObject {
  status: string = 'draft';
  total: number = 0;
  notes: string = '';
}
`;

const CUSTOMER_MODEL = `
import { SmrtObject, smrt } from '${CORE}';
@smrt()
export class Customer extends SmrtObject {
  name: string = '';
}
`;

describe('SmrtRecipe scanning (#3590)', () => {
  let dir: string;

  function write(rel: string, source: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
  }

  async function scan(include = ['src/**/*.ts']) {
    const scanner = new OxcScanner({ cwd: dir, include });
    const { results, resolved } = await scanner.scanAndResolve();
    return { results, resolved };
  }

  function messages(results: { errors: Array<{ message: string }> }) {
    return results.errors.map((error) => error.message);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-recipes-'));
    write('src/models/Order.ts', ORDER_MODEL);
    write('src/models/Customer.ts', CUSTOMER_MODEL);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('detection', () => {
    it('reads a recipe subclass and resolves class references', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/Order.js';
import { Customer } from './models/Customer.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Take customer orders.';
  static synonyms = ['orders', 'sales orders'];
  static models = [Order];
  static nav = [{ label: 'Sales Orders', model: Order }];
  static requires = ['shop.customers'];
}
export class CustomersRecipe extends SmrtRecipe {
  static id = 'shop.customers';
  static label = 'Customers';
  static summary = 'Know your customers.';
  static models = [Customer];
  static nav = [{ label: 'Customers', model: Customer }];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      // Sorted by id, whatever the file order.
      expect(results.recipes.map((r) => r.id)).toEqual([
        'shop.customers',
        'shop.sales',
      ]);
      const sales = results.recipes[1];
      expect(sales).toEqual({
        id: 'shop.sales',
        className: 'SalesRecipe',
        label: 'Sales',
        summary: 'Take customer orders.',
        synonyms: ['orders', 'sales orders'],
        models: ['Order'],
        nav: [{ label: 'Sales Orders', model: 'Order' }],
        requires: ['shop.customers'],
      });
      // Defaults for omitted optional statics.
      expect(results.recipes[0].synonyms).toEqual([]);
      expect(results.recipes[0].requires).toEqual([]);
    });

    it('recognizes an aliased SmrtRecipe import', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe as Recipe } from '${CORE}';
import { Order } from './models/Order.js';
export class SalesRecipe extends Recipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Order];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes.map((r) => r.id)).toEqual(['shop.sales']);
    });

    it('recognizes a namespace import of smrt-core', async () => {
      write(
        'src/recipes.ts',
        `
import * as Core from '${CORE}';
import { Order } from './models/Order.js';
export class SalesRecipe extends Core.SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Order];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes).toHaveLength(1);
    });

    it('accepts the browser entry and subpath specifiers of smrt-core', () => {
      const result = parseSource(
        `
import { SmrtRecipe } from '${CORE}/browser';
export class R extends SmrtRecipe {
  static id = 'a.b';
  static label = 'L';
  static summary = 'S';
  static models = [];
}`,
        'r.ts',
      );
      expect(result.recipes?.map((r) => r.className)).toEqual(['R']);
    });

    it('ignores a local class that merely shares the name', () => {
      const result = parseSource(
        `
class SmrtRecipe {}
export class NotARecipe extends SmrtRecipe { static id = 'x.y'; }
`,
        'r.ts',
      );
      expect(result.recipes).toBeUndefined();
      expect(result.errors).toEqual([]);
    });

    it('does not match a package that merely starts with the core name', () => {
      const result = parseSource(
        `
import { SmrtRecipe } from '@happyvertical/smrt-core-utils';
export class NotOurs extends SmrtRecipe { static id = 'x.y'; }
`,
        'r.ts',
      );
      expect(result.recipes).toBeUndefined();
      expect(result.errors).toEqual([]);
    });

    it('reports a recipe extending another recipe instead of dropping it', () => {
      const result = parseSource(
        `
import { SmrtRecipe } from '${CORE}';
export class Base extends SmrtRecipe {
  static id = 'a.b'; static label = 'L'; static summary = 'S'; static models = [];
}
export class Child extends Base { static id = 'a.c'; }
`,
        'r.ts',
      );
      expect(result.errors.map((e) => e.message).join('\n')).toMatch(
        /Recipe Child: extends the recipe Base; a recipe must extend SmrtRecipe directly/,
      );
    });

    it('reports a recipe declared as a class expression or in a block', () => {
      const result = parseSource(
        `
import { SmrtRecipe } from '${CORE}';
export const A = class extends SmrtRecipe { static id = 'a.b'; };
function make() { class B extends SmrtRecipe { static id = 'a.c'; } return B; }
`,
        'r.ts',
      );
      expect(
        result.errors.filter((e) =>
          /class expression or inside a block/.test(e.message),
        ),
      ).toHaveLength(2);
    });

    it('ignores a SmrtRecipe imported from another package', () => {
      const result = parseSource(
        `
import { SmrtRecipe } from 'some-other-lib';
export class NotOurs extends SmrtRecipe { static id = 'x.y'; }
`,
        'r.ts',
      );
      expect(result.recipes).toBeUndefined();
    });

    it('does not turn a recipe into a model object', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/Order.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Order];
}
`,
      );
      const { resolved } = await scan();
      expect(resolved.map((c) => c.className).sort()).toEqual([
        'Customer',
        'Order',
      ]);
    });

    it('finds a recipe outside a narrowed class glob', async () => {
      write(
        'src/recipes/sales.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order } from '../models/Order.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Order];
}
`,
      );
      const { results } = await scan(['src/models/**/*.ts']);
      expect(results.errors).toEqual([]);
      expect(results.recipes.map((r) => r.id)).toEqual(['shop.sales']);
    });

    it('reports a recipe that cannot be read, never drops it', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
const label = 'Sales';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = label;
  static models = [];
}
`,
      );
      const { results } = await scan();
      const text = messages(results).join('\n');
      expect(text).toMatch(/static label must be a string literal/);
      expect(text).toMatch(/must declare a readable `static summary`/);
    });
  });

  describe('class-reference resolution', () => {
    it('follows an aliased model import to the class it names', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order as SalesOrder } from './models/Order.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [SalesOrder];
  static nav = [{ label: 'Orders', model: SalesOrder }];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes[0].models).toEqual(['Order']);
      expect(results.recipes[0].nav[0].model).toBe('Order');
    });

    it('resolves through a barrel re-export by class name', async () => {
      write(
        'src/models/index.ts',
        `export { Order } from './Order.js';\nexport { Customer } from './Customer.js';\n`,
      );
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/index.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Order];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes[0].models).toEqual(['Order']);
    });

    it('resolves a namespace import member', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import * as Models from './models/Order.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Models.Order];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes[0].models).toEqual(['Order']);
    });

    it('resolves a model declared in the recipe file', async () => {
      write(
        'src/both.ts',
        `
import { SmrtObject, smrt, SmrtRecipe } from '${CORE}';
@smrt()
export class Widget extends SmrtObject { name: string = ''; }
export class WidgetRecipe extends SmrtRecipe {
  static id = 'shop.widgets';
  static label = 'Widgets';
  static summary = 'Widgets.';
  static models = [Widget];
}
`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes[0].models).toEqual(['Widget']);
    });

    it('rejects a string where a class reference is required', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = ['@shop/pkg:Order'];
}
`,
      );
      const { results } = await scan();
      expect(messages(results).join('\n')).toMatch(/must be a class reference/);
    });

    it('rejects a model imported from another package', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order } from '@happyvertical/smrt-commerce';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Order];
}
`,
      );
      const { results } = await scan();
      expect(messages(results).join('\n')).toMatch(
        /another package; a recipe's models must belong to its own package/,
      );
    });

    it('rejects a class that was never scanned', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Ghost } from './models/Ghost.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Ghost];
}
`,
      );
      const { results } = await scan();
      expect(messages(results).join('\n')).toMatch(
        /`Ghost` does not resolve to a model class scanned in this package/,
      );
    });

    it('rejects an identifier that is neither imported nor declared', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Orders.';
  static models = [Nowhere];
}
`,
      );
      const { results } = await scan();
      expect(messages(results).join('\n')).toMatch(
        /neither imported nor declared in this file/,
      );
    });
  });

  describe('validation', () => {
    const header = `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/Order.js';
import { Customer } from './models/Customer.js';
`;

    async function errorsFor(body: string): Promise<string> {
      write('src/recipes.ts', `${header}\n${body}`);
      const { results } = await scan();
      return messages(results).join('\n');
    }

    it('rejects duplicate ids', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.dup'; static label = 'A'; static summary = 'a';
  static models = [Order];
}
export class B extends SmrtRecipe {
  static id = 'shop.dup'; static label = 'B'; static summary = 'b';
  static models = [Customer];
}`);
      expect(text).toMatch(/id `shop.dup` is already declared by/);
    });

    it('rejects a malformed id', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'Sales'; static label = 'A'; static summary = 'a';
  static models = [Order];
}`);
      expect(text).toMatch(/must be dotted lowercase segments/);
    });

    it('rejects a nav model that is not listed in models', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static nav = [{ label: 'Customers', model: Customer }];
}`);
      expect(text).toMatch(/`Customer`, which is not listed in models/);
    });

    it('rejects an empty models list and duplicate models', async () => {
      const empty = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [];
}`);
      expect(empty).toMatch(/models must list at least one model/);
      const dup = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order, Order];
}`);
      expect(dup).toMatch(/lists `Order` more than once/);
    });

    it('rejects bad requires: format, self, duplicate, cycle', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static requires = ['Bad Id', 'shop.a', 'shop.b', 'shop.b'];
}
export class B extends SmrtRecipe {
  static id = 'shop.b'; static label = 'B'; static summary = 'b';
  static models = [Customer];
  static requires = ['shop.a'];
}`);
      expect(text).toMatch(/requires `Bad Id` is not a recipe id/);
      expect(text).toMatch(/cannot require itself/);
      expect(text).toMatch(/requires lists `shop.b` more than once/);
      expect(text).toMatch(/requires cycle shop\.(a|b) -> shop\.(a|b)/);
    });

    it('accepts requires that name recipes in other packages', async () => {
      write(
        'src/recipes.ts',
        `${header}
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static requires = ['elsewhere.customers'];
}`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes[0].requires).toEqual(['elsewhere.customers']);
    });

    it('accepts options that refine declared fields', async () => {
      write(
        'src/recipes.ts',
        `${header}
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = {
    Order: {
      fields: {
        status: { default: 'draft', locked: true, label: 'State', help: 'h', order: 1 },
        notes: { visibility: 'hidden' },
      },
      exposure: { api: false, mcp: { exclude: ['delete'] } },
    },
  };
}`,
      );
      const { results } = await scan();
      expect(results.errors).toEqual([]);
      expect(results.recipes[0].options).toEqual({
        Order: {
          fields: {
            status: {
              default: 'draft',
              locked: true,
              label: 'State',
              help: 'h',
              order: 1,
            },
            notes: { visibility: 'hidden' },
          },
          exposure: { api: false, mcp: { exclude: ['delete'] } },
        },
      });
    });

    it('rejects options naming a field the model does not declare', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = { Order: { fields: { invented: { locked: true } } } };
}`);
      expect(text).toMatch(/`Order` declares no field `invented`/);
    });

    it('rejects options for a model the recipe does not list', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = { Customer: { fields: { name: { locked: true } } } };
}`);
      expect(text).toMatch(
        /options.Customer does not name one of the recipe's models/,
      );
    });

    it('rejects options that would widen exposure', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = { Order: { exposure: { api: true, mcp: { include: ['list'] }, cli: 'yes' } } };
}`);
      expect(text.match(/never widen it/g)).toHaveLength(3);
    });

    it('rejects exclude entries that name no operation, and an empty exclude', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = { Order: { exposure: { api: { exclude: ['delte'] }, mcp: { exclude: [] } } } };
}`);
      expect(text.match(/never widen it/g)).toHaveLength(2);
      expect(text).toMatch(/exposure\.api may only be/);
      expect(text).toMatch(/exposure\.mcp may only be/);
    });

    it('accepts excluding an inherited public method, rejects private ones', async () => {
      write(
        'src/models/Child.ts',
        `
import { SmrtObject, smrt } from '${CORE}';
@smrt()
export class Base extends SmrtObject {
  name: string = '';
  archive() {}
}
@smrt()
export class Child extends Base {
  private secret() {}
  static make() {}
}
`,
      );
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Child } from './models/Child.js';
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Child];
  static options = { Child: { exposure: { mcp: { exclude: ['archive'] } } } };
}
export class B extends SmrtRecipe {
  static id = 'shop.b'; static label = 'B'; static summary = 'b';
  static models = [Child];
  static options = { Child: { exposure: { mcp: { exclude: ['secret'] }, cli: { exclude: ['make'] } } } };
}
`,
      );
      const { results } = await scan();
      expect(
        results.errors.filter((e) => /may only be/.test(e.message)),
      ).toHaveLength(2);
      expect(results.recipes.find((r) => r.id === 'shop.a')?.options).toEqual({
        Child: { exposure: { mcp: { exclude: ['archive'] } } },
      });
    });

    it('rejects unknown option keys and bad hint values', async () => {
      const text = await errorsFor(`
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = {
    Order: {
      type: 'x',
      fields: {
        status: { visibility: 'secret', locked: 'yes', order: 'first', colour: 'red', label: 3 },
      },
    },
  };
}`);
      expect(text).toMatch(/options.Order.type is not a model option/);
      expect(text).toMatch(/visibility must be one of basic, advanced, hidden/);
      expect(text).toMatch(/locked must be a boolean/);
      expect(text).toMatch(/order must be a finite number/);
      expect(text).toMatch(/colour is not a field option/);
      expect(text).toMatch(/label must be a string/);
    });

    it('rejects options that cannot be read statically', async () => {
      const text = await errorsFor(`
const DEFAULT = 'draft';
export class A extends SmrtRecipe {
  static id = 'shop.a'; static label = 'A'; static summary = 'a';
  static models = [Order];
  static options = { Order: { fields: { status: { default: DEFAULT } } } };
}`);
      expect(text).toMatch(/must be a literal value/);
    });
  });

  describe('manifest emission', () => {
    it('qualifies models with the package name and emits the shape', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/Order.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Take customer orders.';
  static synonyms = ['orders'];
  static models = [Order];
  static nav = [{ label: 'Sales Orders', model: Order }];
  static requires = ['shop.customers'];
  static options = { Order: { fields: { status: { locked: true } } } };
}
`,
      );
      const { results, resolved } = await scan();
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: '@shop/pkg',
        typeAliases: results.typeAliases,
        recipes: results.recipes,
      });
      expect(manifest.recipes).toEqual([
        {
          id: 'shop.sales',
          className: 'SalesRecipe',
          label: 'Sales',
          summary: 'Take customer orders.',
          synonyms: ['orders'],
          models: ['@shop/pkg:Order'],
          nav: [{ label: 'Sales Orders', model: '@shop/pkg:Order' }],
          requires: ['shop.customers'],
          options: {
            '@shop/pkg:Order': { fields: { status: { locked: true } } },
          },
        },
      ]);
      expect(Object.keys(manifest.objects)).toContain('@shop/pkg:Order');
    });

    it('emits no recipes key for a package that declares none', async () => {
      const { results, resolved } = await scan();
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: '@shop/pkg',
        recipes: results.recipes,
      });
      expect('recipes' in manifest).toBe(false);
    });

    it('does not duplicate errors when resolve() runs twice', async () => {
      write(
        'src/recipes.ts',
        `
import { SmrtRecipe } from '${CORE}';
export class A extends SmrtRecipe {
  static id = 'bad'; static label = 'A'; static summary = 'a';
  static models = [];
}`,
      );
      const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
      await scanner.scan();
      scanner.resolve();
      const first = scanner.resolve();
      expect(first).toBeDefined();
      const results = (
        scanner as unknown as { scanResults: { errors: unknown[] } }
      ).scanResults;
      expect(results.errors).toHaveLength(2);
    });
  });
});
