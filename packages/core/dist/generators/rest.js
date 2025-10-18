import http from "node:http";
import { O as ObjectRegistry } from "../chunks/registry-x79_kU2s.js";
class APIGenerator {
  config;
  collections = /* @__PURE__ */ new Map();
  context;
  constructor(config = {}, context = {}) {
    this.config = {
      basePath: "/api/v1",
      enableCors: true,
      port: 3e3,
      hostname: "0.0.0.0",
      ...config
    };
    this.context = context;
  }
  /**
   * Register a pre-configured collection instance for API exposure
   *
   * @param name - URL path segment for the collection (e.g., 'products' for /api/products)
   * @param collection - Pre-initialized SmrtCollection instance
   */
  registerCollection(name, collection) {
    this.collections.set(name, collection);
  }
  /**
   * Create Node.js HTTP server with all routes
   */
  createServer() {
    const server = http.createServer(async (req, res) => {
      try {
        const request = await this.nodeRequestToWebRequest(req);
        const response = await this.handleRequest(request);
        await this.webResponseToNodeResponse(response, res);
      } catch (_error) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
    server.listen(this.config.port, this.config.hostname);
    return {
      server,
      url: `http://${this.config.hostname}:${this.config.port}`
    };
  }
  /**
   * Convert stream to string
   */
  async streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  /**
   * Convert Node.js IncomingMessage to Web Request
   */
  async nodeRequestToWebRequest(req) {
    const url = `http://${this.config.hostname}:${this.config.port}${req.url}`;
    const method = req.method || "GET";
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value[0] : value);
      }
    }
    let body;
    if (method !== "GET" && method !== "HEAD") {
      body = await this.streamToString(req);
    }
    return new Request(url, {
      method,
      headers,
      body
    });
  }
  /**
   * Convert Web Response to Node.js ServerResponse
   */
  async webResponseToNodeResponse(webResponse, res) {
    res.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers.entries()) {
      res.setHeader(key, value);
    }
    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  }
  /**
   * Generate fetch handler function (for serverless environments)
   */
  generateHandler() {
    return (req) => this.handleRequest(req);
  }
  /**
   * Main request handler using native Bun APIs
   */
  async handleRequest(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS" && this.config.enableCors) {
      return this.createCorsResponse();
    }
    if (this.config.customRoutes) {
      for (const [path, handler] of Object.entries(this.config.customRoutes)) {
        if (url.pathname === `${this.config.basePath}${path}`) {
          const response = await handler(req);
          return this.addCorsHeaders(response);
        }
      }
    }
    if (url.pathname.startsWith(this.config.basePath || "")) {
      const response = await this.handleObjectRoute(req, url);
      return this.addCorsHeaders(response);
    }
    return this.createErrorResponse(404, "Not found");
  }
  /**
   * Handle CRUD routes for SMRT objects
   */
  async handleObjectRoute(req, url) {
    const pathParts = url.pathname.replace(this.config.basePath || "", "").split("/").filter(Boolean);
    if (pathParts.length === 0) {
      return this.createErrorResponse(400, "Object type required");
    }
    const objectType = pathParts[0];
    const objectId = pathParts[1];
    if (this.collections.has(objectType)) {
      const collection2 = this.collections.get(objectType);
      if (!collection2) throw new Error(`Collection ${objectType} not found`);
      if (this.config.authMiddleware) {
        const authCheck = this.config.authMiddleware(
          objectType,
          req.method.toLowerCase()
        );
        const authResult = await authCheck(req);
        if (authResult instanceof Response) {
          return authResult;
        }
        req = authResult;
      }
      return await this.executeCrudOperation(req, collection2, objectId, url);
    }
    const registeredClasses = ObjectRegistry.getAllClasses();
    const pluralName = this.pluralize(objectType);
    let classInfo = null;
    for (const [name, info] of registeredClasses) {
      if (this.pluralize(name.toLowerCase()) === pluralName) {
        classInfo = info;
        break;
      }
    }
    if (!classInfo) {
      return this.createErrorResponse(
        404,
        `Object type '${objectType}' not found`
      );
    }
    if (this.config.authMiddleware) {
      const authCheck = this.config.authMiddleware(
        classInfo.name,
        req.method.toLowerCase()
      );
      const authResult = await authCheck(req);
      if (authResult instanceof Response) {
        return authResult;
      }
      req = authResult;
    }
    const collection = this.getCollection(classInfo);
    return await this.executeCrudOperation(req, collection, objectId, url);
  }
  /**
   * Execute CRUD operation on a collection
   */
  async executeCrudOperation(req, collection, objectId, url) {
    try {
      if (objectId === "count" && req.method === "GET") {
        return await this.handleCount(collection, url.searchParams);
      }
      switch (req.method) {
        case "GET":
          return objectId ? await this.handleGet(collection, objectId) : await this.handleList(collection, url.searchParams);
        case "POST":
          return await this.handleCreate(collection, req);
        case "PUT":
        case "PATCH":
          if (!objectId) {
            return this.createErrorResponse(
              400,
              "Object ID required for update"
            );
          }
          return await this.handleUpdate(collection, objectId, req);
        case "DELETE":
          if (!objectId) {
            return this.createErrorResponse(
              400,
              "Object ID required for delete"
            );
          }
          return await this.handleDelete(collection, objectId);
        default:
          return this.createErrorResponse(405, "Method not allowed");
      }
    } catch (error) {
      console.error("API Error:", error);
      return this.createErrorResponse(500, "Internal server error");
    }
  }
  /**
   * Handle GET /objects/:id
   */
  async handleGet(collection, id) {
    const object = await collection.get(id);
    if (!object) {
      return this.createErrorResponse(404, "Object not found");
    }
    return this.createJsonResponse(object);
  }
  /**
   * Handle GET /objects (list with query params)
   */
  async handleList(collection, params) {
    const limit = Number.parseInt(params.get("limit") || "50", 10);
    const offset = Number.parseInt(params.get("offset") || "0", 10);
    const orderBy = params.get("orderBy") || "created_at DESC";
    const where = {};
    for (const [key, value] of params.entries()) {
      if (!["limit", "offset", "orderBy"].includes(key)) {
        const match = key.match(/^(.+)\[(.+)\]$/);
        if (match) {
          const field = match[1];
          const operator = match[2];
          const operatorMap = {
            gt: ">",
            gte: ">=",
            lt: "<",
            lte: "<=",
            ne: "!=",
            in: "in",
            like: "like"
          };
          const sqlOperator = operatorMap[operator] || operator;
          const sqlKey = `${field} ${sqlOperator}`;
          where[sqlKey] = operator === "in" ? value.split(",") : value;
        } else {
          where[key] = value;
        }
      }
    }
    const objects = await collection.list({
      where: Object.keys(where).length > 0 ? where : void 0,
      limit,
      offset,
      orderBy
    });
    return this.createJsonResponse(objects);
  }
  /**
   * Handle GET /objects/count
   */
  async handleCount(collection, params) {
    const where = {};
    for (const [key, value] of params.entries()) {
      const match = key.match(/^(.+)\[(.+)\]$/);
      if (match) {
        const field = match[1];
        const operator = match[2];
        const operatorMap = {
          gt: ">",
          gte: ">=",
          lt: "<",
          lte: "<=",
          ne: "!=",
          in: "in",
          like: "like"
        };
        const sqlOperator = operatorMap[operator] || operator;
        const sqlKey = `${field} ${sqlOperator}`;
        where[sqlKey] = operator === "in" ? value.split(",") : value;
      } else {
        where[key] = value;
      }
    }
    const count = await collection.count({
      where: Object.keys(where).length > 0 ? where : void 0
    });
    return this.createJsonResponse({ count });
  }
  /**
   * Handle POST /objects
   */
  async handleCreate(collection, req) {
    const data = await req.json();
    const object = await collection.create({ ...data, _skipLoad: true });
    await object.save();
    return this.createJsonResponse(object, 201);
  }
  /**
   * Handle PUT/PATCH /objects/:id
   */
  async handleUpdate(collection, id, req) {
    const data = await req.json();
    const object = await collection.get(id);
    if (!object) {
      return this.createErrorResponse(404, "Object not found");
    }
    Object.assign(object, data);
    await object.save();
    return this.createJsonResponse(object);
  }
  /**
   * Handle DELETE /objects/:id
   */
  async handleDelete(collection, id) {
    const object = await collection.get(id);
    if (!object) {
      return this.createErrorResponse(404, "Object not found");
    }
    await object.delete();
    return new Response(null, { status: 204 });
  }
  /**
   * Get or create collection instance
   */
  getCollection(classInfo) {
    if (!this.collections.has(classInfo.name)) {
      const collection2 = new classInfo.collectionConstructor({
        ai: this.context.ai,
        db: this.context.db
      });
      this.collections.set(classInfo.name, collection2);
    }
    const collection = this.collections.get(classInfo.name);
    if (!collection) throw new Error(`Collection ${classInfo.name} not found`);
    return collection;
  }
  /**
   * Create JSON response with proper headers
   */
  createJsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  /**
   * Create error response
   */
  createErrorResponse(status, message) {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  /**
   * Create CORS preflight response
   */
  createCorsResponse() {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Max-Age": "86400"
      }
    });
  }
  /**
   * Add CORS headers to response
   */
  addCorsHeaders(response) {
    if (!this.config.enableCors) return response;
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  /**
   * Simple pluralization (basic implementation)
   */
  pluralize(word) {
    if (word.endsWith("y")) {
      return `${word.slice(0, -1)}ies`;
    }
    if (word.endsWith("s") || word.endsWith("sh") || word.endsWith("ch")) {
      return `${word}es`;
    }
    return `${word}s`;
  }
}
function createRestServer(objects, context = {}, config = {}) {
  objects.forEach((obj) => {
    if (!ObjectRegistry.hasClass(obj.name)) {
      console.warn(`Object ${obj.name} not registered with @smrt decorator`);
    }
  });
  const generator = new APIGenerator(config, context);
  const { server, url } = generator.createServer();
  console.log(`🚀 smrt REST API server running at ${url}`);
  return { server, url };
}
function startRestServer(objects, context = {}, config = {}) {
  return new Promise((resolve) => {
    const { server, url } = createRestServer(objects, context, config);
    const shutdown = () => {
      return new Promise((shutdownResolve) => {
        console.log("🛑 Shutting down server gracefully...");
        server.stop();
        console.log("✅ Server shut down complete");
        shutdownResolve();
      });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    resolve(shutdown);
  });
}
export {
  APIGenerator,
  createRestServer,
  startRestServer
};
//# sourceMappingURL=rest.js.map
