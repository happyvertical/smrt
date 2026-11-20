// No database-specific SQL outside `engine/db/` (#5186): the engine's own SQL
// is portable, and what differs lives in the dialect modules.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const FORBIDDEN: Array<[string, RegExp]> = [
  ['pragma_ / PRAGMA', /\bpragma_|\bPRAGMA\b/],
  ['sqlite_master', /sqlite_(master|schema|sequence)/],
  ['VACUUM', /\bVACUUM\b/],
  ['typeof()', /\btypeof\(\$\{|\btypeof\([a-z_"]/],
  ['BLOB cast', /AS BLOB/],
  ['rowid', /\browid\b/i],
  ['AUTOINCREMENT', /\bAUTOINCREMENT\b/],
  ['INSERT OR', /\bINSERT OR\b/],
  ['search_path / set_config', /search_path|set_config/],
  [
    'information_schema / pg_',
    /information_schema|\bpg_(namespace|catalog|class)/,
  ],
  ['IS DISTINCT FROM', /IS DISTINCT FROM/],
];

it('engine sources outside engine/db hold no database-specific SQL', () => {
  const hits: string[] = [];
  for (const file of readdirSync(here)) {
    if (!file.endsWith('.ts') || /\.test\.ts$/.test(file)) continue;
    const code = readFileSync(join(here, file), 'utf8')
      // Comments name these on purpose.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const [what, re] of FORBIDDEN)
      if (re.test(code)) hits.push(`${file}: ${what}`);
  }
  expect(hits).toEqual([]);
});
