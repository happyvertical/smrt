import http from "node:http";
class SmrtClient {
  options;
  constructor(options = {}) {
    this.options = {
      baseUrl: "http://localhost:3000",
      basePath: "/api/v1",
      fetch: globalThis.fetch,
      ...options
    };
  }
  /**
   * Make an authenticated request
   */
  async request(method, path, data) {
    const url = `${this.options.baseUrl}${this.options.basePath}${path}`;
    const headers = {
      "Content-Type": "application/json"
    };
    if (this.options.auth) {
      switch (this.options.auth.type) {
        case "bearer":
          if (this.options.auth.token) {
            headers.Authorization = `Bearer ${this.options.auth.token}`;
          }
          break;
        case "basic":
          if (this.options.auth.username && this.options.auth.password) {
            const credentials = btoa(
              `${this.options.auth.username}:${this.options.auth.password}`
            );
            headers.Authorization = `Basic ${credentials}`;
          }
          break;
      }
    }
    const requestOptions = {
      method,
      headers
    };
    if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
      requestOptions.body = JSON.stringify(data);
    }
    const response = await this.options.fetch(url, requestOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }
  /**
   * GET request
   */
  async get(path, params) {
    let url = path;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== void 0 && value !== null) {
          searchParams.append(key, String(value));
        }
      });
      url += `?${searchParams.toString()}`;
    }
    return this.request("GET", url);
  }
  /**
   * POST request
   */
  async post(path, data) {
    return this.request("POST", path, data);
  }
  /**
   * PUT request
   */
  async put(path, data) {
    return this.request("PUT", path, data);
  }
  /**
   * PATCH request
   */
  async patch(path, data) {
    return this.request("PATCH", path, data);
  }
  /**
   * DELETE request
   */
  async delete(path) {
    return this.request("DELETE", path);
  }
}
function createSmrtClient(options) {
  return new SmrtClient(options);
}
class SmrtMCPServer {
  options;
  constructor(options = {}) {
    this.options = {
      name: "smrt-auto-generated",
      version: "1.0.0",
      tools: [],
      handlers: {},
      ...options
    };
  }
  /**
   * Add a tool to the server
   */
  addTool(tool, handler) {
    this.options.tools.push(tool);
    this.options.handlers[tool.name] = handler;
  }
  /**
   * Get all available tools
   */
  getTools() {
    return this.options.tools;
  }
  /**
   * Execute a tool
   */
  async executeTool(name, params) {
    const handler = this.options.handlers[name];
    if (!handler) {
      throw new Error(`Tool '${name}' not found`);
    }
    try {
      return await handler(params);
    } catch (error) {
      throw new Error(
        `Tool execution failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Get server info
   */
  getServerInfo() {
    return {
      name: this.options.name,
      version: this.options.version,
      toolCount: this.options.tools.length
    };
  }
  /**
   * Start the MCP server (basic implementation)
   */
  async start() {
    console.log(
      `[smrt-mcp] Server '${this.options.name}' started with ${this.options.tools.length} tools`
    );
    console.log(
      `[smrt-mcp] Available tools: ${this.options.tools.map((t) => t.name).join(", ")}`
    );
  }
}
function createMCPServer(options) {
  return new SmrtMCPServer(options);
}
class SmrtServer {
  options;
  routes = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.options = {
      port: 3e3,
      hostname: "localhost",
      basePath: "/api/v1",
      cors: true,
      ...options
    };
  }
  /**
   * Add a route handler
   */
  addRoute(method, path, handler) {
    const key = `${method.toUpperCase()} ${path}`;
    this.routes.set(key, handler);
  }
  /**
   * Add GET route handler (RouteApp compatibility)
   */
  get(path, handler) {
    this.addExpressStyleRoute("GET", path, handler);
  }
  /**
   * Add POST route handler (RouteApp compatibility)
   */
  post(path, handler) {
    this.addExpressStyleRoute("POST", path, handler);
  }
  /**
   * Add PUT route handler (RouteApp compatibility)
   */
  put(path, handler) {
    this.addExpressStyleRoute("PUT", path, handler);
  }
  /**
   * Add DELETE route handler (RouteApp compatibility)
   */
  delete(path, handler) {
    this.addExpressStyleRoute("DELETE", path, handler);
  }
  /**
   * Convert Express-style handler to SMRT handler
   */
  addExpressStyleRoute(method, path, handler) {
    const smrtHandler = async (req) => {
      return new Promise((resolve, reject) => {
        const res = {
          status: (code) => {
            res.statusCode = code;
            return res;
          },
          json: (data) => {
            resolve(
              new Response(JSON.stringify(data), {
                status: res.statusCode || 200,
                headers: {
                  "Content-Type": "application/json",
                  ...res.headers
                }
              })
            );
          },
          send: (data) => {
            const body = typeof data === "string" ? data : JSON.stringify(data);
            resolve(
              new Response(body, {
                status: res.statusCode || 200,
                headers: {
                  "Content-Type": typeof data === "string" ? "text/plain" : "application/json",
                  ...res.headers
                }
              })
            );
          },
          end: (data) => {
            resolve(
              new Response(data || "", {
                status: res.statusCode || 200,
                headers: res.headers
              })
            );
          },
          setHeader: (key, value) => {
            if (!res.headers) res.headers = {};
            res.headers[key] = value;
            return res;
          },
          statusCode: 200,
          headers: {}
        };
        try {
          handler(req, res);
        } catch (error) {
          reject(error);
        }
      });
    };
    this.addRoute(method, path, smrtHandler);
  }
  /**
   * Start the server
   */
  async start() {
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
    server.listen(this.options.port, this.options.hostname);
    const url = `http://${this.options.hostname}:${this.options.port}`;
    console.log(`[smrt] Server started at ${url}`);
    return { server, url };
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
    const url = `http://${this.options.hostname}:${this.options.port}${req.url}`;
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
   * Handle incoming requests
   */
  async handleRequest(request) {
    try {
      if (this.options.cors && request.method === "OPTIONS") {
        return this.createCorsResponse();
      }
      const smrtRequest = await this.parseRequest(request);
      if (this.options.auth) {
        const authResult = await this.authenticate(smrtRequest);
        if (!authResult) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      const routeKey = `${request.method} ${smrtRequest.url}`;
      const handler = this.findRouteHandler(routeKey);
      if (!handler) {
        return new Response("Not Found", { status: 404 });
      }
      const response = await handler(smrtRequest);
      if (this.options.cors) {
        this.addCorsHeaders(response);
      }
      return response;
    } catch (error) {
      console.error("[smrt] Request error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
  /**
   * Parse incoming request into SmrtRequest format
   */
  async parseRequest(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const routePath = pathname.startsWith(this.options.basePath) ? pathname.slice(this.options.basePath.length) : pathname;
    const query = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    let body;
    if (request.body && (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")) {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        body = await request.json();
      } else {
        body = await request.text();
      }
    }
    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      params: {},
      // Will be populated by route matching
      query,
      body,
      headers,
      method: request.method,
      url: routePath,
      json: async () => body
    };
  }
  /**
   * Find route handler with parameter extraction
   */
  findRouteHandler(routeKey) {
    if (this.routes.has(routeKey)) {
      return this.routes.get(routeKey);
    }
    const [method, path] = routeKey.split(" ", 2);
    for (const [key, handler] of this.routes.entries()) {
      const [routeMethod, routePath] = key.split(" ", 2);
      if (method === routeMethod) {
        const params = this.matchRoute(path, routePath);
        if (params !== null) {
          return async (req) => {
            req.params = params;
            return handler(req);
          };
        }
      }
    }
    return void 0;
  }
  /**
   * Match route path with parameters (e.g., /users/:id)
   */
  matchRoute(requestPath, routePath) {
    const requestSegments = requestPath.split("/").filter((s) => s);
    const routeSegments = routePath.split("/").filter((s) => s);
    if (requestSegments.length !== routeSegments.length) {
      return null;
    }
    const params = {};
    for (let i = 0; i < routeSegments.length; i++) {
      const routeSegment = routeSegments[i];
      const requestSegment = requestSegments[i];
      if (routeSegment.startsWith(":")) {
        const paramName = routeSegment.slice(1);
        params[paramName] = requestSegment;
      } else if (routeSegment !== requestSegment) {
        return null;
      }
    }
    return params;
  }
  /**
   * Handle authentication
   */
  async authenticate(request) {
    if (!this.options.auth) return true;
    const authHeader = request.headers.authorization;
    if (!authHeader) return false;
    switch (this.options.auth.type) {
      case "bearer": {
        const token = authHeader.replace("Bearer ", "");
        return this.options.auth.verify ? await this.options.auth.verify(token) : true;
      }
      case "basic": {
        const credentials = authHeader.replace("Basic ", "");
        return this.options.auth.verify ? await this.options.auth.verify(credentials) : true;
      }
      case "custom":
        return this.options.auth.verify ? await this.options.auth.verify(authHeader) : true;
      default:
        return false;
    }
  }
  /**
   * Create CORS preflight response
   */
  createCorsResponse() {
    return new Response(null, {
      status: 204,
      headers: this.getCorsHeaders()
    });
  }
  /**
   * Add CORS headers to response
   */
  addCorsHeaders(response) {
    const corsHeaders = this.getCorsHeaders();
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
  /**
   * Get CORS headers
   */
  getCorsHeaders() {
    const corsConfig = this.options.cors;
    if (typeof corsConfig === "boolean") {
      return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      };
    }
    return {
      "Access-Control-Allow-Origin": Array.isArray(corsConfig.origin) ? corsConfig.origin.join(", ") : corsConfig.origin || "*",
      "Access-Control-Allow-Methods": corsConfig.methods?.join(", ") || "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": corsConfig.headers?.join(", ") || "Content-Type, Authorization"
    };
  }
}
function createSmrtServer(options) {
  return new SmrtServer(options);
}
export {
  createMCPServer as a,
  createSmrtServer as b,
  createSmrtClient as c
};
//# sourceMappingURL=server-D6t1do0C.js.map
