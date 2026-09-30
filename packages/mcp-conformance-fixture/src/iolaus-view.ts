/** Prebuilt portable view: all domain data arrives through authorized tools. */
import { McpAppBridge } from '@happyvertical/smrt-mcp-apps';

const bridge = new McpAppBridge({
  hostWindow: parent,
  hostOrigin: new URL(document.referrer).origin,
  appInfo: { name: 'Synthetic Iolaus review', version: '1' },
});
const main = document.createElement('main');
const status = document.createElement('p');
status.setAttribute('role', 'status');
const materials = document.createElement('pre');
materials.id = 'materials';
document.body.append(status, main, materials);
async function browse() {
  try {
    await bridge.connect();
    if (!bridge.snapshot.hostCapabilities.serverTools) {
      status.textContent = 'Use the dedicated human review page.';
      return;
    }
    const result = await bridge.callTool('iolaus_browse', {});
    const rows = result.structuredContent?.applications;
    if (!Array.isArray(rows)) throw new Error('Invalid applications');
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.id !== 'string' ||
        typeof row.opportunity !== 'string'
      )
        throw new Error('Invalid application');
      const id = row.id;
      const button = document.createElement('button');
      button.textContent = row.opportunity;
      button.addEventListener('click', () => {
        void bridge
          .callTool('iolaus_inspect_materials', { id })
          .then((result) => {
            materials.textContent = JSON.stringify(result.structuredContent);
            const path = result.structuredContent?.humanReviewUrl;
            if (
              typeof path === 'string' &&
              /^\/review\/[a-f0-9-]+$/.test(path)
            ) {
              const link = document.createElement('a');
              link.textContent = 'Open dedicated human review';
              link.href = `${new URL(document.referrer).origin}${path}`;
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
              main.append(link);
            }
            status.textContent =
              'Materials ready for separate human review. Nothing submitted.';
          })
          .catch(() => {
            status.textContent = 'Materials unavailable.';
          });
      });
      main.append(button);
    }
    status.textContent = 'Choose synthetic materials to inspect.';
  } catch {
    status.textContent =
      'Workflow unavailable. Use the dedicated human review page.';
  }
}
window.addEventListener('pagehide', () => bridge.dispose(), { once: true });
void browse();
