/**
 * Test fixture classes for inheritance tests
 * These classes must be in a separate file (not in the test file itself)
 * so they can be included in the test manifest generation
 */

import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Level 1: Base Content class (like @happyvertical/smrt-content)
@smrt()
export class InheritanceTestContent extends SmrtObject {
  title: string = '';
  body: string = '';
  publishedAt: Date | null = null;
  wordCount: number = 0; // INTEGER (no decimal)

  async generateSummary(): Promise<string> {
    return 'Summary from InheritanceTestContent';
  }
}

// Level 2: Praeco Content extends Content (like praeco package)
@smrt()
export class InheritanceTestPraecoContent extends InheritanceTestContent {
  praecoCustom1: string = '';
  sourceUrl: string = '';
  rating: number = 0.0; // DECIMAL (has decimal)

  async analyzeSentiment(): Promise<string> {
    return 'Sentiment from InheritanceTestPraecoContent';
  }
}

// Level 3: Bentley Content extends PraecoContent (like bentleyalberta.com)
@smrt()
export class InheritanceTestBentleyContent extends InheritanceTestPraecoContent {
  bentleyCustom1: string = '';
  localTags: string[] = [];

  async analyzeLocal(): Promise<string> {
    return 'Analysis from InheritanceTestBentleyContent';
  }
}

// Test field override with config merging
@smrt()
export class ParentWithConstraints extends SmrtObject {
  @field({ min: 0, max: 150 })
  age: number = 0;

  @field({ min: 0.0, max: 100.0 })
  score: number = 0.0;
}

@smrt()
export class ChildWithConstraints extends ParentWithConstraints {
  // Override with stricter constraints (should merge: max of mins, min of maxes)
  @field({ min: 18, max: 65 }) // Result: min=18 (stricter), max=65 (stricter)
  age: number = 0;

  @field({ min: 50.0, max: 90.0 }) // Result: min=50 (stricter), max=90 (stricter)
  score: number = 0.0;
}

// Test classes for type mismatch warning
@smrt()
export class ParentTypeMismatch extends SmrtObject {
  myField: string = '';
}

@smrt()
export class ChildTypeMismatch extends ParentTypeMismatch {
  // Type changed from string to number (will trigger warning)
  myField: number = 0;
}

// Test classes for method override
@smrt()
export class ParentWithMethod extends SmrtObject {
  async doSomething(): Promise<string> {
    return 'parent';
  }
}

@smrt()
export class ChildWithMethod extends ParentWithMethod {
  async doSomething(): Promise<string> {
    return 'child';
  }
}

// Test class for missing ancestor warning
@smrt()
export class OrphanClass extends SmrtObject {
  orphanField: string = '';
}
