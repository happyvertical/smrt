import { describe, expect, it } from 'vitest';
import {
  generateGuestAuditInsertPolicySql,
  generatePostgresPermissionSql,
} from '../services/PostgresPermissionPolicies.js';

describe('generateGuestAuditInsertPolicySql (#5196)', () => {
  it('emits one INSERT-only policy gated on guest kind and the request tenant', () => {
    const statements = generateGuestAuditInsertPolicySql();
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(
      /^DROP POLICY IF EXISTS "smrt_audit_logs_guest_insert_[0-9a-f]{8}" ON "public"\."audit_logs"$/,
    );
    expect(statements[1]).toContain('FOR INSERT WITH CHECK');
    expect(statements[1]).toContain(`"actor_kind" = 'guest'`);
    expect(statements[1]).toContain(
      '"tenant_id"::text = smrt_current_tenant_id()',
    );
  });

  it('has no system-context elevation and no read/update/delete arm', () => {
    const sql = generateGuestAuditInsertPolicySql({ enableRls: true }).join(
      ';\n',
    );
    expect(sql).not.toContain('smrt_rls_bypass');
    expect(sql).not.toContain('system_context');
    expect(sql).not.toContain('smrt_has_permission');
    expect(sql).not.toMatch(/FOR (SELECT|UPDATE|DELETE|ALL)/);
    expect(sql).not.toContain('USING');
  });

  it('only enables RLS when asked and honours custom names', () => {
    expect(generateGuestAuditInsertPolicySql().join('\n')).not.toContain(
      'ROW LEVEL SECURITY',
    );
    const sql = generateGuestAuditInsertPolicySql({
      enableRls: true,
      schemaName: 'app',
      tableName: 'trail',
      tenantField: 'org_id',
      actorKindField: 'kind',
    });
    expect(sql[0]).toBe('ALTER TABLE "app"."trail" ENABLE ROW LEVEL SECURITY');
    expect(sql[1]).toBe('ALTER TABLE "app"."trail" FORCE ROW LEVEL SECURITY');
    expect(sql[3]).toContain('ON "app"."trail" FOR INSERT');
    expect(sql[3]).toContain(`"kind" = 'guest'`);
    expect(sql[3]).toContain('"org_id"::text');
  });

  it('is hooked into generatePostgresPermissionSql only when requested', () => {
    const plain = generatePostgresPermissionSql({});
    expect(plain.sql).not.toContain('_guest_insert_');
    const withGuest = generatePostgresPermissionSql({}, undefined, {
      guestAudit: true,
    });
    expect(withGuest.statements).toHaveLength(plain.statements.length + 2);
    expect(withGuest.sql).toContain('_guest_insert_');
    // helper functions precede the policy that calls them
    expect(withGuest.statements[0]).toContain('smrt_rls_bypass');
  });

  it('defaults the audit schema to a policy scope', () => {
    const scoped = generatePostgresPermissionSql(
      {},
      { schemaName: 'app_x', includeClass: () => false },
      { guestAudit: true },
    );
    expect(scoped.sql).toContain('ON "app_x"."audit_logs" FOR INSERT');
  });
});
