/**
 * Global SMRT framework options
 * These apply to all modules unless overridden
 */
export interface SmrtGlobalConfig {
    cacheDir?: string;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    environment?: 'development' | 'production' | 'test';
    [key: string]: unknown;
}
/**
 * Main SMRT configuration structure
 */
export interface SmrtConfig {
    smrt?: SmrtGlobalConfig;
    modules?: {
        [moduleName: string]: Record<string, unknown>;
    };
    packages?: {
        [packageName: string]: Record<string, unknown>;
    };
}
/**
 * Options for loading configuration
 */
export interface LoadConfigOptions {
    configPath?: string;
    searchParents?: boolean;
    cache?: boolean;
}
//# sourceMappingURL=types.d.ts.map