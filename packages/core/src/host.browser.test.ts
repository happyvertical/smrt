import { describe, expect, it } from 'vitest';
import * as browserHost from './host.browser.js';
import * as nodeHost from './host.js';
import * as browserJson from './utils/json.browser.js';
import * as nodeJson from './utils/json.js';

describe('browser host (#2838)', () => {
  it('exposes exactly the names the Node host does', () => {
    expect(Object.keys(browserHost).sort()).toEqual(
      Object.keys(nodeHost).sort(),
    );
  });

  it('refuses database engines that need Node instead of opening another one', () => {
    expect(() =>
      browserHost.getDatabase({ type: 'sqlite', url: ':memory:' }),
    ).toThrow(/"sqlite" is not available in the browser/);
    expect(() =>
      browserHost.getDatabase({ type: 'postgres', url: 'postgres://x/y' }),
    ).toThrow(/"postgres" is not available in the browser/);
  });

  it('uses the same query helpers and nested-transaction error as the Node host', () => {
    expect(browserHost.buildWhere({ id: 1 })).toEqual(
      nodeHost.buildWhere({ id: 1 }),
    );
    expect(browserHost.raw('count(*)')).toEqual(nodeHost.raw('count(*)'));
    expect(browserHost.NestedTransactionError).toBe(
      nodeHost.NestedTransactionError,
    );
  });

  it('reports no installed packages and no AI SDK', async () => {
    await expect(browserHost.discoverInstalledSmrtPackages()).resolves.toEqual(
      [],
    );
    await expect(browserHost.importAI()).rejects.toThrow(
      /not available in the browser/,
    );
  });
});

describe('browser json (#2838)', () => {
  const documents = ['{"a":[1,2,{"b":null}]}', '[]', '"x"', '{', ''];

  it('exposes exactly the names the Node module does', () => {
    expect(Object.keys(browserJson).sort()).toEqual(
      Object.keys(nodeJson).sort(),
    );
  });

  it('agrees with the Node module on every operation', () => {
    for (const text of documents) {
      expect(browserJson.isValid(text)).toBe(nodeJson.isValid(text));
      const browser = browserJson.safeParse(text);
      const node = nodeJson.safeParse(text);
      expect(browser.success).toBe(node.success);
      if (browser.success && node.success) {
        expect(browser.value).toEqual(node.value);
        expect(browserJson.parse(text)).toEqual(nodeJson.parse(text));
      } else {
        expect(() => browserJson.parse(text)).toThrow();
      }
    }
    const value = { a: [1, { b: 'x' }], c: null };
    expect(browserJson.stringify(value, null, 2)).toBe(
      nodeJson.stringify(value, null, 2),
    );
    expect(browserJson.stringify(value, ['a'])).toBe(
      nodeJson.stringify(value, ['a']),
    );
    expect(browserJson.clone(value)).toEqual(nodeJson.clone(value));
    expect(browserJson.clone(value)).not.toBe(value);
    expect(browserJson.safeStringify(value)).toEqual(
      nodeJson.safeStringify(value),
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(browserJson.safeStringify(circular).success).toBe(false);
    expect(nodeJson.safeStringify(circular).success).toBe(false);
  });
});
