import { SmrtCollection } from '../../collection.js';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

// Real SMRT object for integration testing
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'analyze'] },
  cli: true,
})
export class McpIntegrationTestProduct extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field({ min: 0 })
  price: number = 0.0;

  @field({ default: 0 })
  stock: number = 0;

  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      product: this.name,
      price: this.price,
      inStock: this.stock > 0,
      timestamp: new Date(),
    };
  }
}

export class McpIntegrationTestProductCollection extends SmrtCollection<McpIntegrationTestProduct> {
  static readonly _itemClass = McpIntegrationTestProduct;
}
