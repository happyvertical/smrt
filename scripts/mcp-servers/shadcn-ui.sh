#!/usr/bin/env bash

# shadcn-ui MCP Server Bridge Script
# This script provides a nix-friendly wrapper for the shadcn-ui MCP server
# with proper health monitoring and cleanup functionality

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$SCRIPT_DIR/shadcn-ui-mcp-server.log"
PID_FILE="$SCRIPT_DIR/shadcn-ui-mcp-server.pid"
HEALTH_CHECK_INTERVAL=30
MAX_RESTART_ATTEMPTS=3

# Ensure required environment
export FRAMEWORK="${FRAMEWORK:-svelte}"
export NODE_ENV="${NODE_ENV:-production}"

# Logging functions
log_info() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $*" | tee -a "$LOG_FILE"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG_FILE" >&2
}

log_warn() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $*" | tee -a "$LOG_FILE"
}

# Cleanup function
cleanup() {
    local exit_code=$?
    log_info "Shutting down shadcn-ui MCP server..."
    
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            log_info "Terminating server process $pid"
            kill -TERM "$pid" 2>/dev/null || true
            
            # Wait for graceful shutdown
            local count=0
            while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
                sleep 1
                ((count++))
            done
            
            # Force kill if still running
            if kill -0 "$pid" 2>/dev/null; then
                log_warn "Force killing server process $pid"
                kill -KILL "$pid" 2>/dev/null || true
            fi
        fi
        rm -f "$PID_FILE"
    fi
    
    log_info "Cleanup completed"
    exit $exit_code
}

# Set up signal handlers
trap cleanup EXIT INT TERM

# Health check function
health_check() {
    local pid=$1
    if ! kill -0 "$pid" 2>/dev/null; then
        return 1
    fi
    
    # Additional health checks can be added here
    # For now, just check if process is running
    return 0
}

# Start server function
start_server() {
    log_info "Starting shadcn-ui MCP server from project dependency"
    log_info "Framework: $FRAMEWORK"
    log_info "Node environment: $NODE_ENV"
    log_info "Project root: $PROJECT_ROOT"
    
    # Check if bunx is available
    if ! command -v bunx >/dev/null 2>&1; then
        log_error "bunx is not available. Please ensure bun is installed."
        log_info "On NixOS, try: nix-shell -p bun"
        exit 1
    fi
    
    # Start the server using bunx
    cd "$PROJECT_ROOT"
    bunx shadcn-mcp --framework "$FRAMEWORK" "$@" &
    local server_pid=$!
    
    # Save PID
    echo "$server_pid" > "$PID_FILE"
    log_info "Server started with PID $server_pid"
    
    # Monitor server health
    local restart_count=0
    while true; do
        sleep "$HEALTH_CHECK_INTERVAL"
        
        if ! health_check "$server_pid"; then
            log_error "Server process died (PID: $server_pid)"
            
            if [[ $restart_count -lt $MAX_RESTART_ATTEMPTS ]]; then
                ((restart_count++))
                log_info "Attempting restart ($restart_count/$MAX_RESTART_ATTEMPTS)"
                
                # Start new server
                bunx shadcn-mcp --framework "$FRAMEWORK" "$@" &
                server_pid=$!
                echo "$server_pid" > "$PID_FILE"
                log_info "Server restarted with PID $server_pid"
            else
                log_error "Maximum restart attempts ($MAX_RESTART_ATTEMPTS) exceeded"
                exit 1
            fi
        else
            log_info "Server health check passed (PID: $server_pid)"
        fi
    done
}

# Main execution
main() {
    # Check if bun is available
    if ! command -v bun >/dev/null 2>&1; then
        log_error "Bun is not installed or not in PATH"
        log_info "On NixOS, try: nix-shell -p bun"
        exit 1
    fi
    
    # Create log file if it doesn't exist
    touch "$LOG_FILE"
    
    # Check if server is already running
    if [[ -f "$PID_FILE" ]]; then
        local existing_pid
        existing_pid=$(cat "$PID_FILE")
        if kill -0 "$existing_pid" 2>/dev/null; then
            log_error "Server is already running with PID $existing_pid"
            exit 1
        else
            log_warn "Stale PID file found, removing"
            rm -f "$PID_FILE"
        fi
    fi
    
    # Start the server
    start_server "$@"
}

# Help function
show_help() {
    cat << EOF
shadcn-ui MCP Server Bridge Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    -h, --help              Show this help message
    -f, --framework FRAME   Set framework (react|svelte|vue, default: svelte)
    --log-file FILE         Set custom log file path
    --pid-file FILE         Set custom PID file path

ENVIRONMENT VARIABLES:
    FRAMEWORK              Framework to use (react|svelte|vue)
    NODE_ENV               Node environment (development|production)
    
EXAMPLES:
    $0                      # Start with Svelte framework (default)
    $0 --framework react    # Start with React framework
    FRAMEWORK=vue $0        # Start with Vue framework via environment

The server will run with health monitoring and automatic restart capabilities.
Logs are written to: $LOG_FILE

This script uses the project's installed @jpisnice/shadcn-ui-mcp-server package
via bunx, making it compatible with nix and the project's bun setup.
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -f|--framework)
            export FRAMEWORK="$2"
            shift 2
            ;;
        --log-file)
            LOG_FILE="$2"
            shift 2
            ;;
        --pid-file)
            PID_FILE="$2"
            shift 2
            ;;
        *)
            # Pass unknown arguments to the server
            break
            ;;
    esac
done

# Validate framework
case "${FRAMEWORK:-svelte}" in
    react|svelte|vue)
        ;;
    *)
        log_error "Invalid framework: $FRAMEWORK. Must be one of: react, svelte, vue"
        exit 1
        ;;
esac

# Run main function
main "$@"