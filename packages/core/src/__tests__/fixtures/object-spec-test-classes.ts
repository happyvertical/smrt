import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Simple test class extending SmrtObject
@smrt()
export class TestObject extends SmrtObject {
  static tableName = 'test_objects';

  // TypeScript types with decorators for field definitions
  name: string = '';
  description?: string;
  active: boolean = false;
  count: number = 0;
}

// Test class for readonly property handling (Issue #61)
@smrt({ tableName: 'custom_councils' })
export class ObjectSpecTestCouncil extends SmrtObject {
  name: string = '';
  description?: string;
}
