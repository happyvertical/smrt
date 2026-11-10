import { describe, expect, it } from 'vitest';
import { resolveOperationPermissionAlias } from './operation-permission.js';

describe('custom operation permission aliases', () => {
  it('leaves ordinary actions unchanged and resolves declared CRUD grants', () => {
    expect(resolveOperationPermissionAlias({}, 'run')).toBeUndefined();
    expect(
      resolveOperationPermissionAlias(
        {
          operationPermissions: {
            run: { action: 'read' },
            archive: {
              action: 'create',
              databaseActions: ['SELECT', 'UPDATE'],
            },
          },
        },
        'archive',
      ),
    ).toEqual({
      action: 'create',
      databaseActions: ['SELECT', 'UPDATE'],
    });
  });
  it.each([
    null,
    [],
    'read',
    { action: '*' },
    { action: 'read', public: true },
    { action: 'read', databaseActions: ['EXECUTE'] },
    { action: 'read', databaseActions: 'UPDATE' },
  ])('rejects malformed authority %j', (alias) => {
    expect(() =>
      resolveOperationPermissionAlias(
        { operationPermissions: { run: alias } },
        'run',
      ),
    ).toThrow();
  });
  it('cannot weaken CRUD grants or read inherited declarations', () => {
    expect(() =>
      resolveOperationPermissionAlias(
        { operationPermissions: { delete: { action: 'read' } } },
        'delete',
      ),
    ).toThrow();
    expect(
      resolveOperationPermissionAlias(
        { operationPermissions: Object.create({ run: { action: 'read' } }) },
        'run',
      ),
    ).toBeUndefined();
  });
});
