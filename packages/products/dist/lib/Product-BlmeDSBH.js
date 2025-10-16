import { SmrtObject as e, smrt as c } from "@smrt/core";
@c({
  api: {
    include: ["list", "get", "create", "update"]
    // Standard CRUD except delete
  },
  mcp: {
    include: ["list", "get"]
    // AI tools for category discovery
  },
  cli: !0
  // Enable CLI commands for admin
})
class s extends e {
  name = "";
  description = "";
  parentId;
  // For hierarchical categories
  level = 0;
  // Category depth in hierarchy
  productCount = 0;
  // Number of products in this category
  active = !0;
  constructor(t = {}) {
    super(t), this.name = t.name || "", this.description = t.description || "", this.parentId = t.parentId, this.level = t.level || 0, this.productCount = t.productCount || 0, this.active = t.active !== void 0 ? t.active : !0;
  }
  async getProducts() {
    return [];
  }
  async getSubcategories() {
    return [];
  }
  async updateProductCount() {
  }
  static async getRootCategories() {
    return [];
  }
}
@c({
  api: {
    include: ["list", "get", "create", "update"]
    // Standard CRUD except delete
  },
  mcp: {
    include: ["list", "get"]
    // AI tools for product discovery
  },
  cli: !0
  // Enable CLI commands for admin
})
class u extends e {
  name = "";
  description = "";
  category = "";
  // Reference to category
  manufacturer = "";
  model = "";
  price = 0;
  inStock = !0;
  specifications = {};
  tags = [];
  constructor(t = {}) {
    super(t), this.name = t.name || "", this.description = t.description || "", this.category = t.category || "", this.manufacturer = t.manufacturer || "", this.model = t.model || "", this.price = t.price || 0, this.inStock = t.inStock !== void 0 ? t.inStock : !0, this.specifications = t.specifications || {}, this.tags = t.tags || [];
  }
  async getSpecification(t) {
    return this.specifications[t];
  }
  async updateSpecification(t, i) {
    this.specifications[t] = i;
  }
  static async searchByText(t) {
    return [];
  }
  static async findByManufacturer(t) {
    return [];
  }
}
export {
  s as C,
  u as P
};
