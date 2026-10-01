/**
 * `db:status` tenant natural-key detector: a tenant-owned table whose live
 * unique index is still the GLOBAL natural key (the Anytown Ludis shape).
 */

import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrtRegistry as smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  checkTenantNaturalKeyUniques,
  type LiveTableLike,
} from '../tenant-natural-keys.js';

@smrt({ tableName: 'tnk_leagues' })
class TnkLeague extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;
}

@smrt({ tableName: 'tnk_codes', conflictColumns: ['code'] })
class TnkCode extends SmrtObject {
  @field({ type: 'text' })
  code: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;
}

@smrt({ tableName: 'tnk_tags' })
class TnkTag extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

function live(
  tables: Record<
    string,
    Array<{ name: string; columns: string[]; unique?: boolean }>
  >,
): ReadonlyMap<string, LiveTableLike> {
  return new Map(
    Object.entries(tables).map(([table, indexes]) => [table, { indexes }]),
  );
}

function forTables(
  findings: ReturnType<typeof checkTenantNaturalKeyUniques>,
  prefix: string,
) {
  return findings.filter((finding) =>
    finding.details.tableName.startsWith(prefix),
  );
}

describe('checkTenantNaturalKeyUniques', () => {
  it('registers the fixtures with the expected keys', () => {
    expect([TnkLeague.name, TnkCode.name, TnkTag.name]).toHaveLength(3);
    expect(ObjectRegistry.getConflictColumns('TnkLeague')).toEqual([
      'tenant_id',
      'slug',
      'context',
    ]);
  });

  it('fails (error precondition, exit 1) when a tenant-owned table still has the global (slug, context) unique', () => {
    const findings = forTables(
      checkTenantNaturalKeyUniques(
        live({
          tnk_leagues: [
            {
              name: 'tnk_leagues_slug_context_idx',
              columns: ['slug', 'context'],
              unique: true,
            },
          ],
        }),
      ),
      'tnk_',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      name: 'tnk_leagues.tnk_leagues_slug_context_idx',
      status: 'error',
      details: {
        tableName: 'tnk_leagues',
        kind: 'global_unique',
        conflictColumns: ['tenant_id', 'slug', 'context'],
      },
    });
    expect(findings[0].recommendation).toContain('smrt db:migrate');
  });

  it('is quiet once the tenant-inclusive unique is live', () => {
    expect(
      forTables(
        checkTenantNaturalKeyUniques(
          live({
            tnk_leagues: [
              {
                name: 'tnk_leagues_slug_context_idx',
                columns: ['tenant_id', 'slug', 'context'],
                unique: true,
              },
            ],
          }),
        ),
        'tnk_',
      ),
    ).toEqual([]);
  });

  it('warns (no exit 1) while the legacy global unique survives beside the tenant-led one', () => {
    const findings = forTables(
      checkTenantNaturalKeyUniques(
        live({
          tnk_leagues: [
            {
              name: 'tnk_leagues_slug_context_idx',
              columns: ['slug', 'context'],
              unique: true,
            },
            {
              name: 'tnk_leagues_tenant_id_slug_idx',
              columns: ['tenant_id', 'slug', 'context'],
              unique: true,
            },
          ],
        }),
      ),
      'tnk_',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      name: 'tnk_leagues.tnk_leagues_slug_context_idx',
      status: 'warning',
      details: { kind: 'legacy_global_unique' },
    });
    expect(findings[0].recommendation).toContain('--drop-legacy-natural-key');
  });

  it('reports a missing tenant-inclusive unique', () => {
    const findings = forTables(
      checkTenantNaturalKeyUniques(live({ tnk_leagues: [] })),
      'tnk_',
    );
    expect(findings.map((finding) => finding.details.kind)).toEqual([
      'missing_tenant_unique',
    ]);
  });

  it('ignores explicit keys, tenantless tables, and tables not introspected', () => {
    expect(
      forTables(
        checkTenantNaturalKeyUniques(
          live({
            tnk_codes: [
              { name: 'tnk_codes_code_idx', columns: ['code'], unique: true },
            ],
            tnk_tags: [
              {
                name: 'tnk_tags_slug_context_idx',
                columns: ['slug', 'context'],
                unique: true,
              },
            ],
          }),
        ),
        'tnk_',
      ),
    ).toEqual([]);
  });
});
