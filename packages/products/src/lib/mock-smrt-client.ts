/**
 * Mock SMRT Client - Temporary implementation for demo purposes
 *
 * This replaces the missing @smrt/client virtual module with a working implementation
 * that demonstrates the intended functionality.
 */

export interface ProductData {
  id?: string;
  name: string;
  description?: string;
  category: string;
  manufacturer?: string;
  model?: string;
  price?: number;
  inStock?: boolean;
  specifications?: Record<string, any>;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
}

// Mock data store
const mockProducts: ProductData[] = [
  {
    id: '1',
    name: 'Demo Product',
    description: 'A sample product for demonstration',
    category: 'Electronics',
    manufacturer: 'Demo Corp',
    model: 'DM-100',
    price: 29.99,
    inStock: true,
    specifications: { weight: '1.2kg', color: 'Black' },
    tags: ['demo', 'sample'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '2',
    name: 'Budget Item',
    description: 'An affordable option',
    category: 'Accessories',
    manufacturer: 'Budget Inc',
    model: 'BI-200',
    price: 19.99,
    inStock: false,
    specifications: { size: 'small' },
    tags: ['budget', 'affordable'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

class MockApiClient {
  products = {
    async list(): Promise<ApiResponse<ProductData[]>> {
      // Simulate API delay
      await new Promise((resolve) => setTimeout(resolve, 500));

      return {
        data: [...mockProducts],
        success: true,
        message: 'Products retrieved successfully',
      };
    },

    async get(id: string): Promise<ApiResponse<ProductData>> {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const product = mockProducts.find((p) => p.id === id);
      if (!product) {
        throw new Error(`Product with id ${id} not found`);
      }

      return {
        data: product,
        success: true,
        message: 'Product retrieved successfully',
      };
    },

    async create(
      productData: Partial<ProductData>,
    ): Promise<ApiResponse<ProductData>> {
      await new Promise((resolve) => setTimeout(resolve, 300));

      const newProduct: ProductData = {
        id: (mockProducts.length + 1).toString(),
        name: productData.name || 'Untitled Product',
        description: productData.description || '',
        category: productData.category || 'Uncategorized',
        manufacturer: productData.manufacturer || '',
        model: productData.model || '',
        price: productData.price || 0,
        inStock: productData.inStock ?? true,
        specifications: productData.specifications || {},
        tags: productData.tags || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockProducts.push(newProduct);

      return {
        data: newProduct,
        success: true,
        message: 'Product created successfully',
      };
    },

    async update(
      id: string,
      updates: Partial<ProductData>,
    ): Promise<ApiResponse<ProductData>> {
      await new Promise((resolve) => setTimeout(resolve, 300));

      const index = mockProducts.findIndex((p) => p.id === id);
      if (index === -1) {
        throw new Error(`Product with id ${id} not found`);
      }

      const updatedProduct = {
        ...mockProducts[index],
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      mockProducts[index] = updatedProduct;

      return {
        data: updatedProduct,
        success: true,
        message: 'Product updated successfully',
      };
    },

    async delete(id: string): Promise<ApiResponse<void>> {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const index = mockProducts.findIndex((p) => p.id === id);
      if (index === -1) {
        throw new Error(`Product with id ${id} not found`);
      }

      mockProducts.splice(index, 1);

      return {
        data: undefined as any,
        success: true,
        message: 'Product deleted successfully',
      };
    },
  };

  categories = {
    async list(): Promise<ApiResponse<string[]>> {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const categories = Array.from(
        new Set(mockProducts.map((p) => p.category).filter(Boolean)),
      );

      return {
        data: categories,
        success: true,
        message: 'Categories retrieved successfully',
      };
    },
  };
}

export function createClient(baseUrl = '/api/v1'): MockApiClient {
  return new MockApiClient();
}

export default createClient;
