// biome-ignore-all lint/suspicious/noTemplateCurlyInString: pins quote generator templates verbatim, placeholders included.
/**
 * Source pins for the legacy transport profiles (#5158).
 *
 * `../profile.ts` describes how each transport behaves today. A profile cell
 * is only true while the code it was read from stays as it was, so each pin
 * below names the lines a group of cells rests on. When a transport changes
 * before it has moved onto the kernel, the matching pin fails: re-read the
 * transport, correct the profile, then update the pin.
 *
 * A pin is evidence, not behaviour. Removing a profile table removes its pins.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGACY_TRANSPORT_SOURCES, LEGACY_TRANSPORTS } from '../profile';
import type { LegacyTransportId } from '../types';

const PACKAGES = new URL('../../../../', import.meta.url);
const cache = new Map<string, string>();
const source = (path: string): string => {
  let text = cache.get(path);
  if (text === undefined) {
    text = readFileSync(new URL(path, PACKAGES), 'utf8');
    cache.set(path, text);
  }
  return text;
};

interface Pin {
  /** Profile cells this evidence backs. */
  backs: string;
  /** Path relative to `packages/`; defaults to the transport's own source. */
  file?: string;
  present: string[];
  absent?: string[];
}

const REST = 'core/src/generators/rest.ts';
const KIT = 'core/src/vite-plugin/sveltekit-generator.ts';
const MCP = 'core/src/generators/mcp.ts';
const SYNC_ENGINE = 'core/src/sync/apply.ts';

const PINS: Record<LegacyTransportId, Pin[]> = {
  'rest-runtime': [
    {
      backs: 'write',
      present: [
        "readonly.add('displayLabel');",
        'for (const [name, def] of ObjectRegistry.getFields(objectName)) {',
        "if (key.startsWith('_')) continue;",
        'if (writable && !writable.includes(key)) continue;',
        'Object.assign(bound, data);',
        'await collection.delete(id);',
      ],
      absent: ['generatedExpression', 'serializers'],
    },
    {
      backs: 'serialize',
      present: [
        "return typeof serializable?.toPublicJSON === 'function'",
        'return { permissions: this.context.permissions };',
      ],
    },
    {
      backs: 'create, results.create',
      present: [
        'const object = await collection.create({ ...writable, _skipLoad: true });',
        'return this.createJsonResponse(this.toPublicData(object), 201);',
      ],
    },
    {
      backs: 'query, operations.count',
      present: [
        "const limit = resolveListLimit(params.get('limit'));",
        'const where = parseRestListWhere(params);',
        ': this.resolveDefaultListOrderBy(objectName);',
        "if (objectId === 'count' && req.method === 'GET') {",
        'return this.createJsonResponse({ count });',
        '...(displayLabel ? { displayLabel: true } : {}),',
      ],
    },
    {
      backs: 'tenant',
      present: [
        'const scope = resolveDispatchTenantScope();',
        "if (field === 'tenantId' || field === 'tenant_id') {",
        'cleaned.tenantId = null;',
        'isTenantScopedClassResolved(objectName)',
        // Update and delete look the row up by id.
        'const object = await collection.get(id);',
      ],
      absent: ['runWithTenantGate', 'enterTenantContext'],
    },
    {
      backs: 'errors',
      present: [
        'const failure = normalizeTypedHttpError(error);',
        'reportUnexpectedHttpError(error, req),',
        'return new Response(JSON.stringify({ error: message }), {',
      ],
    },
    {
      backs: 'authorization',
      present: [
        'req.method.toLowerCase(),',
        '} else if (!this.isRoutePublic(objectName, req.method)) {',
        'const customResponse = await this.dispatchCustomCollectionAction(',
        'if (action && !this.isApiActionEnabled(objectName, action)) {',
        "return this.createErrorResponse(401, 'Authentication required');",
      ],
    },
    {
      backs: 'lookup',
      present: [
        'return registered?.qualifiedName || registered?.name || itemClass.name;',
        'const classInfo = this.findClassByCollectionSegment(objectType);',
        'if (info.collection === segment) {',
        'classInfo.qualifiedName ?? classInfo.name,',
        'if (this.collections.has(objectType)) {',
      ],
    },
    {
      backs: 'sti',
      present: [
        'const target = ObjectRegistry.resolveCreateTarget(objectName, body, {',
        'const writable = this.applyWritablePolicy(targetName, data);',
      ],
    },
    {
      backs: 'results',
      present: [
        'return objects.map((object: SmrtObject) => this.toPublicData(object));',
        'return new Response(null, { status: 204 });',
        "return this.createErrorResponse(404, 'Object not found');",
        "case 'PATCH':",
      ],
    },
    {
      backs: 'body',
      present: [
        'body = await this.streamToString(req);',
        'const body = await req.json();',
        'const data = this.applyWritablePolicy(objectName, await req.json());',
      ],
    },
  ],

  'sveltekit-emitted': [
    {
      backs: 'write',
      present: [
        'generatedExpression(def) !== undefined',
        "...(objectDef.displayLabelProjection ? ['displayLabel'] : []),",
        'const readonlyFields = targetName ? [...ObjectRegistry.getFields(targetName)]',
        "if (key.startsWith('_')) continue;",
        'Object.assign(bound, data);',
        "await collection.withAuditMutation(item, 'updated', async (bound) => {",
        'await collection.delete(params.id);',
      ],
    },
    {
      backs: 'serialize',
      present: [
        'const permissions = l.permissions ?? l.permissionSet ?? l.smrtPermissions;',
        'return json(item.toPublicJSON(publicJsonOptions), { status: 201 });',
        'applyReadPermissionRedaction(serializedItem, publicJsonOptions),',
        'await ${serializers.listItemSerializerName}(item),',
      ],
    },
    {
      backs: 'create',
      present: ['const item = await collection.create(data);'],
      absent: ['_insertOnly'],
    },
    {
      backs: 'query, operations.count',
      present: [
        'function listBounds(url: URL): { limit: number; offset: number } {',
        "const orderBy = url.searchParams.get('orderBy') || LIST_ORDER_BY;",
        'const count = await collection.count({ where });',
        "${objectDef.displayLabelProjection ? ', displayLabel: true' : ''}",
      ],
    },
    {
      backs: 'tenant',
      present: [
        'return !!objectDef.decoratorConfig?.tenantScoped;',
        'const tenantId = l.tenantId ?? user?.tenantId ?? session?.tenantId ?? tenantContext?.tenantId;',
        "throw error(403, 'Tenant context does not match authenticated principal');",
        "throw error(403, 'Authenticated principal context is incomplete');",
        "${isTenantScoped(objectDef) ? ', ...tenantReadScope()' : ''}",
        "lines.push('  establishTenantContext(locals);');",
      ],
    },
    {
      backs: 'errors, body',
      present: [
        'function smrtRouteErrorResponse(cause: unknown, request: Request) {',
        'const body: unknown = await request.json();',
        "throw error(404, 'Not found');",
      ],
    },
    {
      backs: 'authorization',
      present: [
        'isResolvedPrincipal(l.user) ||',
        'if (PUBLIC_ACCESS === true) return;',
        "if (PUBLIC_ACCESS === 'read' && !mutating) return;",
        'if (tenantContext.superAdminBypass === true) return;',
        'hasGrantedPermission(tenantContext.permissions, permission);',
        "throw error(403, 'Permission denied');",
        "const mutating = routeConfig.method !== 'GET';",
      ],
    },
    {
      backs: 'lookup, sti',
      present: [
        "const target = ObjectRegistry.resolveCreateTarget('${className}', body, {",
        "const data = applyWritablePolicy(target.data, target.collectionName === '${className}' ? undefined : target.name);",
        "`    '${className}',`,",
      ],
    },
    {
      backs: 'results',
      present: [
        'return conditionalJson(request, { items: items_public, count, limit, offset });',
        'return json({ success: true });',
        'export const PUT: RequestHandler = async ({ locals, params, request }) => {',
      ],
      absent: ['export const PATCH'],
    },
  ],

  'mcp-inprocess': [
    {
      backs: 'write',
      present: [
        'createData.created_by = this.context.user.id;',
        'createData.owner_id = this.context.user.id;',
        '(bound as unknown as Record<string, unknown>).updated_by =',
        'Object.assign(bound, updateData);',
        'await collection.delete(args.id as string);',
      ],
    },
    {
      backs: 'serialize',
      present: [
        'return publicSource.toPublicJSON(options);',
        "return mcp && typeof mcp === 'object' ? mcp.serializers?.get : undefined;",
        'return { permissions: this.context.permissions };',
      ],
    },
    {
      backs: 'create',
      present: ['const newItem = await collection.create('],
    },
    {
      backs: 'query',
      present: [
        'limit: resolveListLimit(args.limit),',
        "listOptions.where = args.where as (typeof listOptions)['where'];",
        "where: (args.where as (typeof listOptions)['where']) || {},",
        'listOptions.orderBy = args.orderBy',
      ],
    },
    {
      backs: 'tenant, sti',
      present: [
        'return runWithTenantGate(',
        'className: targetObjectName,',
        'allowCrossTenant: this.context.allowCrossTenant,',
        'this.requireToolAuth(targetObjectName, mutating);',
        "surface: 'mcp',",
      ],
    },
    {
      backs: 'errors',
      present: [
        'text: `Error: ${message}`,',
        'if (error instanceof GeneratedFieldError)',
        "typeof candidate.publicMessage !== 'string' ||",
        'structuredContent: { error: publicError ?? { message } },',
      ],
    },
    {
      backs: 'authorization',
      present: [
        'if (!this.context.user) {',
        "const mutating = action !== 'list' && action !== 'get';",
        "if (publicAccess === 'read' && !mutating) return;",
        'const availableTools = await this.generateTools();',
        // Task creation is a separate entry point.
        'const task = await this.context.taskStore.createTask({',
      ],
    },
    {
      backs: 'lookup',
      present: [
        'const key = this.toolTargets.get(tool)?.registryKey;',
        'const collection = new classInfo.collectionConstructor({',
        'classInfo.qualifiedName || objectName,',
      ],
    },
    {
      backs: 'arguments, results',
      present: [
        'if (!args.id && !args.slug) {',
        'const filter = (args.id ? args.id : args.slug) as string;',
        'count: results.length,',
        "return { success: true, message: 'Object deleted successfully' };",
        "throw new Error('Object not found');",
      ],
    },
  ],

  'mcp-emitted-single': [
    {
      backs: 'query',
      present: [
        'function resolveListBound(raw: any, name: string, fallback: number, max?: number): number {',
        "${indent}  const limit = resolveListBound(args.limit, 'limit', ${DEFAULT_LIST_LIMIT}, ${MAX_LIST_LIMIT});",
        '${indent}  const orderBy = args.orderBy ?? ${JSON.stringify(',
        '${indent}  const where = args.where ?? {};',
        '${indent}  const items = await collection.list({ where, limit, offset, orderBy });',
      ],
    },
    {
      backs: 'write, create, serialize',
      present: [
        '${indent}  const newItem = await collection.create(applyWritablePolicy(targetObjectName, data));',
        'for (const [name, def] of ObjectRegistry.getFields(objectName)) {',
        "permissions: (process.env.SMRT_MCP_PERMISSIONS || '')",
        '${indent}  const itemsPublic = items.map((item) => item.toPublicJSON(PUBLIC_JSON_OPTIONS));',
        'return toPublicResult(await serializer(item, PUBLIC_JSON_OPTIONS));',
      ],
      absent: ['created_by', 'displayLabel', 'generatedExpression'],
    },
    {
      backs: 'tenant',
      present: [
        'const TENANT_SCOPED = new Set(${JSON.stringify(tenantScopedSet)});',
        'toolObject && TENANT_SCOPED.has(toolObject.toLowerCase())',
        'const MCP_TENANT_ID = process.env.SMRT_MCP_TENANT_ID || undefined;',
        "{ tenantScoped: true, tenantId: MCP_TENANT_ID, allowCrossTenant: MCP_ALLOW_CROSS_TENANT, surface: 'MCP' },",
      ],
    },
    {
      backs: 'errors, authorization',
      present: [
        '\\`Error executing tool \\${toolName}: \\${errorMessage}\\`,',
        "if (!runtimeToolEnabled(toolName)) throw new Error('Unknown tool');",
        'const task = await store.createTask({',
      ],
      absent: ['requireToolAuth', 'context.user'],
    },
    {
      backs: 'lookup, sti, arguments, results',
      present: [
        'toolTargets[tool.name].registryKey ??',
        "surface: 'mcp', tenantId: process.env.SMRT_MCP_TENANT_ID,",
        '${indent}  if (!args.id && !args.slug) {',
        '${indent}  return successResult(structuredContent, JSON.stringify(itemsPublic));',
        "${indent}  return successResult({ success: true, message: 'Object deleted successfully' });",
      ],
    },
  ],

  'mcp-emitted-modular': [
    {
      backs: 'query',
      present: [
        '${indent}  const limit = args.limit ?? 50;',
        '${indent}  const offset = args.offset ?? 0;',
        '${indent}  const where = args.where ?? {};',
        // No ordering reaches the collection.
        '${indent}  const items = await collection.list({ where, limit, offset });',
      ],
    },
    {
      backs: 'write, create, serialize',
      present: [
        '${indent}  const newItem = await collection.create(applyWritablePolicy(targetObjectName, data));',
        '${indent}    Object.assign(bound, applyWritablePolicy(${JSON.stringify(lookup)}, updateData));',
        'if (!reference) return item.toPublicJSON(PUBLIC_JSON_OPTIONS);',
      ],
    },
    {
      backs: 'tenant',
      present: [
        'const TENANT_SCOPED = new Set(${JSON.stringify(tenantScopedSet)});',
        'toolObject && TENANT_SCOPED.has(toolObject.toLowerCase())',
      ],
    },
    {
      backs: 'errors, authorization',
      present: [
        '\\`Error executing tool \\${name}: \\${errorMessage}\\`,',
        "if (!runtimeToolEnabled(name)) throw new Error('Unknown tool');",
      ],
    },
    {
      backs: 'lookup, results',
      present: [
        'const lookup = target.registryKey ?? target.objectName;',
        '${indent}  return successResult(structuredContent, JSON.stringify(itemsPublic));',
      ],
    },
  ],

  'sync-runtime': [
    {
      backs: 'write, authorization, lookup, body',
      present: [
        'prepare: (payload) => this.applyWritablePolicy(resolvedName, payload),',
        "op === 'create' ? 'post' : op === 'update' ? 'put' : 'delete';",
        "return this.isRoutePublic(resolvedName, 'POST')",
        'this.isApiActionEnabled(resolvedName, op),',
        'expectedUpdatedAt: bound.updated_at ?? undefined,',
        'objectName = info.name;',
        'rawBody = await req.text();',
        "return this.createErrorResponse(400, 'Invalid JSON body');",
      ],
    },
    {
      backs: 'create, errors, results',
      file: SYNC_ENGINE,
      present: [
        '_insertOnly: true,',
        'id: item.id,',
        "reason: 'write_failed',",
        "if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {",
        "return { ...base, status: 'rejected', reason: 'not_found' };",
        "return { ...base, status: 'applied' };",
      ],
    },
  ],

  'sync-emitted': [
    {
      backs: 'write',
      present: [
        'meta?.readonly === true',
        'applySyncWritablePolicy(payload, {',
        'expectedUpdatedAt: bound.updated_at ?? undefined',
      ],
      absent: ['generatedExpression', 'displayLabel'],
    },
    {
      backs: 'tenant',
      present: [
        'const anyTenantScoped = targets.some((target) => target.tenantScoped);',
        'if (hasTenantContext()) return;',
        'const tenantId = l.tenantId ?? user?.tenantId ?? session?.tenantId;',
      ],
    },
    {
      backs: 'authorization, lookup, body',
      present: [
        "if (target.publicAccess === true) return 'ok' as const;",
        "if (!authenticated) return 'auth_required' as const;",
        'return hasOperationPermission(locals, target.permissionCollection, op)',
        'if (tenantContext.superAdminBypass === true) return true;',
        'isOpAllowed: (op: SyncApplyOp) => target.ops.includes(op),',
        'const collection = await getCollection(target.registryKey);',
        "{ error: { code: 'invalid_batch', message: 'Invalid JSON body' } },",
      ],
    },
  ],

  cli: [
    {
      backs: 'write',
      present: [
        "if (!data || typeof data !== 'object' || Array.isArray(data)) return {};",
        'for (const [name, definition] of ObjectRegistry.getFields(objectName)) {',
        'Object.assign(bound, data);',
        'await collection.delete(id);',
      ],
    },
    {
      backs: 'serialize, results, errors',
      present: [
        'console.log(JSON.stringify(results, null, 2));',
        'console.log(JSON.stringify(result, null, 2));',
        'this.exitWithError(`${objectName} not found`);',
        "error instanceof Error ? error.message : 'Unknown error',",
      ],
      absent: ['toPublicJSON'],
    },
    {
      backs: 'create, sti',
      present: [
        'const result = await collection.create(data);',
        "surface: 'cli' as const,",
        'data = this.applyWritablePolicy(target.collectionName, target.data);',
      ],
    },
    {
      backs: 'query',
      present: [
        'limit: Number.parseInt(String(options.limit), 10),',
        'listOptions.where = JSON.parse(options.where);',
        "const orderBy = options['order-by'] ?? options.orderBy;",
        "default: '50',",
      ],
    },
    {
      backs: 'tenant, authorization, lookup',
      present: [
        'if ((info.name || key).toLowerCase() === lowerName) {',
        'const classInfo = ObjectRegistry.getClass(objectName);',
        'const collection = new classInfo.collectionConstructor({',
        "throw new Error('Unknown command');",
      ],
      absent: ['runWithTenantGate', 'authMiddleware'],
    },
  ],

  'chat-tool-loop': [
    {
      backs: 'write',
      present: [
        'return applySyncWritablePolicy(input, writablePolicyFor(tool));',
        'for (const [name, field] of ObjectRegistry.getFields(registryKey)) {',
        'Object.assign(item, writableToolInput(tool, rest));',
        'await item.save();',
        'await item.delete();',
      ],
      absent: ['withAuditMutation'],
    },
    {
      backs: 'serialize',
      present: [
        'const publicOptions: PublicJsonOptions = { permissions: run.permissions };',
        'return serializer(item as SmrtObject, publicOptions);',
        ": typeof candidate?.toJSON === 'function'",
      ],
    },
    {
      backs: 'query, arguments',
      present: [
        'where: asRecord(args.where),',
        "limit: typeof args.limit === 'number' ? args.limit : 50,",
        'const item = await collection.get(id, { displayLabel: true });',
        "(typeof args.where !== 'object' || Array.isArray(args.where))",
        "if (typeof id !== 'string' || id.length === 0) {",
      ],
    },
    {
      backs: 'authorization, tenant, lookup, sti',
      present: [
        'run.assertToolAllowed(tool.slug);',
        'if (!isManifestToolEnabled(tool, run.context.tenantId)) {',
        'await run.assertOperation(tool.collection, tool.action);',
        'return tool.qualifiedName ?? tool.className;',
        "surface: 'assistant',",
        'return executeAsPrincipal(',
      ],
    },
    {
      backs: 'errors, results, body',
      present: [
        ': { found: false };',
        'return { success: true, id };',
        'return Promise.all(items.map((item) => itemToObservation(item, run)));',
        "if (kind !== 'invalid_request') return { error: message };",
        "'invalid_request',",
      ],
    },
  ],
};

describe('legacy profile source pins', () => {
  it('has pins for every transport', () => {
    expect(Object.keys(PINS).sort()).toEqual([...LEGACY_TRANSPORTS].sort());
    expect(REST).toBe(LEGACY_TRANSPORT_SOURCES['rest-runtime'].source);
    expect(KIT).toBe(LEGACY_TRANSPORT_SOURCES['sveltekit-emitted'].source);
    expect(MCP).toBe(LEGACY_TRANSPORT_SOURCES['mcp-inprocess'].source);
  });

  for (const transport of LEGACY_TRANSPORTS) {
    describe(transport, () => {
      for (const pin of PINS[transport]) {
        const file = pin.file ?? LEGACY_TRANSPORT_SOURCES[transport].source;
        it(`${pin.backs}: ${file} still reads as the profile says`, () => {
          const text = source(file);
          const hint = `${file} changed. Re-read it, correct LEGACY_* for '${transport}' (${pin.backs}) in transport/profile.ts, then update this pin.`;
          for (const fragment of pin.present) {
            expect(
              text.includes(fragment),
              `missing: ${fragment}\n${hint}`,
            ).toBe(true);
          }
          for (const fragment of pin.absent ?? []) {
            expect(
              text.includes(fragment),
              `now present: ${fragment}\n${hint}`,
            ).toBe(false);
          }
        });
      }
    });
  }
});
