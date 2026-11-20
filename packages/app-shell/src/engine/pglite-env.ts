// Test helper: true in the engine suite's PostgreSQL pass (`pnpm test:pglite`).
// A test that needs what only SQLite has (a snapshot file, a draft, `app.db`
// read with `node:sqlite`) is declared `it('...', { skip: onPglite }, ...)`;
// its PostgreSQL counterpart is in `postgres-engine.test.ts`.
export const onPglite = process.env.SMRT_APP_SHELL_DB === 'pglite';
