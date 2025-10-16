/**
 * MCP Server Generator Script for @have/products
 *
 * This script generates a complete MCP server with stdio transport
 * from the Product and Category SMRT objects.
 *
 * Run with: npm run generate:mcp
 */

import { MCPGenerator } from '@smrt/core/generators/mcp';

/**
 * Generate MCP server for products package
 */
async function generateMCPServer() {
  console.log('🤖 Generating MCP Server for @have/products...\n');

  // Create generator instance
  const generator = new MCPGenerator(
    {
      name: 'products-mcp-server',
      version: '1.0.0',
      description: 'MCP server exposing Product and Category SMRT objects',
    },
    {
      // Database and AI context will be configured via environment variables in generated server
      // DATABASE_URL - for database connection
      // OPENAI_API_KEY or ANTHROPIC_API_KEY - for AI client
    }
  );

  // Generate tools to preview what will be available
  const tools = generator.generateTools();
  console.log(`📝 Discovered ${tools.length} tools from SMRT objects:`);
  tools.forEach(tool => {
    console.log(`   - ${tool.name}: ${tool.description}`);
  });
  console.log();

  // Generate complete MCP server with stdio transport
  await generator.generateServer({
    outputPath: 'dist/mcp-server.js',
    serverName: 'products-mcp',
    debug: false, // Set to true for debug logging
    generateClaudeConfigFile: true,
    generateReadme: true,
  });

  console.log('\n✅ MCP Server generation complete!');
  console.log('\n📚 Next steps:');
  console.log('   1. Build the server: npm run build');
  console.log('   2. Add to Claude Desktop config (see dist/claude-config.example.json)');
  console.log('   3. Restart Claude Desktop');
  console.log('   4. Use the tools in Claude Code!\n');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateMCPServer().catch((error) => {
    console.error('❌ MCP server generation failed:', error);
    process.exit(1);
  });
}

export { generateMCPServer };
