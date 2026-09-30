import { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { OpenAiFileSession, openOpenAiFile } from '../dist/files.js';
const status = document.createElement('p'); status.id = 'status';
const bridge = new McpAppBridge({ hostWindow: parent, hostOrigin: 'http://127.0.0.1:47867', appInfo: { name: 'synthetic-files', version: '1' }, timeoutMs: 250 });
const input = { file: { name: 'synthetic.txt', resourceUri: 'host-resource://synthetic' } };
let session: OpenAiFileSession;
for (const operation of ['read', 'write', 'subscribe', 'open', 'dispose']) {
  const button = document.createElement('button'); button.textContent = operation; button.id = operation;
  button.onclick = async () => {
    try {
      if (operation === 'read') status.textContent = JSON.stringify(await session.read());
      if (operation === 'write') status.textContent = JSON.stringify(await session.write({ text: 'synthetic edited' }));
      if (operation === 'subscribe') { await session.subscribe((file) => { status.textContent = JSON.stringify(file); }, () => { status.textContent = 'denied'; }); status.textContent = 'subscribed'; }
      if (operation === 'dispose') { session.dispose(); status.textContent = 'disposed'; }
      if (operation === 'open') { await openOpenAiFile({ bridge, resolveTool: 'file_open', arguments: { id: 'synthetic' }, allowedPaths: ['/synthetic/file.txt'], confirm: async () => true }); status.textContent = 'opened'; }
    } catch { status.textContent = 'denied'; }
  };
  document.body.append(button);
}
document.body.append(status);
await bridge.connect();
session = new OpenAiFileSession({ bridge, input, authorityTool: 'file_authority', fallbackTool: 'file_workflow', maxBytes: 32, mimeTypes: ['text/plain'] });
status.textContent = session.native ? 'native ready' : 'fallback ready';
window.addEventListener('pagehide', () => { session.dispose(); bridge.dispose(); });
