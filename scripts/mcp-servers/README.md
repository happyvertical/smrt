# MCP Server Bridge Scripts

Bridge scripts for integrating external services with Claude via Model Context Protocol (MCP).

## Overview

Each bridge script in this directory handles:
- Service discovery and health checks
- Port-forward management with auto-restart
- MCP protocol translation (JSON-RPC over stdio)
- Cleanup and signal handling

## Available Bridges

### shadcn-ui.sh
Provides access to shadcn/ui components and documentation with support for multiple frameworks.

- **Framework Support**: React, Svelte, Vue
- **Default Framework**: Svelte
- **Features**: Component source code, demos, blocks, and metadata
- **Binary**: Uses project dependency `@jpisnice/shadcn-ui-mcp-server` via bunx
- **Health Monitoring**: Automatic restart on failure
- **Nix Compatible**: Uses `/usr/bin/env bash` and checks for bun availability

**Usage**:
```bash
# Direct usage
./scripts/mcp-servers/shadcn-ui.sh
./scripts/mcp-servers/shadcn-ui.sh --framework react
FRAMEWORK=vue ./scripts/mcp-servers/shadcn-ui.sh

# Via Claude configuration (already configured)
# Accessible as "shadcn-ui" MCP server in Claude
```

### playwright.sh
Provides browser automation capabilities via Playwright with isolated mode for multi-repo development.

- **Isolated Mode**: Enabled by default to prevent conflicts between multiple repos
- **Port Management**: Auto-assigns unique ports per project (58000-58999 range)
- **Memory-Only Profiles**: Browser profiles kept in RAM to avoid disk conflicts
- **Health Monitoring**: Automatic restart on failure with configurable attempts
- **Binary**: Uses project dependency `@playwright/mcp` via bunx
- **Nix Compatible**: Uses `/usr/bin/env bash` and checks for bun availability

**Key Features**:
- **Multi-Repo Safety**: Each repo gets unique port based on path hash
- **No State Persistence**: Clean browser state for each session
- **Automatic Cleanup**: Memory profiles cleaned up on exit
- **Port Conflict Resolution**: Automatically finds available port if default is taken

**Usage**:
```bash
# Direct usage (isolated mode enabled by default)
./scripts/mcp-servers/playwright.sh

# Specify custom port
./scripts/mcp-servers/playwright.sh --port 58150

# Disable isolated mode (not recommended for multi-repo)
./scripts/mcp-servers/playwright.sh --no-isolated

# Via environment variables
PLAYWRIGHT_MCP_PORT=58175 ./scripts/mcp-servers/playwright.sh
PLAYWRIGHT_MCP_ISOLATED=false ./scripts/mcp-servers/playwright.sh

# Via Claude configuration (already configured)
# Accessible as "playwright" MCP server in Claude
```

**Multi-Repo Considerations**:
- Each project automatically gets a unique port based on its path
- Isolated mode prevents browser profile conflicts
- No cookies or session data persists between runs
- ~50-100MB additional memory per instance
- Ideal for running multiple development environments simultaneously

## Usage

1. **Create a bridge script** following the template patterns
2. **Add to Claude Desktop configuration**:
   ```json
   {
     "mcpServers": {
       "your-service": {
         "command": "/absolute/path/to/scripts/mcp-servers/your-service.sh",
         "args": [],
         "env": {
           "SERVICE_CONFIG": "/path/to/config"
         }
       }
     }
   }
   ```

3. **Restart Claude Desktop**: The bridge will automatically handle service setup
4. **Use in conversations**: Ask Claude to interact with your external service

## Bridge Script Architecture

Each bridge script follows this pattern:

```bash
#!/usr/bin/env bash
# Bridge: service-name.sh

# Configuration
NAMESPACE="service-namespace"
SERVICE="service-name"
PORT="service-port"
LOCAL_PORT="unique-local-port"

# Core functions:
# - check_prerequisites()    # Verify kubectl access and service availability
# - start_port_forward()     # Background port-forward with retry logic
# - cleanup()               # Graceful shutdown and cleanup
# - handle_mcp_protocol()   # JSON-RPC message processing
# - main()                  # Stdio loop for MCP communication
```

### Key Requirements

- **Never write to stdout** except for MCP JSON-RPC responses
- **Log to stderr or files** for debugging
- **Handle SIGTERM gracefully** for proper cleanup
- **Auto-restart failed connections** to maintain reliability
- **Validate prerequisites** before starting services

## Creating New Bridges

1. **Copy template** from reference implementations
2. **Update configuration** section with service details
3. **Customize service checks** in `check_prerequisites()`
4. **Implement API translation** in `handle_mcp_protocol()`
5. **Test thoroughly** with Claude integration
6. **Document** in this README

## Common Issues

### Port-Forward Failures
- **Symptom**: Bridge starts but Claude can't connect
- **Solution**: Check logs in `/tmp/{service}-mcp.log`
- **Debug**: Run bridge manually to see error messages

### MCP Protocol Errors
- **Symptom**: Claude shows connection errors
- **Solution**: Verify JSON-RPC format in bridge responses
- **Debug**: Enable verbose logging in bridge script

### Service Unavailable
- **Symptom**: Bridge fails to start port-forward
- **Solution**: Check if service exists and is running
- **Debug**: `kubectl get svc -n {namespace}` and pod status

## Advanced Configuration

### Custom Local Ports
Set environment variables to override default ports:
```bash
export SERVICE_LOCAL_PORT=9090
export OTHER_SERVICE_LOCAL_PORT=9091
```

### Debug Mode
Enable verbose logging:
```bash
export MCP_BRIDGE_DEBUG=true
```

### Multiple Service Instances
Use different configurations for multiple environments:
```json
{
  "mcpServers": {
    "service-prod": {
      "command": "/path/to/service.sh",
      "env": {
        "SERVICE_CONFIG": "/path/to/prod-config",
        "SERVICE_LOCAL_PORT": "8090"
      }
    },
    "service-dev": {
      "command": "/path/to/service.sh", 
      "env": {
        "SERVICE_CONFIG": "/path/to/dev-config",
        "SERVICE_LOCAL_PORT": "8091"
      }
    }
  }
}
```

## Security Considerations

- **Local-only access**: Port-forwards bind to localhost only
- **RBAC compliance**: Requires existing kubectl permissions
- **No credential storage**: Uses existing kubeconfig authentication
- **Process isolation**: Each bridge runs in separate process space

## Future Extensions

Potential MCP bridges for common services:
- Database connections (PostgreSQL, SQLite, etc.)
- Message queues (Redis, RabbitMQ)
- File storage (S3, MinIO, filesystem)
- Monitoring systems (Prometheus, Grafana)
- Version control systems (Git, SVN)
- CI/CD platforms (GitHub Actions, GitLab CI)

## Contributing

When adding new bridges:
1. Follow the established pattern
2. Include comprehensive error handling
3. Add documentation to this README
4. Test with multiple cluster configurations
5. Ensure clean shutdown behavior