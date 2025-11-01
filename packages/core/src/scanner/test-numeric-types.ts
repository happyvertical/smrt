/**
 * Sample classes for testing numeric type inference (integer vs decimal)
 * Tests the 0 vs 0.0 heuristic implementation
 */

import { SmrtObject } from '../object';

// Mock decorator function for testing
function smrt(_config?: any) {
  return (target: any) => target;
}

// Test class with various numeric literal patterns
@smrt()
class NumericTypes extends SmrtObject {
  // Integer patterns (no decimal point)
  count: number = 0;
  quantity: number = 1;
  viewCount: number = 42;
  negativeInt: number = -5;

  // Decimal patterns (has decimal point)
  price: number = 0.0;
  rating: number = 4.5;
  percentage: number = 0.95;
  temperature: number = -3.7;
  sciNotation: number = 1e10; // Note: This will be treated as integer (no dot)

  // Edge cases
  wholeAsDecimal: number = 1.0; // Has dot, should be decimal
  zeroWithoutDot: number = 0; // No dot (Biome removes trailing dot), should be integer

  // TypeScript type annotation should also work
  explicitNumber: number = 100; // No dot, should be integer

  // Strings and other types (for comparison)
  name: string = '';
  active: boolean = true;
}

export { NumericTypes };
