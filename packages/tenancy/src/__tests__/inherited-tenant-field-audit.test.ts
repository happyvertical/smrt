/**
 * The registration audit resolves a tenant field declared on a parent (#3623).
 *
 * A bundled server registers an STI child before its manifest entry loads, so
 * the child's own field map holds only its own decorator fields; the inherited
 * `tenantId` lives on the registered parent. Anytown production logged
 * `missing_tenant_field` for `HistrioPerformer` (smrt-video `Performer`),
 * `HistrioVoiceProfile` (smrt-voice `VoiceProfile`) and `WeatherForecast`
 * (smrt-events `Event`) although the interceptor filtered and populated them
 * correctly.
 *
 * The child here is registered through `ObjectRegistry.register()` without a
 * `@smrt()` decorator, so no manifest entry describes it: the same state as the
 * bundled server. The test asserts that precondition first.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  auditTenantScopedRegistrations,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';

const TENANT_A = 'aaaaaaaa-3623-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-3623-4222-8222-bbbbbbbbbbbb';

/** Shaped like smrt-video `Performer`: the tenant field lives here. */
@TenantScoped({ mode: 'optional' })
@smrt({ tableStrategy: 'sti', tableName: 'audit_inherit_performers' })
class AuditInheritPerformer extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
  }
}

/**
 * Define a subclass the build-time scanner cannot see, so no manifest entry
 * describes it — the bundled-server registration state. A computed key names
 * the class expression at runtime only.
 */
function runtimeOnlySubclass<T extends new (...args: any[]) => any>(
  parts: string[],
  base: T,
): T {
  const name = parts.join('');
  return { [name]: class extends base {} }[name] as T;
}

/** Shaped like Anytown `HistrioPerformer`: no tenant field of its own. */
const AuditInheritAppPerformer = runtimeOnlySubclass(
  ['AuditInherit', 'AppPerformer'],
  AuditInheritPerformer,
);
type AuditInheritAppPerformer = InstanceType<typeof AuditInheritAppPerformer>;

class AuditInheritAppPerformerCollection extends SmrtCollection<AuditInheritAppPerformer> {
  static readonly _itemClass = AuditInheritAppPerformer;
}

/** A parent with no tenant field: its child must still be reported. */
@smrt({ tableStrategy: 'sti', tableName: 'audit_inherit_untenanted' })
class AuditInheritUntenanted extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

const AuditInheritUntenantedChild = runtimeOnlySubclass(
  ['AuditInherit', 'UntenantedChild'],
  AuditInheritUntenanted,
);

const POLICY = {
  field: 'tenantId',
  mode: 'required' as const,
  autoFilter: true,
  autoPopulate: true,
  allowSuperAdminBypass: true,
};

const SELECTORS = ['AuditInheritAppPerformer', 'AuditInheritUntenantedChild'];

describe('registration audit with an inherited tenant field (#3623)', () => {
  let db: DatabaseInterface;
  let performers: AuditInheritAppPerformerCollection;

  beforeAll(async () => {
    ObjectRegistry.register(AuditInheritAppPerformer, {
      tableStrategy: 'sti',
    });
    ObjectRegistry.register(AuditInheritUntenantedChild, {
      tableStrategy: 'sti',
    });
    ObjectRegistry.registerCollection(
      'AuditInheritAppPerformer',
      AuditInheritAppPerformerCollection,
    );
    db = await getTestDatabase({
      db: await getDatabase({ type: 'sqlite', url: ':memory:' }),
      classes: ['AuditInheritPerformer', 'AuditInheritAppPerformer'],
    });
    performers = await AuditInheritAppPerformerCollection.create({ db });
    enableTenancy();
    for (const selector of SELECTORS) {
      registerTenantScopedClass(selector, POLICY);
    }
  }, 30_000);

  afterAll(async () => {
    for (const selector of SELECTORS) unregisterTenantScopedClass(selector);
    disableTenancy();
    await db?.close?.();
  });

  it('reproduces the bundled-server state: the child has no own tenant field', () => {
    const child = ObjectRegistry.getClassByConstructor(
      AuditInheritAppPerformer,
    );
    expect(child).toBeDefined();
    expect(child?.fields.has('tenantId')).toBe(false);
    expect(
      ObjectRegistry.getClassByConstructor(AuditInheritPerformer)?.fields.has(
        'tenantId',
      ),
    ).toBe(true);
  });

  it('does not report missing_tenant_field for a field the parent declares', () => {
    const kinds = auditTenantScopedRegistrations()
      .filter((finding) => finding.selector === 'AuditInheritAppPerformer')
      .map((finding) => finding.kind);
    expect(kinds).not.toContain('missing_tenant_field');
  });

  it('still reports missing_tenant_field when no class in the chain declares it', () => {
    const findings = auditTenantScopedRegistrations().filter(
      (finding) => finding.selector === 'AuditInheritUntenantedChild',
    );
    expect(findings.map((finding) => finding.kind)).toEqual([
      'missing_tenant_field',
    ]);
    expect(findings[0]?.severity).toBe('error');
  });

  it('filters and populates the inherited field in that state', async () => {
    const created = await withTenant({ tenantId: TENANT_A }, async () => {
      const performer = await performers.create({ name: 'Anchor A' });
      await performer.save();
      return performer;
    });
    expect(created.tenantId).toBe(TENANT_A);

    await withTenant({ tenantId: TENANT_A }, async () => {
      expect(await performers.list({})).toHaveLength(1);
    });
    await withTenant({ tenantId: TENANT_B }, async () => {
      expect(await performers.list({})).toHaveLength(0);
      expect(await performers.get({ id: created.id as string })).toBeNull();
    });
  });
});
