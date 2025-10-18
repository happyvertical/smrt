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
var _Content_decorators, _init, _a;
import { SmrtObject, smrt, SmrtCollection } from "@smrt/core";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchDocument } from "@have/documents";
import { ensureDirectoryExists } from "@have/files";
import { makeSlug } from "@have/utils";
import yaml from "yaml";
_Content_decorators = [smrt({
  api: {
    include: ["list", "get", "create", "update", "delete"]
    // Full CRUD operations
  },
  mcp: {
    include: ["list", "get", "create", "update"]
    // AI tools for content management
  },
  cli: true
  // Enable CLI commands for content management
})];
let _Content = class _Content extends (_a = SmrtObject) {
  /**
   * Array of referenced content objects
   */
  references = [];
  /**
   * Content type classification
   */
  type = null;
  /**
   * Content variant for namespaced classification within types
   * Format: generator:domain:specific-type
   * Example: "praeco:meeting:upcoming"
   */
  variant = null;
  /**
   * Reference to file storage key
   */
  fileKey = null;
  /**
   * Author of the content
   */
  author = null;
  /**
   * Content title
   */
  title = "";
  /**
   * Short description or summary
   */
  description = null;
  /**
   * Main content body text
   */
  body = "";
  /**
   * Date when content was published
   */
  publish_date = null;
  /**
   * URL source of the content
   */
  url = null;
  /**
   * Original source identifier
   */
  source = null;
  /**
   * Original URL of the content
   */
  original_url = null;
  /**
   * Content language
   */
  language = null;
  /**
   * Content tags
   */
  tags = [];
  /**
   * Publication status
   */
  status = "draft";
  /**
   * Content state flag
   */
  state = "active";
  /**
   * Additional JSON metadata for flexible schema extension
   */
  metadata = {};
  /**
   * Creates a new Content instance
   */
  constructor(options = {}) {
    super(options);
    this.type = options.type || null;
    this.variant = options.variant || null;
    this.fileKey = options.fileKey || null;
    this.author = options.author || null;
    this.title = options.title || "";
    this.description = options.description || null;
    this.body = options.body || "";
    this.publish_date = options.publish_date || null;
    this.source = options.source || null;
    this.original_url = options.original_url || null;
    this.language = options.language || null;
    this.status = options.status || "draft";
    this.tags = options.tags || [];
    this.state = options.state || "active";
    this.metadata = options.metadata || {};
  }
  /**
   * Initializes this content object
   *
   * @returns Promise that resolves to this instance
   */
  async initialize() {
    await super.initialize();
    if (this.title && !this.name) {
      this.name = this.title;
    }
    return this;
  }
  /**
   * Loads referenced content objects
   *
   * @returns Promise that resolves when references are loaded
   */
  async loadReferences() {
  }
  /**
   * Adds a reference to another content object
   *
   * @param content - Content object or URL to reference
   * @returns Promise that resolves when the reference is added
   */
  async addReference(content) {
    if (typeof content === "string") {
      content = new _Content({
        url: content
      });
      await content.initialize();
    }
    this.references.push(content);
  }
  /**
   * Gets all referenced content objects
   *
   * @returns Promise resolving to an array of referenced Content objects
   */
  async getReferences() {
    return this.references;
  }
  /**
   * Converts this content object to a plain JSON object
   *
   * @returns JSON representation of this content
   */
  toJSON() {
    return {
      id: this.id || "",
      slug: this.slug || "",
      context: this.context || "",
      type: this.type,
      variant: this.variant || "",
      fileKey: this.fileKey || "",
      author: this.author || "",
      title: this.title || "",
      description: this.description || "",
      body: this.body || "",
      publish_date: this.publish_date || "",
      url: this.url || "",
      source: this.source || "",
      status: this.status || "draft",
      state: this.state || "active"
    };
  }
};
_init = __decoratorStart(_a);
_Content = __decorateElement(_init, 0, "Content", _Content_decorators, _Content);
__runInitializers(_init, 1, _Content);
let Content = _Content;
class Contents extends SmrtCollection {
  /**
   * Class constructor for collection items
   */
  static _itemClass = Content;
  /**
   * Configuration options
   */
  options = {};
  /**
   * Directory to store content files
   */
  contentDir;
  /**
   * Cache for loaded content
   */
  loaded;
  /**
   * Creates a new Contents collection
   *
   * Use the static `create()` method inherited from SmrtCollection for proper initialization.
   *
   * @param options - Configuration options
   */
  constructor(options) {
    super(options);
    this.options = options;
    this.loaded = /* @__PURE__ */ new Map();
  }
  /**
   * Gets the database interface
   *
   * @returns Database interface
   */
  getDb() {
    return this._db;
  }
  /**
   * Initializes the collection
   *
   * @returns Promise that resolves to this instance
   */
  async initialize() {
    await super.initialize();
    return this;
  }
  /**
   * Mirrors content from a remote URL
   *
   * Downloads and stores content from a remote URL, extracting text
   * and saving it as a Content object.
   *
   * @param options - Mirror options
   * @param options.url - URL to mirror
   * @param options.mirrorDir - Directory for caching mirrored files
   * @param options.context - Context for the mirrored content
   * @returns Promise resolving to the mirrored Content object
   * @throws Error if URL is invalid or missing
   */
  async mirror(options) {
    if (!options.url) {
      throw new Error("No URL provided");
    }
    let url;
    try {
      url = new URL(options.url);
    } catch (error) {
      console.error(error);
      throw new Error(`Invalid URL provided: ${options.url}`);
    }
    const existing = await this.get({ url: options.url });
    if (existing) {
      return existing;
    }
    const doc = await fetchDocument(options.url, {
      cacheDir: options?.mirrorDir
    });
    const filename = url.pathname.split("/").pop();
    const nameWithoutExtension = filename?.replace(/\.[^/.]+$/, "");
    const title = nameWithoutExtension?.replace(/[-_]/g, " ");
    const slug = makeSlug(title);
    const body = doc.parts.map((part) => part.content).join("\n\n");
    if (body) {
      const content = new Content({
        url: options.url,
        type: "mirror",
        title,
        slug,
        context: options.context || "",
        body
      });
      await content.initialize();
      await content.save();
      return content;
    }
  }
  /**
   * Writes a Content object to the filesystem as a markdown file
   *
   * @param options - Options for writing the content file
   * @param options.content - Content object to write
   * @param options.contentDir - Directory to write the file to
   * @returns Promise that resolves when the file is written
   * @throws Error if contentDir is not provided
   */
  async writeContentFile(options) {
    const { content, contentDir } = options;
    if (!contentDir) {
      throw new Error("No content dir provided");
    }
    const { body } = content;
    const frontMatter = {
      title: content.title,
      slug: content.slug,
      context: content.context,
      author: content.author,
      publish_date: content.publish_date
    };
    let output = "";
    if (frontMatter && Object.keys(frontMatter).length > 0) {
      output += "---\n";
      output += yaml.stringify(frontMatter);
      output += "---\n";
    }
    let formattedBody = body || "";
    if (body && !this.isMarkdown(body)) {
      formattedBody = this.formatAsMarkdown(body);
    }
    output += formattedBody;
    const pathParts = [
      contentDir,
      content.context || "",
      // if empty, use empty string
      content.slug,
      "index.md"
    ].filter(Boolean);
    const outputFile = path.join(...pathParts);
    await ensureDirectoryExists(path.dirname(outputFile));
    await writeFile(outputFile, output);
  }
  /**
   * Checks if text appears to be in markdown format
   *
   * @param text - Text to check
   * @returns Boolean indicating if the text contains markdown syntax
   */
  isMarkdown(text) {
    const markdownIndicators = [
      /^#\s/m,
      // Headers
      /\*\*.+\*\*/,
      // Bold
      /\*.+\*/,
      // Italic
      /\[.+\]\(.+\)/,
      // Links
      /^\s*[-*+]\s/m,
      // Lists
      /^\s*\d+\.\s/m,
      // Numbered lists
      /```[\s\S]*```/,
      // Code blocks
      /^\s*>/m
      // Blockquotes
    ];
    return markdownIndicators.some((indicator) => indicator.test(text));
  }
  /**
   * Formats plain text as simple markdown
   *
   * @param text - Plain text to format
   * @returns Text formatted as basic markdown
   */
  formatAsMarkdown(text) {
    return text.split(/\n\n+/).map((paragraph) => paragraph.trim()).filter(Boolean).join("\n\n");
  }
  /**
   * Synchronizes content to the filesystem
   *
   * Writes all article-type Content objects to the filesystem
   * as markdown files.
   *
   * @param options - Sync options
   * @param options.contentDir - Directory to write content files to
   * @returns Promise that resolves when synchronization is complete
   */
  async syncContentDir(options) {
    const contentFilter = {
      type: "article"
    };
    const contents = await this.list({ where: contentFilter });
    for (const content of contents) {
      await this.writeContentFile({
        content,
        contentDir: options.contentDir || this.options.contentDir || ""
      });
    }
  }
  // public async list(options: {
  //   where?: object;
  //   filter?: object;
  //   offset?: number;
  //   limit?: number;
  // }): Promise<Content[]> {
  //   const { where, filter, offset, limit } = options;
  //   const replacements: any[] = [];
  //   let currIndex = 1;
  //   let whereSql = '';
  //   if (where) {
  //     whereSql = 'where ';
  //     for (const [key, value] of Object.entries(where)) {
  //       whereSql += ` AND ${key} = $${currIndex++}`;
  //       replacements.push(value);
  //     }
  //   }
  //   let whereNotSql = '';
  //   if (filter) {
  //     if (whereSql) {
  //       whereNotSql = ' and ';
  //     } else {
  //       whereNotSql += ' where ';
  //     }
  //     for (const [key, value] of Object.entries(filter)) {
  //       whereNotSql += `${key} != $${currIndex++}`;
  //       replacements.push(value);
  //     }
  //   }
  //   const { rows } = await this._db.query(
  //     `SELECT * FROM contents ${whereSql} ${whereNotSql} LIMIT ${limit} OFFSET ${offset}`,
  //     replacements,
  //   );
  //   return Promise.all(rows.map((row: any) => this.create(row)));
  // }
}
function contentToString(content) {
  const { body, ...frontmatter } = content;
  const separator = "---";
  const frontmatterYAML = yaml.stringify(frontmatter);
  return `${separator}
${frontmatterYAML}
${separator}
${body}`;
}
function stringToContent(data) {
  const separator = "---";
  const frontmatterStart = data.indexOf(separator);
  let frontmatter = {};
  let body = data;
  if (frontmatterStart !== -1) {
    const frontmatterEnd = data.indexOf(
      separator,
      frontmatterStart + separator.length
    );
    if (frontmatterEnd !== -1) {
      const frontmatterYAML = data.substring(frontmatterStart + separator.length, frontmatterEnd).trim();
      frontmatter = yaml.parse(frontmatterYAML) || {};
      body = data.substring(frontmatterEnd + separator.length).trim();
    }
  }
  return {
    ...frontmatter,
    body
  };
}
export {
  Content,
  Contents,
  contentToString,
  stringToContent
};
//# sourceMappingURL=index.js.map
