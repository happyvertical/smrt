#!/usr/bin/env bash

# Playwright MCP Server Bridge Script
# This script provides a nix-friendly wrapper for the Playwright MCP server
# with isolated mode enabled for multi-repo development

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$SCRIPT_DIR/playwright-mcp-server.log"
PID_FILE="$SCRIPT_DIR/playwright-mcp-server.pid"
HEALTH_CHECK_INTERVAL=30
MAX_RESTART_ATTEMPTS=3

# Port configuration for multi-repo support
# Use project name hash to generate unique port in range 58000-58999
# Cross-platform compatible hash generation
if command -v md5sum >/dev/null 2>&1; then
    # Linux/NixOS
    PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | md5sum | cut -c1-8)
elif command -v md5 >/dev/null 2>&1; then
    # macOS
    PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | md5 | cut -c1-8)
else
    # Fallback: use a simple hash based on path length and first characters
    PROJECT_HASH=$(printf "%08x" $(($(echo -n "$PROJECT_ROOT" | wc -c) * 31 + $(printf "%d" "'$(echo "$PROJECT_ROOT" | cut -c1)"))))
fi
BASE_PORT=58000
PORT_RANGE=1000
DEFAULT_PORT=$((BASE_PORT + (0x$PROJECT_HASH % PORT_RANGE)))
PORT="${PLAYWRIGHT_MCP_PORT:-$DEFAULT_PORT}"

# Ensure isolated mode for multi-repo safety
ISOLATED_MODE="${PLAYWRIGHT_MCP_ISOLATED:-true}"
NODE_ENV="${NODE_ENV:-production}"

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
    log_info "Shutting down Playwright MCP server..."
    
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

# Port availability check
check_port() {
    local port=$1
    if command -v ss >/dev/null 2>&1; then
        ! ss -tuln | grep -q ":$port "
    elif command -v netstat >/dev/null 2>&1; then
        ! netstat -tuln 2>/dev/null | grep -q ":$port "
    elif command -v lsof >/dev/null 2>&1; then
        ! lsof -i ":$port" >/dev/null 2>&1
    else
        # Assume port is available if we can't check
        return 0
    fi
}

# Find available port
find_available_port() {
    local start_port=$1
    local max_attempts=100
    local port=$start_port
    
    for ((i=0; i<max_attempts; i++)); do
        if check_port "$port"; then
            echo "$port"
            return 0
        fi
        port=$((BASE_PORT + ((port - BASE_PORT + 1) % PORT_RANGE)))
    done
    
    log_error "Could not find available port in range $BASE_PORT-$((BASE_PORT + PORT_RANGE - 1))"
    return 1
}

# Health check function
health_check() {
    local pid=$1
    if ! kill -0 "$pid" 2>/dev/null; then
        return 1
    fi
    
    # Check if server is responding on the expected port
    if command -v curl >/dev/null 2>&1; then
        if ! curl -s -f -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
            log_warn "Server not responding on port $PORT (this may be normal if no health endpoint)"
        fi
    fi
    
    return 0
}

# Start server function
start_server() {
    log_info "Starting Playwright MCP server"
    log_info "Project root: $PROJECT_ROOT"
    log_info "Port: $PORT"
    log_info "Isolated mode: $ISOLATED_MODE"
    log_info "Node environment: $NODE_ENV"
    
    # Check if bunx is available
    if ! command -v bunx >/dev/null 2>&1; then
        log_error "bunx is not available. Please ensure bun is installed."
        log_info "On NixOS, try: nix-shell -p bun"
        exit 1
    fi
    
    # Build command arguments
    local server_args=("--port" "$PORT")
    
    # Add isolated flag if enabled (default)
    if [[ "$ISOLATED_MODE" == "true" ]]; then
        server_args+=("--isolated")
        log_info "Running in isolated mode for multi-repo safety"
    else
        log_warn "Running without isolated mode - may cause conflicts with other repos"
    fi
    
    # Add any additional arguments passed to script
    if [[ $# -gt 0 ]]; then
        server_args+=("$@")
    fi
    
    # Start the server using bunx
    cd "$PROJECT_ROOT"
    log_info "Starting server with arguments: ${server_args[*]}"
    bunx @playwright/mcp "${server_args[@]}" &
    local server_pid=$!
    
    # Save PID
    echo "$server_pid" > "$PID_FILE"
    log_info "Server started with PID $server_pid"
    
    # Give server time to start
    sleep 2
    
    # Verify server started successfully
    if ! kill -0 "$server_pid" 2>/dev/null; then
        log_error "Server failed to start"
        rm -f "$PID_FILE"
        exit 1
    fi
    
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
                bunx @playwright/mcp "${server_args[@]}" &
                server_pid=$!
                echo "$server_pid" > "$PID_FILE"
                log_info "Server restarted with PID $server_pid"
                
                # Give server time to start
                sleep 2
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
            log_error "Server is already running with PID $existing_pid on port $PORT"
            log_info "To stop it, run: kill $existing_pid"
            exit 1
        else
            log_warn "Stale PID file found, removing"
            rm -f "$PID_FILE"
        fi
    fi
    
    # Find available port if default is taken
    if ! check_port "$PORT"; then
        log_warn "Port $PORT is already in use"
        PORT=$(find_available_port "$PORT")
        log_info "Using alternative port: $PORT"
    fi
    
    # Export port for MCP configuration
    export PLAYWRIGHT_MCP_PORT="$PORT"
    
    # Start the server
    start_server "$@"
}

# Help function
show_help() {
    cat << EOF
Playwright MCP Server Bridge Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    -h, --help              Show this help message
    -p, --port PORT         Set server port (default: project-specific in 8100-8199)
    --no-isolated           Disable isolated mode (not recommended for multi-repo)
    --log-file FILE         Set custom log file path
    --pid-file FILE         Set custom PID file path

ENVIRONMENT VARIABLES:
    PLAYWRIGHT_MCP_PORT     Override default port assignment
    PLAYWRIGHT_MCP_ISOLATED Set to "false" to disable isolated mode
    NODE_ENV                Node environment (development|production)
    
EXAMPLES:
    $0                      # Start with isolated mode on auto-assigned port
    $0 --port 58150         # Start on specific port
    $0 --no-isolated        # Start without isolated mode (single repo only)

MULTI-REPO USAGE:
    Each project gets a unique port based on its path hash (58000-58999).
    Isolated mode is enabled by default to prevent browser profile conflicts.
    
    To run multiple repos simultaneously:
    1. Start this script in each repo - ports will be auto-assigned
    2. Each repo's Claude configuration will use its unique port
    3. Browser profiles are kept in memory (isolated mode)

ISOLATED MODE:
    Enabled by default for multi-repo safety. Benefits:
    - Prevents browser profile conflicts between repos
    - Clean browser state for each session
    - No persistent data between sessions
    - Automatic memory cleanup
    
    Trade-offs:
    - No session persistence (cookies, login states)
    - Slightly higher memory usage (~50-100MB per instance)

Logs are written to: $LOG_FILE

This script uses the project's @playwright/mcp package via bunx,
making it compatible with nix and the project's bun setup.
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        --no-isolated)
            ISOLATED_MODE="false"
            shift
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

# Validate port
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1024 ]] || [[ "$PORT" -gt 65535 ]]; then
    log_error "Invalid port: $PORT. Must be between 1024 and 65535"
    exit 1
fi

# Run main function
main "$@"