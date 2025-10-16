import { a5 as d, Q as c, m as n, R as u } from "./runtime-EeMZGCYM.js";
const r = [
  {
    id: "1",
    name: "Demo Product",
    description: "A sample product for demonstration",
    category: "Electronics",
    manufacturer: "Demo Corp",
    model: "DM-100",
    price: 29.99,
    inStock: !0,
    specifications: { weight: "1.2kg", color: "Black" },
    tags: ["demo", "sample"],
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  },
  {
    id: "2",
    name: "Budget Item",
    description: "An affordable option",
    category: "Accessories",
    manufacturer: "Budget Inc",
    model: "BI-200",
    price: 19.99,
    inStock: !1,
    specifications: { size: "small" },
    tags: ["budget", "affordable"],
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  }
];
class l {
  products = {
    async list() {
      return await new Promise((t) => setTimeout(t, 500)), {
        data: [...r],
        success: !0,
        message: "Products retrieved successfully"
      };
    },
    async get(t) {
      await new Promise((a) => setTimeout(a, 200));
      const e = r.find((a) => a.id === t);
      if (!e)
        throw new Error(`Product with id ${t} not found`);
      return {
        data: e,
        success: !0,
        message: "Product retrieved successfully"
      };
    },
    async create(t) {
      await new Promise((a) => setTimeout(a, 300));
      const e = {
        id: (r.length + 1).toString(),
        name: t.name || "Untitled Product",
        description: t.description || "",
        category: t.category || "Uncategorized",
        manufacturer: t.manufacturer || "",
        model: t.model || "",
        price: t.price || 0,
        inStock: t.inStock ?? !0,
        specifications: t.specifications || {},
        tags: t.tags || [],
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return r.push(e), {
        data: e,
        success: !0,
        message: "Product created successfully"
      };
    },
    async update(t, e) {
      await new Promise((i) => setTimeout(i, 300));
      const a = r.findIndex((i) => i.id === t);
      if (a === -1)
        throw new Error(`Product with id ${t} not found`);
      const s = {
        ...r[a],
        ...e,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return r[a] = s, {
        data: s,
        success: !0,
        message: "Product updated successfully"
      };
    },
    async delete(t) {
      await new Promise((a) => setTimeout(a, 200));
      const e = r.findIndex((a) => a.id === t);
      if (e === -1)
        throw new Error(`Product with id ${t} not found`);
      return r.splice(e, 1), {
        data: void 0,
        success: !0,
        message: "Product deleted successfully"
      };
    }
  };
  categories = {
    async list() {
      return await new Promise((e) => setTimeout(e, 200)), {
        data: Array.from(
          new Set(r.map((e) => e.category).filter(Boolean))
        ),
        success: !0,
        message: "Categories retrieved successfully"
      };
    }
  };
}
function m(o = "/api/v1") {
  return new l();
}
class g {
  #t = d(c({
    items: [],
    loading: !1,
    error: null,
    selectedProduct: null
  }));
  get data() {
    return n(this.#t);
  }
  set data(t) {
    u(this.#t, t, !0);
  }
  api = m("/api/v1");
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
    return this.data.items.filter((t) => t.inStock).length;
  }
  get totalValue() {
    return this.data.items.reduce((t, e) => t + (e.price || 0), 0);
  }
  get categories() {
    const t = new Set(this.data.items.map((e) => e.category).filter(Boolean));
    return Array.from(t);
  }
  // Actions
  async loadProducts() {
    this.data.loading = !0, this.data.error = null;
    try {
      const t = await this.api.products.list();
      t.data && (this.data.items = t.data);
    } catch (t) {
      this.data.error = t instanceof Error ? t.message : "Failed to load products";
    } finally {
      this.data.loading = !1;
    }
  }
  async createProduct(t) {
    this.data.loading = !0, this.data.error = null;
    try {
      const e = await this.api.products.create(t);
      return e.data && this.data.items.push(e.data), e;
    } catch (e) {
      throw this.data.error = e instanceof Error ? e.message : "Failed to create product", e;
    } finally {
      this.data.loading = !1;
    }
  }
  async updateProduct(t, e) {
    this.data.loading = !0, this.data.error = null;
    try {
      const a = await this.api.products.update(t, e);
      if (a.data) {
        const s = this.data.items.findIndex((i) => i.id === t);
        s !== -1 && (this.data.items[s] = a.data), this.data.selectedProduct?.id === t && (this.data.selectedProduct = a.data);
      }
      return a;
    } catch (a) {
      throw this.data.error = a instanceof Error ? a.message : "Failed to update product", a;
    } finally {
      this.data.loading = !1;
    }
  }
  async deleteProduct(t) {
    this.data.loading = !0, this.data.error = null;
    try {
      await this.api.products.delete(t), this.data.items = this.data.items.filter((e) => e.id !== t), this.data.selectedProduct?.id === t && (this.data.selectedProduct = null);
    } catch (e) {
      throw this.data.error = e instanceof Error ? e.message : "Failed to delete product", e;
    } finally {
      this.data.loading = !1;
    }
  }
  selectProduct(t) {
    this.data.selectedProduct = t;
  }
  clearError() {
    this.data.error = null;
  }
  // Filter methods (return derived arrays, don't mutate state)
  filterByCategory(t) {
    return this.data.items.filter((e) => e.category === t);
  }
  filterInStock() {
    return this.data.items.filter((t) => t.inStock);
  }
  searchProducts(t) {
    const e = t.toLowerCase();
    return this.data.items.filter((a) => a.name?.toLowerCase().includes(e) || a.description?.toLowerCase().includes(e) || a.tags?.some((s) => s.toLowerCase().includes(e)));
  }
}
const f = new g();
export {
  g as ProductStoreClass,
  f as productStore
};
