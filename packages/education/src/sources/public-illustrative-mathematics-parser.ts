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
      const before = html.slice(0, anchor.index);
      // Table labels and resource headings are explicit source labels, never guessed from a URL.
      const rowStart = before.lastIndexOf('<tr');
      const rowEnd = before.lastIndexOf('</tr>');
      const heading = [
        ...before.matchAll(/<h[34]\b[^>]*>([\s\S]*?)<\/h[34]>/gi),
      ].at(-1)?.[1];
      const label =
        rowStart > rowEnd
          ? imText(
              /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(
                before.slice(rowStart),
              )?.[1] ?? '',
            )
          : imText(heading ?? '');
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
    if (rootChild || courseChild || unitChild) children.add(child.path);
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
