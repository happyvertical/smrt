import { a as generateDeclarationsFromCLI } from "./index-Dw0X9BVV.js";
import { rm, mkdir, access, cp, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { extract } from "tar";
import { g as glob } from "./index-D2SdCo8s.js";
import { spawn } from "node:child_process";
const generateCommands = {
  "generate-types": {
    name: "generate-types",
    description: "Generate TypeScript declarations from SMRT manifest",
    aliases: ["generate-declarations"],
    args: ["manifest-path"],
    options: {
      "output-dir": {
        type: "string",
        description: "Output directory for generated types"
      }
    },
    handler: async (args, options) => {
      const manifestPath = args[0];
      if (!manifestPath) {
        throw new Error(
          "Manifest path is required: smrt generate-types <manifest-path> [output-dir]"
        );
      }
      const outputDir = options.outputDir || args[1];
      try {
        const cliArgs = outputDir ? [manifestPath, outputDir] : [manifestPath];
        await generateDeclarationsFromCLI(cliArgs);
      } catch (error) {
        throw new Error(
          `Failed to generate types: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
  }
};
const tempDirectories = /* @__PURE__ */ new Set();
let cleanupHandlersRegistered = false;
function registerCleanupHandlers() {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  const cleanup = async () => {
    if (tempDirectories.size === 0) return;
    const dirs = Array.from(tempDirectories);
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          await rm(dir, { recursive: true, force: true });
          tempDirectories.delete(dir);
        } catch (_error) {
        }
      })
    );
  };
  process.on("exit", () => {
  });
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", async (error) => {
    await cleanup();
    throw error;
  });
}
function parseGitUrl(url) {
  let host;
  let user;
  let repo;
  let ref = "HEAD";
  let subdir;
  if (url.startsWith("github:")) {
    host = "github";
    const parts = url.slice(7).split("/");
    user = parts[0];
    const repoAndRef = parts[1]?.split("#") || ["", ""];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];
    if (parts.length > 2) {
      subdir = parts.slice(2).join("/");
    }
  } else if (url.startsWith("gitlab:")) {
    host = "gitlab";
    const parts = url.slice(7).split("/");
    user = parts[0];
    const repoAndRef = parts[1]?.split("#") || ["", ""];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];
    if (parts.length > 2) {
      subdir = parts.slice(2).join("/");
    }
  } else if (url.startsWith("bitbucket:")) {
    host = "bitbucket";
    const parts = url.slice(10).split("/");
    user = parts[0];
    const repoAndRef = parts[1]?.split("#") || ["", ""];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];
    if (parts.length > 2) {
      subdir = parts.slice(2).join("/");
    }
  } else if (url.includes("github.com")) {
    host = "github";
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, "");
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(":");
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else if (url.includes("gitlab.com")) {
    host = "gitlab";
    const match = url.match(/gitlab\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid GitLab URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, "");
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(":");
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else if (url.includes("bitbucket.org")) {
    host = "bitbucket";
    const match = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid Bitbucket URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, "");
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(":");
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else {
    throw new Error(`Unsupported git URL: ${url}`);
  }
  return { host, user, repo, ref, subdir };
}
function getTarballUrl(repo) {
  switch (repo.host) {
    case "github":
      return `https://github.com/${repo.user}/${repo.repo}/archive/${repo.ref}.tar.gz`;
    case "gitlab":
      return `https://gitlab.com/${repo.user}/${repo.repo}/-/archive/${repo.ref}/${repo.repo}-${repo.ref}.tar.gz`;
    case "bitbucket":
      return `https://bitbucket.org/${repo.user}/${repo.repo}/get/${repo.ref}.tar.gz`;
    default:
      throw new Error(`Unsupported git host: ${repo.host}`);
  }
}
function validateRedirectUrl(redirectUrl) {
  try {
    const url = new URL(redirectUrl);
    if (url.protocol !== "https:") {
      throw new Error(
        `Invalid redirect protocol: ${url.protocol} (only https: allowed)`
      );
    }
    const trustedHosts = [
      "github.com",
      "www.github.com",
      "codeload.github.com",
      "gitlab.com",
      "www.gitlab.com",
      "bitbucket.org",
      "www.bitbucket.org"
    ];
    if (!trustedHosts.includes(url.hostname)) {
      throw new Error(`Redirect to untrusted host: ${url.hostname}`);
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.startsWith("192.168.") || url.hostname.startsWith("10.") || url.hostname.startsWith("172.")) {
      throw new Error(
        `Redirect to internal/local address not allowed: ${url.hostname}`
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid redirect URL format: ${redirectUrl}`);
    }
    throw error;
  }
}
async function downloadTarball(url, dest) {
  const REQUEST_TIMEOUT = 3e4;
  const MAX_TARBALL_SIZE = 100 * 1024 * 1024;
  return new Promise((resolve2, reject) => {
    let timedOut = false;
    let receivedBytes = 0;
    const req = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          return reject(new Error("Redirect without location header"));
        }
        try {
          validateRedirectUrl(redirectUrl);
        } catch (error) {
          return reject(error);
        }
        return downloadTarball(redirectUrl, dest).then(resolve2, reject);
      }
      if (response.statusCode !== 200) {
        return reject(
          new Error(`Failed to download tarball: HTTP ${response.statusCode}`)
        );
      }
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_TARBALL_SIZE) {
          response.destroy(new Error("Tarball size exceeds limit"));
        }
      });
      const extractStream = extract({
        cwd: dest,
        strip: 1
        // Remove top-level directory from tarball
      });
      response.pipe(extractStream);
      extractStream.on("finish", () => resolve2(dest));
      extractStream.on("error", (err) => {
        response.destroy();
        reject(err);
      });
    });
    req.setTimeout(REQUEST_TIMEOUT, () => {
      timedOut = true;
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", (err) => {
      if (timedOut) {
        reject(new Error("Request timed out"));
      } else {
        reject(err);
      }
    });
  });
}
async function loadGitTemplate(gitUrl) {
  registerCleanupHandlers();
  const repo = parseGitUrl(gitUrl);
  const tempDir = join(
    tmpdir(),
    `smrt-template-${repo.user}-${repo.repo}-${Date.now()}`
  );
  await mkdir(tempDir, { recursive: true });
  tempDirectories.add(tempDir);
  try {
    const tarballUrl = getTarballUrl(repo);
    console.log(
      `Downloading template from ${repo.host}:${repo.user}/${repo.repo}...`
    );
    await downloadTarball(tarballUrl, tempDir);
    const templateDir = repo.subdir ? join(tempDir, repo.subdir) : tempDir;
    const configPath = join(templateDir, "template.config.js");
    try {
      const configUrl = pathToFileURL(configPath).href;
      const module2 = await import(configUrl);
      const config = module2.default || module2;
      validateTemplateConfig$2(config, configPath);
      config.__tempDir = tempDir;
      return config;
    } catch (_error) {
      try {
        const tsConfigPath = join(templateDir, "template.config.ts");
        const configUrl = pathToFileURL(tsConfigPath).href;
        const module2 = await import(configUrl);
        const config = module2.default || module2;
        validateTemplateConfig$2(config, tsConfigPath);
        config.__tempDir = tempDir;
        return config;
      } catch {
        throw new Error(
          `No template.config.js or template.config.ts found in ${gitUrl}`
        );
      }
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
async function cleanupGitTemplate(config) {
  const tempDir = config.__tempDir;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}
function validateTemplateConfig$2(config, source) {
  const required = ["name", "description", "dependencies"];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`
      );
    }
  }
  if (typeof config.dependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`
    );
  }
  if (config.devDependencies && typeof config.devDependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`
    );
  }
}
function expandHomeDirectory(path) {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}
function validateResolvedPath(absolutePath, originalPath) {
  const home = homedir();
  if (absolutePath.includes("\0") || originalPath.includes("\0")) {
    throw new Error(
      "Path contains null bytes (potential path traversal attempt)"
    );
  }
  if (originalPath.startsWith("~")) {
    const normalizedPath2 = resolve(absolutePath);
    const normalizedHome = resolve(home);
    if (!normalizedPath2.startsWith(normalizedHome)) {
      throw new Error(
        `Path traversal detected: resolved path "${normalizedPath2}" escapes home directory "${normalizedHome}"`
      );
    }
  }
  const sensitivePaths = [
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/var/log"
  ];
  const normalizedPath = resolve(absolutePath);
  for (const sensitivePath of sensitivePaths) {
    if (normalizedPath === sensitivePath || normalizedPath.startsWith(`${sensitivePath}/`)) {
      throw new Error(
        `Access to sensitive system directory not allowed: ${sensitivePath}`
      );
    }
  }
  if (normalizedPath.startsWith("/bin/") || normalizedPath.startsWith("/sbin/") || normalizedPath.startsWith("/usr/bin/") || normalizedPath.startsWith("/usr/sbin/")) {
    throw new Error("Access to system binary directories not allowed");
  }
}
async function resolveLocalPath(localPath) {
  let absolutePath;
  if (localPath.startsWith("~")) {
    absolutePath = expandHomeDirectory(localPath);
  } else if (localPath.startsWith("/")) {
    absolutePath = localPath;
  } else {
    absolutePath = resolve(process.cwd(), localPath);
  }
  validateResolvedPath(absolutePath, localPath);
  try {
    await access(absolutePath);
  } catch {
    throw new Error(`Local template path does not exist: ${absolutePath}`);
  }
  return absolutePath;
}
async function loadLocalTemplate(resolvedPath) {
  let configPath = null;
  for (const ext of ["js", "ts"]) {
    const testPath = join(resolvedPath, `template.config.${ext}`);
    try {
      await access(testPath);
      configPath = testPath;
      break;
    } catch {
    }
  }
  if (!configPath) {
    throw new Error(
      `No template.config.js or template.config.ts found in ${resolvedPath}`
    );
  }
  try {
    const configUrl = pathToFileURL(configPath).href;
    const module2 = await import(configUrl);
    const config = module2.default || module2;
    validateTemplateConfig$1(config, configPath);
    return config;
  } catch (error) {
    throw new Error(
      `Failed to load template config from ${configPath}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
function validateTemplateConfig$1(config, source) {
  const required = ["name", "description", "dependencies"];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`
      );
    }
  }
  if (typeof config.dependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`
    );
  }
  if (config.devDependencies && typeof config.devDependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`
    );
  }
}
async function resolveNpmPackage(packagePath) {
  try {
    const resolved = require.resolve(packagePath, {
      paths: [process.cwd(), ...module.paths]
    });
    return resolved;
  } catch {
    const nodeModulesPath = join(process.cwd(), "node_modules", packagePath);
    try {
      await access(nodeModulesPath);
      return nodeModulesPath;
    } catch {
      throw new Error(
        `npm package '${packagePath}' not found. Install with: npm install ${packagePath.split("/")[0]}`
      );
    }
  }
}
async function loadNpmTemplate(resolvedPath) {
  let configPath;
  if (resolvedPath.endsWith("template.config.js") || resolvedPath.endsWith("template.config.ts")) {
    configPath = resolvedPath;
  } else {
    const dir = resolvedPath.endsWith(".js") ? dirname(resolvedPath) : resolvedPath;
    try {
      configPath = join(dir, "template.config.js");
      await access(configPath);
    } catch {
      try {
        configPath = join(dir, "template.config.ts");
        await access(configPath);
      } catch {
        throw new Error(
          `No template.config.js or template.config.ts found in ${dir}`
        );
      }
    }
  }
  try {
    const configUrl = pathToFileURL(configPath).href;
    const module2 = await import(configUrl);
    const config = module2.default || module2;
    validateTemplateConfig(config, configPath);
    return config;
  } catch (error) {
    throw new Error(
      `Failed to load template config from ${configPath}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
async function findTemplateInPackages(shortName) {
  const nodeModulesPath = join(process.cwd(), "node_modules");
  const patterns = [
    // Scoped packages with templates directory
    `${nodeModulesPath}/@*/templates/${shortName}/template.config.{js,ts}`,
    // Scoped packages direct
    `${nodeModulesPath}/@*/${shortName}/template.config.{js,ts}`,
    // Unscoped packages
    `${nodeModulesPath}/${shortName}/template.config.{js,ts}`,
    // Templates subdirectory in any package
    `${nodeModulesPath}/*/templates/${shortName}/template.config.{js,ts}`
  ];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { absolute: true });
    if (matches.length > 0) {
      const configPath = matches[0];
      return dirname(configPath);
    }
  }
  return null;
}
async function discoverInstalledTemplates() {
  const nodeModulesPath = join(process.cwd(), "node_modules");
  const patterns = [
    `${nodeModulesPath}/@*/templates/*/template.config.{js,ts}`,
    `${nodeModulesPath}/*/template.config.{js,ts}`
  ];
  const templates = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { absolute: true });
    for (const configPath of matches) {
      try {
        const configUrl = pathToFileURL(configPath).href;
        const module2 = await import(configUrl);
        const config = module2.default || module2;
        const relativePath = configPath.replace(nodeModulesPath + "/", "");
        const source = relativePath.substring(
          0,
          relativePath.indexOf("/template.config")
        );
        templates.push({
          name: config.name || "unknown",
          source,
          config
        });
      } catch (error) {
        console.warn(`Failed to load template at ${configPath}:`, error);
      }
    }
  }
  return templates;
}
function validateTemplateConfig(config, source) {
  const required = ["name", "description", "dependencies"];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`
      );
    }
  }
  if (typeof config.dependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`
    );
  }
  if (config.devDependencies && typeof config.devDependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`
    );
  }
}
async function resolveTemplate(name) {
  if (name.startsWith("github:") || name.startsWith("gitlab:") || name.startsWith("git@") || name.endsWith(".git") || name.startsWith("https://github.com") || name.startsWith("https://gitlab.com")) {
    return {
      type: "git",
      location: name,
      resolved: name
    };
  }
  if (name.startsWith("/") || name.startsWith(".") || name.startsWith("~")) {
    return {
      type: "local",
      location: name,
      resolved: await resolveLocalPath(name)
    };
  }
  if (name.includes("@") || name.includes("/")) {
    return {
      type: "npm",
      location: name,
      resolved: await resolveNpmPackage(name)
    };
  }
  const npmPath = await findTemplateInPackages(name);
  if (npmPath) {
    return {
      type: "npm",
      location: npmPath,
      resolved: await resolveNpmPackage(npmPath)
    };
  }
  throw new Error(
    `Template '${name}' not found. Tried:
  - npm package: @*/${name}, @*/templates/${name}
  - local path: ./${name}, ../${name}

Use one of:
  - npm package: @org/pkg/templates/name
  - git repo: github:user/repo
  - local path: ../path/to/template`
  );
}
async function loadTemplate(source) {
  switch (source.type) {
    case "npm":
      return loadNpmTemplate(source.resolved);
    case "git":
      return loadGitTemplate(source.resolved);
    case "local":
      return loadLocalTemplate(source.resolved);
    default:
      throw new Error(`Unknown template type: ${source.type}`);
  }
}
async function generate(source, config, options) {
  console.log(`
🏗️  Creating gnode: ${options.name}`);
  console.log(`📦 Using template: ${config.name} (${config.description})
`);
  if (config.baseGenerator) {
    console.log(`📝 Running base generator (${config.framework})...`);
    await runBaseGenerator(config.baseGenerator, options.outputDir);
  } else {
    await mkdir(options.outputDir, { recursive: true });
  }
  console.log("📋 Copying template files...");
  await overlayTemplate(source, config, options.outputDir);
  console.log("🔧 Configuring package.json...");
  await mergePackageJson(options.outputDir, config, options.name);
  console.log("\n✅ Gnode created successfully!");
  console.log(`
📍 Next steps:`);
  console.log(`   cd ${options.name}`);
  console.log(`   pnpm install`);
  console.log(`   pnpm dev
`);
}
function validateBaseGenerator(baseGen, outputDir) {
  const allowedCommands = ["npm", "npx", "pnpm", "yarn", "bun", "bunx"];
  if (!allowedCommands.includes(baseGen.command)) {
    throw new Error(
      `Base generator command "${baseGen.command}" not allowed. Allowed commands: ${allowedCommands.join(", ")}`
    );
  }
  const dangerousChars = /[;&|`$(){}[\]<>'"\\]/;
  if (dangerousChars.test(outputDir)) {
    throw new Error(
      `Output directory contains dangerous characters: ${outputDir}. Only alphanumeric, dash, underscore, dot, and forward slash are allowed.`
    );
  }
  for (const arg of baseGen.args) {
    const replacedArg = arg.replace("{DIR}", outputDir);
    if (dangerousChars.test(replacedArg)) {
      throw new Error(
        `Base generator argument contains dangerous characters after placeholder replacement: ${replacedArg}`
      );
    }
  }
}
async function runBaseGenerator(baseGen, outputDir) {
  validateBaseGenerator(baseGen, outputDir);
  const args = baseGen.args.map((arg) => arg.replace("{DIR}", outputDir));
  return new Promise((resolve2, reject) => {
    const proc = spawn(baseGen.command, args, {
      stdio: "inherit",
      shell: false
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve2();
      } else {
        reject(new Error(`Base generator exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
async function overlayTemplate(source, config, outputDir) {
  let overlayDir;
  switch (source.type) {
    case "npm":
      overlayDir = join(dirname(source.resolved), "overlay");
      break;
    case "git": {
      const tempDir = config.__tempDir;
      if (!tempDir) {
        throw new Error("Git template temp directory not found");
      }
      overlayDir = join(tempDir, "overlay");
      break;
    }
    case "local":
      overlayDir = join(source.resolved, "overlay");
      break;
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
  const files = await glob("**/*", {
    cwd: overlayDir,
    dot: true,
    onlyFiles: true
  });
  for (const file of files) {
    const src = join(overlayDir, file);
    const dest = join(outputDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
  }
}
async function mergePackageJson(outputDir, config, projectName) {
  const pkgPath = join(outputDir, "package.json");
  let pkg;
  try {
    const content = await readFile(pkgPath, "utf-8");
    pkg = JSON.parse(content);
  } catch {
    pkg = {
      name: projectName,
      version: "0.1.0",
      private: true,
      scripts: {},
      dependencies: {},
      devDependencies: {}
    };
  }
  pkg.name = projectName;
  pkg.dependencies = {
    ...pkg.dependencies,
    ...config.dependencies
  };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    ...config.devDependencies
  };
  if (!pkg.scripts["workflow:research"]) {
    pkg.scripts = {
      ...pkg.scripts,
      "workflow:research": "tsx src/workflows/research.ts",
      "workflow:report": "tsx src/workflows/report.ts"
    };
  }
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
const gnodeCommands = {
  "gnode create": {
    name: "gnode create",
    description: "Create a new gnode from template",
    args: ["name"],
    options: {
      template: {
        type: "string",
        description: "Template to use (npm package, git repo, or local path)",
        default: "sveltekit"
      },
      "output-dir": {
        type: "string",
        description: "Output directory (defaults to ./<name>)"
      }
    },
    handler: async (args, options) => {
      const name = args[0];
      if (!name) {
        throw new Error("Project name is required: smrt gnode create <name>");
      }
      const outputDir = options.outputDir || `./${name}`;
      const templateName = options.template || "sveltekit";
      try {
        console.log(`🔍 Resolving template: ${templateName}...`);
        const source = await resolveTemplate(templateName);
        console.log(`✓ Found template: ${source.type}:${source.location}
`);
        const config = await loadTemplate(source);
        await generate(source, config, {
          name,
          template: templateName,
          outputDir
        });
        if (source.type === "git") {
          await cleanupGitTemplate(config);
        }
      } catch (error) {
        throw new Error(
          `Failed to create gnode: ${error instanceof Error ? error.message : "Unknown error"}`,
          { cause: error }
        );
      }
    }
  },
  "gnode list-templates": {
    name: "gnode list-templates",
    description: "List available gnode templates",
    aliases: ["gnode ls"],
    handler: async (_args, _options) => {
      console.log("📦 Discovering installed templates...\n");
      const templates = await discoverInstalledTemplates();
      if (templates.length === 0) {
        console.log("No templates found in node_modules.");
        console.log(
          "\nTo use a template, install a package that provides one:"
        );
        console.log("  npm install @happyvertical/praeco");
        console.log("\nOr use a git repository:");
        console.log("  smrt gnode create my-town --template=github:user/repo");
        return;
      }
      console.log("Available templates:\n");
      for (const t of templates) {
        console.log(`  ${t.name}`);
        console.log(`    ${t.config.description}`);
        console.log(`    Source: ${t.source}`);
        console.log(`    Framework: ${t.config.framework || "unknown"}`);
        console.log();
      }
      console.log(`Found ${templates.length} template(s)
`);
      console.log("Usage:");
      console.log("  smrt gnode create <name> --template=<template-name>");
      console.log("  smrt gnode create my-town --template=sveltekit");
    }
  }
};
export {
  generateCommands,
  gnodeCommands
};
//# sourceMappingURL=index-Dequee6D.js.map
