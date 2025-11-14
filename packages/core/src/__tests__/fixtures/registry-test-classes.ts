import { integer, text } from '../../fields/index.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Test classes for registry.test.ts
@smrt()
export class TestCategory extends SmrtObject {
  name = text();
  description = text();
}

@smrt()
export class TestCustomer extends SmrtObject {
  name = text();
  email = text();
}

@smrt()
export class RegistryTestProduct extends SmrtObject {
  name = text();
  price = integer();
  categoryId = text();
}

@smrt()
export class TestOrder extends SmrtObject {
  customerId = text();
  productId = text();
  total = integer();
}

// Test class for Field helper preservation (Issue #102, #103)
@smrt()
export class OverwriteTestObject extends SmrtObject {
  // Field helper with specific configuration
  name = text({ required: true, maxLength: 100 });
}
