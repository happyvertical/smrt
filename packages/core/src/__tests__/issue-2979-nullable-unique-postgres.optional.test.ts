/**
 * Registers the #2979 suite with `pnpm test:postgres` (which runs only
 * `*.optional.test.ts`). The suite itself runs on SQLite in the default lane
 * and adds its PostgreSQL cases when `SMRT_TEST_POSTGRES_URL` is set.
 */
import './issue-2979-nullable-unique.test.js';
