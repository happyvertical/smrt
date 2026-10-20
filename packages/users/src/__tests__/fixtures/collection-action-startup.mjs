import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const coreRoot = fileURLToPath(new URL('../../../../core/', import.meta.url));
const usersRoot = fileURLToPath(new URL('../../../', import.meta.url));
const tenancyRoot = fileURLToPath(new URL('../../../../tenancy/', import.meta.url));
const core = pathToFileURL(join(coreRoot, 'dist/index.js')).href;
const tenancy = pathToFileURL(join(tenancyRoot, 'dist/index.js')).href;
const { build } = createRequire(join(coreRoot, 'package.json'))('esbuild');
const { generateSvelteKitRoutes } = await import(pathToFileURL(join(coreRoot, 'dist/vite-plugin.js')).href);
const { ObjectRegistry } = await import(core);
const { createResourceListHandler } = await import(pathToFileURL(join(usersRoot, 'dist/sveltekit.js')).href);
const { withTenant } = await import(tenancy);
const pkg = '@fixture/startup4171';
const inheritedNamespace = process.argv.includes('--inherited-namespace');
const modelVisible = process.argv.includes('--model-visible');
const collectionPath = inheritedNamespace ? 'domainboot4171' : 'facadeboot4171';
const root = mkdtempSync(join(process.env.CI_TEST_TMPDIR || process.env.TMPDIR, 'startup4171-'));
let actual;
try {
  mkdirSync(join(root, 'src/lib/objects'), { recursive: true });
  mkdirSync(join(root, 'src/lib/server'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@happyvertical'), { recursive: true });
  for (const [name, path] of [['smrt-core', coreRoot], ['smrt-tenancy', tenancyRoot]]) symlinkSync(path, join(root, 'node_modules/@happyvertical', name));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'startup4171', type: 'module' }));
  const source = (name, code) => { const path = join(root, 'src/lib/objects', `${name}.ts`); writeFileSync(path, code); return path; };
  const modelFile = source('DomainBoot4171', `import {SmrtObject,smrt} from '${core}'; export class DomainBoot4171 extends SmrtObject { static inspect(){ return {receiver:this.name}; } } smrt({packageName:'${pkg}',tableName:'domain_boot4171',collection:'domainboot4171',api:${modelVisible ? "{include:['inspect'],principalContext:true}" : 'false'},cli:${modelVisible ? "{include:['inspect']}" : 'false'},mcp:false})(DomainBoot4171);`);
  // Deliberately undecorated: the inherited domain behavior must survive without
  // adding local parent annotations to compensate for framework registration.
  const parentFile = source('DomainCollectionBoot4171', `import {SmrtCollection} from '${core}'; import {DomainBoot4171} from './DomainBoot4171'; export class DomainCollectionBoot4171 extends SmrtCollection { static _itemClass=DomainBoot4171; inheritedBehavior(){return 'canonical';} }`);
  const facadeFile = source('FacadeBoot4171', `import {smrt} from '${core}'; import {getCurrentTenant} from '${tenancy}'; import {DomainCollectionBoot4171} from './DomainCollectionBoot4171'; export class FacadeBoot4171 extends DomainCollectionBoot4171 { static calls=[]; static async submit(options){ this.calls.push(options); if(options.ownerTenant && options.ownerTenant!==getCurrentTenant()?.tenantId) throw Object.assign(new Error('Wrong owner'),{status:403,code:'owner_denied'}); if(options.fail) throw Object.assign(new Error('Domain conflict'),{status:409,code:'domain_conflict'}); return {accepted:options,tenantId:getCurrentTenant()?.tenantId,userId:getCurrentTenant()?.userId}; } } smrt({packageName:'${pkg}',${inheritedNamespace ? '' : `collection:'${collectionPath}',`}api:{include:['submit'],principalContext:true},cli:{include:['submit']},mcp:false})(FacadeBoot4171);`);
  const defaultFile = source('DefaultCollectionBoot4171', `import {SmrtCollection,smrt} from '${core}'; import {DomainBoot4171} from './DomainBoot4171'; export class DefaultCollectionBoot4171 extends SmrtCollection { static _itemClass=DomainBoot4171; } smrt({packageName:'${pkg}',api:false,cli:true,mcp:false})(DefaultCollectionBoot4171);`);
  const entry = (className, filePath, collection, extendsName, extendsTypeArg) => ({ name: className, className, qualifiedName: `${pkg}:${className}`, packageName: pkg, filePath, collection, extends: extendsName, extendsTypeArg, fields: {}, methods: {}, decoratorConfig: { tableName: 'domain_boot4171', collection, api: false, cli: false, mcp: false } });
  const model = entry('DomainBoot4171', modelFile, 'domainboot4171', 'SmrtObject');
  if (modelVisible) { model.decoratorConfig.api = { include: ['inspect'], principalContext: true }; model.decoratorConfig.cli = { include: ['inspect'] }; model.methods = { inspect: { name: 'inspect', isStatic: true, isPublic: true, parameters: [], returnType: 'unknown' } }; }
  const parent = entry('DomainCollectionBoot4171', parentFile, 'domainboot4171', 'SmrtCollection', 'DomainBoot4171');
  const facade = { ...entry('FacadeBoot4171', facadeFile, collectionPath, 'DomainCollectionBoot4171'), decoratorConfig: { tableName: 'domain_boot4171', ...(inheritedNamespace ? {} : { collection: collectionPath }), api: { include: ['submit'], principalContext: true }, cli: { include: ['submit'] }, mcp: false }, methods: { submit: { name: 'submit', isStatic: true, isPublic: true, async: true, parameters: [{ name: 'options', type: 'Record<string, unknown>', optional: false }], returnType: 'Promise<unknown>' } } };
  const ordinary = { ...entry('DefaultCollectionBoot4171', defaultFile, 'domainboot4171', 'SmrtCollection', 'DomainBoot4171'), decoratorConfig: { api: false, cli: true, mcp: false } };
  const manifest = { version: '1', timestamp: 0, packageName: pkg, objects: { DomainBoot4171: model, DomainCollectionBoot4171: parent, FacadeBoot4171: facade, DefaultCollectionBoot4171: ordinary } };
  // Keep the unrelated default collection source out of this startup runtime:
  // registering a second constructor for the SAME model intentionally replaces
  // it. Its default omission is tested by generation separately below.
  const activeManifest = { ...manifest, objects: { DomainBoot4171: model, DomainCollectionBoot4171: parent, FacadeBoot4171: facade } };
  writeFileSync(join(root, 'src/lib/server/smrt.ts'), `import {ObjectRegistry} from '${core}'; export function getSmrtConfig(){return {db:{type:'sqlite',url:':memory:'}};} export function getCollection(name,options){return ObjectRegistry.getCollection(name,{...options,db:globalThis.__fixture4171Db});}`);
  await generateSvelteKitRoutes(root, activeManifest, { enabled: true, objectsDir: 'src/lib/objects', routesDir: 'src/routes/api', configPath: 'src/lib/server', configFileName: 'smrt.ts' });
  assert.equal(ObjectRegistry.getClass(`${pkg}:FacadeBoot4171`), undefined, 'no preregistration may hide startup failures');
  const kit = join(root, 'kit.ts');
  writeFileSync(kit, `export function error(status,message){throw Object.assign(new Error(message),{status});} export function json(value,init={}){return new Response(JSON.stringify(value),init);}`);
  const bundle = async (entryFile, name) => { const outfile = join(root, name); await build({ entryPoints: [entryFile], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: [core, tenancy], plugins: [{ name: 'fixture-aliases', setup(builder) { builder.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({ path: kit })); builder.onResolve({ filter: /^\$lib\/server\/smrt(-register)?$/ }, ({ path }) => ({ path: join(root, 'src/lib/server', `${path.slice(12)}.ts`) })); } }] }); return await import(pathToFileURL(outfile).href); };
  await bundle(join(root, 'src/lib/server/smrt-register.ts'), 'startup.mjs');
  assert.equal(ObjectRegistry.isCollectionClass(`${pkg}:FacadeBoot4171`), true);
  actual = await ObjectRegistry.getCollection(`${pkg}:DomainBoot4171`, { db: { type: 'sqlite', url: ':memory:' } });
  assert.equal(actual.constructor.name, 'FacadeBoot4171');
  assert.equal(ObjectRegistry.getClass(`${pkg}:FacadeBoot4171`).collectionConstructor, actual.constructor, 'generated startup preserves exact live host identity');
  assert.equal(actual.inheritedBehavior(), 'canonical');
  globalThis.__fixture4171Db = actual.db;
  assert.deepEqual(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions()).filter(name => name.includes('boot4171')), ['domain_boot4171']);
  const tables = await actual.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='domain_boot4171'");
  assert.deepEqual(tables.rows, [], 'runtime does not create an unused application table');
  const session = { user: { id: 'actor' }, permissions: ['domainboot4171.submit'], tenantId: 'tenant-a', sessionId: 'fixture' };
  const discover = async (resolved, allowedClasses = ['FacadeBoot4171']) => { const handler = createResourceListHandler({ ensureRegistry: () => {}, resolveSession: async () => resolved, commandPolicy: ({ classMeta, session }) => !!session.user && session.tenantId === 'tenant-a' && allowedClasses.some(name => classMeta.qualifiedName === `${pkg}:${name}`) }); const response = await handler({ cookies: { get: () => undefined }, request: new Request('http://localhost/api/_resources'), url: new URL('http://localhost/api/_resources') }); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const body = await discover(session);
  assert.equal(body.resources.length, 1);
  assert.equal(body.resources[0].apiPath, collectionPath);
  assert.deepEqual(body.resources[0].commands.map(({ methodName, kind, scope }) => [methodName, kind, scope]), [['submit', 'custom', 'collection']]);
  if (modelVisible) {
    assert.equal(body.resources[0].className, 'DomainBoot4171', 'model shell is stable even when model policy denies');
    const both = await discover(session, ['DomainBoot4171', 'FacadeBoot4171']);
    assert.deepEqual(both.resources[0].commands.map(command => command.methodName), ['inspect', 'submit']);
    assert.equal(both.resources.length, 1);
    const modelOnly = await discover(session, ['DomainBoot4171']);
    assert.deepEqual(modelOnly.resources[0].commands.map(command => command.methodName), ['inspect']);
    assert.equal((await discover(session, [])).resources.length, 0);
    const modelRoute = await bundle(join(root, 'src/routes/api/domainboot4171/inspect/+server.ts'), 'model-route.mjs');
    await assert.rejects(modelRoute.POST({ locals: {}, request: new Request('http://localhost/api/domainboot4171/inspect', { method: 'POST' }) }), { status: 401 });
    await assert.rejects(modelRoute.POST({ locals: session, request: new Request('http://localhost/api/domainboot4171/inspect', { method: 'POST' }) }), { status: 403 });
    const inspected = await modelRoute.POST({ locals: { ...session, permissions: ['domainboot4171.inspect'] }, request: new Request('http://localhost/api/domainboot4171/inspect', { method: 'POST' }) });
    assert.equal((await inspected.json()).result.receiver, 'DomainBoot4171');
  }
  assert.equal((await discover({ ...session, user: null })).resources.length, 0);
  assert.equal((await discover({ ...session, tenantId: 'tenant-b' })).resources.length, 0);
  const route = await bundle(join(root, `src/routes/api/${collectionPath}/submit/+server.ts`), 'route.mjs');
  const request = (value) => new Request(`http://localhost/api/${collectionPath}/submit`, { method: 'POST', body: JSON.stringify(value) });
  await assert.rejects(route.POST({ locals: {}, request: request({}) }), { status: 401 });
  await assert.rejects(route.POST({ locals: { ...session, permissions: ['facadeboot4171.submit'] }, request: request({}) }), { status: 403 });
  const response = await route.POST({ locals: session, request: request({ opaque: { nested: 'kept' }, tenantId: 'forged', ownerTenant: 'tenant-a' }) });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.deepEqual(result.accepted.opaque, { nested: 'kept' }); assert.equal(result.tenantId, 'tenant-a'); assert.equal(result.userId, 'actor');
  await assert.rejects(withTenant({ tenantId: 'tenant-b', userId: 'actor', permissions: new Set(session.permissions) }, () => route.POST({ locals: session, request: request({}) })), { status: 403 });
  assert.equal((await route.POST({ locals: session, request: request({ ownerTenant: 'tenant-b' }) })).status, 403);
  assert.equal((await route.POST({ locals: session, request: request({ fail: true }) })).status, 409);
  // Generate an ordinary collection on its own: no named opt-in means its
  // metadata is not added to generated startup or discovery.
  await generateSvelteKitRoutes(root, { ...manifest, objects: { DomainBoot4171: model, DefaultCollectionBoot4171: ordinary } }, { enabled: true, objectsDir: 'src/lib/objects', routesDir: 'src/routes/api', configPath: 'src/lib/server', configFileName: 'smrt.ts' });
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(root, 'src/lib/server/smrt-register.ts'), 'utf8').includes('ObjectRegistry.registerPackageManifest'), false);
  assert.equal(readFileSync(join(root, 'src/lib/server/smrt-register.ts'), 'utf8').includes('ObjectRegistry.registerCollection'), false);
  console.log('RESULT4171=' + JSON.stringify({ inheritedNamespace, modelVisible, startupDiscovery: true, realInheritedConstructor: true, canonicalSchemaOnly: true, noRuntimeSchemaWrites: true, itemAuthority: true, authAndTenantNegatives: true, typedFailure: true, defaultUnchanged: true }));
} finally {
  if (actual) await actual.db.close?.();
  delete globalThis.__fixture4171Db;
  rmSync(root, { force: true, recursive: true });
}
