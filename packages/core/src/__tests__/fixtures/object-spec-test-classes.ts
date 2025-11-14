import { boolean, integer, text } from '../../fields/index.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Simple test class extending SmrtObject
@smrt()
export class TestObject extends SmrtObject {
  static tableName = 'test_objects';

  // Need to initialize properties for runtime field detection
  name = text();
  description? = text();
  active = boolean();
  count = integer();
}

// Test class for readonly property handling (Issue #61)
@smrt({ tableName: 'custom_councils' })
export class ObjectSpecTestCouncil extends SmrtObject {
  name = text();
  description? = text();
}
