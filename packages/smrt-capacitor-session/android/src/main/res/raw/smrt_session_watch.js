// Installed by SmrtSessionPlugin on every page load (happyvertical/smrt#5160).
// A cookie set by a fetch response (a SvelteKit use:enhance sign-in) raises no
// page load, so tell the plugin as soon as a fetch, XHR or beacon completes; it
// flushes the WebView cookie jar only if the watched cookies changed. Reads no
// cookie, sends nothing but the nudge, and is a no-op outside the Capacitor shell.
(function () {
  var w = window;
  if (w.__smrtSessionWatch) return;
  var plugin = w.Capacitor && w.Capacitor.Plugins && w.Capacitor.Plugins.SmrtSession;
  if (!plugin || typeof plugin.checkCookies !== 'function' || typeof w.PerformanceObserver !== 'function') return;
  w.__smrtSessionWatch = true;
  var kinds = { fetch: true, xmlhttprequest: true, beacon: true };
  new w.PerformanceObserver(function (list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i++) {
      if (kinds[entries[i].initiatorType]) {
        Promise.resolve(plugin.checkCookies()).catch(function () {});
        return;
      }
    }
  }).observe({ type: 'resource' });
})();
