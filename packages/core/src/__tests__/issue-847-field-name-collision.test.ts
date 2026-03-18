/**
 * Test for Issue #847: Fields filtered when name collides with external package
 *
 * This test validates the FIX for Issue #847.
 *
 * THE BUG (now fixed):
 * When a local class (Council extends SmrtObject) had a field with the same name
 * as a field in an external package class (Profile.name from smrt-profiles),
 * the local field would get filtered out even though there was NO inheritance relationship.
 *
 * THE FIX:
 * 1. AST scanner now only skips DEFAULT_BASE_CLASSES (SmrtObject, SmrtClass, SmrtCollection)
 *    instead of all discovered SMRT classes from external packages
 * 2. Registry now properly handles qualified class name lookups
 *
 * These tests verify that:
 * - Local fields with names matching external package fields are correctly registered
 * - Fields serialize properly in toJSON()
 * - Fields persist correctly to the database
 * - Field updates work as expected
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry.js';
import { SchemaGenerator } from '../schema/generator.js';

// Test class that has a 'name' field - same name as Profile.name from smrt-profiles
// This class simulates Council but uses a different name to avoid collision with praeco's Council
// Issue847Council does NOT extend Profile, it extends SmrtObject directly
@smrt({ tableName: 'issue847_councils' })
class Issue847Council extends SmrtObject {
  // This field has the same name as Profile.name from @happyvertical/smrt-profiles
  // It should persist correctly since Issue847Council doesn't extend Profile
  name: string = '';

  // Other fields for comparison
  meetingsUrl: string = '';
  timezone: string = 'America/Toronto';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.meetingsUrl) this.meetingsUrl = options.meetingsUrl;
    if (options.timezone) this.timezone = options.timezone;
  }
}

describe('Issue #847: Field name collision with external packages', () => {
  beforeEach(() => {
    // Clear registry to ensure clean state
    ObjectRegistry.clear();

    const schemaGenerator = new SchemaGenerator();
    const profileFields = {
      name: { type: 'text', required: false, default: '' }, // Collision with Council.name!
      email: { type: 'text', required: false, default: '' },
      bio: { type: 'text', required: false, default: '' },
    };
    const councilFields = {
      name: { type: 'text', required: false, default: '' }, // Same field name as Profile!
      meetingsUrl: { type: 'text', required: false, default: '' },
      timezone: {
        type: 'text',
        required: false,
        default: 'America/Toronto',
      },
    };

    // FIRST: Register a mock "Profile" class from an external package
    // This simulates @happyvertical/smrt-profiles having a "name" field
    const profileDef = {
      className: 'Profile',
      decoratorConfig: {
        tableName: 'profiles',
      },
      fields: profileFields,
      schema: schemaGenerator.generateCTISchemaFromManifest(
        'Profile',
        'profiles',
        profileFields,
      ),
    };
    ObjectRegistry.registerFromManifest('Profile', profileDef, 'smrt-profiles');

    // Register the Issue847Council class FROM a manifest that includes the name field
    // This simulates the production scenario where OXC scanner generates
    // a manifest with both decorator config and pre-generated schema metadata.
    const councilDef = {
      className: 'Issue847Council',
      decoratorConfig: {
        tableName: 'issue847_councils',
      },
      fields: councilFields,
      schema: schemaGenerator.generateCTISchemaFromManifest(
        'Issue847Council',
        'issue847_councils',
        councilFields,
      ),
    };
    ObjectRegistry.registerFromManifest('Issue847Council', councilDef);
  });

  it('should have name field in manifest/registry', () => {
    // Verify Issue847Council is registered with name field
    const fields = ObjectRegistry.getFields('Issue847Council');

    // Issue847Council should have name field in registry
    expect(fields.has('name')).toBe(true);
    expect(fields.has('meetingsUrl')).toBe(true);
    expect(fields.has('timezone')).toBe(true);
  });

  it('should serialize name field in toJSON()', async () => {
    const council = new Issue847Council({
      name: 'Test Council',
      meetingsUrl: 'https://example.com/meetings',
      timezone: 'America/New_York',
      db: { type: 'sqlite', url: ':memory:' },
    });
    await council.initialize();

    // Get JSON representation
    const json = council.toJSON();

    // Verify name field is correctly serialized (validates fix for Issue #847)
    expect(json.name).toBe('Test Council');
    expect(json.meetingsUrl).toBe('https://example.com/meetings');
    expect(json.timezone).toBe('America/New_York');
  });

  it('should persist name field to database', async () => {
    // Create council with name
    const council = new Issue847Council({
      name: 'Waterloo Council',
      meetingsUrl: 'https://waterloo.ca/meetings',
      timezone: 'America/Toronto',
      db: { type: 'sqlite', url: ':memory:' },
    });
    await council.initialize();

    await council.save();

    // Retrieve from database - pass ID in constructor to trigger auto-load
    const retrieved = new Issue847Council({
      id: council.id,
      db: council._db, // Pass the db instance directly (has 'query' method)
    });
    await retrieved.initialize(); // Auto-loads because id is set

    // All fields should persist, including name (validates fix for Issue #847)
    expect(retrieved.name).toBe('Waterloo Council');
    expect(retrieved.meetingsUrl).toBe('https://waterloo.ca/meetings');
    expect(retrieved.timezone).toBe('America/Toronto');
  });

  it('should handle update of name field', async () => {
    // Create initial council
    const council = new Issue847Council({
      name: 'Original Name',
      meetingsUrl: 'https://example.com',
      db: { type: 'sqlite', url: ':memory:' },
    });
    await council.initialize();
    await council.save();

    // Update the name
    council.name = 'Updated Name';
    await council.save();

    // Retrieve and verify - pass ID in constructor to trigger auto-load
    const retrieved = new Issue847Council({
      id: council.id,
      db: council._db, // Pass the db instance directly (has 'query' method)
    });
    await retrieved.initialize(); // Auto-loads because id is set
    expect(retrieved.name).toBe('Updated Name');
  });
});
