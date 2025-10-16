import { ScanResult, SmartObjectManifest } from './types';
export declare class ManifestGenerator {
    /**
     * Generate manifest from scan results
     */
    generateManifest(scanResults: ScanResult[]): SmartObjectManifest;
    /**
     * Generate TypeScript interfaces from manifest
     */
    generateTypeDefinitions(manifest: SmartObjectManifest): string;
    /**
     * Generate a single interface definition
     */
    private generateInterface;
    /**
     * Map field types to TypeScript types
     */
    private mapFieldTypeToTS;
    /**
     * Generate simple endpoint list for testing/documentation
     */
    generateRestEndpoints(manifest: SmartObjectManifest): string;
    /**
     * Generate REST endpoint code implementations
     */
    generateRestEndpointCode(manifest: SmartObjectManifest): string;
    /**
     * Get simple endpoint strings for an object
     */
    private getSimpleEndpoints;
    /**
     * Generate a single REST endpoint
     */
    private generateRestEndpoint;
    /**
     * Generate simple MCP tool names for testing/documentation
     */
    generateMCPTools(manifest: SmartObjectManifest): string;
    /**
     * Generate MCP tool JSON definitions
     */
    generateMCPToolsCode(manifest: SmartObjectManifest): string;
    /**
     * Get simple MCP tool names for an object
     */
    private getSimpleMCPToolNames;
    /**
     * Generate a single MCP tool
     */
    private generateMCPTool;
    /**
     * Generate JSON schema properties for fields
     */
    private generateSchemaProperties;
    /**
     * Map field types to JSON Schema types
     */
    private mapFieldTypeToJSON;
    /**
     * Save manifest to file
     */
    saveManifest(manifest: SmartObjectManifest, filePath: string): void;
    /**
     * Load manifest from file
     */
    loadManifest(filePath: string): SmartObjectManifest;
}
/**
 * Convenience function to generate manifest
 */
export declare function generateManifest(scanResults: ScanResult[]): SmartObjectManifest;
//# sourceMappingURL=manifest-generator.d.ts.map