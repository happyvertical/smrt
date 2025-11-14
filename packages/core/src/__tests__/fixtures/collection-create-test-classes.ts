import { SmrtCollection } from '../../collection.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Test models for collection-create.test.ts
@smrt()
export class CollectionCreateTestProduct extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  quantity: number = 0;
}

@smrt()
export class CollectionCreateTestProductCollection extends SmrtCollection<CollectionCreateTestProduct> {
  static readonly _itemClass = CollectionCreateTestProduct;

  // Custom method to verify subclass typing
  customMethod(): string {
    return 'custom-method';
  }
}

// STI test models (from issue #283)
@smrt({ tableStrategy: 'sti' })
export class Organization extends SmrtObject {
  name: string = '';
  type: string = '';
}

@smrt()
export class Council extends Organization {
  jurisdiction: string = '';
}

@smrt({ tableName: 'profiles' })
export class Councils extends SmrtCollection<Council> {
  static readonly _itemClass = Council;

  // Custom method specific to Councils
  async getByJurisdiction(jurisdiction: string): Promise<Council | null> {
    return await this.get({ jurisdiction });
  }
}
