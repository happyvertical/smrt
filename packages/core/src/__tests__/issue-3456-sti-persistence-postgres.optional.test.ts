import { describe } from 'vitest';
import { runSti3456Persistence } from './issue-3456-sti-persistence.fixture.test.js';

if (process.env.SMRT_TEST_POSTGRES_URL) runSti3456Persistence('postgres');
else describe.skip('PostgreSQL STI subclass persistence (#3456)', () => {});
