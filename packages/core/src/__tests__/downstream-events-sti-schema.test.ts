/**
 * Downstream regression: external Event STI base + downstream Meeting child
 *
 * Reproduces the shape used by downstream apps like anytown:
 * - the shared STI base (`Event`) is loaded by importing the package at runtime
 * - a downstream package contributes a child class (`Meeting`) via manifest data
 * - schema synthesis must keep the shared `events` table complete
 *
 * The regression guard is intentionally strict:
 * - `getAllSchemas()` must keep STI meta columns plus base Event columns
 * - downstream Meeting columns must merge into `events`
 * - `getAllSchemasAsDefinitions()` must agree with the DDL output
 * - no separate `meetings` table should be synthesized
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearManifestCache,
  loadExternalManifest,
} from '../manifest/manifest-loader.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

type SmartObjectDefinition = {
  fields?: Record<string, unknown>;
  [key: string]: unknown;
};

type SmartObjectManifest = {
  objects?: Record<string, SmartObjectDefinition>;
  [key: string]: unknown;
};

function findObjectInManifest(
  manifest: SmartObjectManifest | undefined,
  className: string,
  packageName: string,
): SmartObjectDefinition | undefined {
  if (!manifest?.objects) return undefined;

  const qualifiedKey = `${packageName}:${className}`;
  if (manifest.objects[qualifiedKey]) {
    return manifest.objects[qualifiedKey];
  }

  const lowerKey = className.toLowerCase();
  return manifest.objects[lowerKey] || manifest.objects[className];
}

describe('Downstream events STI schema synthesis', () => {
  let restoreRegistry: () => void;

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    clearManifestCache();
    const manifest = await loadExternalManifest('@happyvertical/smrt-events');
    const eventDef = findObjectInManifest(
      manifest,
      'Event',
      '@happyvertical/smrt-events',
    );

    expect(eventDef).toBeDefined();

    ObjectRegistry.registerFromManifest(
      'Event',
      eventDef!,
      '@happyvertical/smrt-events',
    );
  });

  afterAll(() => {
    restoreRegistry();
    clearManifestCache();
  });

  it('keeps base Event columns and downstream Meeting columns on the shared events table', () => {
    const eventClass = ObjectRegistry.findClass('Event');
    expect(eventClass).toBeDefined();
    expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
    expect(ObjectRegistry.getSTIBase('Event')).toBe('Event');

    // This mirrors a downstream built manifest child: inherited STI metadata
    // is already resolved, but the child still contributes its own fields.
    ObjectRegistry.registerFromManifest(
      'Meeting',
      {
        className: 'Meeting',
        extends: 'Event',
        packageName: '@test/downstream',
        fields: {
          councilId: { type: 'text', default: '' },
          agendaUrl: { type: 'text', default: '' },
        },
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'events',
        },
        schema: {
          tableName: 'events',
          ddl: '',
          columns: {},
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '',
        },
      },
      '@test/downstream',
    );

    expect(ObjectRegistry.getTableStrategy('Meeting')).toBe('sti');
    expect(ObjectRegistry.getSTIBase('Meeting')).toBe('Event');

    const schemas = ObjectRegistry.getAllSchemas();
    expect(schemas.events).toBeDefined();
    expect(schemas.meetings).toBeUndefined();

    const eventsDDL = schemas.events.ddl;
    expect(eventsDDL).toContain('"_meta_type"');
    expect(eventsDDL).toContain('"_meta_data"');
    expect(eventsDDL).toContain('"name"');
    expect(eventsDDL).toContain('"type_id"');
    expect(eventsDDL).toContain('"status"');
    expect(eventsDDL).toContain('"council_id"');
    expect(eventsDDL).toContain('"agenda_url"');

    const definitions = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(definitions.events).toBeDefined();
    expect(definitions.meetings).toBeUndefined();
    expect(definitions.events.columns._meta_type).toBeDefined();
    expect(definitions.events.columns._meta_data).toBeDefined();
    expect(definitions.events.columns.name).toBeDefined();
    expect(definitions.events.columns.type_id).toBeDefined();
    expect(definitions.events.columns.status).toBeDefined();
    expect(definitions.events.columns.council_id).toBeDefined();
    expect(definitions.events.columns.agenda_url).toBeDefined();
  });
});
