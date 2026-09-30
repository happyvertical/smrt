import { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { observeOpenAiNavigation, openAiNavigationLink, requestOpenAiDisplayMode } from '../dist/client.js';
const status = document.createElement('p'); status.id = 'status'; status.textContent = 'Inline application';
const link = document.createElement('a'); link.id = 'link'; link.textContent = 'Open settings';
link.href = openAiNavigationLink('unknown', { pluginId: 'synthetic', toolName: 'view', platform: 'web' }, 'https://app.example/settings');
const button = document.createElement('button'); button.textContent = 'Expand';
const contextButton = document.createElement('button'); contextButton.id = 'context'; contextButton.textContent = 'Context';
const messageButton = document.createElement('button'); messageButton.id = 'message'; messageButton.textContent = 'Message';
document.body.append(status, link, button, contextButton, messageButton);
const bridge = new McpAppBridge({ hostWindow: parent, hostOrigin: 'http://127.0.0.1:47865', appInfo: { name: 'synthetic-openai-navigation', version: '1' }, availableDisplayModes: ['inline', 'fullscreen'], timeoutMs: 200 });
const stop = observeOpenAiNavigation({ bridge, resolveTool: 'resolve_target', onResult: (result, url) => { status.textContent = `${url}: ${result.content[0]?.text}`; }, onFallback: reason => { status.textContent = `Inline fallback: ${reason}`; } });
button.onclick = async () => { button.textContent = await requestOpenAiDisplayMode(bridge, 'fullscreen'); };
void bridge.connect().then(() => {
  try {
    const context = bridge.registerExtension({ id: 'openai-context', capability: { path: ['experimental', 'openai/modelContext'] }, methods: ['ui/update-model-context'], notifications: [] });
    contextButton.onclick = async () => {
      try { await context.request('ui/update-model-context', { content: [{ type: 'text', text: 'Private synthetic context', _meta: { 'openai/title': 'Synthetic', 'openai/thumbnail': { src: 'https://assets.invalid/x.png' } }, annotations: { audience: ['assistant'] } }] }); status.textContent = 'Native context'; } catch { status.textContent = 'Portable context'; }
    };
  } catch { contextButton.onclick = () => { status.textContent = 'Portable context'; }; }
  try {
    const message = bridge.registerExtension({ id: 'openai-message', capability: { path: ['experimental', 'openai/message'] }, methods: ['ui/message'], notifications: [] });
    messageButton.onclick = async () => { try { await message.request('ui/message', { role: 'user', content: [{ type: 'text', text: 'Synthetic message' }] }); status.textContent = 'Native message'; } catch { status.textContent = 'Portable message'; } };
  } catch { messageButton.onclick = () => { status.textContent = 'Portable message'; }; }
}).catch(() => { status.textContent = 'Portable context'; });
window.addEventListener('pagehide', () => { stop(); bridge.dispose(); });
