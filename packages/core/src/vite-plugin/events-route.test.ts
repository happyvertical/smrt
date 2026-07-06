/**
 * Tests for the generated SvelteKit `_events` SSE route (issue #1763).
 *
 * Tests the generator, not the generated output at runtime (matching the
 * changes-route generator test approach): fixture manifest in, assert the
 * emitted route file's location and load-bearing content — fail-closed auth
 * guard, tenant-context establishment, database anchoring, and that the file
 * stays THIN (delegates the stream lifecycle to core's buildChangeEventStream
 * rather than duplicating SSE framing/subscribe logic).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

// Mock node:fs module (same pattern as changes-route.test.ts)
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocking
import { generateEventsRoute } from './events-route';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header';
import type { SvelteKitOptions } from './sveltekit-generator';

const projectRoot = '/test/project';

const baseOptions: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
};

function buildManifest(
  objects: SmartObjectManifest['objects'],
): SmartObjectManifest {
  return { objects } as SmartObjectManifest;
}

function writtenRouteContent(): string {
  const call = vi
    .mocked(writeFileSync)
    .mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].endsWith('+server.ts'),
    );
  expect(call).toBeDefined();
  return String(call?.[1]);
}

describe('generateEventsRoute (#1763)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('emits an auth-guarded _events route anchored on the first object', () => {
    const generated = generateEventsRoute(
      projectRoot,
      buildManifest({
        Zebra: {
          className: 'Zebra',
          collection: 'zebras',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
        Apple: {
          className: 'Apple',
          collection: 'apples',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );

    expect(generated).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith(
      join(projectRoot, 'src/routes/api', '_events'),
      { recursive: true },
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(projectRoot, 'src/routes/api', '_events', '+server.ts'),
      expect.any(String),
      'utf-8',
    );

    const content = writtenRouteContent();
    // Cleanup pass recognizes generated files by this exact header.
    expect(content.startsWith(AUTO_GENERATED_ROUTE_HEADER)).toBe(true);
    // Fail-closed auth: guard is present and there is no public bypass.
    expect(content).toContain('requireRouteAuth(locals)');
    expect(content).toContain("throw error(401, 'Authentication required')");
    expect(content).not.toContain('PUBLIC_ACCESS');
    // Anchored on the alphabetically first non-collection class.
    expect(content).toContain("getCollection('Apple')");
  });

  it('imports the core stream builder and does NOT duplicate the SSE logic', () => {
    generateEventsRoute(
      projectRoot,
      buildManifest({
        Doc: {
          className: 'Doc',
          collection: 'docs',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );
    const content = writtenRouteContent();

    // The stream lifecycle lives in core — the route imports and delegates.
    expect(content).toContain(
      "import {\n  buildChangeEventStream,\n  eventStreamCapacityExceededResponse,\n  resolveDispatchTenantScope,\n  tryReserveChangeEventSubscriberSlot,\n} from '@happyvertical/smrt-core'",
    );
    expect(content).toContain('const MANIFEST_HASH = undefined;');
    expect(content).toContain(
      'const releaseSubscriberSlot = tryReserveChangeEventSubscriberSlot(collection.db)',
    );
    expect(content).toContain(
      'buildChangeEventStream(collection.db, {\n      cursor,\n      tenantScope,\n      manifestHash: MANIFEST_HASH,\n      releaseSubscriberSlot,\n    })',
    );
    // It streams over an event-stream response.
    expect(content).toContain("'Content-Type': 'text/event-stream'");
    // It must NOT re-implement the framing / subscription that core owns.
    expect(content).not.toContain('ReadableStream');
    expect(content).not.toContain('subscribeToChangeSignals');
    expect(content).not.toContain('encodeSseEvent');
    // GET only — the stream is read-only over HTTP.
    expect(content).toContain('export const GET: RequestHandler');
    expect(content).not.toContain('export const POST');
  });

  it('threads a configured per-process subscriber cap into the emitted route', () => {
    generateEventsRoute(
      projectRoot,
      buildManifest({
        Doc: {
          className: 'Doc',
          collection: 'docs',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      { ...baseOptions, eventsRoute: { maxSubscribers: 42 } },
    );

    const content = writtenRouteContent();
    expect(content).toContain(
      'tryReserveChangeEventSubscriberSlot(collection.db, 42)',
    );
    expect(content).toContain('eventStreamCapacityExceededResponse()');
  });

  it('honors Last-Event-ID precedence over ?since= in the emitted cursor parse', () => {
    generateEventsRoute(
      projectRoot,
      buildManifest({
        Doc: {
          className: 'Doc',
          collection: 'docs',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );
    const content = writtenRouteContent();
    // Last-Event-ID is checked before ?since= — reconnection resumes exactly.
    const lastEventIdx = content.indexOf("headers.get('Last-Event-ID')");
    const sinceIdx = content.indexOf("searchParams.get('since')");
    expect(lastEventIdx).toBeGreaterThan(-1);
    expect(sinceIdx).toBeGreaterThan(-1);
    expect(lastEventIdx).toBeLessThan(sinceIdx);
  });

  it('anchors on the verbatim manifest registry key, not the bare className', () => {
    generateEventsRoute(
      projectRoot,
      buildManifest({
        '@happyvertical/smrt-ledgers:Account': {
          className: 'Account',
          collection: 'accounts',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );
    const content = writtenRouteContent();
    expect(content).toContain(
      "getCollection('@happyvertical/smrt-ledgers:Account')",
    );
    expect(content).not.toContain("getCollection('Account')");
  });

  it('establishes tenant context only when the project has tenant-scoped objects', () => {
    const scoped = buildManifest({
      Doc: {
        className: 'Doc',
        collection: 'docs',
        fields: {},
        methods: {},
        decoratorConfig: { api: true, tenantScoped: true },
      },
    });
    generateEventsRoute(projectRoot, scoped, baseOptions);
    const withTenancy = writtenRouteContent();
    expect(withTenancy).toContain('establishTenantContext(locals)');
    expect(withTenancy).toContain("from '@happyvertical/smrt-tenancy'");

    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);

    const unscoped = buildManifest({
      Doc: {
        className: 'Doc',
        collection: 'docs',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
    });
    generateEventsRoute(projectRoot, unscoped, baseOptions);
    const withoutTenancy = writtenRouteContent();
    expect(withoutTenancy).not.toContain('establishTenantContext');
    expect(withoutTenancy).not.toContain('@happyvertical/smrt-tenancy');
  });

  it('never anchors on a collection class', () => {
    generateEventsRoute(
      projectRoot,
      buildManifest({
        AardvarkCollection: {
          className: 'AardvarkCollection',
          collection: 'aardvarks',
          fields: {},
          methods: {},
          decoratorConfig: {},
          extends: 'SmrtCollection',
        },
        Bird: {
          className: 'Bird',
          collection: 'birds',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );
    expect(writtenRouteContent()).toContain("getCollection('Bird')");
  });

  it('skips generation when disabled or when there is nothing to anchor on', () => {
    const manifest = buildManifest({
      Doc: {
        className: 'Doc',
        collection: 'docs',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
    });

    expect(
      generateEventsRoute(projectRoot, manifest, {
        ...baseOptions,
        eventsRoute: { enabled: false },
      }),
    ).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();

    expect(
      generateEventsRoute(projectRoot, buildManifest({}), baseOptions),
    ).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
