import { McpAppBridge } from '../src/index.js';

const bridge = new McpAppBridge({ hostWindow: parent, hostOrigin: 'http://127.0.0.1:47862', appInfo: { name: 'Synthetic opportunity viewer', version: '1' }, timeoutMs: 2000 });
const status = document.createElement('p');
const content = document.createElement('main');
const review = document.createElement('a');
review.textContent = 'Open human review';
review.href = 'https://example.com/opportunities/synthetic-1/review';
review.target = '_blank'; review.rel = 'noopener noreferrer';
const reviewUrl = document.createElement('code');
reviewUrl.textContent = review.href;
document.body.append(status, content, review, reviewUrl);
let currentRequest: AbortController | undefined;
let generation = 0;
function render(result: { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown> }): void {
  content.replaceChildren();
  for (const block of result.content) {
    const text = document.createElement('p'); text.textContent = block.text; content.append(text);
  }
  const rows = result.structuredContent?.opportunities;
  if (!Array.isArray(rows)) return;
  for (const value of rows) {
    if (typeof value !== 'object' || !value || typeof value.id !== 'string' || typeof value.title !== 'string') continue;
    const button = document.createElement('button'); button.textContent = value.title;
    button.disabled = !bridge.snapshot.hostCapabilities.serverTools;
    button.addEventListener('click', () => { void load('opportunity_detail', { id: value.id }); }); content.append(button);
  }
}
async function load(name: string, args: Record<string, unknown>): Promise<void> {
  const revision = ++generation; currentRequest?.abort(); currentRequest = new AbortController();
  try {
    const result = await bridge.callTool(name, args, currentRequest.signal);
    if (revision === generation && !bridge.signal.aborted) render(result);
  } catch { if (revision === generation && !bridge.signal.aborted) status.textContent = 'Tool unavailable. Continue in human review.'; }
}
bridge.subscribe((snapshot) => {
  status.textContent = snapshot.state;
  if (snapshot.toolResult) render(snapshot.toolResult);
});
review.addEventListener('click', (event) => {
  if (bridge.snapshot.hostCapabilities.openLinks) {
    event.preventDefault();
    void bridge.openLink(review.href).catch(() => { status.textContent = 'Open the review URL in your browser.'; });
  }
});
void bridge.connect().then(() => {
  if (bridge.snapshot.hostCapabilities.serverTools) void load('opportunity_list', {});
  else status.textContent = 'Interactive tools unavailable. Continue in human review.';
}).catch(() => { status.textContent = 'Host unavailable. Continue in human review.'; });
addEventListener('pagehide', () => bridge.dispose());
// Test-only controls. The generated fixture is synthetic, not a production app template.
Object.assign(window, { fixture: {
  bridge,
  pending: () => bridge.callTool('pending').catch((error: Error) => error.message),
  blockedNetwork: async () => {
    let blocked = false;
    try { await fetch('https://example.invalid/private'); } catch { blocked = true; }
    const img = document.createElement('img');
    const imageBlocked = new Promise<boolean>((resolve) => { img.onerror = () => resolve(true); img.onload = () => resolve(false); });
    img.src = 'https://example.invalid/asset.png'; document.body.append(img);
    return { blocked, imageBlocked: await imageBlocked };
  },
} });
