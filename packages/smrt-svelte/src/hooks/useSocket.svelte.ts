/**
 * Hook to access WebSocket state and methods
 */

import type { SocketStatus } from '../state/app-state.js';
import { getAppStateContext } from '../state/context.js';

/**
 * Access WebSocket state and methods
 *
 * @example
 * ```svelte
 * <script>
 *   import { useSocket } from '@happyvertical/smrt-svelte';
 *
 *   const socket = useSocket();
 *
 *   function sendPing() {
 *     socket.send({ type: 'ping' });
 *   }
 * </script>
 *
 * <p>Status: {socket.status}</p>
 * <p>Connected: {socket.isConnected}</p>
 * <button onclick={sendPing} disabled={!socket.isConnected}>
 *   Ping
 * </button>
 * ```
 */
export function useSocket(): {
  /** Current connection status */
  readonly status: SocketStatus;
  /** Whether the socket is connected */
  readonly isConnected: boolean;
  /** Whether the socket is reconnecting */
  readonly isReconnecting: boolean;
  /** Number of reconnection attempts */
  readonly reconnectAttempts: number;
  /** Last connection error */
  readonly lastError: Event | null;
  /** Send a message through the socket */
  send: (data: unknown) => void;
  /** Manually trigger reconnection */
  reconnect: () => void;
  /** Disconnect from the server */
  disconnect: () => void;
} {
  const app = getAppStateContext();

  return {
    get status() {
      return app.state.socket.status;
    },
    get isConnected() {
      return app.state.socket.status === 'connected';
    },
    get isReconnecting() {
      return app.state.socket.status === 'reconnecting';
    },
    get reconnectAttempts() {
      return app.state.socket.reconnectAttempts;
    },
    get lastError() {
      return app.state.socket.lastError;
    },
    send: (data: unknown) => app.sendMessage(data),
    reconnect: () => {
      const config = app.socketConfig;
      if (config) {
        app.connectSocket(config);
      }
    },
    disconnect: () => app.disconnectSocket(),
  };
}
