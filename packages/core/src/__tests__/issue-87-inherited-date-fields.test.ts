/**
 * Test for Issue #87: Inherited Date fields generate as REAL instead of DATETIME
 *
 * When a SMRT object extends a parent class that has Date fields, the schema
 * generator should create DATETIME columns for those inherited Date fields,
 * not REAL columns.
 */

import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { boolean, datetime, integer, text } from '../fields/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

describe('Issue #87: Inherited Date fields schema generation', () => {
  it('should generate DATETIME columns for inherited Date fields', async () => {
    // Define a parent class with Date fields (similar to Event)
    @smrt({
      api: { include: ['list', 'get'] },
    })
    class ParentEvent extends SmrtObject {
      startDate = datetime({ nullable: true });
      endDate = datetime({ nullable: true });
      issuedAt = datetime({ nullable: true }); // This field was mentioned in the issue
    }

    // Define a child class that extends the parent
    @smrt({
      api: { include: ['list', 'get'] },
    })
    class ChildEvent extends ParentEvent {
      temperature = integer();
      description = text();
    }

    // Register collections
    class ParentEventCollection extends SmrtCollection<ParentEvent> {
      static readonly _itemClass = ParentEvent;
    }

    class ChildEventCollection extends SmrtCollection<ChildEvent> {
      static readonly _itemClass = ChildEvent;
    }

    ObjectRegistry.registerCollection('ParentEvent', ParentEventCollection);
    ObjectRegistry.registerCollection('ChildEvent', ChildEventCollection);

    // Create collection to trigger schema generation
    const collection = await ChildEventCollection.create({
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

  it('should correctly infer types for various inherited field types', async () => {
    // Test with multiple field types to ensure Date isn't special-cased
    @smrt({
      api: { include: ['list', 'get'] },
    })
    class BaseModel extends SmrtObject {
      textField = text();
      numberField = integer();
      booleanField = boolean();
      issueDate = datetime({ nullable: true }); // Conventional naming: ends with 'Date'
      optionalEventDate = datetime({ nullable: true }); // Conventional naming: ends with 'Date'
    }

    @smrt({
      api: { include: ['list', 'get'] },
    })
    class DerivedModel extends BaseModel {
      derivedField = text();
    }

    class DerivedModelCollection extends SmrtCollection<DerivedModel> {
      static readonly _itemClass = DerivedModel;
    }

    ObjectRegistry.registerCollection('DerivedModel', DerivedModelCollection);

    const collection = await DerivedModelCollection.create({
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
