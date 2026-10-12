/** Minimal MCP Apps bridge, injected before the self-contained Planner bundle. */
export const KITCHEN_BRIDGE = `<script>
(() => {
  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  let latest;
  let hostOrigin = '*';
  function send(message) { window.parent.postMessage({ jsonrpc: '2.0', ...message }, hostOrigin); }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = 'kitchen-' + ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The host did not answer. Refresh the plan before retrying.'));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  function publish(data) {
    if (!data || typeof data.planId !== 'string' || !data.state) return;
    latest = data;
    for (const listener of listeners) listener(data);
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (hostOrigin !== '*' && event.origin !== hostOrigin) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      if (event.origin && event.origin !== 'null') hostOrigin = event.origin;
      const item = pending.get(message.id);
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || 'Host request failed'));
      else item.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-result') {
      publish(message.params?.structuredContent);
    } else if (message.method === 'ping' && message.id !== undefined) {
      send({ id: message.id, result: {} });
    }
  });
  const ready = request('ui/initialize', {
    appInfo: { name: 'smrt-kitchen-planner', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: '2026-01-26',
  }).then((result) => {
    if (result?.protocolVersion !== '2026-01-26') throw new Error('Unsupported MCP Apps protocol');
    send({ method: 'ui/notifications/initialized', params: {} });
    return result;
  });
  ready.catch(() => {});
  window.smrtKitchen = {
    async callTool(name, args) {
      if (!['get_plan', 'run_commands', 'export_plan', 'validate_plan', 'planner_ui_update'].includes(name)) {
        throw new Error('This tool is not available from the Planner UI');
      }
      await ready;
      const result = await request('tools/call', { name, arguments: args });
      if (!result?.structuredContent) throw new Error('The host returned no structured data');
      return result.structuredContent;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
  };
  ready.then(async () => {
    const resumePlanId = window.__smrtKitchenReloadPlanId;
    if (resumePlanId) {
      try {
        const result = await request('tools/call', {
          name: 'get_plan', arguments: { planId: resumePlanId },
        });
        publish(result?.structuredContent);
      } catch { /* A later render result can still supply the plan. */ }
    }
    let version = window.__smrtKitchenUiVersion;
    if (!version) return;
    let checking = false;
    let stopped = false;
    let reloadNotice;
    function showReloadNotice() {
      if (reloadNotice) return;
      reloadNotice = document.createElement('p');
      reloadNotice.setAttribute('role', 'alert');
      reloadNotice.textContent = 'The new Planner UI could not reload. Reopen this app tab to use it.';
      document.body.prepend(reloadNotice);
    }
    const check = async () => {
      if (checking || stopped || document.visibilityState === 'hidden') return;
      checking = true;
      let attemptedVersion = false;
      try {
        const result = await request('tools/call', {
          name: 'planner_ui_update',
          arguments: { version, planId: latest?.planId || resumePlanId || '' },
        });
        const update = result?.structuredContent;
        if (update?.changed && typeof update.html === 'string' && typeof update.version === 'string') {
          // A rejected artifact must not be resent every poll. A later build
          // has a different digest and can still replace it.
          version = update.version;
          attemptedVersion = true;
          const next = new DOMParser().parseFromString(update.html, 'text/html');
          const nextStyle = next.getElementById('smrt-planner-styles');
          const nextEntry = next.getElementById('smrt-planner-entry');
          const currentStyle = document.getElementById('smrt-planner-styles');
          const currentEntry = document.getElementById('smrt-planner-entry');
          if (!nextStyle || !nextEntry || !currentStyle || !currentEntry || !window.smrtKitchenUnmount) {
            throw new Error('The Planner bundle cannot be reloaded in this tab');
          }
          await window.smrtKitchenUnmount();
          const style = document.createElement('style');
          style.id = 'smrt-planner-styles';
          style.textContent = nextStyle.textContent;
          currentStyle.replaceWith(style);
          const entry = document.createElement('script');
          entry.id = 'smrt-planner-entry';
          entry.textContent = nextEntry.textContent;
          currentEntry.replaceWith(entry);
          reloadNotice?.remove();
          reloadNotice = undefined;
        }
      } catch {
        if (attemptedVersion) showReloadNotice();
        // A build may be in progress; check again for a newer digest.
      }
      checking = false;
    };
    const timer = setInterval(check, 1500);
    window.addEventListener('pagehide', () => {
      stopped = true;
      clearInterval(timer);
    }, { once: true });
  }).catch(() => {});
  ready.then(() => {
    const observer = new ResizeObserver(() => send({
      method: 'ui/notifications/size-changed',
      params: { height: document.documentElement.scrollHeight },
    }));
    observer.observe(document.documentElement);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }).catch(() => {});
})();
</script>`;
