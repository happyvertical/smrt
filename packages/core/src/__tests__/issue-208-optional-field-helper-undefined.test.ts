/**
 * Test for Issue #208: Optional TEXT fields with field helpers bypass toJSON() fix
 *
 * This tests the specific case from issue #208 where fields declared as:
 * description? = text();
 *
 * are still passing undefined to the database even after the toJSON() fix.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { text } from '../fields';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Define test class at module level for AST scanner
@smrt({ tableName: 'councils_issue_208' })
class CouncilIssue208 extends SmrtObject {
  name = text({ required: true });
  description? = text(); // Optional field helper - the problematic case
}

class CouncilIssue208Collection extends SmrtCollection<CouncilIssue208> {
  static readonly _itemClass = CouncilIssue208;
}

describe('Issue #208: Optional TEXT field helpers with undefined values', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  });

  it('should handle field helper with optional ? syntax when undefined', async () => {
    const collection = await CouncilIssue208Collection.create({ db });

    // Create without description - this is the failing case from #208
    const council = await collection.create({
      name: 'Test Council',
      // description not provided
    });

    // This should not throw "Cannot create values of type ANY"
    await council.save();

    expect(council.id).toBeDefined();
    expect(council.name).toBe('Test Council');
  });

  it('should convert undefined to empty string in toJSON()', async () => {
    const collection = await CouncilIssue208Collection.create({ db });

    const council = await collection.create({
      name: 'Test Council',
    });

    const json = council.toJSON();

    // Check what toJSON() returns for the undefined description field
    console.log('toJSON() output:', json);
    console.log('description value:', json.description);
    console.log('description type:', typeof json.description);

    // The fix should convert undefined TEXT fields to empty strings
    expect(json.description).toBe('');
  });

  it('should show field type from getFields()', async () => {
    const collection = await CouncilIssue208Collection.create({ db });

    const council = await collection.create({
      name: 'Test Council',
    });

    const fields = council.getFields();
    console.log('Fields:', Object.keys(fields));

    if (fields.description) {
      console.log('description field:', fields.description);
      console.log('description.type:', fields.description.type);
      console.log('description.value:', fields.description.value);
    } else {
      console.log('description field not in getFields()!');
    }

    expect(fields.description).toBeDefined();
    expect(fields.description.type).toBe('text');
  });
});
