import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGuestPermissionConfig,
  parseGuestPermissionConfig,
} from '../guest-config.js';

describe('parseGuestPermissionConfig (#5196)', () => {
  it('parses a well-formed block', () => {
    expect(
      parseGuestPermissionConfig({
        collections: ['products', 'contact_messages', 'products'],
        createCollections: ['contact_messages'],
        createFields: {
          contact_messages: { allowedFields: ['name', 'message'] },
        },
        trustedProxyHops: 1,
        rateLimits: { createPerClient: 3, readPerTenant: 500 },
      }),
    ).toEqual({
      collections: ['products', 'contact_messages'],
      createCollections: ['contact_messages'],
      createFields: {
        contact_messages: { allowedFields: ['name', 'message'] },
      },
      trustedProxyHops: 1,
      rateLimits: { createPerClient: 3, readPerTenant: 500 },
    });
    expect(parseGuestPermissionConfig({ collections: ['a'] })).toEqual({
      collections: ['a'],
      createCollections: [],
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'products'],
    ['an array', ['products']],
    ['no collections', {}],
    ['empty collections', { collections: [] }],
    ['collections not an array', { collections: 'products' }],
    ['a non-string entry', { collections: ['products', 3] }],
    ['an empty-string entry', { collections: ['products', ''] }],
    ['a path-like entry', { collections: ['../products'] }],
    ['an entry with a dot', { collections: ['products.read'] }],
    ['a wildcard entry', { collections: ['*'] }],
    ['an unknown key', { collections: ['a'], everything: true }],
    [
      'createCollections not an array',
      { collections: ['a'], createCollections: 'a' },
    ],
    [
      'a create collection not listed',
      { collections: ['a'], createCollections: ['b'] },
    ],
    [
      'a malformed create entry',
      { collections: ['a'], createCollections: [1] },
    ],
    [
      'a create collection with no field list',
      { collections: ['a'], createCollections: ['a'] },
    ],
    [
      'a field list for a collection that is not a create collection',
      {
        collections: ['a', 'b'],
        createCollections: ['a'],
        createFields: {
          a: { allowedFields: ['x'] },
          b: { allowedFields: ['x'] },
        },
      },
    ],
    [
      'an empty field list',
      {
        collections: ['a'],
        createCollections: ['a'],
        createFields: { a: { allowedFields: [] } },
      },
    ],
    [
      'a dotted field name',
      {
        collections: ['a'],
        createCollections: ['a'],
        createFields: { a: { allowedFields: ['x.y'] } },
      },
    ],
    [
      'an unknown field-config key',
      {
        collections: ['a'],
        createCollections: ['a'],
        createFields: { a: { allowedFields: ['x'], tenantId: 'z' } },
      },
    ],
    [
      'a non-integer trusted hop count',
      { collections: ['a'], trustedProxyHops: 1.5 },
    ],
    [
      'a negative trusted hop count',
      { collections: ['a'], trustedProxyHops: -1 },
    ],
    ['an unknown rate limit', { collections: ['a'], rateLimits: { x: 1 } }],
    ['a zero rate limit', { collections: ['a'], rateLimits: { windowMs: 0 } }],
  ])('refuses the whole block when %s', (_name, raw) => {
    expect(parseGuestPermissionConfig(raw)).toBeNull();
  });
});

describe('getGuestPermissionConfig (#5196)', () => {
  afterEach(() => {
    clearCache();
  });

  it('reads packages.users.permissions.guest and fails closed when malformed', () => {
    setConfig({
      packages: {
        users: { permissions: { guest: { collections: ['products'] } } },
      },
    });
    expect(getGuestPermissionConfig()).toEqual({
      collections: ['products'],
      createCollections: [],
    });
    clearCache();
    setConfig({
      packages: { users: { permissions: { guest: { collections: 'oops' } } } },
    });
    expect(getGuestPermissionConfig()).toBeNull();
  });
});
