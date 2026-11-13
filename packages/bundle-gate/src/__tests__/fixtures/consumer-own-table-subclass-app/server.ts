/**
 * Server entry for the #4922 gate, run from the app root. It registers the
 * package class (smrt-messages' own-table `Attachment`) and then the app's
 * scanned manifest the way the CLI's manifest discovery does, and reports
 * what the registry holds for the app's same-named subclass. It then saves
 * rows with and without the overridden required field.
 */
import { readFileSync } from 'node:fs';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import '@happyvertical/smrt-messages';

const manifest = JSON.parse(readFileSync('.smrt/manifest.json', 'utf8')) as {
  packageName: string;
  objects: Record<string, unknown>;
};
for (const [name, definition] of Object.entries(manifest.objects)) {
  ObjectRegistry.registerFromManifest(
    name,
    definition as never,
    manifest.packageName,
  );
}
const consumerName = '@test/consumer:Attachment';

const fields = await ObjectRegistry.getAllFields(consumerName);
const registryFields = [...ObjectRegistry.getFields(consumerName).keys()];
const schema = ObjectRegistry.getAllSchemasAsDefinitions().attachments;
const columns = Object.fromEntries(
  Object.entries(schema?.columns ?? {}).map(([name, column]) => [
    name,
    column.notNull === true,
  ]),
);

const db = await getTestDatabase({ classes: [consumerName] });
const attachments = await ObjectRegistry.getCollection(consumerName, { db });
const created = await attachments.create({
  filename: 'a.txt',
  contentType: 'text/plain',
  size: 1,
  virusScanned: true,
});
await created.save();
const rows = (
  await db.query(
    'SELECT filename, content_type, size, virus_scanned FROM attachments',
  )
).rows;

let refusal: string | null = null;
try {
  const missing = await attachments.create({
    contentType: 'text/plain',
    size: 1,
  });
  await missing.save();
} catch (error) {
  refusal = error instanceof Error ? error.message : String(error);
}
const rowCount = (await db.query('SELECT COUNT(*) AS n FROM attachments'))
  .rows[0].n;

console.log(
  `SMRT_OWN_TABLE_SUBCLASS_RESULT=${JSON.stringify({
    consumer: consumerName,
    fields: [...fields.keys()],
    registryFields,
    columns,
    rows,
    refusal,
    rowCount: Number(rowCount),
  })}`,
);
