#!/usr/bin/env bash

# SMRT Development MCP Server background wrapper.
#
# MCP clients should launch scripts/mcp-servers/smrt-dev-mcp.mjs directly (see
# .mcp.json). This wrapper keeps the start|stop|status|logs surface that the
# packages/*/.claude/setup-mcp.sh scripts use: it runs the same launcher, never
# pnpm exec, and keeps its own messages on stderr.

set -euo pipefail

SERVER_NAME="SMRT Development MCP Server"
SMRT_ROOT="${SMRT_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
LAUNCHER="$SMRT_ROOT/scripts/mcp-servers/smrt-dev-mcp.mjs"
LOG_FILE="${SMRT_DEV_MCP_LOG_FILE:-/tmp/smrt-dev-mcp-server.log}"
PID_FILE="${SMRT_DEV_MCP_PID_FILE:-/tmp/smrt-dev-mcp-server.pid}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >&2
}

error() {
    log "ERROR: $*"
    exit 1
}

running_pid() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid=$(cat "$PID_FILE")
    kill -0 "$pid" 2>/dev/null || return 1
    echo "$pid"
}

stop_server() {
    local pid
    if pid=$(running_pid); then
        log "Stopping $SERVER_NAME (PID: $pid)"
        kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
}

start_server() {
    command -v node >/dev/null 2>&1 || error "node is not installed"
    [[ -f "$LAUNCHER" ]] || error "Launcher not found: $LAUNCHER"
    local existing
    if existing=$(running_pid); then
        error "$SERVER_NAME already running (PID: $existing)"
    fi

    log "Starting $SERVER_NAME..."
    cd "$SMRT_ROOT"
    # The stdio server exits on stdin EOF, so hand it a stdin that never closes.
    node "$LAUNCHER" < <(tail -f /dev/null) >>"$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    sleep 2
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        error "Server failed to start; see $LOG_FILE"
    fi
    log "$SERVER_NAME is running (PID: $pid)"
}

case "${1:-start}" in
    start)
        start_server
        ;;
    stop)
        stop_server
        log "Server stopped"
        ;;
    restart)
        stop_server
        sleep 1
        start_server
        ;;
    status)
        if pid=$(running_pid); then
            log "Server is running (PID: $pid)"
        else
            log "Server is not running"
            exit 1
        fi
        ;;
    logs)
        tail -f "$LOG_FILE"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}" >&2
        exit 1
        ;;
esac
