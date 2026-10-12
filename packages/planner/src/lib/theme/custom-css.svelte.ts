/**
 * Custom CSS from a cookbook is untrusted: a cookbook can be imported, shared,
 * or written by a host agent. Before it reaches the page it is parsed by the
 * browser, stripped of external loads, and re-serialized inside an `@scope`
 * rooted at this Planner's own app shell, so it can neither style the host
 * page nor fetch anything. It applies only once the visitor approves that
 * exact text.
 */

/** The shell class authors write; a leading one is read as this Planner's shell. */
export const SHELL_CLASS = 'smrt-admin-shell';
/** Marks the one shell element a Planner's custom CSS is scoped to. */
export const SCOPE_ATTRIBUTE = 'data-smrt-planner-scope';
/** `?styles=off` turns custom CSS off, whatever it hides. */
export const STYLES_OFF_PARAM = 'styles';
const APPROVED_KEY = 'smrt-planner-approved-css-v2';
const LEGACY_APPROVED_KEY = 'smrt-planner-approved-css';
const MAX_APPROVED = 20;

/** Value functions that load something: allowed only as literal `data:` URLs. */
const LOADS = /\b(?:url|image-set|image|cross-fade|element|src)\s*\(/gi;

/**
 * Whether a rule's whole declaration text is safe. The text is checked as
 * written out, shorthands and `var()` fallbacks included, because the browser
 * keeps a `var()` value (and a custom property) as raw author text: any escape
 * is refused, and every load must be a literal `url("data:...")`.
 */
function safeDeclarations(text: string): boolean {
  if (text.includes('\\')) return false;
  for (const match of text.matchAll(LOADS)) {
    if (!/^url/i.test(match[0])) return false;
    const rest = text.slice((match.index ?? 0) + match[0].length).trimStart();
    if (!/^(["']?)data:/i.test(rest)) return false;
  }
  return true;
}

/** Split a selector list on its top-level commas. */
function selectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

const LEADING_SHELL = new RegExp(`^\\.${SHELL_CLASS}(?![\\w-])`);

/**
 * Inside `@scope`, a selector without `:scope` is read as a descendant of the
 * root, so `.smrt-admin-shell a` would never match. A leading shell selector
 * becomes `:scope`; the scope limit still keeps every match inside the shell.
 */
function shellToScope(rule: CSSStyleRule): void {
  const next = selectorList(rule.selectorText)
    .map((selector) => selector.replace(LEADING_SHELL, ':scope'))
    .join(', ');
  if (next !== rule.selectorText) rule.selectorText = next;
}

/** Rule types that stay inside the scope; every other at-rule is global. */
const KEPT = [
  'CSSStyleRule',
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSContainerRule',
  'CSSNestedDeclarations',
];
const kept = (rule: CSSRule) =>
  KEPT.some(
    (name) =>
      name in globalThis &&
      rule instanceof
        (globalThis as unknown as Record<string, typeof CSSRule>)[name],
  );

/**
 * Keep only scoped style rules, at every depth: `@import`, `@font-face`,
 * `@keyframes`, `@property`, `@layer` and the like register global names that
 * `@scope` does not confine. A rule whose declarations could load anything is
 * dropped whole.
 */
function strip(
  list: CSSRuleList,
  remove: (index: number) => void,
  nestedInStyle = false,
): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i];
    const style = (rule as Partial<CSSStyleRule>).style;
    if (!kept(rule) || (style && !safeDeclarations(style.cssText))) {
      remove(i);
      continue;
    }
    const isStyle = 'selectorText' in rule;
    if (isStyle && !nestedInStyle) shellToScope(rule as CSSStyleRule);
    const group = rule as Partial<CSSGroupingRule>;
    if (group.cssRules && group.deleteRule) {
      const owner = group as CSSGroupingRule;
      strip(
        owner.cssRules,
        (at) => owner.deleteRule(at),
        nestedInStyle || isStyle,
      );
    }
  }
}

/**
 * The browser's own reading of `css`, without external loads, scoped to the
 * element `scope` selects. Serialized rules are balanced, so nothing can close
 * the scope. Empty outside a browser or when nothing survives.
 */
export function containCustomCss(css: string, scope: string): string {
  if (!css.trim() || typeof CSSStyleSheet === 'undefined') return '';
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  strip(sheet.cssRules, (at) => sheet.deleteRule(at));
  const rules = Array.from(sheet.cssRules, (rule) => rule.cssText);
  return rules.length ? `@scope (${scope}) {\n${rules.join('\n')}\n}` : '';
}

let nextScope = 0;

/**
 * The selector for the app shell around `element`, marking that one shell so
 * custom CSS cannot reach another shell on the page (a host's own AppShell or
 * a second Planner). Null when `element` is not inside a shell.
 */
export function shellScopeOf(element: Element | null): string | null {
  const shell = element?.closest(`.${SHELL_CLASS}`);
  if (!shell) return null;
  let id = shell.getAttribute(SCOPE_ATTRIBUTE);
  if (!id) {
    id = `p${++nextScope}`;
    shell.setAttribute(SCOPE_ATTRIBUTE, id);
  }
  return `[${SCOPE_ATTRIBUTE}="${id}"]`;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of the UTF-8 text, hex. Synchronous so approval checks stay reactive. */
export function sha256(text: string): string {
  const data = new TextEncoder().encode(text);
  const bits = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          w[i]) >>>
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

function readApproved(): string[] {
  try {
    localStorage.removeItem(LEGACY_APPROVED_KEY);
    const value = JSON.parse(localStorage.getItem(APPROVED_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))
      : [];
  } catch {
    return [];
  }
}

const approvedThisPage = new Set<string>();
// Bumped on each approval so readers re-run.
const approvals = $state({ version: 0 });

/** Remember the visitor's approval of exactly this CSS. */
export function approveCustomCss(css: string): void {
  const id = sha256(css);
  approvedThisPage.add(id);
  const next = [id, ...readApproved().filter((v) => v !== id)].slice(
    0,
    MAX_APPROVED,
  );
  try {
    localStorage.setItem(APPROVED_KEY, JSON.stringify(next));
  } catch {
    // Without storage the approval lasts for this page only.
  }
  approvals.version++;
}

/** Approved on this page or remembered on this device; reactive to approvals. */
export function customCssApproved(css: string): boolean {
  void approvals.version;
  const id = sha256(css);
  return approvedThisPage.has(id) || readApproved().includes(id);
}

/** `?styles=off` in the address bar. */
export function customCssDisabled(search: string): boolean {
  return new URLSearchParams(search).get(STYLES_OFF_PARAM) === 'off';
}
