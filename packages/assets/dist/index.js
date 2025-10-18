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
var _Asset_decorators, _init, _a, _AssetMetafield_decorators, _init2, _b, _AssetStatus_decorators, _init3, _c, _AssetType_decorators, _init4, _d;
import { SmrtObject, smrt, SmrtCollection } from "@smrt/core";
_Asset_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
class Asset extends (_a = SmrtObject) {
  // Core fields
  name = "";
  // User-friendly name
  slug = "";
  // URL-friendly identifier
  sourceUri = "";
  // URI to the actual file (e.g., 's3://bucket/key', 'file:///path')
  mimeType = "";
  // MIME type (e.g., 'image/jpeg', 'video/mp4')
  description = "";
  // Optional description
  version = 1;
  // Version number
  // Foreign key references (stored as IDs/slugs)
  primaryVersionId = null;
  // Points to first version's ID
  typeSlug = "";
  // FK to AssetType.slug
  statusSlug = "";
  // FK to AssetStatus.slug
  ownerProfileId = null;
  // FK to Profile.id (nullable)
  parentId = null;
  // FK to Asset.id (for derivatives)
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.slug) this.slug = options.slug;
    if (options.sourceUri) this.sourceUri = options.sourceUri;
    if (options.mimeType) this.mimeType = options.mimeType;
    if (options.description) this.description = options.description;
    if (options.version !== void 0) this.version = options.version;
    if (options.primaryVersionId !== void 0)
      this.primaryVersionId = options.primaryVersionId;
    if (options.typeSlug) this.typeSlug = options.typeSlug;
    if (options.statusSlug) this.statusSlug = options.statusSlug;
    if (options.ownerProfileId !== void 0)
      this.ownerProfileId = options.ownerProfileId;
    if (options.parentId !== void 0) this.parentId = options.parentId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
  /**
   * Get all tags for this asset from @smrt/tags
   *
   * @returns Array of Tag instances from @smrt/tags package
   */
  async getTags() {
    const collection = this.getCollection();
    if (!collection) return [];
    const db = await collection.getDb();
    const rows = await db.prepare("SELECT tag_slug FROM asset_tags WHERE asset_id = ?").all(this.id);
    const { Tag } = await import("@smrt/tags");
    const tags = [];
    for (const row of rows) {
      const tag = await Tag.getBySlug(row.tag_slug);
      if (tag) tags.push(tag);
    }
    return tags;
  }
  /**
   * Check if this asset has a specific tag
   *
   * @param tagSlug - The slug of the tag to check
   * @returns True if the asset has this tag
   */
  async hasTag(tagSlug) {
    const collection = this.getCollection();
    if (!collection) return false;
    const db = await collection.getDb();
    const result = await db.prepare(
      "SELECT COUNT(*) as count FROM asset_tags WHERE asset_id = ? AND tag_slug = ?"
    ).get(this.id, tagSlug);
    return result.count > 0;
  }
  /**
   * Get the parent asset (if this is a derivative)
   *
   * @returns Parent Asset instance or null
   */
  async getParent() {
    if (!this.parentId) return null;
    const collection = this.getCollection();
    if (!collection) return null;
    return await collection.get({ id: this.parentId });
  }
  /**
   * Get all derivative assets (children)
   *
   * @returns Array of child Asset instances
   */
  async getChildren() {
    const collection = this.getCollection();
    if (!collection) return [];
    return await collection.list({
      where: { parentId: this.id }
    });
  }
  /**
   * Get the type of this asset
   *
   * @returns AssetType instance or null
   */
  async getType() {
    if (!this.typeSlug) return null;
    const { AssetType: AssetType2 } = await Promise.resolve().then(() => assetType);
    return await AssetType2.getBySlug(this.typeSlug);
  }
  /**
   * Get the status of this asset
   *
   * @returns AssetStatus instance or null
   */
  async getStatus() {
    if (!this.statusSlug) return null;
    const { AssetStatus: AssetStatus2 } = await Promise.resolve().then(() => assetStatus);
    return await AssetStatus2.getBySlug(this.statusSlug);
  }
  /**
   * Get asset by slug
   *
   * @param slug - The slug to search for
   * @returns Asset instance or null
   */
  static async getBySlug(_slug) {
    return null;
  }
}
_init = __decoratorStart(_a);
Asset = __decorateElement(_init, 0, "Asset", _Asset_decorators, Asset);
__runInitializers(_init, 1, Asset);
_AssetMetafield_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create"] },
  cli: true
})];
class AssetMetafield extends (_b = SmrtObject) {
  slug = "";
  // Primary key (human-readable identifier, e.g., 'width', 'height')
  name = "";
  // Display name (e.g., 'Width', 'Height')
  validation = "";
  // JSON validation rules stored as text
  constructor(options = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.validation) this.validation = options.validation;
  }
  /**
   * Get validation rules as parsed object
   *
   * @returns Parsed validation object or empty object if no validation
   */
  getValidation() {
    if (!this.validation) return {};
    try {
      return JSON.parse(this.validation);
    } catch {
      return {};
    }
  }
  /**
   * Set validation rules from object
   *
   * @param rules - Validation rules object
   */
  setValidation(rules) {
    this.validation = JSON.stringify(rules);
  }
  /**
   * Get asset metafield by slug
   *
   * @param slug - The slug to search for
   * @returns AssetMetafield instance or null
   */
  static async getBySlug(_slug) {
    return null;
  }
}
_init2 = __decoratorStart(_b);
AssetMetafield = __decorateElement(_init2, 0, "AssetMetafield", _AssetMetafield_decorators, AssetMetafield);
__runInitializers(_init2, 1, AssetMetafield);
class AssetMetafieldCollection extends SmrtCollection {
  static _itemClass = AssetMetafield;
  /**
   * Get or create an asset metafield by slug
   *
   * @param slug - The metafield slug
   * @param name - The display name (defaults to slug)
   * @param validation - Optional validation rules (JSON string or object)
   * @returns The existing or newly created AssetMetafield
   */
  async getOrCreate(slug, name, validation) {
    const existing = await this.list({ where: { slug }, limit: 1 });
    if (existing.length > 0) {
      return existing[0];
    }
    const validationString = typeof validation === "string" ? validation : validation ? JSON.stringify(validation) : "";
    return await this.create({
      slug,
      name: name || slug,
      validation: validationString
    });
  }
  /**
   * Initialize common asset metafields
   *
   * Creates standard metafields with validation rules:
   * - width (integer, min: 0)
   * - height (integer, min: 0)
   * - duration (number, min: 0)
   * - size (integer, min: 0)
   * - author (string)
   * - copyright (string)
   */
  async initializeCommonMetafields() {
    await this.getOrCreate("width", "Width", {
      type: "integer",
      min: 0,
      description: "Width in pixels"
    });
    await this.getOrCreate("height", "Height", {
      type: "integer",
      min: 0,
      description: "Height in pixels"
    });
    await this.getOrCreate("duration", "Duration", {
      type: "number",
      min: 0,
      description: "Duration in seconds"
    });
    await this.getOrCreate("size", "File Size", {
      type: "integer",
      min: 0,
      description: "File size in bytes"
    });
    await this.getOrCreate("author", "Author", {
      type: "string",
      description: "Content creator"
    });
    await this.getOrCreate("copyright", "Copyright", {
      type: "string",
      description: "Copyright notice"
    });
  }
}
_AssetStatus_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create"] },
  cli: true
})];
class AssetStatus extends (_c = SmrtObject) {
  slug = "";
  // Primary key (human-readable identifier, e.g., 'draft', 'published')
  name = "";
  // Display name (e.g., 'Draft', 'Published')
  description = "";
  // Optional description
  constructor(options = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.description) this.description = options.description;
  }
  /**
   * Get asset status by slug
   *
   * @param slug - The slug to search for
   * @returns AssetStatus instance or null
   */
  static async getBySlug(_slug) {
    return null;
  }
}
_init3 = __decoratorStart(_c);
AssetStatus = __decorateElement(_init3, 0, "AssetStatus", _AssetStatus_decorators, AssetStatus);
__runInitializers(_init3, 1, AssetStatus);
const assetStatus = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AssetStatus
}, Symbol.toStringTag, { value: "Module" }));
class AssetStatusCollection extends SmrtCollection {
  static _itemClass = AssetStatus;
  /**
   * Get or create an asset status by slug
   *
   * @param slug - The asset status slug
   * @param name - The display name (defaults to slug)
   * @param description - Optional description
   * @returns The existing or newly created AssetStatus
   */
  async getOrCreate(slug, name, description) {
    const existing = await this.list({ where: { slug }, limit: 1 });
    if (existing.length > 0) {
      return existing[0];
    }
    return await this.create({
      slug,
      name: name || slug,
      description
    });
  }
  /**
   * Initialize common asset statuses
   *
   * Creates standard asset statuses if they don't exist:
   * - draft
   * - published
   * - archived
   * - deleted
   */
  async initializeCommonStatuses() {
    await this.getOrCreate("draft", "Draft", "Work in progress, not yet ready");
    await this.getOrCreate("published", "Published", "Live and available");
    await this.getOrCreate(
      "archived",
      "Archived",
      "No longer active but preserved"
    );
    await this.getOrCreate("deleted", "Deleted", "Marked for deletion");
  }
}
_AssetType_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create"] },
  cli: true
})];
class AssetType extends (_d = SmrtObject) {
  slug = "";
  // Primary key (human-readable identifier, e.g., 'image', 'video')
  name = "";
  // Display name (e.g., 'Image', 'Video')
  description = "";
  // Optional description
  constructor(options = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.description) this.description = options.description;
  }
  /**
   * Get asset type by slug
   *
   * @param slug - The slug to search for
   * @returns AssetType instance or null
   */
  static async getBySlug(_slug) {
    return null;
  }
}
_init4 = __decoratorStart(_d);
AssetType = __decorateElement(_init4, 0, "AssetType", _AssetType_decorators, AssetType);
__runInitializers(_init4, 1, AssetType);
const assetType = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AssetType
}, Symbol.toStringTag, { value: "Module" }));
class AssetTypeCollection extends SmrtCollection {
  static _itemClass = AssetType;
  /**
   * Get or create an asset type by slug
   *
   * @param slug - The asset type slug
   * @param name - The display name (defaults to slug)
   * @param description - Optional description
   * @returns The existing or newly created AssetType
   */
  async getOrCreate(slug, name, description) {
    const existing = await this.list({ where: { slug }, limit: 1 });
    if (existing.length > 0) {
      return existing[0];
    }
    return await this.create({
      slug,
      name: name || slug,
      description
    });
  }
  /**
   * Initialize common asset types
   *
   * Creates standard asset types if they don't exist:
   * - image
   * - video
   * - document
   * - audio
   * - folder
   */
  async initializeCommonTypes() {
    await this.getOrCreate(
      "image",
      "Image",
      "Image files (JPEG, PNG, GIF, etc.)"
    );
    await this.getOrCreate(
      "video",
      "Video",
      "Video files (MP4, AVI, MOV, etc.)"
    );
    await this.getOrCreate(
      "document",
      "Document",
      "Document files (PDF, DOCX, TXT, etc.)"
    );
    await this.getOrCreate(
      "audio",
      "Audio",
      "Audio files (MP3, WAV, AAC, etc.)"
    );
    await this.getOrCreate(
      "folder",
      "Folder",
      "Container for organizing assets"
    );
  }
}
class AssetCollection extends SmrtCollection {
  static _itemClass = Asset;
  /**
   * Add a tag to an asset (uses @smrt/tags)
   *
   * @param assetId - The asset ID to tag
   * @param tagSlug - The tag slug from @smrt/tags
   */
  async addTag(assetId, tagSlug) {
    const db = await this.getDb();
    await db.prepare(
      "INSERT OR IGNORE INTO asset_tags (asset_id, tag_slug, created_at) VALUES (?, ?, ?)"
    ).run(assetId, tagSlug, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Remove a tag from an asset
   *
   * @param assetId - The asset ID
   * @param tagSlug - The tag slug to remove
   */
  async removeTag(assetId, tagSlug) {
    const db = await this.getDb();
    await db.prepare("DELETE FROM asset_tags WHERE asset_id = ? AND tag_slug = ?").run(assetId, tagSlug);
  }
  /**
   * Get all assets with a specific tag
   *
   * @param tagSlug - The tag slug to filter by
   * @returns Array of assets with this tag
   */
  async getByTag(tagSlug) {
    const db = await this.getDb();
    const rows = await db.prepare("SELECT asset_id FROM asset_tags WHERE tag_slug = ?").all(tagSlug);
    const assets = [];
    for (const row of rows) {
      const asset = await this.get({ id: row.asset_id });
      if (asset) assets.push(asset);
    }
    return assets;
  }
  /**
   * Get assets by type
   *
   * @param typeSlug - The asset type slug (e.g., 'image', 'video')
   * @returns Array of assets matching the type
   */
  async getByType(typeSlug) {
    return await this.list({ where: { typeSlug } });
  }
  /**
   * Get assets by status
   *
   * @param statusSlug - The asset status slug (e.g., 'published', 'draft')
   * @returns Array of assets matching the status
   */
  async getByStatus(statusSlug) {
    return await this.list({ where: { statusSlug } });
  }
  /**
   * Get assets by owner
   *
   * @param ownerProfileId - The profile ID of the owner
   * @returns Array of assets owned by this profile
   */
  async getByOwner(ownerProfileId) {
    return await this.list({ where: { ownerProfileId } });
  }
  /**
   * Create a new version of an existing asset
   *
   * @param primaryVersionId - The primary version ID (first version's ID)
   * @param newSourceUri - The new source URI for this version
   * @param updates - Optional additional updates
   * @returns The newly created asset version
   */
  async createNewVersion(primaryVersionId, newSourceUri, updates = {}) {
    const versions = await this.listVersions(primaryVersionId);
    if (versions.length === 0) {
      throw new Error(
        `No asset found with primary version ID: ${primaryVersionId}`
      );
    }
    versions.sort((a, b) => b.version - a.version);
    const latestVersion = versions[0];
    return await this.create({
      ...latestVersion,
      id: void 0,
      // Generate new ID
      sourceUri: newSourceUri,
      version: latestVersion.version + 1,
      primaryVersionId,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date(),
      ...updates
    });
  }
  /**
   * Get the latest version of an asset
   *
   * @param primaryVersionId - The primary version ID
   * @returns The latest version or null
   */
  async getLatestVersion(primaryVersionId) {
    const versions = await this.listVersions(primaryVersionId);
    if (versions.length === 0) return null;
    versions.sort((a, b) => b.version - a.version);
    return versions[0];
  }
  /**
   * List all versions of an asset
   *
   * @param primaryVersionId - The primary version ID
   * @returns Array of all asset versions, ordered by version number
   */
  async listVersions(primaryVersionId) {
    const db = await this.getDb();
    const rows = await db.prepare(
      "SELECT * FROM assets WHERE primary_version_id = ? OR id = ? ORDER BY version ASC"
    ).all(primaryVersionId, primaryVersionId);
    return rows.map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });
  }
  /**
   * Get child assets (derivatives) of a parent asset
   *
   * @param parentId - The parent asset ID
   * @returns Array of child assets
   */
  async getChildren(parentId) {
    return await this.list({ where: { parentId } });
  }
  /**
   * Get assets by MIME type pattern
   *
   * @param mimePattern - MIME type pattern (e.g., 'image/*', 'video/mp4')
   * @returns Array of matching assets
   */
  async getByMimeType(mimePattern) {
    const db = await this.getDb();
    const pattern = mimePattern.replace("*", "%");
    const rows = await db.prepare("SELECT * FROM assets WHERE mime_type LIKE ?").all(pattern);
    return rows.map((row) => {
      const asset = new Asset();
      Object.assign(asset, row);
      return asset;
    });
  }
}
export {
  Asset,
  AssetCollection,
  AssetMetafield,
  AssetMetafieldCollection,
  AssetStatus,
  AssetStatusCollection,
  AssetType,
  AssetTypeCollection
};
//# sourceMappingURL=index.js.map
