/**
 * Plain-Node registration probe: import the generated `.smrt/register.js` the
 * way the smrt CLI does for db:migrate (no Vite, no Vitest), then check that
 * each class registered once under its declaring package and that the
 * consumed package's models resolve schemas from the installed registry.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';

await import('./.smrt/register.js');

const qualified = ObjectRegistry.getQualifiedClassNames();
function expectOnly(className, expected) {
  const found = qualified.filter((name) => name.endsWith(`:${className}`));
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new Error(`${className} registered as ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
  }
}
expectOnly('SmrtHierarchical', ['@happyvertical/smrt-core:SmrtHierarchical']);
expectOnly('Tag', ['@happyvertical/smrt-tags:Tag']);

const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
const tables = Object.keys(schemas);
if (!tables.includes('tags')) {
  throw new Error(`generated registration resolved no schema for the tags table (resolved: ${JSON.stringify(tables)})`);
}
console.log(`registered ${qualified.length} classes; resolved ${tables.length} schemas`);
