/**
 * CLI Argument Parsing Utility
 *
 * Provides robust parsing for multi-word commands, options, and arguments.
 * Supports Node.js util.parseArgs for option parsing with fallback.
 */
/**
 * Command option configuration
 */
export interface OptionConfig {
    type: 'string' | 'boolean';
    description: string;
    default?: any;
    short?: string;
}
/**
 * Command definition
 */
export interface Command {
    name: string;
    description: string;
    aliases?: string[];
    options?: Record<string, OptionConfig>;
    args?: string[];
    handler?: (args: any, options: any) => Promise<void>;
}
/**
 * Parsed command line arguments
 */
export interface ParsedArgs {
    command?: string;
    args: string[];
    options: Record<string, any>;
}
/**
 * Parse command line arguments with support for multi-word commands
 *
 * Handles:
 * - Multi-word commands (up to 3 words: "gnode create", "foo bar baz")
 * - Command aliases
 * - Positional arguments
 * - Options using Node.js util.parseArgs
 * - Global flags (--help, --version)
 * - Automatic removal of node/script paths
 *
 * @param argv - Process argv or custom argument array
 * @param commands - Array of command definitions to match against
 * @param builtInCommands - Optional map of additional built-in commands
 * @returns Parsed arguments with command, args, and options
 *
 * @example
 * ```typescript
 * const parsed = parseCliArgs(
 *   ['node', 'cli.js', 'gnode', 'create', 'my-site', '--template=town'],
 *   commands
 * );
 * // { command: 'gnode create', args: ['my-site'], options: { template: 'town' } }
 * ```
 */
export declare function parseCliArgs(argv: string[], commands: Command[], builtInCommands?: Record<string, Command>): ParsedArgs;
//# sourceMappingURL=parse-args.d.ts.map