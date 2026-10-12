import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KITCHEN_BRIDGE } from './bridge.js';

/** Opt-in desktop capability probe. This is not the Planner UI. */
export const KITCHEN_UI_URI = 'ui://smrt-kitchen/capability-v1.html';
export const KITCHEN_UI_MIME = 'text/html;profile=mcp-app';

export const KITCHEN_UI_RESOURCE = {
  uri: KITCHEN_UI_URI,
  name: 'SMRT Kitchen desktop capability check',
  mimeType: KITCHEN_UI_MIME,
};

export const KITCHEN_UI_CONTENT = {
  ...KITCHEN_UI_RESOURCE,
  text: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${KITCHEN_BRIDGE}
<title>SMRT Kitchen capability check</title></head>
<body><main><h1>SMRT Kitchen</h1>
<p>Local MCP App resource rendered.</p>
<p>This capability check does not edit your plan. Continue using the Kitchen tools in chat.</p>
</main></body></html>`,
  _meta: {
    ui: {
      prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [] },
    },
  },
};

/** Load only an operator-selected local artifact; tool arguments never choose files. */
export function loadPlannerUi(file: string, resumePlanId?: string) {
  const html = readFileSync(file, 'utf8');
  if (!/<head(?:\s[^>]*)?>/i.test(html)) {
    throw new Error(
      'Planner UI must be a complete self-contained HTML document',
    );
  }
  const digest = createHash('sha256').update(html).digest('hex').slice(0, 16);
  const bootstrap = `<script>window.__smrtKitchenUiVersion=${JSON.stringify(digest)};window.__smrtKitchenReloadPlanId=${JSON.stringify(resumePlanId ?? '').replace(/</g, '\\u003c')};</script>`;
  const text = html.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) => head + bootstrap + KITCHEN_BRIDGE,
  );
  return {
    ...KITCHEN_UI_CONTENT,
    uri: `ui://smrt-kitchen/planner-${digest}.html`,
    name: 'SMRT Planner',
    text,
  };
}
