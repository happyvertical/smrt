function convertTypeToJsonSchema(tsType) {
  const cleanType = tsType.trim();
  if (cleanType === "string") {
    return { type: "string" };
  }
  if (cleanType === "number") {
    return { type: "number" };
  }
  if (cleanType === "boolean") {
    return { type: "boolean" };
  }
  if (cleanType === "null") {
    return { type: "null" };
  }
  if (cleanType === "any" || cleanType === "unknown") {
    return {};
  }
  if (cleanType.endsWith("[]")) {
    const itemType = cleanType.slice(0, -2);
    return {
      type: "array",
      items: convertTypeToJsonSchema(itemType)
    };
  }
  const arrayMatch = cleanType.match(/^Array<(.+)>$/);
  if (arrayMatch) {
    return {
      type: "array",
      items: convertTypeToJsonSchema(arrayMatch[1])
    };
  }
  if (cleanType.includes("|")) {
    const options = cleanType.split("|").map((s) => s.trim());
    if (options.every((opt) => opt.startsWith("'") && opt.endsWith("'"))) {
      return {
        type: "string",
        enum: options.map((opt) => opt.slice(1, -1))
        // Remove quotes
      };
    }
    return {
      oneOf: options.map(convertTypeToJsonSchema)
    };
  }
  if (cleanType.startsWith("{") && cleanType.endsWith("}")) {
    return { type: "object" };
  }
  if (cleanType.startsWith("Record<")) {
    return { type: "object" };
  }
  return { type: "string", description: `TypeScript type: ${cleanType}` };
}
function shouldIncludeMethod(method, config) {
  if (!config || !config.callable) {
    return false;
  }
  if (config.exclude?.includes(method.name)) {
    return false;
  }
  if (!method.isPublic) {
    return false;
  }
  if (method.isStatic) {
    return false;
  }
  if (config.callable === "all") {
    return true;
  }
  if (config.callable === "public-async") {
    return method.async;
  }
  if (Array.isArray(config.callable)) {
    return config.callable.includes(method.name);
  }
  return false;
}
function generateToolFromMethod(method, config) {
  const parameters = {
    type: "object",
    properties: {},
    required: []
  };
  for (const param of method.parameters) {
    parameters.properties[param.name] = convertTypeToJsonSchema(param.type);
    if (!param.optional) {
      parameters.required.push(param.name);
    }
    if (param.default !== void 0) {
      parameters.properties[param.name].default = param.default;
    }
  }
  if (parameters.required.length === 0) {
    delete parameters.required;
  }
  const description = config?.descriptions?.[method.name] || method.description || `Call the ${method.name} method`;
  return {
    type: "function",
    function: {
      name: method.name,
      description,
      parameters
    }
  };
}
function generateToolManifest(methods, config) {
  const tools = [];
  for (const method of methods) {
    if (shouldIncludeMethod(method, config)) {
      const tool = generateToolFromMethod(method, config);
      tools.push(tool);
    }
  }
  return tools;
}
class ManifestGenerator {
  /**
   * Generate manifest from scan results
   */
  generateManifest(scanResults) {
    const manifest = {
      version: "1.0.0",
      timestamp: Date.now(),
      objects: {}
    };
    for (const result of scanResults) {
      for (const objectDef of result.objects) {
        if (objectDef.decoratorConfig.ai) {
          const methods = Object.values(objectDef.methods);
          const tools = generateToolManifest(
            methods,
            objectDef.decoratorConfig.ai
          );
          if (tools.length > 0) {
            objectDef.tools = tools;
          }
        }
        manifest.objects[objectDef.name] = objectDef;
      }
    }
    return manifest;
  }
  /**
   * Generate TypeScript interfaces from manifest
   */
  generateTypeDefinitions(manifest) {
    const interfaces = [];
    for (const [_name, obj] of Object.entries(manifest.objects)) {
      interfaces.push(this.generateInterface(obj));
    }
    return interfaces.join("\n\n");
  }
  /**
   * Generate a single interface definition
   */
  generateInterface(obj) {
    const fields = Object.entries(obj.fields).map(([name, field]) => {
      const optional = !field.required ? "?" : "";
      const type = this.mapFieldTypeToTS(field.type);
      return `  ${name}${optional}: ${type};`;
    }).join("\n");
    return `export interface ${obj.className}Data {
${fields}
}`;
  }
  /**
   * Map field types to TypeScript types
   */
  mapFieldTypeToTS(fieldType) {
    switch (fieldType) {
      case "text":
        return "string";
      case "decimal":
        return "number";
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "datetime":
        return "Date | string";
      case "json":
        return "any";
      case "foreignKey":
        return "string";
      default:
        return "any";
    }
  }
  /**
   * Generate simple endpoint list for testing/documentation
   */
  generateRestEndpoints(manifest) {
    const endpoints = [];
    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const apiConfig = obj.decoratorConfig.api;
      if (apiConfig !== false) {
        endpoints.push(...this.getSimpleEndpoints(obj));
      }
    }
    return endpoints.join("\n");
  }
  /**
   * Generate REST endpoint code implementations
   */
  generateRestEndpointCode(manifest) {
    const endpoints = [];
    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const apiConfig = obj.decoratorConfig.api;
      if (apiConfig !== false) {
        endpoints.push(this.generateRestEndpoint(obj));
      }
    }
    return endpoints.join("\n\n");
  }
  /**
   * Get simple endpoint strings for an object
   */
  getSimpleEndpoints(obj) {
    const { collection } = obj;
    const config = obj.decoratorConfig.api;
    const exclude = typeof config === "object" && config?.exclude || [];
    const include = typeof config === "object" && config?.include || void 0;
    const endpoints = [];
    const shouldInclude = (op) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };
    if (shouldInclude("list")) {
      endpoints.push(`GET /${collection}`);
    }
    if (shouldInclude("create")) {
      endpoints.push(`POST /${collection}`);
    }
    if (shouldInclude("get")) {
      endpoints.push(`GET /${collection}/:id`);
    }
    if (shouldInclude("update")) {
      endpoints.push(`PUT /${collection}/:id`);
    }
    if (shouldInclude("delete")) {
      endpoints.push(`DELETE /${collection}/:id`);
    }
    return endpoints;
  }
  /**
   * Generate a single REST endpoint
   */
  generateRestEndpoint(obj) {
    const { collection, className } = obj;
    const config = obj.decoratorConfig.api;
    const exclude = typeof config === "object" && config?.exclude || [];
    const include = typeof config === "object" && config?.include || void 0;
    const operations = [];
    const shouldInclude = (op) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };
    if (shouldInclude("list")) {
      operations.push(`  // GET /${collection} - List ${collection}`);
      operations.push(`  app.get('/${collection}', async (req: Request) => {`);
      operations.push(
        `    const collection = await get${className}Collection();`
      );
      operations.push("    const items = await collection.list(req.query);");
      operations.push("    return Response.json(items);");
      operations.push("  });");
    }
    if (shouldInclude("get")) {
      operations.push(`  // GET /${collection}/:id - Get ${className}`);
      operations.push(
        `  app.get('/${collection}/:id', async (req: Request) => {`
      );
      operations.push(
        `    const collection = await get${className}Collection();`
      );
      operations.push("    const item = await collection.get(req.params.id);");
      operations.push(
        `    if (!item) return new Response('Not found', { status: 404 });`
      );
      operations.push("    return Response.json(item);");
      operations.push("  });");
    }
    if (shouldInclude("create")) {
      operations.push(`  // POST /${collection} - Create ${className}`);
      operations.push(`  app.post('/${collection}', async (req: Request) => {`);
      operations.push(
        `    const collection = await get${className}Collection();`
      );
      operations.push("    const data = await req.json();");
      operations.push("    const item = await collection.create(data);");
      operations.push("    return Response.json(item, { status: 201 });");
      operations.push("  });");
    }
    if (shouldInclude("update")) {
      operations.push(`  // PUT /${collection}/:id - Update ${className}`);
      operations.push(
        `  app.put('/${collection}/:id', async (req: Request) => {`
      );
      operations.push(
        `    const collection = await get${className}Collection();`
      );
      operations.push("    const data = await req.json();");
      operations.push(
        "    const item = await collection.update(req.params.id, data);"
      );
      operations.push(
        `    if (!item) return new Response('Not found', { status: 404 });`
      );
      operations.push("    return Response.json(item);");
      operations.push("  });");
    }
    if (shouldInclude("delete")) {
      operations.push(`  // DELETE /${collection}/:id - Delete ${className}`);
      operations.push(
        `  app.delete('/${collection}/:id', async (req: Request) => {`
      );
      operations.push(
        `    const collection = await get${className}Collection();`
      );
      operations.push(
        "    const success = await collection.delete(req.params.id);"
      );
      operations.push(
        `    if (!success) return new Response('Not found', { status: 404 });`
      );
      operations.push(`    return new Response('', { status: 204 });`);
      operations.push("  });");
    }
    return `// ${className} endpoints
${operations.join("\n")}`;
  }
  /**
   * Generate simple MCP tool names for testing/documentation
   */
  generateMCPTools(manifest) {
    const tools = [];
    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const mcpConfig = obj.decoratorConfig.mcp;
      if (mcpConfig !== false) {
        tools.push(...this.getSimpleMCPToolNames(obj));
      }
    }
    return tools.join("\n");
  }
  /**
   * Generate MCP tool JSON definitions
   */
  generateMCPToolsCode(manifest) {
    const tools = [];
    for (const [_name, obj] of Object.entries(manifest.objects)) {
      const mcpConfig = obj.decoratorConfig.mcp;
      if (mcpConfig !== false) {
        tools.push(this.generateMCPTool(obj));
      }
    }
    return `[
${tools.join(",\n")}
]`;
  }
  /**
   * Get simple MCP tool names for an object
   */
  getSimpleMCPToolNames(obj) {
    const { collection } = obj;
    const config = obj.decoratorConfig.mcp;
    const exclude = typeof config === "object" && config?.exclude || [];
    const include = typeof config === "object" && config?.include || void 0;
    const tools = [];
    const shouldInclude = (op) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };
    if (shouldInclude("list")) {
      tools.push(`list_${collection}`);
    }
    if (shouldInclude("get")) {
      tools.push(`get_${collection}`);
    }
    if (shouldInclude("create")) {
      tools.push(`create_${collection}`);
    }
    if (shouldInclude("update")) {
      tools.push(`update_${collection}`);
    }
    if (shouldInclude("delete")) {
      tools.push(`delete_${collection}`);
    }
    return tools;
  }
  /**
   * Generate a single MCP tool
   */
  generateMCPTool(obj) {
    const { collection, className, name } = obj;
    const config = obj.decoratorConfig.mcp;
    const exclude = typeof config === "object" && config?.exclude || [];
    const include = typeof config === "object" && config?.include || void 0;
    const tools = [];
    const shouldInclude = (op) => {
      if (include && !include.includes(op)) return false;
      if (exclude.includes(op)) return false;
      return true;
    };
    if (shouldInclude("list")) {
      tools.push(`  {
    name: "list_${collection}",
    description: "List ${collection}",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
        where: { type: "object" }
      }
    }
  }`);
    }
    if (shouldInclude("get")) {
      tools.push(`  {
    name: "get_${name}",
    description: "Get a ${name} by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The ${name} ID" }
      },
      required: ["id"]
    }
  }`);
    }
    if (shouldInclude("create")) {
      const requiredFields = Object.entries(obj.fields).filter(([_, field]) => field.required).map(([fieldName]) => fieldName);
      tools.push(`  {
    name: "create_${name}",
    description: "Create a new ${name}",
    inputSchema: {
      type: "object",
      properties: ${JSON.stringify(this.generateSchemaProperties(obj.fields), null, 6)},
      required: ${JSON.stringify(requiredFields)}
    }
  }`);
    }
    return tools.join(",\n");
  }
  /**
   * Generate JSON schema properties for fields
   */
  generateSchemaProperties(fields) {
    const properties = {};
    for (const [name, field] of Object.entries(fields)) {
      properties[name] = {
        type: this.mapFieldTypeToJSON(field.type),
        description: field.description || `The ${name} field`
      };
      if (field.min !== void 0) properties[name].minimum = field.min;
      if (field.max !== void 0) properties[name].maximum = field.max;
      if (field.minLength !== void 0)
        properties[name].minLength = field.minLength;
      if (field.maxLength !== void 0)
        properties[name].maxLength = field.maxLength;
    }
    return properties;
  }
  /**
   * Map field types to JSON Schema types
   */
  mapFieldTypeToJSON(fieldType) {
    switch (fieldType) {
      case "text":
        return "string";
      case "decimal":
        return "number";
      case "integer":
        return "integer";
      case "boolean":
        return "boolean";
      case "datetime":
        return "string";
      case "json":
        return "object";
      case "foreignKey":
        return "string";
      default:
        return "string";
    }
  }
  /**
   * Save manifest to file
   */
  saveManifest(manifest, filePath) {
    const fs = require("node:fs");
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  }
  /**
   * Load manifest from file
   */
  loadManifest(filePath) {
    const fs = require("node:fs");
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  }
}
function generateManifest(scanResults) {
  const generator = new ManifestGenerator();
  return generator.generateManifest(scanResults);
}
export {
  ManifestGenerator as M,
  generateToolFromMethod as a,
  generateToolManifest as b,
  convertTypeToJsonSchema as c,
  generateManifest as g,
  shouldIncludeMethod as s
};
//# sourceMappingURL=manifest-generator-Bb3IuFsV.js.map
