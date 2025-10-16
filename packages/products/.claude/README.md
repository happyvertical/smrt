# SMRT Products Project - Claude Integration

This directory contains Claude Desktop configuration for the SMRT Products project.

## Setup

1. **Automatic Setup** (Recommended)
   ```bash
   # Run the auto-setup script
   ./.claude/setup-mcp.sh
   ```
   This will:
   - Auto-detect the HAVE SDK location
   - Generate the correct MCP configuration for your environment
   - Test the MCP server setup

2. **Manual Configuration**
   ```bash
   # View the generated configuration
   cat .claude/mcp-config.json
   # Copy this to your Claude Desktop settings
   ```

3. **Agent Configuration**
   - The `smrt-expert.md` file contains the agent definition for SMRT framework expertise
   - This agent understands microservice architecture and triple-purpose development patterns

## Features Available

- **Product Management Objects**: Product, Category, Inventory, etc.
- **SMRT Framework Tools**: Object generation, validation, API preview
- **Triple-Purpose Development**: NPM package, Module Federation, Standalone app
- **Auto-Generation**: REST APIs, MCP tools, TypeScript clients, UI components

## Usage Examples

### Creating Product Objects
> "Create a Product object with name, price, category, and inventory tracking"

### Microservice Architecture
> "Set up module federation configuration for sharing product components"

### API Generation
> "Generate REST API endpoints and TypeScript client for the Product object"

### Component Development
> "Create Svelte 5 components using runes for product catalog management"

## Environment

- **PROJECT_TYPE**: products
- **SDK_ROOT**: /Users/will/Work/happyvertical/repos/sdk
- **NODE_ENV**: development

## Development Modes

- **Standalone Application**: Complete independent web app
- **Module Federation Provider**: Runtime component sharing
- **NPM Package Library**: Traditional build-time imports