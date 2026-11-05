/**
 * Pure parser for the developer-intent index (`intents/index.md`).
 *
 * The index is one markdown table whose last column lists `;`-separated
 * backticked signal tokens (`import:node-cron`, `call:setInterval`,
 * `regex:...`). The duplicate-detection pass is driven entirely by these rows,
 * so a new row with signals needs no code change (#4690).
 */

export interface IntentSignal {
  /** Token kind: the text before the first colon (`import`, `call`, ...). */
  kind: string;
  /** Token value: everything after the first colon. */
  value: string;
  /** The token exactly as written in the table. */
  raw: string;
}

export interface IntentHomePackage {
  /** Unscoped package name, e.g. `smrt-jobs`. */
  name: string;
  /** Published npm name, e.g. `@happyvertical/smrt-jobs`. */
  packageName: string;
  /** Component page concept ID, e.g. `/components/smrt-jobs.md`. */
  componentPage: string;
}

export interface IntentRow {
  intent: string;
  /** Intent page concept ID, e.g. `/intents/scheduled-runs.md`. */
  intentPage: string;
  homePackages: IntentHomePackage[];
  entryPoint: string;
  signals: IntentSignal[];
}

const PACKAGE_SCOPE = '@happyvertical/';

/** Split a table row on unescaped pipes, unescaping `\|` inside cells. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\' && line[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  // A leading and trailing pipe produce empty edge cells.
  if (cells[0]?.trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

function linkTargets(cell: string): { text: string; href: string }[] {
  return Array.from(cell.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)).map(
    (match) => ({ text: match[1], href: match[2] }),
  );
}

/** `/intents/x.md`, `./x.md` or `x.md` -> `/<kind>/x.md`. */
function conceptId(href: string, kind: 'intents' | 'components'): string {
  const base = href.split('#')[0].split('/').pop() ?? href;
  return `/${kind}/${base}`;
}

function parseSignals(cell: string): IntentSignal[] {
  const signals: IntentSignal[] = [];
  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const raw = match[1].trim();
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      signals.push({ kind: '', value: raw, raw });
      continue;
    }
    signals.push({
      kind: raw.slice(0, colon).trim(),
      value: raw.slice(colon + 1),
      raw,
    });
  }
  return signals;
}

/**
 * Parse the first intent table found in `markdown`. Columns are located by
 * header name (`Intent`, `Page`, `Home package(s)`, `Entry point`,
 * `Hand-rolled signals`) so column order may change. Rows without a page link
 * are ignored.
 */
export function parseIntentIndex(markdown: string): IntentRow[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex(
    (line) => /^\s*\|/.test(line) && /\bintent\b/i.test(line),
  );
  if (headerIndex < 0) return [];

  const headers = splitRow(lines[headerIndex]).map((cell) =>
    cell.toLowerCase(),
  );
  const column = (needle: string, fallback: number): number => {
    const found = headers.findIndex((header) => header.includes(needle));
    return found >= 0 ? found : fallback;
  };
  const columns = {
    intent: column('intent', 0),
    page: column('page', 1),
    home: column('home', 2),
    entry: column('entry', 3),
    signals: column('signal', 4),
  };

  const rows: IntentRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\s*\|/.test(line)) {
      if (rows.length > 0 || line.trim() !== '') break;
      continue;
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // delimiter row
    const cells = splitRow(line);
    const pageLink = linkTargets(cells[columns.page] ?? '')[0];
    if (!pageLink) continue;
    const homePackages = linkTargets(cells[columns.home] ?? '').map((link) => {
      const componentPage = conceptId(link.href, 'components');
      const name = componentPage
        .replace(/^\/components\//, '')
        .replace(/\.md$/, '');
      return { name, packageName: `${PACKAGE_SCOPE}${name}`, componentPage };
    });
    rows.push({
      intent: cells[columns.intent] ?? '',
      intentPage: conceptId(pageLink.href, 'intents'),
      homePackages,
      entryPoint: cells[columns.entry] ?? '',
      signals: parseSignals(cells[columns.signals] ?? ''),
    });
  }
  return rows;
}
