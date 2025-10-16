/**
 * Product knowledge base model
 *
 * SMRT auto-generates REST APIs, MCP tools, and TypeScript clients from this class.
 */

import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';

/**
 * Options for Product initialization
 */
export interface ProductOptions extends SmrtObjectOptions {
  name?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
  model?: string;
  price?: number;
  inStock?: boolean;
  specifications?: Record<string, any>;
  tags?: string[];
}

/**
 * Product information for knowledge base queries
 */
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'], // Standard CRUD except delete
  },
  mcp: {
    include: ['list', 'get'], // AI tools for product discovery
  },
  cli: true, // Enable CLI commands for admin
})
export class Product extends SmrtObject {
  name = '';
  description = '';
  category = ''; // Reference to category
  manufacturer = '';
  model = '';
  price = 0;
  inStock = true;
  specifications: Record<string, any> = {};
  tags: string[] = [];

  constructor(options: ProductOptions = {}) {
    super(options);
    this.name = options.name || '';
    this.description = options.description || '';
    this.category = options.category || '';
    this.manufacturer = options.manufacturer || '';
    this.model = options.model || '';
    this.price = options.price || 0;
    this.inStock = options.inStock !== undefined ? options.inStock : true;
    this.specifications = options.specifications || {};
    this.tags = options.tags || [];
  }

  async getSpecification(key: string): Promise<any> {
    return this.specifications[key];
  }

  async updateSpecification(key: string, value: any): Promise<void> {
    this.specifications[key] = value;
  }

  static async searchByText(_query: string): Promise<Product[]> {
    // Search implementation will be auto-generated
    return [];
  }

  static async findByManufacturer(_manufacturer: string): Promise<Product[]> {
    // Manufacturer search will be auto-generated
    return [];
  }
}
