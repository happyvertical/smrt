import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Test classes for registry.test.ts
@smrt()
export class TestCategory extends SmrtObject {
  name: string = '';
  description: string = '';
}

@smrt()
export class TestCustomer extends SmrtObject {
  name: string = '';
  email: string = '';
}

@smrt()
export class RegistryTestProduct extends SmrtObject {
  name: string = '';
  price: number = 0;
  categoryId: string = '';
}

@smrt()
export class TestOrder extends SmrtObject {
  customerId: string = '';
  productId: string = '';
  total: number = 0;
}

// Test class for decorator preservation (Issue #102, #103)
@smrt()
export class OverwriteTestObject extends SmrtObject {
  // Decorator with specific configuration
  @field({ required: true, maxLength: 100 })
  name: string = '';
}
