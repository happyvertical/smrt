/**
 * Product Store - Svelte 5 Runes State Management
 *
 * Reactive store for managing product state with SMRT auto-generated client.
 * Uses Svelte 5 runes for reactive state management.
 */

import { createClient, type ProductData } from '../mock-smrt-client';

interface ProductStore {
  items: ProductData[];
  loading: boolean;
  error: string | null;
  selectedProduct: ProductData | null;
}

export class ProductStoreClass {
  private data = $state<ProductStore>({
    items: [],
    loading: false,
    error: null,
    selectedProduct: null,
  });

  private api = createClient('/api/v1');

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

  // Actions
  async loadProducts() {
    this.data.loading = true;
    this.data.error = null;

    try {
      const response = await this.api.products.list();
      if (response.data) {
        this.data.items = response.data;
      }
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : 'Failed to load products';
    } finally {
      this.data.loading = false;
    }
  }

  async createProduct(productData: Partial<ProductData>) {
    this.data.loading = true;
    this.data.error = null;

    try {
      const response = await this.api.products.create(productData);
      if (response.data) {
        this.data.items.push(response.data);
      }
      return response;
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
      const response = await this.api.products.update(id, updates);
      if (response.data) {
        const index = this.data.items.findIndex((p) => p.id === id);
        if (index !== -1) {
          this.data.items[index] = response.data;
        }

        // Update selected product if it's the one being updated
        if (this.data.selectedProduct?.id === id) {
          this.data.selectedProduct = response.data;
        }
      }
      return response;
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
      await this.api.products.delete(id);
      this.data.items = this.data.items.filter((p) => p.id !== id);

      // Clear selection if deleted product was selected
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

  // Filter methods (return derived arrays, don't mutate state)
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
