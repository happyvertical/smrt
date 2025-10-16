#!/usr/bin/env bash

# SMRT Content Project - MCP Setup Script
# This script auto-detects the HAVE SDK location and sets up the MCP server

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$PROJECT_ROOT/.claude"

# Function to find SDK root
find_sdk_root() {
    local current_dir="$PROJECT_ROOT"

    # Check if we're inside the SDK repo
    while [[ "$current_dir" != "/" ]]; do
        if [[ -f "$current_dir/package.json" ]] && grep -q "@have/sdk" "$current_dir/package.json" 2>/dev/null; then
            echo "$current_dir"
            return 0
        fi
        current_dir="$(dirname "$current_dir")"
    done

    # Check node_modules
    if [[ -d "$PROJECT_ROOT/node_modules/@have/sdk" ]]; then
        echo "$PROJECT_ROOT/node_modules/@have/sdk"
        return 0
    fi

    # Check parent directories for node_modules
    current_dir="$PROJECT_ROOT"
    while [[ "$current_dir" != "/" ]]; do
        if [[ -d "$current_dir/node_modules/@have/sdk" ]]; then
            echo "$current_dir/node_modules/@have/sdk"
            return 0
        fi
        current_dir="$(dirname "$current_dir")"
    done

    echo "ERROR: HAVE SDK not found. Please install with: npm install @have/sdk" >&2
    return 1
}

# Function to create portable MCP config
create_mcp_config() {
    local sdk_root="$1"
    local config_file="$CLAUDE_DIR/mcp-config.json"

    cat > "$config_file" << EOF
{
  "mcpServers": {
    "smrt-dev-server": {
      "command": "$sdk_root/scripts/mcp-servers/smrt-dev-server.sh",
      "args": [],
      "env": {
        "NODE_ENV": "development",
        "PROJECT_TYPE": "content",
        "SDK_ROOT": "$sdk_root"
      }
    }
  }
}
EOF

    echo "Created MCP config at: $config_file"
}

# Main execution
main() {
    echo "Setting up MCP server for SMRT Content project..."

    SDK_ROOT=$(find_sdk_root)
    if [[ $? -ne 0 ]]; then
        exit 1
    fi

    echo "Found HAVE SDK at: $SDK_ROOT"

    # Ensure .claude directory exists
    mkdir -p "$CLAUDE_DIR"

    # Create MCP configuration
    create_mcp_config "$SDK_ROOT"

    # Test the MCP server build
    echo "Testing MCP server setup..."
    if [[ -x "$SDK_ROOT/scripts/mcp-servers/smrt-dev-server.sh" ]]; then
        SDK_ROOT="$SDK_ROOT" "$SDK_ROOT/scripts/mcp-servers/smrt-dev-server.sh" status || true
        echo "MCP server setup completed successfully!"
        echo ""
        echo "Next steps:"
        echo "1. Copy the contents of $CLAUDE_DIR/mcp-config.json to your Claude Desktop settings"
        echo "2. Restart Claude Desktop"
        echo "3. The SMRT development tools will be available for this project"
    else
        echo "ERROR: MCP server script not found at: $SDK_ROOT/scripts/mcp-servers/smrt-dev-server.sh"
        exit 1
    fi
}

main "$@"