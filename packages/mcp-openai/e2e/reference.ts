import { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { observeOpenAiNavigation, openAiNavigationLink, requestOpenAiDisplayMode } from '../dist/client.js';
import { updateOpenAiModelContext } from '../dist/context.js';
import { sendOpenAiMessage } from '../dist/messages.js';
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
const newMessageButton = document.createElement('button'); newMessageButton.id = 'message-new'; newMessageButton.textContent = 'New message';
const missingCallbackButton = document.createElement('button'); missingCallbackButton.id = 'message-new-missing'; missingCallbackButton.textContent = 'New without callback';
const abortButton = document.createElement('button'); abortButton.id = 'abort-context'; abortButton.textContent = 'Abort context';
document.body.append(newMessageButton, missingCallbackButton, abortButton);
let contextController: AbortController | undefined;
abortButton.onclick = () => contextController?.abort();
void bridge.connect().then(() => {
  let contextNative: Parameters<typeof updateOpenAiModelContext>[0]['native'];
  let messageNative: Parameters<typeof sendOpenAiMessage>[0]['native'];
  try {
    const extension = bridge.registerExtension({ id: 'openai-context', capability: { path: ['experimental', 'openai/modelContext'] }, methods: ['ui/update-model-context'], notifications: [] });
    contextNative = async (params, signal) => { await extension.request('ui/update-model-context', params, signal); };
  } catch { /* The exported helper negotiates the portable path. */ }
  try {
    const extension = bridge.registerExtension({ id: 'openai-message', capability: { path: ['experimental', 'openai/message'] }, methods: ['ui/message'], notifications: [] });
    messageNative = async (params, signal) => { await extension.request('ui/message', params, signal); };
  } catch { /* The exported helper rejects unsupported new-conversation sends. */ }
  contextButton.onclick = async () => {
    contextController = new AbortController();
    try {
      const result = await updateOpenAiModelContext({ bridge, native: contextNative, signal: contextController.signal, value: { text: { text: 'Private synthetic context', title: 'Synthetic', thumbnail: { src: 'https://assets.invalid/x.png' }, background: true }, structuredContent: { selection: 'replacement' } } });
      status.textContent = result === 'native' ? 'Native context' : 'Portable context';
    } catch { status.textContent = 'Context rejected'; }
  };
  const send = async (target: 'active' | 'new', omitNative = false) => {
    try {
      const result = await sendOpenAiMessage({ bridge, native: omitNative ? undefined : messageNative, value: { target, text: { text: 'Synthetic message' } } });
      status.textContent = result === 'native' ? 'Native message' : 'Portable message';
    } catch { status.textContent = 'Message rejected'; }
  };
  messageButton.onclick = () => void send('active');
  newMessageButton.onclick = () => void send('new');
  missingCallbackButton.onclick = () => void send('new', true);
}).catch(() => { status.textContent = 'Connection rejected'; });
window.addEventListener('pagehide', () => { stop(); bridge.dispose(); });
