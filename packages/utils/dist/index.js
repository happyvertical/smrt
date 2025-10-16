import * as vm from "node:vm";
import { createId as createId$1 } from "@paralleldrive/cuid2";
import { isCuid } from "@paralleldrive/cuid2";
import { isValid, add, format, parse, parseISO } from "date-fns";
import pluralize from "pluralize";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
function extractCodeBlock(text, language) {
  if (!text) {
    return "";
  }
  const langPattern = language ? `${language}\\s*` : "(?:\\w+\\s*)?";
  const codeBlockRegex = new RegExp(
    `\`\`\`${langPattern}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``,
    "i"
  );
  const match = text.match(codeBlockRegex);
  if (match && match[1]) {
    return match[1].trim();
  }
  const inlineRegex = /`([^`]+)`/;
  const inlineMatch = text.match(inlineRegex);
  if (inlineMatch && inlineMatch[1]) {
    return inlineMatch[1].trim();
  }
  return "";
}
function extractJSON(text) {
  if (!text) {
    throw new SyntaxError("Cannot extract JSON from empty text");
  }
  let jsonText = extractCodeBlock(text, "json");
  if (!jsonText) {
    jsonText = extractCodeBlock(text);
  }
  if (!jsonText) {
    const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = text.match(/\[[\s\S]*\]/);
    if (jsonObjectMatch) {
      jsonText = jsonObjectMatch[0];
    } else if (jsonArrayMatch) {
      jsonText = jsonArrayMatch[0];
    } else {
      jsonText = text.trim();
    }
  }
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new SyntaxError(
      `Failed to parse JSON: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
function extractAllCodeBlocks(text, language) {
  if (!text) {
    return [];
  }
  const langPattern = language ? `${language}\\s*` : "(?:\\w+\\s*)?";
  const codeBlockRegex = new RegExp(
    `\`\`\`${langPattern}\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``,
    "gi"
  );
  const blocks = [];
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1]) {
      blocks.push(match[1].trim());
    }
  }
  return blocks;
}
function extractFunctionDefinition(code, functionName) {
  if (!code || !functionName) {
    return "";
  }
  const patterns = [
    // function foo() { ... }
    {
      regex: new RegExp(
        `function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`,
        "i"
      ),
      hasBraces: true
    },
    // const foo = function() { ... }
    {
      regex: new RegExp(
        `(?:const|let|var)\\s+${functionName}\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{`,
        "i"
      ),
      hasBraces: true
    },
    // const foo = () => { ... }
    {
      regex: new RegExp(
        `(?:const|let|var)\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
        "i"
      ),
      hasBraces: true
    },
    // const foo = () => ... (no braces)
    {
      regex: new RegExp(
        `(?:const|let|var)\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*[^;]+;?`,
        "i"
      ),
      hasBraces: false
    }
  ];
  for (const { regex, hasBraces } of patterns) {
    const match = code.match(regex);
    if (match && match.index !== void 0) {
      const startIdx = match.index;
      if (!hasBraces) {
        return match[0].trim();
      }
      const braceIdx = code.indexOf("{", startIdx);
      if (braceIdx === -1) continue;
      let idx = braceIdx;
      let depth = 0;
      let endIdx = -1;
      while (idx < code.length) {
        const char = code[idx];
        if (char === "{") {
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0) {
            endIdx = idx;
            break;
          }
        }
        idx++;
      }
      if (endIdx !== -1) {
        return code.slice(startIdx, endIdx + 1).trim();
      }
    }
  }
  return "";
}
const DEFAULT_BUILTINS = [
  "Array",
  "Object",
  "JSON",
  "Math",
  "Date",
  "String",
  "Number",
  "Boolean",
  "RegExp",
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "Symbol",
  "Promise"
];
function createSandbox(options = {}) {
  const {
    globals = {},
    allowedBuiltins = DEFAULT_BUILTINS,
    allowConsole = false
  } = options;
  const sandbox = /* @__PURE__ */ Object.create(null);
  for (const builtin of allowedBuiltins) {
    if (builtin in globalThis) {
      sandbox[builtin] = globalThis[builtin];
    }
  }
  if (allowConsole) {
    sandbox.console = console;
  }
  Object.assign(sandbox, globals);
  return vm.createContext(sandbox);
}
function executeCode(code, sandbox, options = {}) {
  const {
    timeout = 5e3,
    filename = "generated-code.js",
    captureResult = true
  } = options;
  try {
    let wrappedCode;
    if (captureResult) {
      const hasMultipleStatements = code.includes(";") || code.includes("\n") && code.trim().split("\n").length > 1;
      const hasFunctionDef = /function\s+\w+|const\s+\w+\s*=\s*function|const\s+\w+\s*=\s*\(/i.test(code);
      if (hasMultipleStatements || hasFunctionDef) {
        wrappedCode = code;
      } else {
        wrappedCode = `(function() { return (${code}); })();`;
      }
    } else {
      wrappedCode = code;
    }
    const result = vm.runInContext(wrappedCode, sandbox, {
      timeout,
      filename,
      displayErrors: true
    });
    return result;
  } catch (error) {
    if (error instanceof Error) {
      const message = `Code execution failed: ${error.message}`;
      const enhancedError = new Error(message);
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
    throw error;
  }
}
async function executeCodeAsync(code, sandbox, options = {}) {
  const {
    timeout = 5e3,
    filename = "generated-code.js",
    captureResult = true
  } = options;
  try {
    let wrappedCode;
    if (captureResult) {
      const trimmedCode = code.trim();
      const lines = trimmedCode.split("\n");
      if (lines.length > 1 || trimmedCode.includes(";")) {
        const statements = trimmedCode.split("\n").filter((line) => line.trim());
        const lastLine = statements[statements.length - 1];
        const otherLines = statements.slice(0, -1);
        if (lastLine.trim().startsWith("return ")) {
          wrappedCode = `(async function() {
            ${trimmedCode}
          })();`;
        } else {
          const lastExpression = lastLine.trim().replace(/;$/, "");
          wrappedCode = `(async function() {
            ${otherLines.join("\n")}
            return ${lastExpression};
          })();`;
        }
      } else {
        wrappedCode = `(async function() {
          return (${trimmedCode});
        })();`;
      }
    } else {
      wrappedCode = `(async function() {
        ${code}
      })();`;
    }
    const result = await vm.runInContext(wrappedCode, sandbox, {
      timeout,
      filename,
      displayErrors: true
    });
    return result;
  } catch (error) {
    if (error instanceof Error) {
      const message = `Async code execution failed: ${error.message}`;
      const enhancedError = new Error(message);
      enhancedError.stack = error.stack;
      throw enhancedError;
    }
    throw error;
  }
}
function executeInSandbox(code, options = {}) {
  const sandbox = createSandbox(options);
  return executeCode(code, sandbox, options);
}
async function executeInSandboxAsync(code, options = {}) {
  const sandbox = createSandbox(options);
  return executeCodeAsync(code, sandbox, options);
}
const DANGEROUS_PATTERNS = [
  /require\s*\(/i,
  // No require()
  /import\s+/i,
  // No import statements
  /eval\s*\(/i,
  // No eval()
  /Function\s*\(/i,
  // No Function constructor
  /process\./i,
  // No process access
  /fs\./i,
  // No filesystem module
  /child_process/i,
  // No child process
  /__dirname/i,
  // No directory access
  /__filename/i,
  // No file access
  /global\./i
  // No global object manipulation
];
function validateCode(code, options = {}) {
  const {
    allowedGlobals,
    disallowedPatterns = DANGEROUS_PATTERNS,
    maxLength = 5e4,
    allowRequire = false,
    allowImport = false,
    allowEval = false,
    checkSyntax = true
  } = options;
  const errors = [];
  const warnings = [];
  if (!code || code.trim().length === 0) {
    errors.push("Code is empty");
    return { valid: false, errors, warnings };
  }
  if (code.length > maxLength) {
    errors.push(
      `Code exceeds maximum length (${code.length} > ${maxLength} characters)`
    );
  }
  const patternFlags = /* @__PURE__ */ new Map([
    [DANGEROUS_PATTERNS[0], "require"],
    // /require\s*\(/i
    [DANGEROUS_PATTERNS[1], "import"],
    // /import\s+/i
    [DANGEROUS_PATTERNS[2], "eval"],
    // /eval\s*\(/i
    [DANGEROUS_PATTERNS[3], "eval"]
    // /Function\s*\(/i - also controlled by allowEval
    // Patterns 4-9 are always dangerous (process, fs, child_process, etc.)
  ]);
  const effectivePatterns = disallowedPatterns.filter((pattern, index) => {
    const patternType = patternFlags.get(DANGEROUS_PATTERNS[index]);
    if (patternType === "require" && allowRequire) {
      return false;
    }
    if (patternType === "import" && allowImport) {
      return false;
    }
    if (patternType === "eval" && allowEval) {
      return false;
    }
    return true;
  });
  for (const pattern of effectivePatterns) {
    if (pattern.test(code)) {
      errors.push(
        `Code contains disallowed pattern: ${pattern.source.replace(/\\/g, "")}`
      );
    }
  }
  if (allowedGlobals) {
    const undeclaredVars = findUndeclaredVariables(code, allowedGlobals);
    if (undeclaredVars.length > 0) {
      warnings.push(
        `Potentially undeclared variables: ${undeclaredVars.join(", ")}`
      );
    }
  }
  if (checkSyntax) {
    const syntaxErrors = checkCodeSyntax(code);
    errors.push(...syntaxErrors);
  }
  const stats = {
    length: code.length,
    lines: code.split("\n").length,
    hasAsync: /\basync\b\s*(function|\([\w\s,={}[\]]*\)\s*=>|\w+\s*\()/m.test(code),
    hasArrowFunctions: /=>/.test(code),
    hasClasses: /\bclass\s+\w+/.test(code)
  };
  if (stats.lines > 100) {
    warnings.push(`Code is long (${stats.lines} lines) - consider breaking into smaller functions`);
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats
  };
}
function checkCodeSyntax(code) {
  const errors = [];
  try {
    new Function(code);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const message = error.message;
      if (message.includes("await is only valid") && /\bawait\b/.test(code)) {
        try {
          new Function(`(async function() { ${code} })()`);
          return errors;
        } catch (asyncError) {
          if (asyncError instanceof SyntaxError) {
            errors.push(`Syntax error: ${asyncError.message}`);
          }
        }
      } else {
        errors.push(`Syntax error: ${message}`);
      }
    }
  }
  return errors;
}
function findUndeclaredVariables(code, allowedGlobals) {
  const undeclaredVars = /* @__PURE__ */ new Set();
  const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  const matches = code.matchAll(identifierRegex);
  const declaredVars = /* @__PURE__ */ new Set();
  const declarationRegex = /\b(?:var|let|const|function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  const declarations = code.matchAll(declarationRegex);
  for (const match of declarations) {
    if (match[1]) {
      declaredVars.add(match[1]);
    }
  }
  for (const match of matches) {
    const identifier = match[1];
    if (isJavaScriptKeyword(identifier)) {
      continue;
    }
    if (declaredVars.has(identifier)) {
      continue;
    }
    if (allowedGlobals.includes(identifier)) {
      continue;
    }
    if (isCommonBuiltin(identifier)) {
      continue;
    }
    undeclaredVars.add(identifier);
  }
  return Array.from(undeclaredVars);
}
function isJavaScriptKeyword(word) {
  const keywords = [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "async",
    "await"
  ];
  return keywords.includes(word);
}
function isCommonBuiltin(word) {
  const builtins = [
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Date",
    "Math",
    "JSON",
    "RegExp",
    "Error",
    "Map",
    "Set",
    "Promise",
    "Symbol",
    "undefined",
    "null",
    "true",
    "false",
    "console",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent"
  ];
  return builtins.includes(word);
}
function isSafeCode(code) {
  const result = validateCode(code, {
    maxLength: 5e4,
    checkSyntax: true
  });
  return result.valid;
}
class ConsoleLogger {
  debug(message, context) {
    if (context) {
      console.debug(message, context);
    } else {
      console.debug(message);
    }
  }
  info(message, context) {
    if (context) {
      console.info(message, context);
    } else {
      console.info(message);
    }
  }
  warn(message, context) {
    if (context) {
      console.warn(message, context);
    } else {
      console.warn(message);
    }
  }
  error(message, context) {
    if (context) {
      console.error(message, context);
    } else {
      console.error(message);
    }
  }
}
class NoOpLogger {
  debug() {
  }
  info() {
  }
  warn() {
  }
  error() {
  }
}
let globalLogger = new ConsoleLogger();
const setLogger = (logger) => {
  globalLogger = logger;
};
const getLogger = () => {
  return globalLogger;
};
const disableLogging = () => {
  globalLogger = new NoOpLogger();
};
const enableLogging = () => {
  globalLogger = new ConsoleLogger();
};
var ErrorCode = /* @__PURE__ */ ((ErrorCode2) => {
  ErrorCode2["VALIDATION_ERROR"] = "VALIDATION_ERROR";
  ErrorCode2["API_ERROR"] = "API_ERROR";
  ErrorCode2["FILE_ERROR"] = "FILE_ERROR";
  ErrorCode2["NETWORK_ERROR"] = "NETWORK_ERROR";
  ErrorCode2["DATABASE_ERROR"] = "DATABASE_ERROR";
  ErrorCode2["PARSING_ERROR"] = "PARSING_ERROR";
  ErrorCode2["TIMEOUT_ERROR"] = "TIMEOUT_ERROR";
  ErrorCode2["UNKNOWN_ERROR"] = "UNKNOWN_ERROR";
  return ErrorCode2;
})(ErrorCode || {});
class BaseError extends Error {
  /** Error classification code */
  code;
  /** Additional context data for debugging */
  context;
  /** When the error occurred */
  timestamp;
  constructor(message, code = "UNKNOWN_ERROR", context) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    this.timestamp = /* @__PURE__ */ new Date();
    Error.captureStackTrace?.(this, this.constructor);
  }
  /**
   * Serializes the error to a JSON-compatible object
   * @returns Object containing all error properties
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack
    };
  }
}
class ValidationError extends BaseError {
  constructor(message, context) {
    super(message, "VALIDATION_ERROR", context);
  }
}
class ApiError extends BaseError {
  constructor(message, context) {
    super(message, "API_ERROR", context);
  }
}
class FileError extends BaseError {
  constructor(message, context) {
    super(message, "FILE_ERROR", context);
  }
}
class NetworkError extends BaseError {
  constructor(message, context) {
    super(message, "NETWORK_ERROR", context);
  }
}
class DatabaseError extends BaseError {
  constructor(message, context) {
    super(message, "DATABASE_ERROR", context);
  }
}
class ParsingError extends BaseError {
  constructor(message, context) {
    super(message, "PARSING_ERROR", context);
  }
}
class TimeoutError extends BaseError {
  constructor(message, context) {
    super(message, "TIMEOUT_ERROR", context);
  }
}
const makeId = (type = "cuid2") => {
  if (type === "cuid2") {
    return createId$1();
  }
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
};
const createId = createId$1;
const makeSlug = (str) => {
  const from = "àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìıİłḿñńǹňôöòóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż+·/_,:;";
  const to = "aaaaaaaaaacccddeeeeeeeegghiiiiiiiilmnnnnoooooooooprrsssssttuuuuuuuuuwxyyzzz--------------";
  const textToCompare = new RegExp(
    from.split("").join("|").replace(/\+/g, "\\+"),
    "g"
  );
  return str.toString().toLowerCase().replace("&", "-38-").replace(/\s+/g, "-").replace(textToCompare, (c) => to.charAt(from.indexOf(c))).replace(/[&.]/g, "-").replace(/[^\w-º+]+/g, "").replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
};
const urlFilename = (url) => {
  const parsedUrl = new URL(url);
  const pathSegments = parsedUrl.pathname.split("/");
  const filename = pathSegments[pathSegments.length - 1];
  return filename || "index.html";
};
const urlPath = (url) => {
  const parsedUrl = new URL(url);
  const pathSegments = [
    parsedUrl.hostname,
    ...parsedUrl.pathname.split("/").filter(Boolean)
  ];
  return pathSegments.join("/");
};
const sleep = (duration) => {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
};
function waitFor(it, { timeout = 0, delay = 1e3 } = {}) {
  return new Promise((resolve, reject) => {
    const beginTime = Date.now();
    (async function waitATick() {
      try {
        const result = await it();
        if (typeof result !== "undefined") {
          return resolve(result);
        }
        if (timeout > 0) {
          if (Date.now() > beginTime + timeout) {
            return reject(
              new TimeoutError("Function call timed out", {
                timeout,
                delay,
                elapsedTime: Date.now() - beginTime
              })
            );
          }
        }
        setTimeout(waitATick, delay);
      } catch (error) {
        reject(error);
      }
    })();
  });
}
const isArray = (obj) => {
  return Array.isArray(obj);
};
const isPlainObject = (obj) => {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
};
const isUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};
const camelCase = (str) => {
  return str.toLowerCase().replace(/[-_]+/g, " ").replace(/[^\w\s]/g, "").replace(/\s(.)/g, (_, char) => char.toUpperCase()).replace(/\s/g, "").replace(/^(.)/, (_, char) => char.toLowerCase());
};
const snakeCase = (str) => {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "").replace(/[-\s]+/g, "_");
};
const keysToCamel = (obj) => {
  if (isPlainObject(obj)) {
    const n = {};
    Object.keys(obj).forEach((k) => {
      n[camelCase(k)] = keysToCamel(obj[k]);
    });
    return n;
  }
  if (isArray(obj)) {
    return obj.map((i) => keysToCamel(i));
  }
  return obj;
};
const keysToSnake = (obj) => {
  if (isPlainObject(obj)) {
    const n = {};
    Object.keys(obj).forEach((k) => {
      n[snakeCase(k)] = keysToSnake(obj[k]);
    });
    return n;
  }
  if (isArray(obj)) {
    return obj.map((i) => keysToSnake(i));
  }
  return obj;
};
const domainToCamel = (domain) => camelCase(domain);
const logTicker = (tick, options = {}) => {
  const { chars = [".", "..", "..."] } = options;
  if (tick) {
    const index = chars.indexOf(tick);
    return index + 1 >= chars.length ? chars[0] : chars[index + 1];
  }
  return chars[0];
};
const parseAmazonDateString = (dateStr) => {
  const regex = /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})([A-Z0-9]+)/;
  const match = dateStr.match(regex);
  if (!match) {
    throw new ParsingError("Could not parse Amazon date string", {
      dateString: dateStr,
      expectedFormat: "YYYYMMDDTHHMMSSZ"
    });
  }
  const [matched, year, month, day, hour, minutes, seconds, timezone] = match;
  if (matched !== dateStr) {
    throw new ParsingError("Invalid Amazon date string format", {
      dateString: dateStr,
      matched,
      expectedFormat: "YYYYMMDDTHHMMSSZ"
    });
  }
  const date = /* @__PURE__ */ new Date(
    `${year}-${month}-${day}T${hour}:${minutes}:${seconds}${timezone}`
  );
  return date;
};
const dateInString = (str) => {
  const cleanStr = str.toLowerCase();
  const underscoreMatch = str.match(/(\d{4})_(\d{1,2})_(\d{1,2})/);
  if (underscoreMatch) {
    const [, year2, month, day2] = underscoreMatch;
    const date2 = new Date(
      Number.parseInt(year2, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day2, 10)
    );
    if (!Number.isNaN(date2.getTime())) return date2;
  }
  const dotMatch = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, month, day2, year2] = dotMatch;
    const date2 = new Date(
      Number.parseInt(year2, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day2, 10)
    );
    if (!Number.isNaN(date2.getTime())) return date2;
  }
  const isoMatch = cleanStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const [, year2, month, day2] = isoMatch;
    const date2 = new Date(
      Number.parseInt(year2, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day2, 10)
    );
    if (!Number.isNaN(date2.getTime())) return date2;
  }
  const usMatch = cleanStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (usMatch) {
    const [, month, day2, year2] = usMatch;
    const date2 = new Date(
      Number.parseInt(year2, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day2, 10)
    );
    if (!Number.isNaN(date2.getTime())) return date2;
  }
  const yearMatch = cleanStr.match(/20\d{2}/);
  if (!yearMatch) return null;
  const year = Number.parseInt(yearMatch[0], 10);
  const monthPatterns = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12
  };
  let foundMonth = null;
  let monthStart = -1;
  let monthName = "";
  for (const [name, monthNum] of Object.entries(monthPatterns)) {
    const monthIndex = cleanStr.indexOf(name);
    if (monthIndex !== -1) {
      foundMonth = monthNum;
      monthStart = monthIndex;
      monthName = name;
      break;
    }
  }
  if (!foundMonth) return null;
  const yearIndex = cleanStr.indexOf(yearMatch[0]);
  const beforeMonth = cleanStr.substring(
    Math.max(0, monthStart - 15),
    monthStart
  );
  const afterMonth = cleanStr.substring(
    monthStart + monthName.length,
    Math.min(cleanStr.length, monthStart + monthName.length + 15)
  );
  const beforeYear = cleanStr.substring(
    Math.max(0, yearIndex - 15),
    yearIndex
  );
  const afterYear = cleanStr.substring(
    yearIndex + 4,
    Math.min(cleanStr.length, yearIndex + 19)
  );
  const dayMatch = beforeMonth.match(/(?<!\d)(\d{1,2})\s*$/) || // Day before month (not preceded by another digit)
  afterMonth.match(/^\s*(\d{1,2})(?!\d)/) || // Day right after month (not followed by another digit)
  beforeYear.match(/(?<!\d)(\d{1,2})\s*$/) || // Day before year (not preceded by another digit)
  afterYear.match(/^\s*(\d{1,2})(?!\d)/) || // Day right after year (not followed by another digit)
  afterMonth.match(/[^\d](\d{1,2})(?!\d)/);
  const day = dayMatch ? Number.parseInt(dayMatch[1], 10) : 1;
  if (day < 1 || day > 31) return null;
  const date = new Date(year, foundMonth - 1, day);
  return !Number.isNaN(date.getTime()) ? date : null;
};
const prettyDate = (dateString) => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat(void 0, {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(date);
};
const pluralizeWord = pluralize;
const singularize = pluralize.singular;
const isPlural = pluralize.isPlural;
const isSingular = pluralize.isSingular;
const formatDate = (date, formatStr = "yyyy-MM-dd") => {
  const dateObj = typeof date === "string" ? new Date(date) : date;
  return format(dateObj, formatStr);
};
const parseDate = (dateStr, formatStr) => {
  if (formatStr) {
    return parse(dateStr, formatStr, /* @__PURE__ */ new Date());
  }
  return parseISO(dateStr);
};
const isValidDate = isValid;
const addInterval = add;
const getTempDirectory = (subfolder) => {
  const tmpBase = process?.env ? process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp" : "/tmp";
  const basePath = `${tmpBase}/.have-sdk`;
  return subfolder ? `${basePath}/${subfolder}` : basePath;
};
function parseCliArgs(argv, commands, builtInCommands = {}) {
  let args = argv;
  if (args.length > 0 && basename(args[0]) === "node") {
    args = args.slice(1);
  }
  if (args.length > 0 && args[0].endsWith(".js")) {
    args = args.slice(1);
  }
  if (args.length === 0) {
    return { args: [], options: {} };
  }
  if (args.includes("--help")) {
    return { command: "help", args: [], options: {} };
  }
  if (args.includes("--version")) {
    return { command: "version", args: [], options: {} };
  }
  let matchedCommand;
  let commandName;
  let commandWordCount = 0;
  for (let i = Math.min(3, args.length); i > 0; i--) {
    const possibleCommand = args.slice(0, i).join(" ");
    const found = builtInCommands[possibleCommand] || commands.find(
      (cmd) => cmd.name === possibleCommand || cmd.aliases?.includes(possibleCommand)
    );
    if (found) {
      matchedCommand = found;
      commandName = possibleCommand;
      commandWordCount = i;
      break;
    }
  }
  if (!commandName && args.length > 0) {
    commandName = args[0];
    commandWordCount = 1;
    matchedCommand = commands.find(
      (cmd) => cmd.name === commandName || cmd.aliases?.includes(commandName)
    );
  }
  if (!matchedCommand) {
    if (args.includes("-h")) {
      return { command: "help", args: [], options: {} };
    }
    if (args.includes("-v")) {
      return { command: "version", args: [], options: {} };
    }
    return {
      command: commandName,
      args: args.slice(1).filter((arg) => !arg.startsWith("-")),
      options: {}
    };
  }
  const parseConfig = {
    args: args.slice(commandWordCount),
    options: {},
    strict: false,
    // Allow unknown options
    allowPositionals: true
    // Required for mixing positional args and options
  };
  if (matchedCommand.options) {
    for (const [name, option] of Object.entries(matchedCommand.options)) {
      parseConfig.options[name] = {
        type: option.type === "boolean" ? "boolean" : "string",
        ...option.default !== void 0 && { default: option.default }
      };
      if (option.short) {
        parseConfig.options[name].short = option.short;
      }
    }
  }
  try {
    const parsed = parseArgs(parseConfig);
    return {
      command: commandName,
      args: parsed.positionals || [],
      options: parsed.values || {}
    };
  } catch (error) {
    return {
      command: commandName,
      args: args.slice(commandWordCount).filter((arg) => !arg.startsWith("-")),
      options: {}
    };
  }
}
function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hostname = parsed.hostname.replace(/^www\./, "");
  if (parsed.protocol === "http:" && parsed.port === "80" || parsed.protocol === "https:" && parsed.port === "443") {
    parsed.port = "";
  }
  parsed.hash = "";
  const params = new URLSearchParams(parsed.search);
  const filtered = new URLSearchParams();
  const trackingParams = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "gclid",
    "msclkid",
    "_ga",
    "mc_cid",
    "mc_eid"
  ];
  Array.from(params.keys()).sort().forEach((key) => {
    if (!trackingParams.includes(key)) {
      filtered.set(key, params.get(key));
    }
  });
  parsed.search = filtered.toString();
  return parsed.toString();
}
function generateScopeFromUrl(url, baseScope = "discovery/parser") {
  const parsed = new URL(normalizeUrl(url));
  const domain = parsed.hostname;
  const pathParts = parsed.pathname.split("/").filter((p) => p);
  const pageType = pathParts[0] || "index";
  return `${baseScope}/${domain}/${pageType}`;
}
function hashPageContent(html) {
  return createHash("sha256").update(html).digest("hex");
}
export {
  ApiError,
  BaseError,
  DatabaseError,
  ErrorCode,
  FileError,
  NetworkError,
  ParsingError,
  TimeoutError,
  ValidationError,
  addInterval,
  camelCase,
  createId,
  createSandbox,
  dateInString,
  disableLogging,
  domainToCamel,
  enableLogging,
  executeCode,
  executeCodeAsync,
  executeInSandbox,
  executeInSandboxAsync,
  extractAllCodeBlocks,
  extractCodeBlock,
  extractFunctionDefinition,
  extractJSON,
  formatDate,
  generateScopeFromUrl,
  getLogger,
  getTempDirectory,
  hashPageContent,
  isArray,
  isCuid,
  isPlainObject,
  isPlural,
  isSafeCode,
  isSingular,
  isUrl,
  isValidDate,
  keysToCamel,
  keysToSnake,
  logTicker,
  makeId,
  makeSlug,
  normalizeUrl,
  parseAmazonDateString,
  parseCliArgs,
  parseDate,
  pluralizeWord,
  prettyDate,
  setLogger,
  singularize,
  sleep,
  snakeCase,
  urlFilename,
  urlPath,
  validateCode,
  waitFor
};
//# sourceMappingURL=index.js.map
