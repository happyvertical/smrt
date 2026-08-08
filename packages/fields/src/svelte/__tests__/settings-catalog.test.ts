import { describe, expect, it } from 'vitest';
import type { FieldPolicyAuditSnapshot } from '../../types.js';
import {
  auditObjectRefs,
  fieldPolicyCatalogPreservedParams,
  fieldPolicyControlPanelNavItem,
  fieldPolicyRollup,
  orgRowIdsForObject,
  prunableDriftRows,
} from '../settings-catalog.js';

const objectRef = '@test/smrt-fields:Document';

function audit(): FieldPolicyAuditSnapshot {
  return {
    caller: {
      tenantId: 'tenant',
      userId: 'user',
      canManageOrg: true,
      canPersonalize: true,
    },
    appRows: [],
    orgRows: [
      {
        id: 'org-row',
        objectRef,
        fieldName: 'title',
        scopeType: 'tenant',
        tenantId: 'tenant',
        userId: null,
        updatedBy: 'user',
        createdAt: null,
        updatedAt: null,
        defaultValue: null,
        displayOrder: null,
        help: null,
        label: null,
        locked: null,
        visibility: 'advanced',
      },
    ],
    inheritedOrgKeys: {},
    userOverrideCounts: { [objectRef]: { title: 2 } },
    driftRows: [
      {
        id: 'stale',
        objectRef: '@gone:Old',
        fieldName: 'gone',
        scopeType: 'tenant',
        tenantId: 'tenant',
        userId: null,
        updatedBy: null,
        createdAt: null,
        updatedAt: null,
        reason: 'unknown-object',
        prunable: true,
      },
    ],
    policies: {
      [objectRef]: {
        objectRef,
        fields: {
          title: {
            fieldName: 'title',
            hasDefault: true,
            defaultValue: 'tenant',
            visibility: 'advanced',
            help: null,
            label: null,
            order: null,
            group: null,
            locked: false,
            required: false,
          },
        },
        layers: {
          title: [
            {
              layer: 'code',
              delta: { default: { value: 'code' }, visibility: 'basic' },
            },
            {
              layer: 'tenant',
              tenantId: 'tenant',
              delta: { default: { value: 'tenant' }, visibility: 'advanced' },
            },
          ],
        },
      },
    },
  };
}

describe('field-policy control-panel adapters', () => {
  it('replays explained layers for code/app/org cells and never exposes user rows', () => {
    const rollup = fieldPolicyRollup(audit(), objectRef, 'title');
    expect(rollup.code).toMatchObject({
      defaultValue: 'code',
      visibility: 'basic',
    });
    expect(rollup.org).toMatchObject({
      defaultValue: 'tenant',
      visibility: 'advanced',
      contributed: true,
    });
    expect(rollup.userCount).toBe(2);
    expect(rollup.orgRow?.id).toBe('org-row');
  });

  it('keeps a selected off-page object in the capped policy read while count refs remain complete', () => {
    const page = {
      items: Array.from({ length: 100 }, (_, index) => ({
        objectRef: `@test:Thing${index}`,
      })),
      selected: { objectRef: '@test:Selected' },
    };
    const refs = auditObjectRefs(page as never);
    expect(refs.objectRefs).toHaveLength(100);
    expect(refs.objectRefs[0]).toBe('@test:Selected');
    expect(refs.countObjectRefs).toHaveLength(101);
  });

  it('selects only caller-prunable drift rows and produces a permission-gated tenant nav item', () => {
    expect(prunableDriftRows(audit()).map((row) => row.id)).toEqual(['stale']);
    expect(orgRowIdsForObject(audit(), objectRef)).toEqual(['org-row']);
    expect(
      fieldPolicyControlPanelNavItem({
        href: '/admin/fields',
        permissions: [],
      }),
    ).toBeNull();
    expect(
      fieldPolicyControlPanelNavItem({
        href: '/admin/fields',
        permissions: ['fields.policy.manage'],
      }),
    ).toMatchObject({ href: '/admin/fields', label: 'Field settings' });
  });

  it('keeps a nondefault page size across catalog search, selection, and pagination links', () => {
    expect(
      fieldPolicyCatalogPreservedParams({
        page: { pageSize: 25 },
        filters: {
          packageFilter: 'package',
          objectFilter: 'object',
          customizedOnly: true,
        },
      } as never),
    ).toEqual({
      package: 'package',
      object: 'object',
      customized: '1',
      pageSize: '25',
    });
  });
});
