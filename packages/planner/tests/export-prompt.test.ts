/**
 * The Export page's prompt for a coding agent (`cookbook/prompt.ts`): the
 * cookbook survives the heredoc byte for byte, the delimiter never collides
 * with the body, the CLI version is the installed smrt line, the app name is
 * a safe slug, and the size is the prompt's UTF-8 length.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeCookbook,
  describeLayout,
  describeTheme,
  pageLabel,
  summarizeCookbook,
} from '../src/lib/cookbook/describe.ts';
import {
  exportFileName,
  exportFileSize,
  formatSize,
  slugify,
} from '../src/lib/cookbook/file.ts';
import {
  applyCommand,
  appNameFor,
  buildAgentPrompt,
  COOKBOOK_FILE,
  heredoc,
  heredocBody,
  heredocDelimiter,
} from '../src/lib/cookbook/prompt.ts';
import { COOKBOOK_SCHEMA, type Cookbook } from '../src/lib/cookbook/types.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { SMRT_VERSION } from '../src/lib/smrt-version.ts';

const bakery = getLibraryCookbook('bakery');
if (!bakery) throw new Error('the bakery cookbook is missing');
const cookbook: Cookbook = bakery.document;
const empty: Cookbook = {
  $schema: COOKBOOK_SCHEMA,
  version: 1,
  recipes: [],
  features: [],
  policies: [],
};

const installedVersion = (
  JSON.parse(
    readFileSync(
      new URL(
        '../node_modules/@happyvertical/smrt-core/package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { version: string }
).version;

describe('the agent prompt', () => {
  const prompt = buildAgentPrompt(cookbook, { fallbackName: bakery.name });

  it('carries the cookbook as plain minified JSON that parses back equal', () => {
    const body = heredocBody(prompt.text, COOKBOOK_FILE);
    expect(body).toBeDefined();
    expect(body).toBe(JSON.stringify(cookbook));
    expect(body).not.toContain('\n');
    expect(JSON.parse(body as string)).toEqual(cookbook);
    // Quoted, so the shell expands nothing inside it.
    expect(prompt.text).toContain(
      `cat > ${COOKBOOK_FILE} <<'${prompt.delimiter}'\n`,
    );
    expect(prompt.text).not.toMatch(/base64/i);
  });

  it('names the installed smrt line, not a literal', () => {
    expect(prompt.version).toBe(SMRT_VERSION);
    expect(SMRT_VERSION).toBe(installedVersion);
    const cli = `npx -y @happyvertical/smrt-cli@${installedVersion}`;
    expect(prompt.text).toContain(`${cli} cookbook validate ${COOKBOOK_FILE}`);
    expect(prompt.text).toContain(
      `${cli} cookbook apply ${COOKBOOK_FILE} ${prompt.appName}`,
    );
    expect(prompt.text).toContain(
      `${cli} cookbook apply ${COOKBOOK_FILE} --into ${prompt.appName}`,
    );
  });

  it('walks the released CLI: prerequisites, write, validate, apply, install, doctor', () => {
    const order = [
      'Create a new s-m-r-t app from the cookbook below',
      'report what you ran',
      '1. Prerequisites: Node 26 or newer',
      'pnpm 11',
      `2. Write the cookbook`,
      `cat > ${COOKBOOK_FILE} <<'`,
      `3. Validate it`,
      'cookbook validate',
      'cookbook apply',
      '4. Set it up',
      `cd ${prompt.appName} && pnpm exec smrt app install`,
      'pnpm exec smrt app doctor',
      'Do not hand-edit',
    ];
    let at = 0;
    for (const piece of order) {
      const next = prompt.text.indexOf(piece, at);
      expect(next, piece).toBeGreaterThanOrEqual(at);
      at = next;
    }
    expect(prompt.text).toContain('git');
    expect(prompt.text).not.toMatch(/^5\. /m);
  });

  it('needs no registry override: no .npmrc, no registry, no mirror caveat', () => {
    // Every @happyvertical package is on npmjs at the released version, and
    // the app the CLI makes ships its own .npmrc.
    expect(prompt.text).not.toContain('.npmrc');
    expect(prompt.text).not.toMatch(/registry|mirror|npm\.happyvertical/i);
    // Nor does it ever tell anyone to turn pnpm's release-age check off.
    expect(prompt.text).not.toMatch(/minimum-?release-?age/i);
  });

  it('names the app after the cookbook, then the library cookbook, then my-app', () => {
    expect(prompt.appName).toBe('bakery');
    expect(appNameFor({ ...cookbook, name: "Grandma's Bakery!" })).toBe(
      'grandma-s-bakery',
    );
    expect(appNameFor({ ...cookbook, name: 'Pâtisserie Été' }, 'x')).toBe(
      'patisserie-ete',
    );
    expect(appNameFor(cookbook)).toBe('my-app');
    expect(appNameFor({ ...cookbook, name: '!!!' }, '???')).toBe('my-app');
    expect(buildAgentPrompt(empty).appName).toBe('my-app');
  });

  it('reports its size in UTF-8 bytes', () => {
    expect(prompt.bytes).toBe(new TextEncoder().encode(prompt.text).length);
    expect(prompt.bytes).toBeGreaterThan(JSON.stringify(cookbook).length);
    const accented = buildAgentPrompt({ ...cookbook, name: 'Été' });
    expect(accented.bytes).toBeGreaterThan(accented.text.length);
    expect(formatSize(prompt.bytes)).toMatch(/^\d+(\.\d)? KB$/);
    expect(formatSize(640)).toBe('640 bytes');
    expect(formatSize(3653)).toBe('3.6 KB');
    expect(formatSize(20480)).toBe('20 KB');
  });

  it('picks a delimiter no line of the body equals', () => {
    expect(heredocDelimiter('{"a":1}')).toBe('COOKBOOK_EOF');
    const colliding =
      '{\nCOOKBOOK_EOF\n"x": "COOKBOOK_EOF_1"\nCOOKBOOK_EOF_1\n}';
    expect(heredocDelimiter(colliding)).toBe('COOKBOOK_EOF_2');
    const block = heredoc('cookbook.json', colliding);
    expect(block.startsWith("cat > cookbook.json <<'COOKBOOK_EOF_2'\n")).toBe(
      true,
    );
    expect(block.endsWith('\nCOOKBOOK_EOF_2')).toBe(true);
    expect(heredocBody(block, 'cookbook.json')).toBe(colliding);
    // A name that would put the delimiter on the one JSON line changes nothing:
    // minified JSON is a single line starting with `{`.
    const named = buildAgentPrompt({ ...cookbook, name: 'COOKBOOK_EOF' });
    expect(named.delimiter).toBe('COOKBOOK_EOF');
    expect(
      JSON.parse(heredocBody(named.text, COOKBOOK_FILE) as string),
    ).toEqual({ ...cookbook, name: 'COOKBOOK_EOF' });
  });

  it('gives the downloaded file its one command', () => {
    expect(slugify('Grandma’s  Bakery')).toBe('grandma-s-bakery');
    expect(exportFileName('Bakery')).toBe('bakery.cookbook.json');
    expect(applyCommand('bakery.cookbook.json', 'bakery')).toBe(
      `npx -y @happyvertical/smrt-cli@${installedVersion} cookbook apply bakery.cookbook.json bakery`,
    );
    expect(exportFileSize(cookbook)).toBe(
      new TextEncoder().encode(`${JSON.stringify(cookbook, null, 2)}\n`).length,
    );
  });
});

describe('the cookbook summary', () => {
  it('has one line per dimension with content, in order', () => {
    const lines = describeCookbook(cookbook);
    expect(lines.map((line) => line.id)).toEqual([
      'recipes',
      'features',
      'options',
      'theme',
      'layout',
    ]);
    const recipes = lines[0];
    expect(recipes.label).toBe(`${cookbook.recipes.length} recipes`);
    expect(recipes.chips).toHaveLength(cookbook.recipes.length);
    expect(recipes.chips?.every((chip) => !chip.includes('.'))).toBe(true);
    expect(lines[1]).toMatchObject({
      label: '1 feature',
      chips: ['Production order'],
    });
    expect(lines[2].chips?.[0]).toMatch(/^Customer: payment terms/);
    expect(lines[3].text).toBe('brand colour #b45309, Georgia font');
    expect(lines[4].text).toMatch(/^4 custom sections \(Shop, Wholesale/);
    expect(lines[4].text).toContain('2 hidden');
    expect(lines[4].text).toContain('reordered');
  });

  it('is empty for an empty cookbook, with a matching sentence', () => {
    expect(describeCookbook(empty)).toEqual([]);
    expect(summarizeCookbook(empty)).toBe('an empty cookbook');
    expect(summarizeCookbook(cookbook)).toBe(
      `${cookbook.recipes.length} recipes, 1 feature, ${cookbook.policies.length} saved options, a theme and a layout`,
    );
  });

  it('describes features, pages, narrowed surfaces and theme choices', () => {
    const lines = describeCookbook({
      ...empty,
      features: ['@happyvertical/smrt-inventory:StockLevel'],
      exposure: { '@happyvertical/smrt-commerce:Order': ['api'] },
      theme: {
        preset: 'studio',
        colorScheme: 'dark',
        borderRadius: 'lg',
        density: 'touch',
        contrast: 'more',
        customCss: '.x{}',
      },
      layout: {
        version: 1,
        customSections: [{ id: 'custom:shop', label: 'Shop' }],
        items: { 'item:commerce:Order': { label: 'Tickets' } },
        moved: { 'item:commerce:Order': 'custom:shop' },
      },
      overviews: {
        'section:sales': { version: 1 } as never,
        'custom:shop': { version: 1 } as never,
        'detail:happyvertical.smrt-commerce.Customer': { version: 1 } as never,
        'section:more': { version: 1 } as never,
      },
    });
    expect(lines.map((line) => line.id)).toEqual([
      'features',
      'exposure',
      'theme',
      'layout',
      'pages',
    ]);
    expect(lines[0].chips).toEqual(['Stock level']);
    expect(lines[1].chips).toEqual(['Order: api']);
    expect(lines[2].text).toBe(
      'Studio preset, dark scheme, lg corners, touch density, more contrast, custom CSS',
    );
    expect(lines[3].text).toBe(
      '1 custom section (Shop), 1 renamed or restyled, 1 moved',
    );
    expect(lines[4].chips).toEqual([
      'Sales',
      'Shop',
      'Customer record',
      'More',
    ]);
    expect(pageLabel('whatever')).toBe('Whatever');
    expect(describeTheme({ preset: 'glass' })).toEqual([]);
    expect(describeLayout({ version: 1 })).toEqual([]);
  });
});
