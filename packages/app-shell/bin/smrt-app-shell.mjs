#!/usr/bin/env node
// Start the published server build (#5494): the SvelteKit adapter-node output
// in `build/`, whose `index.js` raises BODY_SIZE_LIMIT before the handler loads
// and starts listening (PORT, HOST, SOCKET_PATH, SHUTDOWN_TIMEOUT: adapter-node).
// The app reads its profile and storage from the environment (agents/deploy.md).
// SIGTERM/SIGINT drain the shell and exit (src/lib/server/shutdown.ts).
//
// `smrt-app-shell migrate-to-postgres --tenant <id> --user <id>` runs that one
// operator command instead and exits (build/operator.js, #5193).
const commands = new Set(['migrate-to-postgres']);
if (commands.has(process.argv[2])) await import('../build/operator.js');
else await import('../build/index.js');
