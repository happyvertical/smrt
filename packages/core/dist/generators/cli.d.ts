import { Command, ParsedArgs } from '@have/utils';
export interface CLIConfig {
    name?: string;
    version?: string;
    description?: string;
    prompt?: boolean;
    colors?: boolean;
}
export interface CLIContext {
    db?: any;
    ai?: any;
    user?: {
        id: string;
        roles?: string[];
    };
}
export type CLICommand = Command;
export type { ParsedArgs } from '@have/utils';
/**
 * Generate CLI commands for smrt objects
 */
export declare class CLIGenerator {
    private config;
    private context;
    private collections;
    constructor(config?: CLIConfig, context?: CLIContext);
    /**
     * Check if running in test environment
     */
    private isTestMode;
    /**
     * Handle exits safely in test mode
     */
    private exitWithError;
    /**
     * Generate CLI handler function
     */
    generateHandler(): (argv: string[]) => Promise<void>;
    /**
     * Generate all CLI commands
     */
    private generateCommands;
    /**
     * Generate CRUD commands for a specific object
     */
    private generateObjectCommands;
    /**
     * Execute a parsed command
     */
    executeCommand(parsed: ParsedArgs, commands: CLICommand[]): Promise<void>;
    /**
     * Generate utility commands
     */
    generateUtilityCommands(): CLICommand[];
    /**
     * Create schema command handler
     */
    private createSchemaHandler;
    /**
     * Show help information
     */
    showHelp(commands: CLICommand[]): Promise<void>;
    /**
     * Show help for a single command
     */
    private showCommandHelp;
    /**
     * Create a simple spinner
     */
    private createSpinner;
    /**
     * Prompt for input
     */
    private prompt;
    /**
     * Confirm prompt
     */
    private confirm;
    /**
     * Handle LIST command
     */
    private handleList;
    /**
     * Handle GET command
     */
    private handleGet;
    /**
     * Handle CREATE command
     */
    private handleCreate;
    /**
     * Handle UPDATE command
     */
    private handleUpdate;
    /**
     * Handle DELETE command
     */
    private handleDelete;
    /**
     * Get or create collection for an object
     */
    private getCollection;
    /**
     * Interactive field prompts
     */
    private promptForFields;
    /**
     * Parse field value from string
     */
    private parseFieldValue;
    /**
     * Display results as table
     */
    private displayTable;
    /**
     * Convert object to YAML-like string
     */
    private toYamlString;
}
export declare function main(): Promise<void>;
//# sourceMappingURL=cli.d.ts.map