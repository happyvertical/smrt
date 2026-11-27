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

import { existsSync, writeFileSync } from 'node:fs';
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
import { generateEventsRoute as generateEventsRouteInto } from './events-route';
import { RouteFilePlan } from './generated-route-files';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header';
import type { SvelteKitOptions } from './sveltekit-generator';

const projectRoot = '/test/project';

// The writer renders into the route-file plan and never touches the disk.
let plan = new RouteFilePlan();
const generateEventsRoute = (
  root: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
  webManifestHash?: string,
) => generateEventsRouteInto(root, manifest, options, plan, webManifestHash);

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
  const entry = plan.entries().at(-1);
  expect(entry).toBeDefined();
  return String(entry?.content);
}

describe('generateEventsRoute (#1763)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    plan = new RouteFilePlan();
  });

  it('emits an auth-guarded _events route anchored on the first object', () => {
    const generated = generateEventsRoute(
      projectRoot,
      buildManifest({
        Zebra: {
          className: 'Zebra',
          name: 'Zebra',
          filePath: '',
          collection: 'zebras',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
        Apple: {
          className: 'Apple',
          name: 'Apple',
          filePath: '',
          collection: 'apples',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );

    expect(generated).toBe(true);
    expect(plan.entries().map(({ routeDir }) => routeDir)).toEqual([
      join(projectRoot, 'src/routes/api', '_events'),
    ]);
    expect(writeFileSync).not.toHaveBeenCalled();

    const content = writtenRouteContent();
    // Cleanup pass recognizes generated files by this exact header.
    expect(content.startsWith(AUTO_GENERATED_ROUTE_HEADER)).toBe(true);
    // Fail-closed auth: guard is present and there is no public bypass.
    expect(content).toContain('requireRouteAuth(locals)');
    // The shared sign-in decision REST makes for the feed (#5195): 401
    // AUTHENTICATION_REQUIRED, never public, no feed-specific copy of the rule.
    expect(content).toContain('authorize({');
    expect(content).toContain('apiPrincipalFromLocals(locals)');
    expect(content).toContain("permissionCollection: '_feed'");
    expect(content).toContain('publicAccess: false');
    expect(content).toContain('throw error(decision.status, body);');
    // Never an object literal carrying `code`: `error()` rejects it (App.Error).
    expect(content).not.toMatch(/error\(\s*[^,()]+,\s*\{[^}]*code/);
    expect(content).not.toContain('hasAuthenticatedPrincipal');
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
          name: 'Doc',
          filePath: '',
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
      "import {\n  apiPrincipalFromLocals,\n  authorize,\n  buildChangeEventStream,\n  enforceRouteLimits,\n  eventStreamCapacityExceededResponse,\n  getRequestTenantContext,\n  resolveDispatchTenantScope,\n  tryReserveChangeEventSubscriberSlot,\n} from '@happyvertical/smrt-core'",
    );
    expect(content).toContain('const MANIFEST_HASH = undefined;');
    expect(content).toContain(
      'const releaseSubscriberSlot = tryReserveChangeEventSubscriberSlot(collection.db)',
    );
    expect(content).toContain(
      'buildChangeEventStream(collection.db, {\n      cursor,\n      tenantScope,\n      manifestHash: MANIFEST_HASH,\n      releaseSubscriberSlot,\n      locals,\n      request,\n    })',
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
          name: 'Doc',
          filePath: '',
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
          name: 'Doc',
          filePath: '',
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
          name: 'Account',
          filePath: '',
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
        name: 'Doc',
        filePath: '',
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
        name: 'Doc',
        filePath: '',
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
          name: 'AardvarkCollection',
          filePath: '',
          collection: 'aardvarks',
          fields: {},
          methods: {},
          decoratorConfig: {},
          extends: 'SmrtCollection',
        },
        Bird: {
          className: 'Bird',
          name: 'Bird',
          filePath: '',
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

  describe('cross-origin CORS emission (#1861)', () => {
    const docManifest = () =>
      buildManifest({
        Doc: {
          className: 'Doc',
          name: 'Doc',
          filePath: '',
          collection: 'docs',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      });

    it('emits no CORS surface by default (same-origin only)', () => {
      generateEventsRoute(projectRoot, docManifest(), baseOptions);
      const content = writtenRouteContent();
      expect(content).not.toContain('Access-Control-Allow-Origin');
      expect(content).not.toContain('ROUTE_CORS');
      expect(content).not.toContain('export const OPTIONS');
      // The default output still carries the same-origin note.
      expect(content).toContain('Same-origin only unless an origin allowlist');
    });

    it('wraps the route in the shared CORS policy when an allowlist is configured', () => {
      generateEventsRoute(projectRoot, docManifest(), {
        ...baseOptions,
        eventsRoute: {
          allowedOrigins: ['https://widget.example', 'https://app.example'],
          allowCredentials: true,
        },
      });
      const content = writtenRouteContent();
      // Through `generators/cors.ts`, as every other generated route (#5195):
      // the origin is echoed only when allow-listed, never `*`.
      expect(content).toContain(
        'const ROUTE_CORS = {"allowedOrigins":["https://widget.example","https://app.example"],"allowCredentials":true}',
      );
      expect(content).toContain('applyCorsHeaders(');
      expect(content).toContain('corsPreflightResponse(request, ROUTE_CORS)');
      expect(content).toContain(
        'export const GET: RequestHandler = withRouteCors(GETHandler)',
      );
      expect(content).toContain('export const OPTIONS: RequestHandler');
      // No copy of the policy in the route itself.
      expect(content).not.toContain('CORS_ALLOWED_ORIGINS');
      expect(content).not.toContain('eventsCorsHeaders');
      expect(content).not.toContain("'Access-Control-Allow-Origin': '*'");
    });

    it('does not add credentials unless allowCredentials is opted in', () => {
      generateEventsRoute(projectRoot, docManifest(), {
        ...baseOptions,
        eventsRoute: { allowedOrigins: ['https://widget.example'] },
      });
      const content = writtenRouteContent();
      expect(content).toContain(
        'const ROUTE_CORS = {"allowedOrigins":["https://widget.example"],"allowCredentials":false}',
      );
    });

    it('inherits sveltekit.cors when the route sets no allowlist of its own', () => {
      generateEventsRoute(projectRoot, docManifest(), {
        ...baseOptions,
        cors: { allowedOrigins: ['https://app.example'] },
      });
      expect(writtenRouteContent()).toContain(
        'const ROUTE_CORS = {"allowedOrigins":["https://app.example"],"allowCredentials":false}',
      );
    });

    it('lets its own allowlist win over sveltekit.cors', () => {
      generateEventsRoute(projectRoot, docManifest(), {
        ...baseOptions,
        cors: { allowedOrigins: ['https://app.example'] },
        eventsRoute: { allowedOrigins: ['https://widget.example'] },
      });
      const content = writtenRouteContent();
      expect(content).toContain('https://widget.example');
      expect(content).not.toContain('https://app.example');
    });

    it('allowedOrigins: [] keeps the stream same-origin whatever sveltekit.cors allows', () => {
      generateEventsRoute(projectRoot, docManifest(), {
        ...baseOptions,
        cors: { allowedOrigins: ['https://app.example'] },
        eventsRoute: { allowedOrigins: [] },
      });
      const content = writtenRouteContent();
      expect(content).not.toContain('ROUTE_CORS');
      expect(content).not.toContain('export const OPTIONS');
    });

    it('treats a whitespace-only / empty allowlist as unconfigured (fail-closed)', () => {
      generateEventsRoute(projectRoot, docManifest(), {
        ...baseOptions,
        eventsRoute: { allowedOrigins: ['   ', ''], allowCredentials: true },
      });
      const content = writtenRouteContent();
      expect(content).not.toContain('ROUTE_CORS');
      expect(content).not.toContain('export const OPTIONS');
    });
  });

  it('skips generation when disabled or when there is nothing to anchor on', () => {
    const manifest = buildManifest({
      Doc: {
        className: 'Doc',
        name: 'Doc',
        filePath: '',
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
    expect(plan.entries()).toEqual([]);

    expect(
      generateEventsRoute(projectRoot, buildManifest({}), baseOptions),
    ).toBe(false);
    expect(plan.entries()).toEqual([]);
  });
});
