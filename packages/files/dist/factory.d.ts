import { FilesystemInterface, GetFilesystemOptions } from './shared/types';
/**
 * Register a filesystem provider
 */
export declare function registerProvider(type: string, factory: () => Promise<any>): void;
/**
 * Get list of available provider types
 */
export declare function getAvailableProviders(): string[];
/**
 * Main factory function to create filesystem instances
 */
export declare function getFilesystem(options?: GetFilesystemOptions): Promise<FilesystemInterface>;
/**
 * Initialize providers by registering them
 */
export declare function initializeProviders(): Promise<void>;
/**
 * Check if a provider is available
 */
export declare function isProviderAvailable(type: string): boolean;
/**
 * Get provider information
 */
export declare function getProviderInfo(type: string): {
    available: boolean;
    description: string;
    requiredOptions: string[];
};
//# sourceMappingURL=factory.d.ts.map