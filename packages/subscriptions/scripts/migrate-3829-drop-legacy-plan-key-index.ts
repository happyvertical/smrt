#!/usr/bin/env node

/** Remove the pre-#3829 global subscription-plan key index after manifest migration. */
import { getDatabase } from '@happyvertical/sql';

import { dropLegacyPlanKeyIndex } from './plan-key.ts';

function typeFor(input: string): 'postgres' | 'duckdb' | 'sqlite' {
  if (/^postgres(?:ql)?:/i.test(input)) return 'postgres';
  if (/^duckdb:/i.test(input) || /\.duckdb($|\?)/i.test(input)) return 'duckdb';
  return 'sqlite';
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url)
    throw new Error(
      'Usage: migrate-3829-drop-legacy-plan-key-index.ts <database-url>',
    );
  const type = typeFor(url);
  if (type === 'duckdb') {
    throw new Error(
      'DuckDB stores the legacy UNIQUE(plan_key) as an inline constraint. Rebuild _smrt_subscription_plans in a reviewed transaction with UNIQUE(tenant_id, plan_key).',
    );
  }
  const db = await getDatabase({ type, url });
  try {
    await dropLegacyPlanKeyIndex(db);
  } finally {
    await db.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
