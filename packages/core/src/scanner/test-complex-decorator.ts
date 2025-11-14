/**
 * Test file for issue #166: Complex decorator parsing
 * This reproduces the pattern used in praeco that causes scanner failure
 */

import { SmrtObject } from '../object';

// Mock decorator function
function smrt(_config?: any) {
  return (target: any) => target;
}

// Simple decorator (should work)
@smrt({ tableName: 'test_councils' })
export class TestCouncil extends SmrtObject {
  name = '';
  url = '';
}

// Complex decorator with nested objects (issue #166)
@smrt({
  tableName: 'praeco_sources',
  api: {
    include: ['list', 'get', 'create', 'update'],
  },
  mcp: {
    include: ['list', 'get', 'search', 'sync'],
  },
  cli: true,
})
export class PraecoSource extends SmrtObject {
  name = '';
  type = 'documents';
  url = '';
}

// Another complex decorator with different structure
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
  mcp: {
    include: ['list', 'get', 'analyze'],
  },
  cli: true,
})
export class ComplexDecoratorTestDocument extends SmrtObject {
  title = '';
  content = '';
  wordCount = 0;
}
