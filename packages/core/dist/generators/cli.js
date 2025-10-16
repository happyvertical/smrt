#!/usr/bin/env node
import { createInterface } from "node:readline";
import { O as ObjectRegistry } from "../chunks/registry-Bh44IFAJ.js";
import { parseCliArgs } from "@have/utils";
let _gnodeCommands = null;
let _generateCommands = null;
async function getGnodeCommands() {
  if (!_gnodeCommands) {
    const { gnodeCommands } = await import("../chunks/index-CEGpQ-x1.js");
    _gnodeCommands = gnodeCommands;
  }
  return _gnodeCommands;
}
async function getGenerateCommands() {
  if (!_generateCommands) {
    const { generateCommands } = await import("../chunks/index-CEGpQ-x1.js");
    _generateCommands = generateCommands;
  }
  return _generateCommands;
}
class CLIGenerator {
  config;
  context;
  collections = /* @__PURE__ */ new Map();
  constructor(config = {}, context = {}) {
    this.config = {
      name: "smrt",
      version: "1.0.0",
      description: "Admin CLI for smrt objects",
      prompt: true,
      colors: true,
      ...config
    };
    this.context = context;
  }
  /**
   * Check if running in test environment
   */
  isTestMode() {
    return process.env.NODE_ENV === "test" || process.env.VITEST === "true" || typeof global.it === "function" || typeof global.describe === "function";
  }
  /**
   * Handle exits safely in test mode
   */
  exitWithError(message, code = 1) {
    if (this.isTestMode()) {
      throw new Error(message);
    }
    console.error(message);
    process.exit(code);
  }
  /**
   * Generate CLI handler function
   */
  generateHandler() {
    const commands = this.generateCommands();
    return async (argv) => {
      const parsed = parseCliArgs(argv, commands, {});
      await this.executeCommand(parsed, commands);
    };
  }
  /**
   * Generate all CLI commands
   */
  generateCommands() {
    const commands = [];
    const registeredClasses = ObjectRegistry.getAllClasses();
    for (const [name, classInfo] of registeredClasses) {
      commands.push(...this.generateObjectCommands(name, classInfo));
    }
    commands.push(...this.generateUtilityCommands());
    return commands;
  }
  /**
   * Generate CRUD commands for a specific object
   */
  generateObjectCommands(objectName, _classInfo) {
    const commands = [];
    const lowerName = objectName.toLowerCase();
    const config = ObjectRegistry.getConfig(objectName);
    const cliConfig = config.cli;
    if (cliConfig === false) return commands;
    const excluded = (typeof cliConfig === "object" ? cliConfig.exclude : []) || [];
    const included = typeof cliConfig === "object" ? cliConfig.include : null;
    const shouldInclude = (command) => {
      if (included && !included.includes(command)) return false;
      if (excluded.includes(command)) return false;
      return true;
    };
    if (shouldInclude("list")) {
      commands.push({
        name: `${lowerName}:list`,
        description: `List ${objectName} objects`,
        aliases: [`${lowerName}:ls`],
        options: {
          limit: {
            type: "string",
            description: "limit number of results",
            default: "50",
            short: "l"
          },
          offset: {
            type: "string",
            description: "offset for pagination",
            default: "0",
            short: "o"
          },
          "order-by": { type: "string", description: "field to order by" },
          where: { type: "string", description: "filter conditions as JSON" },
          format: {
            type: "string",
            description: "output format (table|json)",
            default: "table"
          }
        },
        handler: async (_args, options) => {
          await this.handleList(objectName, options);
        }
      });
    }
    if (shouldInclude("get")) {
      commands.push({
        name: `${lowerName}:get`,
        description: `Get ${objectName} by ID or slug`,
        aliases: [`${lowerName}:show`],
        args: ["id"],
        options: {
          format: {
            type: "string",
            description: "output format (json|yaml)",
            default: "json"
          }
        },
        handler: async (args, options) => {
          await this.handleGet(objectName, args[0], options);
        }
      });
    }
    if (shouldInclude("create")) {
      const options = {
        interactive: {
          type: "boolean",
          description: "interactive mode with prompts"
        },
        "from-file": { type: "string", description: "create from JSON file" }
      };
      const fields = ObjectRegistry.getFields(objectName);
      for (const [fieldName, field] of fields) {
        const optionName = fieldName.replace(/_/g, "-");
        const description = field.options?.description || `${objectName} ${fieldName}`;
        options[optionName] = { type: "string", description };
      }
      commands.push({
        name: `${lowerName}:create`,
        description: `Create new ${objectName}`,
        aliases: [`${lowerName}:new`],
        options,
        handler: async (_args, options2) => {
          await this.handleCreate(objectName, options2);
        }
      });
    }
    if (shouldInclude("update")) {
      const options = {
        interactive: {
          type: "boolean",
          description: "interactive mode with prompts"
        },
        "from-file": { type: "string", description: "update from JSON file" }
      };
      const fields = ObjectRegistry.getFields(objectName);
      for (const [fieldName, field] of fields) {
        const optionName = fieldName.replace(/_/g, "-");
        const description = field.options?.description || `${objectName} ${fieldName}`;
        options[optionName] = { type: "string", description };
      }
      commands.push({
        name: `${lowerName}:update`,
        description: `Update ${objectName}`,
        aliases: [`${lowerName}:edit`],
        args: ["id"],
        options,
        handler: async (args, options2) => {
          await this.handleUpdate(objectName, args[0], options2);
        }
      });
    }
    if (shouldInclude("delete")) {
      commands.push({
        name: `${lowerName}:delete`,
        description: `Delete ${objectName}`,
        aliases: [`${lowerName}:rm`],
        args: ["id"],
        options: {
          force: { type: "boolean", description: "skip confirmation prompt" }
        },
        handler: async (args, options) => {
          await this.handleDelete(objectName, args[0], options);
        }
      });
    }
    return commands;
  }
  /**
   * Execute a parsed command
   */
  async executeCommand(parsed, commands) {
    if (!parsed.command) {
      await this.showHelp(commands);
      return;
    }
    const command = commands.find(
      (cmd) => cmd.name === parsed.command || parsed.command && cmd.aliases && cmd.aliases.includes(parsed.command)
    );
    if (command) {
      if (command.args && parsed.args.length < command.args.length) {
        this.exitWithError(
          `Missing required arguments: ${command.args.slice(parsed.args.length).join(", ")}`
        );
        return;
      }
      if (!command.handler) {
        this.exitWithError(`Command '${parsed.command}' has no handler defined`);
        return;
      }
      try {
        await command.handler(parsed.args, parsed.options);
        return;
      } catch (error) {
        this.exitWithError(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        return;
      }
    }
    const [gnodeCommands, generateCommands] = await Promise.all([
      getGnodeCommands(),
      getGenerateCommands()
    ]);
    const builtInCommands = {
      ...gnodeCommands,
      ...generateCommands
    };
    const builtInCommand = builtInCommands[parsed.command];
    if (builtInCommand) {
      if (builtInCommand.args && parsed.args.length < builtInCommand.args.length) {
        this.exitWithError(
          `Missing required arguments: ${builtInCommand.args.slice(parsed.args.length).join(", ")}`
        );
        return;
      }
      if (!builtInCommand.handler) {
        this.exitWithError(
          `Command '${parsed.command}' has no handler defined`
        );
        return;
      }
      try {
        await builtInCommand.handler(parsed.args, parsed.options);
        return;
      } catch (error) {
        this.exitWithError(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        return;
      }
    }
    this.exitWithError(`Unknown command '${parsed.command}'`);
  }
  /**
   * Generate utility commands
   */
  generateUtilityCommands() {
    const commands = [];
    commands.push({
      name: "objects",
      description: "List all registered smrt objects",
      aliases: ["ls"],
      handler: async (_args, _options) => {
        const registeredClasses = ObjectRegistry.getAllClasses();
        console.log("Registered smrt objects:");
        for (const [name] of registeredClasses) {
          console.log(`  • ${name}`);
        }
      }
    });
    commands.push({
      name: "schema",
      description: "Show schema for an object",
      args: ["object"],
      handler: this.createSchemaHandler()
    });
    commands.push({
      name: "help",
      description: "Show help information",
      aliases: ["h"],
      handler: async (_args, _options) => {
        await this.showHelp(commands);
      }
    });
    commands.push({
      name: "version",
      description: "Show version information",
      aliases: ["v"],
      handler: async (_args, _options) => {
        console.log(`${this.config.name} v${this.config.version}`);
      }
    });
    commands.push({
      name: "status",
      description: "Show system status",
      handler: async (_args, _options) => {
        console.log("System Status:");
        console.log(`- CLI: ${this.config.name} v${this.config.version}`);
        console.log(
          `- Database: ${this.context.db ? "Connected" : "Not connected"}`
        );
        console.log(`- AI: ${this.context.ai ? "Available" : "Not available"}`);
        console.log(`- User: ${this.context.user?.id || "Not authenticated"}`);
      }
    });
    return commands;
  }
  /**
   * Create schema command handler
   */
  createSchemaHandler() {
    return async (args, _options) => {
      const objectName = args[0];
      const fields = ObjectRegistry.getFields(objectName);
      if (fields.size === 0) {
        this.exitWithError(`Object ${objectName} not found`);
        return;
      }
      console.log(`Schema for ${objectName}:`);
      for (const [fieldName, field] of fields) {
        console.log(
          `  ${fieldName}: ${field.type}${field.options?.required ? " (required)" : ""}`
        );
        if (field.options?.description) {
          console.log(`    ${field.options.description}`);
        }
      }
    };
  }
  /**
   * Show help information
   */
  async showHelp(commands) {
    console.log(`${this.config.name} v${this.config.version}`);
    console.log(this.config.description);
    console.log();
    const [gnodeCommands, generateCommands] = await Promise.all([
      getGnodeCommands(),
      getGenerateCommands()
    ]);
    console.log("Gnode Commands:");
    for (const command of Object.values(gnodeCommands)) {
      this.showCommandHelp(command);
    }
    console.log("Code Generation:");
    for (const command of Object.values(generateCommands)) {
      this.showCommandHelp(command);
    }
    const utilityCommands = commands.filter(
      (cmd) => cmd.name === "objects" || cmd.name === "schema" || cmd.name === "help" || cmd.name === "version" || cmd.name === "status"
    );
    if (utilityCommands.length > 0) {
      console.log("Utility Commands:");
      for (const command of utilityCommands) {
        this.showCommandHelp(command);
      }
    }
    const objectCommands = commands.filter(
      (cmd) => !utilityCommands.includes(cmd)
    );
    if (objectCommands.length > 0) {
      console.log("Object Commands (auto-generated):");
      for (const command of objectCommands) {
        this.showCommandHelp(command);
      }
    }
  }
  /**
   * Show help for a single command
   */
  showCommandHelp(command) {
    const aliases = command.aliases ? ` (${command.aliases.join(", ")})` : "";
    const args = command.args ? ` ${command.args.map((arg) => `<${arg}>`).join(" ")}` : "";
    console.log(`  ${command.name}${args}${aliases}`);
    console.log(`    ${command.description}`);
    if (command.options) {
      for (const [name, option] of Object.entries(command.options)) {
        const short = option.short ? `-${option.short}, ` : "";
        console.log(`    ${short}--${name}: ${option.description}`);
      }
    }
    console.log();
  }
  /**
   * Create a simple spinner
   */
  createSpinner(text) {
    if (this.config.colors) {
      process.stdout.write(`⠋ ${text}`);
      return {
        succeed: (successText) => {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          console.log(`✅ ${successText || text}`);
        },
        fail: (errorText) => {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          console.log(`❌ ${errorText || text}`);
        }
      };
    }
    console.log(text);
    return {
      succeed: (successText) => console.log(successText || "Done"),
      fail: (errorText) => console.log(errorText || "Failed")
    };
  }
  /**
   * Prompt for input
   */
  async prompt(message) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    return new Promise((resolve) => {
      rl.question(`${message} `, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  /**
   * Confirm prompt
   */
  async confirm(message) {
    const answer = await this.prompt(`${message} (y/n)`);
    return answer.toLowerCase().startsWith("y");
  }
  /**
   * Handle LIST command
   */
  async handleList(objectName, options) {
    const spinner = this.createSpinner(`Listing ${objectName} objects...`);
    try {
      const collection = await this.getCollection(objectName);
      const listOptions = {
        limit: Number.parseInt(options.limit, 10),
        offset: Number.parseInt(options.offset, 10)
      };
      if (options.orderBy) {
        listOptions.orderBy = options.orderBy;
      }
      if (options.where) {
        listOptions.where = JSON.parse(options.where);
      }
      const results = await collection.list(listOptions);
      spinner.succeed(`Found ${results.length} ${objectName} objects`);
      if (options.format === "json") {
        console.log(JSON.stringify(results, null, 2));
      } else {
        this.displayTable(results, objectName);
      }
    } catch (error) {
      spinner.fail(`Failed to list ${objectName} objects`);
      console.error(
        "Error:",
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
  /**
   * Handle GET command
   */
  async handleGet(objectName, id, options) {
    const spinner = this.createSpinner(`Getting ${objectName}...`);
    try {
      const collection = await this.getCollection(objectName);
      const result = await collection.get(id);
      if (!result) {
        spinner.fail(`${objectName} not found`);
        this.exitWithError(`${objectName} not found`);
        return;
      }
      spinner.succeed(`Found ${objectName}`);
      if (options.format === "yaml") {
        console.log(this.toYamlString(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      spinner.fail(`Failed to get ${objectName}`);
      console.error(
        "Error:",
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
  /**
   * Handle CREATE command
   */
  async handleCreate(objectName, options) {
    try {
      let data = {};
      if (options.fromFile) {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(options.fromFile, "utf-8");
        data = JSON.parse(content);
      } else if (options.interactive && this.config.prompt) {
        data = await this.promptForFields(objectName, {});
      } else {
        const fields = ObjectRegistry.getFields(objectName);
        for (const [fieldName] of fields) {
          const optionName = fieldName.replace(/_/g, "-");
          if (options[optionName] !== void 0) {
            data[fieldName] = this.parseFieldValue(options[optionName]);
          }
        }
      }
      const spinner = this.createSpinner(`Creating ${objectName}...`);
      const collection = await this.getCollection(objectName);
      const result = await collection.create(data);
      await result.save();
      spinner.succeed(`Created ${objectName} with ID: ${result.id}`);
      if (!options.quiet) {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
  /**
   * Handle UPDATE command
   */
  async handleUpdate(objectName, id, options) {
    try {
      const collection = await this.getCollection(objectName);
      const existing = await collection.get(id);
      if (!existing) {
        this.exitWithError(`${objectName} not found`);
        return;
      }
      let data = {};
      if (options.fromFile) {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(options.fromFile, "utf-8");
        data = JSON.parse(content);
      } else if (options.interactive && this.config.prompt) {
        data = await this.promptForFields(objectName, existing);
      } else {
        const fields = ObjectRegistry.getFields(objectName);
        for (const [fieldName] of fields) {
          const optionName = fieldName.replace(/_/g, "-");
          if (options[optionName] !== void 0) {
            data[fieldName] = this.parseFieldValue(options[optionName]);
          }
        }
      }
      const spinner = this.createSpinner(`Updating ${objectName}...`);
      Object.assign(existing, data);
      await existing.save();
      spinner.succeed(`Updated ${objectName}`);
      if (!options.quiet) {
        console.log(JSON.stringify(existing, null, 2));
      }
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
  /**
   * Handle DELETE command
   */
  async handleDelete(objectName, id, options) {
    try {
      const collection = await this.getCollection(objectName);
      const existing = await collection.get(id);
      if (!existing) {
        this.exitWithError(`${objectName} not found`);
        return;
      }
      if (!options.force && this.config.prompt) {
        const confirmed = await this.confirm(
          `Are you sure you want to delete ${objectName} "${existing.name || existing.id}"?`
        );
        if (!confirmed) {
          console.log("Cancelled");
          return;
        }
      }
      const spinner = this.createSpinner(`Deleting ${objectName}...`);
      await existing.delete();
      spinner.succeed(`Deleted ${objectName}`);
    } catch (error) {
      this.exitWithError(
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
  /**
   * Get or create collection for an object
   */
  async getCollection(objectName) {
    if (!this.collections.has(objectName)) {
      const classInfo = ObjectRegistry.getClass(objectName);
      if (!classInfo || !classInfo.collectionConstructor) {
        throw new Error(
          `Object ${objectName} not found or has no collection constructor`
        );
      }
      const collection = new classInfo.collectionConstructor({
        ai: this.context.ai,
        db: this.context.db
      });
      await collection.initialize();
      this.collections.set(objectName, collection);
    }
    return this.collections.get(objectName);
  }
  /**
   * Interactive field prompts
   */
  async promptForFields(objectName, current) {
    const fields = ObjectRegistry.getFields(objectName);
    const result = {};
    for (const [fieldName, field] of fields) {
      const currentValue = current[fieldName];
      let message = `${fieldName}`;
      if (field.options?.description) {
        message += ` (${field.options.description})`;
      }
      if (currentValue !== void 0) {
        message += ` [${currentValue}]`;
      }
      message += ": ";
      if (field.type === "boolean") {
        result[fieldName] = await this.confirm(message);
      } else {
        const input = await this.prompt(message);
        if (input.trim()) {
          result[fieldName] = this.parseFieldValue(input);
        } else if (currentValue !== void 0) {
          result[fieldName] = currentValue;
        }
      }
    }
    return result;
  }
  /**
   * Parse field value from string
   */
  parseFieldValue(value) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  /**
   * Display results as table
   */
  displayTable(results, objectName) {
    if (results.length === 0) {
      console.log(`No ${objectName} objects found`);
      return;
    }
    const keys = ["id", "name", "slug", "created_at"];
    const rows = results.map(
      (item) => keys.map((key) => String(item[key] || "").substring(0, 30))
    );
    console.log();
    console.log(keys.join("	"));
    console.log("-".repeat(80));
    rows.forEach((row) => {
      console.log(row.join("	"));
    });
    console.log();
  }
  /**
   * Convert object to YAML-like string
   */
  toYamlString(obj, indent = 0) {
    const spaces = "  ".repeat(indent);
    let result = "";
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === void 0) {
        result += `${spaces}${key}: null
`;
      } else if (typeof value === "object" && !Array.isArray(value)) {
        result += `${spaces}${key}:
${this.toYamlString(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        result += `${spaces}${key}:
`;
        value.forEach((item) => {
          result += `${spaces}  - ${item}
`;
        });
      } else {
        result += `${spaces}${key}: ${value}
`;
      }
    }
    return result;
  }
}
async function main() {
  const config = {
    name: "smrt",
    version: "1.0.0",
    description: "Admin CLI for smrt objects",
    prompt: !process.env.CI,
    // Disable prompts in CI
    colors: !process.env.NO_COLOR && process.stdout.isTTY
  };
  const context = {
    // db and ai can be configured via environment or initialized here
  };
  const cli = new CLIGenerator(config, context);
  const handler = cli.generateHandler();
  const args = process.argv.slice(2);
  try {
    await handler(args);
  } catch (error) {
    console.error(
      "CLI Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
    process.exit(1);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
export {
  CLIGenerator,
  main
};
//# sourceMappingURL=cli.js.map
