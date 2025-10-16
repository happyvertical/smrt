var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var _Category_decorators, _init, _a, _Product_decorators, _init2, _b;
import { SmrtObject, smrt } from "@have/smrt";
_Category_decorators = [smrt({
  api: {
    include: ["list", "get", "create", "update"]
    // Standard CRUD except delete
  },
  mcp: {
    include: ["list", "get"]
    // AI tools for category discovery
  },
  cli: true
  // Enable CLI commands for admin
})];
class Category extends (_a = SmrtObject) {
  name = "";
  description = "";
  parentId;
  // For hierarchical categories
  level = 0;
  // Category depth in hierarchy
  productCount = 0;
  // Number of products in this category
  active = true;
  constructor(options = {}) {
    super(options);
    this.name = options.name || "";
    this.description = options.description || "";
    this.parentId = options.parentId;
    this.level = options.level || 0;
    this.productCount = options.productCount || 0;
    this.active = options.active !== void 0 ? options.active : true;
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
_init = __decoratorStart(_a);
Category = __decorateElement(_init, 0, "Category", _Category_decorators, Category);
__runInitializers(_init, 1, Category);
_Product_decorators = [smrt({
  api: {
    include: ["list", "get", "create", "update"]
    // Standard CRUD except delete
  },
  mcp: {
    include: ["list", "get"]
    // AI tools for product discovery
  },
  cli: true
  // Enable CLI commands for admin
})];
class Product extends (_b = SmrtObject) {
  name = "";
  description = "";
  category = "";
  // Reference to category
  manufacturer = "";
  model = "";
  price = 0;
  inStock = true;
  specifications = {};
  tags = [];
  constructor(options = {}) {
    super(options);
    this.name = options.name || "";
    this.description = options.description || "";
    this.category = options.category || "";
    this.manufacturer = options.manufacturer || "";
    this.model = options.model || "";
    this.price = options.price || 0;
    this.inStock = options.inStock !== void 0 ? options.inStock : true;
    this.specifications = options.specifications || {};
    this.tags = options.tags || [];
  }
  async getSpecification(key) {
    return this.specifications[key];
  }
  async updateSpecification(key, value) {
    this.specifications[key] = value;
  }
  static async searchByText(_query) {
    return [];
  }
  static async findByManufacturer(_manufacturer) {
    return [];
  }
}
_init2 = __decoratorStart(_b);
Product = __decorateElement(_init2, 0, "Product", _Product_decorators, Product);
__runInitializers(_init2, 1, Product);
export {
  Category,
  Product
};
//# sourceMappingURL=index.js.map
