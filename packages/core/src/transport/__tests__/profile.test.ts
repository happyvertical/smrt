/**
 * Legacy transport profiles (#5158): the shape every migration reads.
 *
 * Whether a cell is true is the job of `profile-source-pins.test.ts`. This
 * file keeps the tables complete (every transport, every behaviour, every
 * operation), immutable, and consistent with the facts the migration plan was
 * drawn up from.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_CHAT,
  LEGACY_CLI,
  LEGACY_MCP,
  LEGACY_MCP_EMITTED_MODULAR,
  LEGACY_MCP_EMITTED_SINGLE,
  LEGACY_PROFILES,
  LEGACY_REST,
  LEGACY_SERVER_MANAGED_KEYS,
  LEGACY_SVELTEKIT,
  LEGACY_SYNC_EMITTED,
  LEGACY_SYNC_RUNTIME,
  LEGACY_TRANSPORT_SOURCES,
  LEGACY_TRANSPORTS,
} from '../profile';
import {
  type LegacyTransportId,
  MUTATING_OPERATIONS,
  SURFACE_EXPOSURE,
  TRANSPORT_OPERATIONS,
  TRANSPORT_SURFACES,
  type TransportProfile,
  type TransportProfileSection,
} from '../types';

const SECTIONS: TransportProfileSection[] = [
  'operations',
  'write',
  'serialize',
  'create',
  'query',
  'tenant',
  'errors',
  'authorization',
  'lookup',
  'sti',
  'arguments',
  'results',
  'body',
];

const where = (
  predicate: (profile: TransportProfile) => boolean,
): LegacyTransportId[] =>
  LEGACY_TRANSPORTS.filter((id) => predicate(LEGACY_PROFILES[id]));

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('transport operations and surfaces', () => {
  it('enumerates the six operations and five surfaces', () => {
    expect(TRANSPORT_OPERATIONS).toEqual([
      'list',
      'get',
      'count',
      'create',
      'update',
      'delete',
    ]);
    expect(TRANSPORT_SURFACES).toEqual([
      'rest',
      'mcp',
      'sync',
      'cli',
      'assistant',
    ]);
    expect(Object.isFrozen(TRANSPORT_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(TRANSPORT_SURFACES)).toBe(true);
  });

  it('maps every surface to a runtime-exposure surface', () => {
    expect(Object.keys(SURFACE_EXPOSURE).sort()).toEqual(
      [...TRANSPORT_SURFACES].sort(),
    );
    // Sync has no exposure surface of its own.
    expect(SURFACE_EXPOSURE.sync).toBe('rest');
    expect(SURFACE_EXPOSURE.assistant).toBe('assistant');
  });

  it('marks exactly the writes as mutating', () => {
    expect([...MUTATING_OPERATIONS].sort()).toEqual([
      'create',
      'delete',
      'update',
    ]);
  });
});

describe('legacy profiles', () => {
  it('covers nine transports across all five surfaces', () => {
    expect(Object.keys(LEGACY_PROFILES)).toEqual([...LEGACY_TRANSPORTS]);
    expect(LEGACY_TRANSPORTS).toHaveLength(9);
    expect(
      new Set(LEGACY_TRANSPORTS.map((id) => LEGACY_PROFILES[id].surface)),
    ).toEqual(new Set(TRANSPORT_SURFACES));
  });

  it.each([
    ...LEGACY_TRANSPORTS,
  ])('%s decides every behaviour and operation', (id) => {
    const profile = LEGACY_PROFILES[id];
    expect(profile.transport).toBe(id);
    expect(profile.surface).toBe(LEGACY_TRANSPORT_SOURCES[id].surface);
    for (const section of SECTIONS) {
      expect(profile[section], `${id}.${section}`).toBeTypeOf('object');
    }
    // A section added to the type must be added here and to every table.
    expect(Object.keys(profile).sort()).toEqual(
      ['surface', 'transport', ...SECTIONS].sort(),
    );
    expect(Object.keys(profile.operations).sort()).toEqual(
      [...TRANSPORT_OPERATIONS].sort(),
    );
    for (const operation of TRANSPORT_OPERATIONS) {
      const availability = profile.operations[operation];
      const explanation = availability.served
        ? availability.as
        : availability.reason;
      expect(explanation.length, `${id}.${operation}`).toBeGreaterThan(0);
    }
    expect(profile.sti.exposureSurface).toBe(SURFACE_EXPOSURE[profile.surface]);
  });

  it('is immutable all the way down', () => {
    expect(isDeepFrozen(LEGACY_PROFILES)).toBe(true);
    expect(() => {
      (LEGACY_REST.write as { arrayBody: string }).arrayBody = 'refused';
    }).toThrow(TypeError);
  });

  it('names a source file that exists for every transport', () => {
    for (const id of LEGACY_TRANSPORTS) {
      const url = new URL(
        `../../../../${LEGACY_TRANSPORT_SOURCES[id].source}`,
        import.meta.url,
      );
      expect(existsSync(url), LEGACY_TRANSPORT_SOURCES[id].source).toBe(true);
    }
  });

  it('exports each profile under its own name', () => {
    expect(LEGACY_REST).toBe(LEGACY_PROFILES['rest-runtime']);
    expect(LEGACY_SVELTEKIT).toBe(LEGACY_PROFILES['sveltekit-emitted']);
    expect(LEGACY_MCP).toBe(LEGACY_PROFILES['mcp-inprocess']);
    expect(LEGACY_MCP_EMITTED_SINGLE).toBe(
      LEGACY_PROFILES['mcp-emitted-single'],
    );
    expect(LEGACY_MCP_EMITTED_MODULAR).toBe(
      LEGACY_PROFILES['mcp-emitted-modular'],
    );
    expect(LEGACY_SYNC_RUNTIME).toBe(LEGACY_PROFILES['sync-runtime']);
    expect(LEGACY_SYNC_EMITTED).toBe(LEGACY_PROFILES['sync-emitted']);
    expect(LEGACY_CLI).toBe(LEGACY_PROFILES.cli);
    expect(LEGACY_CHAT).toBe(LEGACY_PROFILES['chat-tool-loop']);
  });
});

describe('what the profiles say about today', () => {
  it('every write filter drops the same seven keys and reads api.writable', () => {
    expect(LEGACY_SERVER_MANAGED_KEYS).toEqual([
      'id',
      'tenantId',
      'tenant_id',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
    ]);
    for (const id of LEGACY_TRANSPORTS) {
      const { write } = LEGACY_PROFILES[id];
      expect(write.serverManagedKeys).toBe(LEGACY_SERVER_MANAGED_KEYS);
      expect(write.allowlist).toBe('api.writable');
      expect(write.underscorePrefixedKeys).toBe('dropped');
    }
  });

  it('three write filters handle displayLabel, and one handles generated fields', () => {
    expect(
      where((p) => p.write.displayLabelKey === 'dropped-when-projected'),
    ).toEqual(['rest-runtime', 'sveltekit-emitted', 'sync-runtime']);
    expect(where((p) => p.write.generatedFields !== 'passed-through')).toEqual([
      'sveltekit-emitted',
    ]);
  });

  it('in-process MCP sets ownership keys', () => {
    expect(
      where(
        (p) =>
          p.write.serverSetKeys.create.length +
            p.write.serverSetKeys.update.length >
          0,
      ),
    ).toEqual(['mcp-inprocess']);
  });

  it('sync creates are insert-only', () => {
    expect(where((p) => p.create.conflict === 'insert-only')).toEqual([
      'sync-runtime',
      'sync-emitted',
    ]);
  });

  it('the CLI prints toJSON output', () => {
    expect(where((p) => p.serialize.item === 'toJSON')).toEqual(['cli']);
  });

  it('filter keys are validated by the collection on every transport', () => {
    for (const id of LEGACY_TRANSPORTS) {
      expect(LEGACY_PROFILES[id].query.filterFieldAccess).toBe(
        'collection-rules',
      );
    }
  });

  it('the two emitted MCP servers page differently', () => {
    expect(LEGACY_MCP_EMITTED_MODULAR.query).toMatchObject({
      bounds: 'unvalidated-default-50',
      orderBy: 'never',
    });
    expect(LEGACY_MCP_EMITTED_SINGLE.query).toMatchObject({
      bounds: 'inline-parser',
      orderBy: 'caller-or-default',
    });
  });

  it('tenant handling covers every operation on six transports', () => {
    expect(where((p) => p.tenant.operations !== 'all')).toEqual([
      'rest-runtime',
      'sync-runtime',
      'cli',
    ]);
  });

  it('error rendering differs between HTTP and the other surfaces', () => {
    expect(where((p) => p.errors.messageVisible === 'typed-4xx-only')).toEqual([
      'rest-runtime',
      'sveltekit-emitted',
    ]);
    expect(where((p) => p.errors.render === 'message-shown')).toEqual([
      'mcp-inprocess',
      'mcp-emitted-single',
      'mcp-emitted-modular',
      'cli',
    ]);
  });

  it('three transports check an operation permission', () => {
    expect(
      where((p) => p.authorization.operationPermission !== 'none'),
    ).toEqual(['sveltekit-emitted', 'sync-emitted', 'chat-tool-loop']);
  });

  it('six transports always look a model up by registry key', () => {
    expect(where((p) => p.lookup.policyName !== 'registry-key')).toEqual([
      'rest-runtime',
      'sync-runtime',
      'cli',
    ]);
  });

  it('records the list shape of every transport', () => {
    expect(
      Object.fromEntries(
        LEGACY_TRANSPORTS.map((id) => [id, LEGACY_PROFILES[id].results.list]),
      ),
    ).toEqual({
      'rest-runtime': 'bare-array',
      'sveltekit-emitted': 'items-count-limit-offset',
      'mcp-inprocess': 'data-meta',
      'mcp-emitted-single': 'data-meta-with-array-text',
      'mcp-emitted-modular': 'data-meta-with-array-text',
      'sync-runtime': 'n/a',
      'sync-emitted': 'n/a',
      cli: 'printed',
      'chat-tool-loop': 'bare-array',
    });
  });

  it('runtime REST accepts PATCH and generated routes do not', () => {
    expect(LEGACY_REST.results.updateMethods).toEqual(['PUT', 'PATCH']);
    expect(LEGACY_SVELTEKIT.results.updateMethods).toEqual(['PUT']);
  });
});
