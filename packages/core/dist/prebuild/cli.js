#!/usr/bin/env node
import { a as generateDeclarationsFromCLI } from "../chunks/index-Dw0X9BVV.js";
const args = process.argv.slice(2);
const command = args[0];
switch (command) {
  case "generate-types":
  case "generate-declarations":
    generateDeclarationsFromCLI(args.slice(1)).catch((error) => {
      console.error("Error generating declarations:", error);
      process.exit(1);
    });
    break;
  default:
    console.log(`
SMRT Pre-build CLI

Usage:
  smrt generate-types <manifest-path> [output-dir]

Commands:
  generate-types       Generate TypeScript declarations from manifest

Examples:
  smrt generate-types ./manifest.json src/types/generated
  smrt generate-types ./static-manifest.js
`);
    process.exit(1);
}
//# sourceMappingURL=cli.js.map
