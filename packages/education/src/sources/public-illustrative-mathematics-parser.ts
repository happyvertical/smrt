/** Strict first-edition hierarchy and public artifact parsing; never executes HTML. */
export const IM_ORIGIN = 'https://im.kendallhunt.com';
export const IM_ASSET_ORIGIN = 'https://cms-assets.illustrativemathematics.org';
export const IM_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';
export const IM_ROOTS = [
  '/k5/curriculum.html',
  '/MS/index.html',
  '/HS/index.html',
];

export function imText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
export interface ImPageIdentity {
  path: string;
  band: string;
  course?: string;
  unit?: string;
  lesson?: string;
  audience?: string;
  leaf: string;
}
/** Canonical paths contain no escapes, queries, credentials, or arbitrary filenames. */
export function imPagePath(value: string): ImPageIdentity {
  if (value === '/') return { path: '/', band: '', leaf: '' };
  if (IM_ROOTS.includes(value))
    return { path: value, band: value.split('/')[1], leaf: 'root' };
  const k =
    /^\/(k5(?:_es)?)\/(teachers|families)\/(kindergarten|grade-[1-5])(?:\/unit-([1-9][0-9]?))?(?:\/lesson-([1-9][0-9]?))?\/(units|lessons|resources|preparation|family-materials)\.html$/i.exec(
      value,
    );
  const m =
    /^\/(MS(?:_ES)?|HS(?:_ES)?)\/(teachers|families)\/([1-4])(?:\/([1-9][0-9]?))?(?:\/([1-9][0-9]?))?\/(index|resources|preparation)\.html$/i.exec(
      value,
    );
  const x = k ?? m;
  if (!x) throw new Error('Unsupported first-edition hierarchy path.');
  const [, rawBand, audience, course, unit, lesson, leaf] = x;
  const band = rawBand.toLowerCase().startsWith('k5')
    ? rawBand.toLowerCase()
    : rawBand.toUpperCase();
  const isK = band.startsWith('k5');
  if (
    (band.startsWith('MS') && course === '4') ||
    (lesson && (!unit || audience !== 'teachers' || leaf !== 'preparation')) ||
    (!lesson && leaf === 'preparation') ||
    (isK && !unit && !['units', 'resources'].includes(leaf)) ||
    (isK &&
      unit &&
      !lesson &&
      !['lessons', 'resources', 'family-materials'].includes(leaf)) ||
    (!isK && !lesson && !['index', 'resources'].includes(leaf))
  )
    throw new Error('Inconsistent first-edition hierarchy.');
  const path = `/${band}/${audience}/${course}${unit ? `/${isK ? 'unit-' : ''}${unit}` : ''}${lesson ? `/${isK ? 'lesson-' : ''}${lesson}` : ''}/${leaf}.html`;
  return { path, band, audience, course, unit, lesson, leaf };
}
export function imAssetId(url: URL): string | undefined {
  return url.origin === IM_ASSET_ORIGIN &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    /^\/[a-zA-Z0-9]{20,64}$/.test(url.pathname)
    ? url.pathname.slice(1)
    : undefined;
}
export function imStableId(path: string, assetId?: string): string {
  return `im-first-edition:${path}${assetId ? `#${assetId}` : ''}`;
}
export function imHierarchyTitle(page: ImPageIdentity): string {
  const course = page.band.startsWith('k5')
    ? `Grade ${page.course === 'kindergarten' ? 'K' : page.course?.slice(6)}`
    : page.band.startsWith('MS')
      ? `Grade ${Number(page.course) + 5}`
      : ['', 'Algebra 1', 'Geometry', 'Algebra 2', 'Algebra 1 Supports'][
          Number(page.course)
        ];
  return `IM ${page.band} ${course ?? ''}${page.unit ? ` Unit ${page.unit}` : ''}${page.lesson ? ` Lesson ${page.lesson}` : ''}`.trim();
}
export interface ImArtifact {
  id: string;
  label: string;
  allowed: boolean;
}
export interface ImParsedPage {
  children: string[];
  artifacts: ImArtifact[];
  exclusions: { code: string; message: string }[];
  attribution: string;
  notices: string;
  licensed: boolean;
  title: string;
}
interface RoleContainer {
  tag: string;
  parent?: RoleContainer;
  contentStart: number;
  resource: boolean;
  closed: boolean;
  malformed: boolean;
  headings: { tag: string; text: string }[];
  descendantHeadingCount: number;
  cells: string[];
}

/** A '<' is legal inside a tag only in a closed, quoted attribute value. */
function malformedTagToken(token: string): boolean {
  const prefix = /^<\/?[a-zA-Z][\w:-]*/.exec(token);
  if (!prefix) return true;
  const end = token.length - 1;
  let index = prefix[0].length;
  while (index < end) {
    while (index < end && /\s/.test(token[index])) index++;
    if (index === end || (index === end - 1 && token[index] === '/'))
      return false;
    const nameStart = index;
    while (index < end && !/[\s"'<>/=]/.test(token[index])) index++;
    if (index === nameStart) return true;
    while (index < end && /\s/.test(token[index])) index++;
    if (token[index] !== '=') continue;
    index++;
    while (index < end && /\s/.test(token[index])) index++;
    const quote = token[index];
    if (quote === '"' || quote === "'") {
      const close = token.indexOf(quote, index + 1);
      if (close < 0 || close >= end) return true;
      index = close + 1;
    } else {
      const valueStart = index;
      while (index < end && !/\s/.test(token[index])) {
        if (/["'`=<>]/.test(token[index])) return true;
        index++;
      }
      if (index === valueStart) return true;
    }
  }
  return false;
}

/** Bind each link to its own source row/block; headings never cross containers. */
function localArtifactLabels(html: string): Map<number, string> {
  const stack: RoleContainer[] = [];
  const links: {
    start: number;
    owner?: RoleContainer;
    kind?: 'row' | 'resource';
  }[] = [];
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  const tokens =
    /<\/?([a-zA-Z][\w:-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  const invalidateOwners = () => {
    for (const owner of stack)
      if (owner.resource || owner.tag === 'tr') owner.malformed = true;
  };
  let tokenCount = 0;
  let consumedEnd = 0;
  for (const token of html.matchAll(tokens)) {
    if (++tokenCount > 50_000 || stack.length > 256)
      throw new Error('First-edition role structure exceeds parser bounds.');
    // Unconsumed markup starts are malformed descendants too (e.g. a tag
    // truncated before its '>' and then followed by an ancestor close).
    if (/<[/!]?[a-zA-Z]/.test(html.slice(consumedEnd, token.index)))
      invalidateOwners();
    consumedEnd = token.index + token[0].length;
    const malformed = malformedTagToken(token[0]);
    if (malformed) invalidateOwners();
    const tag = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index < 0) {
        invalidateOwners();
        continue;
      }
      const node = stack[index];
      if (index !== stack.length - 1) {
        invalidateOwners();
        node.malformed = true;
        for (const dangling of stack.slice(index + 1))
          dangling.malformed = true;
      }
      node.closed = true;
      if (/^h[1-6]$/.test(tag)) {
        const content = imText(html.slice(node.contentStart, token.index));
        if (!node.malformed && node.parent?.resource)
          node.parent.headings.push({ tag, text: content });
        const row = stack
          .slice(0, index)
          .findLast((ancestor) => ancestor.tag === 'tr');
        if (row) row.headings.push({ tag, text: content });
      }
      if (tag === 'td' && node.parent?.tag === 'tr')
        node.parent.cells.push(
          imText(html.slice(node.contentStart, token.index)),
        );
      stack.length = index;
      continue;
    }
    // Register headings at OPEN: malformed close recovery must not erase them.
    if (/^h[1-6]$/.test(tag)) {
      for (const owner of stack)
        if (owner.resource || owner.tag === 'tr')
          owner.descendantHeadingCount++;
    }
    const parent = stack.at(-1);
    if (tag === 'a') {
      if (
        parent?.tag === 'td' &&
        parent.parent?.tag === 'tr' &&
        parent.parent.cells.length > 0
      )
        links.push({ start: token.index, owner: parent.parent, kind: 'row' });
      else
        links.push({
          start: token.index,
          owner: parent?.resource ? parent : undefined,
          kind: 'resource',
        });
    }
    if (voidTags.has(tag) || token[0].endsWith('/>')) continue;
    const className =
      /\sclass\s*=\s*["']([^"']*)["']/i.exec(token[0])?.[1] ?? '';
    stack.push({
      tag,
      parent,
      contentStart: token.index + token[0].length,
      resource:
        tag === 'div' &&
        className.split(/\s+/).includes('im-c-row__flex-resource'),
      closed: false,
      malformed,
      headings: [],
      descendantHeadingCount: 0,
      cells: [],
    });
  }
  // Open owners or their descendants at EOF are never a complete source boundary.
  invalidateOwners();
  const labels = new Map<number, string>();
  for (const link of links) {
    const owner = link.owner;
    if (!owner?.closed || owner.malformed) continue;
    if (link.kind === 'row') {
      if (owner.descendantHeadingCount === 0 && owner.headings.length === 0)
        labels.set(link.start, owner.cells[0] ?? '');
    } else if (
      owner.descendantHeadingCount === 1 &&
      owner.headings.length === 1 &&
      /^h[34]$/.test(owner.headings[0].tag)
    )
      labels.set(link.start, owner.headings[0].text);
  }
  return labels;
}

export function parseImFirstEditionPage(
  rawHtml: string,
  path: string,
): ImParsedPage {
  const page = imPagePath(path);
  const html = rawHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/i.exec(html)?.[1] ?? '';
  const licensed =
    /href=["']https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/["']/i.test(
      footer,
    ) &&
    /Illustrative Mathematics/i.test(imText(footer)) &&
    !/licenses\/(?:by-nc|by-sa|by-nd)|all rights reserved/i.test(footer);
  const paragraphs = [...footer.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(
    (x) => imText(x[1]),
  );
  const attribution = paragraphs
    .filter((s) => /copyright|©|licensed under/i.test(s))
    .join('\n');
  const notices = paragraphs
    .filter((s) => /name and logo|respective|attribution/i.test(s))
    .join('\n');
  const children = new Set<string>();
  const exclusions: ImParsedPage['exclusions'] = [];
  const artifacts = new Map<string, ImArtifact>();
  const localLabels = localArtifactLabels(html);
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  if (anchors.length > 4000)
    throw new Error('First-edition page has too many links.');
  for (const anchor of anchors) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(anchor[1])?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), IM_ORIGIN + path);
    } catch {
      exclusions.push({
        code: 'invalid_link',
        message: 'Malformed source link.',
      });
      continue;
    }
    if (/oauth_im\/login/.test(url.pathname)) {
      exclusions.push({
        code: 'login_required',
        message: imText(anchor[2]) || 'Login-gated material.',
      });
      continue;
    }
    if (
      url.hostname === 'accessim.org' ||
      url.hostname.endsWith('.accessim.org')
    ) {
      exclusions.push({
        code: 'different_edition',
        message: 'AccessIM/v.360 is outside the first edition.',
      });
      continue;
    }
    if (url.origin === IM_ASSET_ORIGIN) {
      const id = imAssetId(url);
      if (!id) {
        exclusions.push({
          code: 'invalid_asset_path',
          message: 'Unsupported official asset path.',
        });
        continue;
      }
      if (!/im-c-filetype--pdf|>\s*pdf\s*</i.test(anchor[0])) {
        exclusions.push({
          code: 'unsupported_format',
          message: `Non-PDF artifact ${id}.`,
        });
        continue;
      }
      const label = localLabels.get(anchor.index) ?? '';
      const allowed =
        /^(Student Task Statements|Student Handouts|Cumulative Practice Problems|Family Support Materials|Family Materials|Learning Targets|Student Task Statement Cover Page)$/i.test(
          label,
        );
      const prior = artifacts.get(id);
      artifacts.set(id, {
        id,
        label,
        allowed:
          allowed && (!prior || (prior.allowed && prior.label === label)),
      });
      continue;
    }
    if (
      url.origin !== IM_ORIGIN ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      /%|\\/.test(href)
    )
      continue;
    let child: ImPageIdentity;
    try {
      child = imPagePath(url.pathname);
    } catch {
      if (
        /^\/(?:k5(?:_es)?|MS(?:_ES)?|HS(?:_ES)?)\/(?:teachers|families|students)\//i.test(
          url.pathname,
        )
      )
        exclusions.push({
          code: 'unsupported_hierarchy_or_html',
          message: `Outside declared PDF hierarchy: ${url.pathname}`,
        });
      continue;
    }
    const sameCourse =
      child.band === page.band &&
      child.audience === page.audience &&
      child.course === page.course;
    const rootChild =
      page.leaf === 'root' &&
      child.band.toLowerCase().replace('_es', '') === page.band.toLowerCase() &&
      child.course &&
      !child.unit &&
      child.leaf !== 'resources';
    const courseChild =
      page.course &&
      !page.unit &&
      page.leaf !== 'resources' &&
      sameCourse &&
      ((child.unit && !child.lesson && child.leaf !== 'resources') ||
        (!child.unit && child.leaf === 'resources'));
    const unitChild =
      page.unit &&
      !page.lesson &&
      !['resources', 'family-materials'].includes(page.leaf) &&
      sameCourse &&
      child.unit === page.unit &&
      ((child.lesson && child.leaf === 'preparation') ||
        (!child.lesson && child.leaf === 'resources'));
    const familyMaterialsChild =
      page.band.startsWith('k5') &&
      page.audience === 'families' &&
      page.unit &&
      !page.lesson &&
      page.leaf !== 'family-materials' &&
      sameCourse &&
      child.unit === page.unit &&
      !child.lesson &&
      child.leaf === 'family-materials';
    if (rootChild || courseChild || unitChild || familyMaterialsChild)
      children.add(child.path);
  }
  if (children.size > 128 || artifacts.size > 128)
    throw new Error('First-edition page exceeds hierarchy/artifact bound.');
  return {
    children: [...children],
    artifacts: [...artifacts.values()],
    exclusions,
    attribution,
    notices,
    licensed,
    title: imText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
  };
}
