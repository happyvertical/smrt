/**
 * The served-surface gate (scripts/check-served-surface.mjs) records each REST
 * action's verb, route, auth and permission from the route emitter's own
 * resolvers. This pins that record against the handlers the SvelteKit
 * generator actually emits, unmodified, for a fixture with a model and a
 * collection receiver, a sensitive pair, GET and POST actions, a route path
 * override, an operation-permission alias, a collection over an abstract
 * item, and each `api.public` posture. The permission is checked by running
 * the emitted permission guard with principals holding the recorded slug and
 * a different one; the CRUD write handlers' guard is run the same way against
 * the recorded `crudPermission`. MCP and CLI need no cross-check: the gate reads the tools
 * and commands those generators emit.
 */
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The gate's REST inventory, the same module its worker runs.
import { restSurface } from '../../../../../scripts/lib/served-surface-rest.mjs';
import * as core from '../../index';
import type { SmartObjectManifest } from '../../scanner/types';
import { resolvePermissionCollection } from '../route-policy';
import {
  resolveApiActionRouteConfig,
  resolveApiCustomActions,
  resolveCollectionItemObject,
} from '../web-collections';

vi.mock('node:fs', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

import { generateSvelteKitRoutes } from '../sveltekit-generator';

const resolvers = {
  exposedCrudVerbs: core.exposedCrudVerbs,
  resolveOperationPermissionAlias: core.resolveOperationPermissionAlias,
  resolveApiCustomActions,
  resolveApiActionRouteConfig,
  resolveCollectionItemObject,
  resolvePermissionCollection,
};

const method = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  async: true,
  parameters: [],
  returnType: 'Promise<unknown>',
  isStatic: false,
  isPublic: true,
  ...extra,
});

type Posture = false | 'read' | true;

function manifest(
  posture: Posture,
  { abstractShape = true }: { abstractShape?: boolean } = {},
): SmartObjectManifest {
  const api = (extra: Record<string, unknown> = {}) => ({
    ...extra,
    ...(posture === false ? {} : { public: posture }),
  });
  return {
    version: '1.0.0',
    objects: {
      '@cross/app:Ticket': {
        name: 'ticket',
        qualifiedName: '@cross/app:Ticket',
        className: 'Ticket',
        collection: 'tickets',
        filePath: '/cross/src/Ticket.ts',
        fields: { title: { type: 'text' } },
        methods: {
          peek: method('peek', { decoratorConfig: { httpMethod: 'GET' } }),
          close: method('close'),
          reopen: method('reopen'),
          tally: method('tally', {
            isStatic: true,
            decoratorConfig: { httpMethod: 'GET' },
          }),
        },
        decoratorConfig: {
          api: api({ routes: { reopen: { path: 'revive' } } }),
          operationPermissions: { close: { action: 'update' } },
        },
      },
      '@cross/app:TicketCollection': {
        name: 'ticketcollection',
        qualifiedName: '@cross/app:TicketCollection',
        className: 'TicketCollection',
        collection: 'tickets',
        filePath: '/cross/src/TicketCollection.ts',
        extends: 'SmrtCollection',
        extendsTypeArg: 'Ticket',
        collectionOf: '@cross/app:Ticket',
        fields: {},
        methods: {
          sweep: method('sweep'),
          summary: method('summary', {
            decoratorConfig: { httpMethod: 'GET' },
          }),
        },
        decoratorConfig: {
          api: api({ include: ['list', 'sweep', 'summary'] }),
        },
      },
      '@cross/app:Secret': {
        name: 'secret',
        qualifiedName: '@cross/app:Secret',
        className: 'Secret',
        collection: 'secrets',
        filePath: '/cross/src/Secret.ts',
        fields: { value: { type: 'text' } },
        methods: { rotate: method('rotate') },
        decoratorConfig: { sensitive: true, api: api() },
      },
      '@cross/app:Shape': {
        name: 'shape',
        qualifiedName: '@cross/app:Shape',
        className: 'Shape',
        collection: 'shapes',
        filePath: '/cross/src/Shape.ts',
        fields: { label: { type: 'text' } },
        methods: {},
        decoratorConfig: {
          ...(abstractShape ? { abstract: true } : {}),
          api: api({ include: ['list', 'get'] }),
        },
      },
      '@cross/app:ShapeCollection': {
        name: 'shapecollection',
        qualifiedName: '@cross/app:ShapeCollection',
        className: 'ShapeCollection',
        collection: 'shapes',
        filePath: '/cross/src/ShapeCollection.ts',
        extends: 'SmrtCollection',
        extendsTypeArg: 'Shape',
        collectionOf: '@cross/app:Shape',
        fields: {},
        methods: { recount: method('recount') },
        decoratorConfig: { api: api({ include: ['list', 'recount'] }) },
      },
    },
  } as unknown as SmartObjectManifest;
}

interface RecordedAction {
  verb: string;
  route: string;
  auth: 'open' | 'required';
  permission: string | false;
}

/** The emitted permission guard, compiled from the handler's own source. */
function emittedPermissionGuard(
  source: string,
  action: string,
): (locals: unknown) => boolean {
  const take = (name: string) => {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`emitted ${name} not found`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0)
        return source.slice(start, i + 1);
    }
    throw new Error(`emitted ${name} is unbalanced`);
  };
  const constant = (name: string) =>
    source.match(new RegExp(`const ${name}[^=]*= (.+);`))?.[1] ?? 'undefined';
  const program = [
    `const PUBLIC_ACCESS = ${constant('PUBLIC_ACCESS')};`,
    `const PERMISSION_COLLECTION = ${constant('PERMISSION_COLLECTION')};`,
    take('readJsonRecord'),
    take('hasGrantedPermission'),
    take('requireRoutePermission'),
  ].join('\n');
  const js = ts.transpileModule(program, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const guard = new Function(
    'error',
    'action',
    `${js}\nreturn (locals) => requireRoutePermission(locals, action);`,
  )((status: number) => {
    throw Object.assign(new Error('denied'), { status });
  }, action) as (locals: unknown) => void;
  return (locals) => {
    try {
      guard(locals);
      return true;
    } catch (failure) {
      if ((failure as { status?: number }).status === 403) return false;
      throw failure;
    }
  };
}

/** Action handlers by route directory, read from the emitted source. */
function emittedActions(): Map<
  string,
  Omit<RecordedAction, 'route' | 'permission'> & {
    guardAction: string | undefined;
    source: string;
  }
> {
  const actions = new Map();
  for (const call of vi.mocked(writeFileSync).mock.calls) {
    const file = String(call[0]);
    const source = String(call[1]);
    const match = file.match(/routes\/api\/(.+)\/\+server\.ts$/);
    if (!match) continue;
    const route = match[1];
    // CRUD route files are not action routes.
    if (!/requireRouteAuth\(locals, (true|false)\);/.test(source)) continue;
    if (/^[^/]+(\/\[id\])?$/.test(route)) continue;
    const publicAccess = JSON.parse(
      source.match(/const PUBLIC_ACCESS: boolean \| 'read' = (.+);/)?.[1] ??
        'false',
    ) as Posture;
    const handler = source.match(
      /export const (GET|POST|PUT|PATCH|DELETE)[\s\S]*?requireRouteAuth\(locals, (true|false)\);([\s\S]*?)\n\s*\n/,
    );
    if (!handler) continue;
    const [, verb, mutating, rest] = handler;
    const open =
      publicAccess === true ||
      (publicAccess === 'read' && mutating === 'false');
    actions.set(route, {
      verb,
      auth: open ? 'open' : 'required',
      guardAction: rest.match(
        /requireRoutePermission\(locals, "([^"]+)"\)/,
      )?.[1],
      source,
    });
  }
  return actions;
}

async function emitAndRecord(fixture: SmartObjectManifest) {
  await generateSvelteKitRoutes('/cross', fixture, {
    enabled: true,
    routesDir: 'src/routes/api',
    objectsDir: 'src/lib/objects',
    configPath: 'src/lib/server',
    configFileName: 'smrt.ts',
  });
  const recorded = new Map<string, RecordedAction>();
  for (const def of Object.values(fixture.objects)) {
    const surface = restSurface(resolvers, {
      definition: def,
      manifest: fixture,
      isCollection: Boolean(def.collectionOf),
      isModelClassName: (name: string) =>
        Object.values(fixture.objects).some((o) => o.className === name),
    });
    for (const action of Object.values(
      (surface && surface.actions) || {},
    ) as RecordedAction[])
      recorded.set(action.route, action);
  }
  return { recorded, emitted: emittedActions() };
}

describe('served-surface REST inventory matches the emitted SvelteKit handlers', () => {
  beforeEach(() => vi.mocked(writeFileSync).mockClear());

  for (const posture of [false, 'read', true] as const) {
    it(`route, verb, auth and permission per action (public ${String(posture)})`, async () => {
      const { recorded, emitted } = await emitAndRecord(manifest(posture));
      expect(recorded.size).toBeGreaterThanOrEqual(6);
      expect([...recorded.keys()].sort()).toEqual([...emitted.keys()].sort());
      for (const [route, action] of recorded) {
        const handler = emitted.get(route);
        expect(handler, route).toBeDefined();
        expect({ verb: handler?.verb, auth: handler?.auth }, route).toEqual({
          verb: action.verb,
          auth: action.auth,
        });
        // The permission identity, by running the emitted guard.
        if (!handler?.guardAction) {
          expect(action.permission, route).toBe(false);
          continue;
        }
        const allows = emittedPermissionGuard(
          handler.source,
          handler.guardAction,
        );
        if (action.permission === false) {
          expect(posture, route).toBe(true);
          expect(allows({ permissions: [] }), route).toBe(true);
          continue;
        }
        expect(allows({ permissions: [action.permission] }), route).toBe(true);
        expect(allows({ permissions: [`${action.permission}x`] }), route).toBe(
          false,
        );
      }
    });
  }

  it('an operation-permission alias, a route override and a collection’s item slug are what the handlers enforce', async () => {
    const { recorded, emitted } = await emitAndRecord(manifest(false));
    expect(recorded.get('tickets/[id]/close')?.permission).toBe(
      'tickets.update',
    );
    expect(recorded.get('tickets/[id]/revive')?.permission).toBe(
      'tickets.reopen',
    );
    expect(recorded.get('tickets/sweep')?.permission).toBe('tickets.sweep');
    const close = emitted.get('tickets/[id]/close');
    const allows = emittedPermissionGuard(
      close?.source ?? '',
      close?.guardAction ?? '',
    );
    // The alias admits holders of the update permission, not of close.
    expect(allows({ permissions: ['tickets.update'] })).toBe(true);
    expect(allows({ permissions: ['tickets.close'] })).toBe(false);
  });

  it('CRUD write handlers enforce the recorded permission collection, a hosted subclass’s included', async () => {
    const fixture = manifest(false);
    const objects = fixture.objects as unknown as Record<
      string,
      Record<string, unknown>
    >;
    objects['@cross/app:Case'] = {
      name: 'case',
      qualifiedName: '@cross/app:Case',
      className: 'Case',
      collection: 'cases',
      permissionCollection: 'records',
      filePath: '/cross/src/Case.ts',
      fields: { title: { type: 'text' } },
      methods: {},
      decoratorConfig: { api: {} },
    };
    await generateSvelteKitRoutes('/cross', fixture, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    });
    const crudFiles = new Map<string, string>();
    for (const call of vi.mocked(writeFileSync).mock.calls) {
      const match = String(call[0]).match(/routes\/api\/(.+)\/\+server\.ts$/);
      if (match && /^[^/]+(\/\[id\])?$/.test(match[1]))
        crudFiles.set(match[1], String(call[1]));
    }
    let guarded = 0;
    for (const [key, route] of [
      ['@cross/app:Case', 'cases'],
      ['@cross/app:Ticket', 'tickets'],
    ] as const) {
      const surface = restSurface(resolvers, {
        definition: fixture.objects[key],
        manifest: fixture,
        isCollection: false,
      }) as { crud?: string[]; crudPermission?: string } | false;
      expect(surface && surface.crudPermission, key).toBe(
        route === 'cases' ? 'records' : 'tickets',
      );
      for (const file of [route, `${route}/[id]`]) {
        const source = crudFiles.get(file);
        expect(source, file).toBeDefined();
        for (const verb of ['create', 'update', 'delete']) {
          if (!source?.includes(`requireRoutePermission(locals, "${verb}")`))
            continue;
          guarded++;
          const allows = emittedPermissionGuard(source, verb);
          const recorded = `${surface && surface.crudPermission}.${verb}`;
          expect(allows({ permissions: [recorded] }), `${file} ${verb}`).toBe(
            true,
          );
          if (route === 'cases')
            expect(
              allows({ permissions: [`cases.${verb}`] }),
              `${file} ${verb}`,
            ).toBe(false);
        }
      }
    }
    // Both resources' create, update and delete handlers were run.
    expect(guarded).toBe(6);
  });

  it('a collection over an abstract item emits no action; the concrete item emits it and the record follows', async () => {
    const abstract = await emitAndRecord(manifest(false));
    expect(abstract.recorded.has('shapes/recount')).toBe(false);
    expect(abstract.emitted.has('shapes/recount')).toBe(false);
    vi.mocked(writeFileSync).mockClear();
    const concrete = await emitAndRecord(
      manifest(false, { abstractShape: false }),
    );
    expect(concrete.recorded.get('shapes/recount')?.verb).toBe('POST');
    expect(concrete.emitted.get('shapes/recount')?.verb).toBe('POST');
  });
});
