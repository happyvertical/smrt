/**
 * Product Store - Client-only version for federation builds
 *
 * This version provides the same interface as the full product store
 * but uses mock data and doesn't depend on SMRT virtual modules.
 */

import type { ProductData } from '../types';

interface ProductStore {
  items: ProductData[];
  loading: boolean;
  error: string | null;
  selectedProduct: ProductData | null;
}

export class ProductStoreClass {
  private data = $state<ProductStore>({
    items: [
      {
        id: '1',
        name: 'Sample Product',
        description: 'This is a sample product for demonstration',
        price: 29.99,
        inStock: true,
        category: 'Electronics',
        tags: ['sample', 'demo'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    loading: false,
    error: null,
    selectedProduct: null,
  });

  // Reactive getters
  get items() {
    return this.data.items;
  }
  get loading() {
    return this.data.loading;
  }
  get error() {
    return this.data.error;
  }
  get selectedProduct() {
    return this.data.selectedProduct;
  }

  // Derived state
  get inStockCount() {
    return this.data.items.filter((p) => p.inStock).length;
  }

  get totalValue() {
    return this.data.items.reduce(
      (sum, product) => sum + (product.price || 0),
      0,
    );
  }

  get categories() {
    const categorySet = new Set(
      this.data.items.map((p) => p.category).filter(Boolean),
    );
    return Array.from(categorySet);
  }

  // Actions (mock implementations)
  async loadProducts() {
    this.data.loading = true;
    this.data.error = null;

    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 500));

    this.data.loading = false;
  }

  async createProduct(productData: Partial<ProductData>) {
    this.data.loading = true;
    this.data.error = null;

    try {
      const newProduct: ProductData = {
        id: String(Date.now()),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...productData,
      };

      this.data.items.push(newProduct);
      return { data: newProduct };
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : 'Failed to create product';
      throw err;
    } finally {
      this.data.loading = false;
    }
  }

  async updateProduct(id: string, updates: Partial<ProductData>) {
    this.data.loading = true;
    this.data.error = null;

    try {
      const index = this.data.items.findIndex((p) => p.id === id);
      if (index !== -1) {
        const updatedProduct = {
          ...this.data.items[index],
          ...updates,
          updated_at: new Date().toISOString(),
        };
        this.data.items[index] = updatedProduct;

        if (this.data.selectedProduct?.id === id) {
          this.data.selectedProduct = updatedProduct;
        }

        return { data: updatedProduct };
      }
      throw new Error('Product not found');
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : 'Failed to update product';
      throw err;
    } finally {
      this.data.loading = false;
    }
  }

  async deleteProduct(id: string) {
    this.data.loading = true;
    this.data.error = null;

    try {
      this.data.items = this.data.items.filter((p) => p.id !== id);

      if (this.data.selectedProduct?.id === id) {
        this.data.selectedProduct = null;
      }
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : 'Failed to delete product';
      throw err;
    } finally {
      this.data.loading = false;
    }
  }

  selectProduct(product: ProductData | null) {
    this.data.selectedProduct = product;
  }

  clearError() {
    this.data.error = null;
  }

  // Filter methods
  filterByCategory(category: string): ProductData[] {
    return this.data.items.filter((p) => p.category === category);
  }

  filterInStock(): ProductData[] {
    return this.data.items.filter((p) => p.inStock);
  }

  searchProducts(query: string): ProductData[] {
    const lowercaseQuery = query.toLowerCase();
    return this.data.items.filter(
      (product) =>
        product.name?.toLowerCase().includes(lowercaseQuery) ||
        product.description?.toLowerCase().includes(lowercaseQuery) ||
        product.tags?.some((tag) => tag.toLowerCase().includes(lowercaseQuery)),
    );
  }
}

// Export singleton instance
export const productStore = new ProductStoreClass();
