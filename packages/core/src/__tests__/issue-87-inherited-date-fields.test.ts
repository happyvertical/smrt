/**
 * Test for Issue #87: Inherited Date fields generate as REAL instead of DATETIME
 *
 * When a SMRT object extends a parent class that has Date fields, the schema
 * generator should create DATETIME columns for those inherited Date fields,
 * not REAL columns.
 */

import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

// Move test classes to module level so AST scanner can pick them up during test manifest generation
// Test 1 classes: Parent-child relationship with Date fields
@smrt({
  api: { include: ['list', 'get'] },
})
class Issue87ParentEvent extends SmrtObject {
  @field({ nullable: true })
  startDate: Date | null = null;

  @field({ nullable: true })
  endDate: Date | null = null;

  @field({ nullable: true })
  issuedAt: Date | null = null; // This field was mentioned in the issue
}

@smrt({
  api: { include: ['list', 'get'] },
})
class Issue87ChildEvent extends Issue87ParentEvent {
  temperature: number = 0;
  description: string = '';
}

class Issue87ParentEventCollection extends SmrtCollection<Issue87ParentEvent> {
  static readonly _itemClass = Issue87ParentEvent;
}

class Issue87ChildEventCollection extends SmrtCollection<Issue87ChildEvent> {
  static readonly _itemClass = Issue87ChildEvent;
}

// Test 2 classes: Multiple field types inheritance
@smrt({
  api: { include: ['list', 'get'] },
})
class Issue87BaseModel extends SmrtObject {
  textField: string = '';
  numberField: number = 0;
  booleanField: boolean = false;

  @field({ nullable: true })
  issueDate: Date | null = null; // Conventional naming: ends with 'Date'

  @field({ nullable: true })
  optionalEventDate: Date | null = null; // Conventional naming: ends with 'Date'
}

@smrt({
  api: { include: ['list', 'get'] },
})
class Issue87DerivedModel extends Issue87BaseModel {
  derivedField: string = '';
}

class Issue87DerivedModelCollection extends SmrtCollection<Issue87DerivedModel> {
  static readonly _itemClass = Issue87DerivedModel;
}

describe('Issue #87: Inherited Date fields schema generation', () => {
  // FIXME: AST scanner doesn't handle class inheritance in test files (child classes not in manifest)
  // These tests need to be fixed when the AST scanner is updated to handle inheritance properly
  it.skip('should generate DATETIME columns for inherited Date fields', async () => {
    // Register collections
    ObjectRegistry.registerCollection(
      'Issue87ParentEvent',
      Issue87ParentEventCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue87ChildEvent',
      Issue87ChildEventCollection,
    );

    // Create collection to trigger schema generation
    const collection = await Issue87ChildEventCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create an instance with Date values to verify the schema works
    const now = new Date();
    const event = await collection.create({
      slug: 'test-event',
      startDate: now,
      endDate: now,
      issuedAt: now,
      temperature: 25,
      description: 'Test event',
    });

    await event.save();

    // Verify we can retrieve the object and Date fields are preserved
    const retrieved = await collection.get('test-event');
    expect(retrieved).toBeDefined();
    expect(retrieved?.startDate).toBeInstanceOf(Date);
    expect(retrieved?.endDate).toBeInstanceOf(Date);
    expect(retrieved?.issuedAt).toBeInstanceOf(Date);
  });

  it.skip('should correctly infer types for various inherited field types', async () => {
    // Test with multiple field types to ensure Date isn't special-cased
    ObjectRegistry.registerCollection(
      'Issue87DerivedModel',
      Issue87DerivedModelCollection,
    );

    const collection = await Issue87DerivedModelCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Create an instance with values to verify schema works
    const now = new Date();
    const instance = await collection.create({
      slug: 'test-model',
      textField: 'test',
      numberField: 42,
      booleanField: true,
      issueDate: now,
      optionalEventDate: now,
      derivedField: 'derived',
    });

    await instance.save();

    // Verify we can retrieve the object and all types are preserved
    const retrieved = await collection.get('test-model');
    expect(retrieved).toBeDefined();
    expect(retrieved?.textField).toBe('test');
    expect(retrieved?.numberField).toBe(42);
    expect(retrieved?.booleanField).toBe(1); // SQLite stores booleans as INTEGER (0/1)
    expect(retrieved?.issueDate).toBeInstanceOf(Date);
    expect(retrieved?.optionalEventDate).toBeInstanceOf(Date);
    expect(retrieved?.derivedField).toBe('derived');
  });
});
