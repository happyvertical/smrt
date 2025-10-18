import { cosmiconfig } from "cosmiconfig";
const MODULE_NAME = "smrt";
let cachedConfig = null;
async function loadConfig$1(options = {}) {
  const { configPath, searchParents = true, cache = true } = options;
  if (cache && cachedConfig) {
    return cachedConfig;
  }
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.mjs`,
      `${MODULE_NAME}.config.cjs`,
      `${MODULE_NAME}.config.json`
    ],
    stopDir: searchParents ? void 0 : process.cwd(),
    cache
    // Respect cache option
  });
  let result = null;
  try {
    if (configPath) {
      result = await explorer.load(configPath);
    } else {
      result = await explorer.search();
    }
  } catch (_error) {
    return {};
  }
  const config = result?.config || {};
  if (cache) {
    cachedConfig = config;
  }
  return config;
}
function clearConfigCache() {
  cachedConfig = null;
  const cacheKeys = Object.keys(require.cache);
  for (const key of cacheKeys) {
    if (key.includes("smrt.config")) {
      delete require.cache[key];
    }
  }
}
let runtimeConfig = {};
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) && targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)) {
      result[key] = deepMerge(
        targetValue,
        sourceValue
      );
    } else if (sourceValue !== void 0) {
      result[key] = sourceValue;
    }
  }
  return result;
}
function setConfig$1(config) {
  runtimeConfig = deepMerge(runtimeConfig, config);
}
function getRuntimeConfig() {
  return runtimeConfig;
}
function clearRuntimeConfig() {
  runtimeConfig = {};
}
function mergeConfigs(defaults, fileConfig, runtime) {
  let result = { ...defaults };
  result = deepMerge(result, fileConfig);
  result = deepMerge(result, runtime);
  return result;
}
let loadedConfig = null;
async function loadConfig(options) {
  const config = await loadConfig$1(options);
  loadedConfig = config;
  return config;
}
function getModuleConfig(moduleName, defaults) {
  const fileConfig = loadedConfig || {};
  const runtime = getRuntimeConfig();
  const globalConfig = fileConfig.smrt || {};
  const moduleConfig = fileConfig.modules?.[moduleName] || {};
  const runtimeModuleConfig = runtime.modules?.[moduleName] || {};
  const defaultsWithGlobal = mergeConfigs(
    defaults || {},
    globalConfig,
    {}
  );
  const withModuleConfig = mergeConfigs(defaultsWithGlobal, moduleConfig, {});
  const final = mergeConfigs(withModuleConfig, runtimeModuleConfig, {});
  return final;
}
function getPackageConfig(packageName, defaults) {
  const fileConfig = loadedConfig || {};
  const runtime = getRuntimeConfig();
  const globalConfig = fileConfig.smrt || {};
  const packageConfig = fileConfig.packages?.[packageName] || {};
  const runtimePackageConfig = runtime.packages?.[packageName] || {};
  const defaultsWithGlobal = mergeConfigs(
    defaults || {},
    globalConfig,
    {}
  );
  const withPackageConfig = mergeConfigs(defaultsWithGlobal, packageConfig, {});
  const final = mergeConfigs(withPackageConfig, runtimePackageConfig, {});
  return final;
}
function setConfig(config) {
  setConfig$1(config);
}
function clearCache() {
  loadedConfig = null;
  clearConfigCache();
  clearRuntimeConfig();
}
function defineConfig(config) {
  return config;
}
export {
  clearCache,
  defineConfig,
  getModuleConfig,
  getPackageConfig,
  loadConfig,
  setConfig
};
//# sourceMappingURL=index.js.map
