import * as fs from "node:fs";
import * as path from "node:path";
import { g as generateDeclarations } from "./chunks/index-Dw0X9BVV.js";
const VIRTUAL_MODULES = {
  "@smrt/routes": "smrt:routes",
  "@smrt/client": "smrt:client",
  "@smrt/mcp": "smrt:mcp",
  "@smrt/types": "smrt:types",
  "@smrt/manifest": "smrt:manifest"
};
function smrtConsumer(options = {}) {
  const {
    packages = [],
    generateTypes = true,
    typesDir = "src/types/smrt-generated",
    projectRoot = process.cwd(),
    disableScanning = false
  } = options;
  let smrtPackages = [];
  let typeManifest = null;
  let typesGenerated = false;
  return {
    name: "smrt-consumer",
    async buildStart() {
      console.log("[smrt:consumer] Initializing SMRT consumer plugin");
      if (packages.length === 0 && !disableScanning) {
        smrtPackages = await discoverSmrtPackages(projectRoot);
      } else {
        smrtPackages = packages;
      }
      if (smrtPackages.length > 0) {
        console.log(
          `[smrt:consumer] Found SMRT packages: ${smrtPackages.join(", ")}`
        );
        typeManifest = await aggregateTypeManifests(smrtPackages, projectRoot);
        if (generateTypes && !typesGenerated) {
          await generateProjectTypes(typeManifest, typesDir, projectRoot);
          typesGenerated = true;
        }
      } else {
        console.log("[smrt:consumer] No SMRT packages found");
        typeManifest = { version: "1.0.0", timestamp: Date.now(), objects: {} };
      }
    },
    resolveId(id, _importer) {
      if (id in VIRTUAL_MODULES) {
        const typeFileName = getTypeFileName(id);
        const typePath = path.join(projectRoot, typesDir, typeFileName);
        if (fs.existsSync(typePath)) {
          return typePath;
        }
        return `\0${VIRTUAL_MODULES[id]}`;
      }
      return null;
    },
    async load(id) {
      const cleanId = id.startsWith("\0") ? id.slice(1) : id;
      if (!typeManifest) {
        typeManifest = { version: "1.0.0", timestamp: Date.now(), objects: {} };
      }
      switch (cleanId) {
        case "smrt:routes":
          return generateFallbackRoutesModule();
        case "smrt:client":
          return generateFallbackClientModule(typeManifest);
        case "smrt:mcp":
          return generateFallbackMcpModule();
        case "smrt:types":
          return generateFallbackTypesModule(typeManifest);
        case "smrt:manifest":
          return generateFallbackManifestModule(typeManifest);
        default:
          return null;
      }
    }
  };
}
async function discoverSmrtPackages(projectRoot) {
  const packages = [];
  const nodeModulesPath = path.join(projectRoot, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    return packages;
  }
  try {
    const packageJsonPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies
      };
      for (const [name, version] of Object.entries(allDeps)) {
        if (typeof version === "string" && (name.includes("smrt") || name.includes("@have/") || await hasSmrtManifest(nodeModulesPath, name))) {
          packages.push(name);
        }
      }
    }
  } catch (error) {
    console.warn("[smrt:consumer] Error discovering packages:", error);
  }
  return packages;
}
async function hasSmrtManifest(nodeModulesPath, packageName) {
  const packagePath = path.join(nodeModulesPath, packageName);
  const manifestPath = path.join(
    packagePath,
    "dist",
    "manifest",
    "static-manifest.js"
  );
  return fs.existsSync(manifestPath);
}
async function aggregateTypeManifests(packages, projectRoot) {
  const aggregatedManifest = {
    version: "1.0.0",
    timestamp: Date.now(),
    objects: {}
  };
  for (const packageName of packages) {
    try {
      const manifestPath = path.join(
        projectRoot,
        "node_modules",
        packageName,
        "dist",
        "manifest",
        "static-manifest.js"
      );
      if (fs.existsSync(manifestPath)) {
        const manifestModule = await import(manifestPath);
        const manifest = manifestModule.staticManifest || manifestModule.default;
        if (manifest?.objects) {
          Object.assign(aggregatedManifest.objects, manifest.objects);
        }
      }
    } catch (error) {
      console.warn(
        `[smrt:consumer] Error loading manifest from ${packageName}:`,
        error
      );
    }
  }
  return aggregatedManifest;
}
async function generateProjectTypes(typeManifest, typesDir, projectRoot) {
  if (!typeManifest || Object.keys(typeManifest.objects).length === 0) {
    console.log(
      "[smrt:consumer] No SMRT objects found, skipping type generation"
    );
    return;
  }
  await generateDeclarations({
    manifest: typeManifest,
    outDir: typesDir,
    projectRoot,
    includeVirtualModules: true,
    includeObjectTypes: true
  });
  console.log(
    `[smrt:consumer] Generated types for ${Object.keys(typeManifest.objects).length} objects`
  );
}
function getTypeFileName(virtualModule) {
  const moduleMap = {
    "@smrt/routes": "smrt-routes.d.ts",
    "@smrt/client": "smrt-client.d.ts",
    "@smrt/mcp": "smrt-mcp.d.ts",
    "@smrt/types": "smrt-types.d.ts",
    "@smrt/manifest": "smrt-manifest.d.ts"
  };
  return moduleMap[virtualModule] || "smrt-unknown.d.ts";
}
function generateFallbackRoutesModule() {
  return `
// Fallback routes module
export function setupRoutes(app) {
  console.warn('[smrt:consumer] No routes available - SMRT packages may not be properly configured');
}
export default setupRoutes;
`;
}
function generateFallbackClientModule(manifest) {
  const objects = Object.entries(manifest?.objects || {});
  if (objects.length === 0) {
    return `
// Fallback client module
export function createClient(basePath = '/api/v1') {
  console.warn('[smrt:consumer] No API client available - SMRT packages may not be properly configured');
  return {};
}
export default createClient;
`;
  }
  const clientMethods = objects.map(([name, obj]) => {
    const { collection } = obj;
    return `
  ${name}: {
    list: () => fetch(basePath + '/${collection}').then(r => r.json()),
    get: (id) => fetch(basePath + '/${collection}/' + id).then(r => r.json()),
    create: (data) => fetch(basePath + '/${collection}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json()),
    update: (id, data) => fetch(basePath + '/${collection}/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(r => r.json()),
    delete: (id) => fetch(basePath + '/${collection}/' + id, {
      method: 'DELETE'
    }).then(r => r.ok)
  }`;
  }).join(",");
  return `
// Auto-generated API client from SMRT consumer
export function createClient(basePath = '/api/v1') {
  return {${clientMethods}
  };
}
export default createClient;
`;
}
function generateFallbackMcpModule() {
  return `
// Fallback MCP module
export const tools = [];
export function createMCPServer() {
  console.warn('[smrt:consumer] No MCP tools available - SMRT packages may not be properly configured');
  return { name: 'smrt-consumer', version: '1.0.0', tools: [] };
}
export default createMCPServer;
`;
}
function generateFallbackTypesModule(manifest) {
  const objects = Object.entries(manifest?.objects || {});
  if (objects.length === 0) {
    return `// No types available`;
  }
  const interfaces = objects.map(([_name, obj]) => {
    return `export interface ${obj.className}Data {
  id?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: any;
}`;
  });
  return interfaces.join("\n\n");
}
function generateFallbackManifestModule(manifest) {
  return `
// Auto-generated manifest from SMRT consumer
export const manifest = ${JSON.stringify(manifest, null, 2)};
export default manifest;
`;
}
export {
  smrtConsumer
};
//# sourceMappingURL=consumer-plugin.js.map
