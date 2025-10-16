# SMRT Content Project - Claude Integration

This directory contains Claude Desktop configuration for the SMRT Content project.

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
   - This agent understands content processing patterns and SMRT object development

## Features Available

- **Content Processing Objects**: Document, Article, Media, etc.
- **SMRT Framework Tools**: Object generation, validation, API preview
- **AI Integration**: Content analysis, quality assessment, SEO optimization
- **Collection Management**: Content collections with search and filtering

## Usage Examples

### Creating Content Objects
> "Create a BlogPost object with title, content, author, tags, and publication status"

### Content Analysis
> "Add AI methods to analyze content quality and SEO potential"

### Collection Operations
> "Generate a collection for managing blog posts with search and filtering"

## Environment

- **PROJECT_TYPE**: content
- **SDK_ROOT**: /Users/will/Work/happyvertical/repos/sdk
- **NODE_ENV**: development