# @happyvertical/smrt-capacitor-session

Capacitor Android plugin that keeps a WebView cookie session durable (#5077).
Android's WebView writes new cookies to disk lazily (about every 30 s), so a shell
killed soon after a cookie-session sign-in comes back signed out. This plugin is the
framework's answer for Capacitor shells that load a smrt web app and use its cookie
session (Hearth, #254); it is not part of the KMP `smrt-mobile` / `smrt-android`
native-bearer stack, which has no WebView.

## Layout

- `android/src/main/java/.../SmrtSessionPlugin.java`: `@CapacitorPlugin(name = "SmrtSession")`.
  While the app is resumed it polls the current page's cookie jar every `POLL_MS` (500 ms)
  and calls `CookieManager.flush()` when it changed; it also flushes on pause, stop and
  destroy. Polling is required: a fetch-set cookie raises no page load or lifecycle event,
  and `am force-stop` of a foreground app runs no callback.
- `.../CookieFlushPolicy.java`: the pure change detector, tested without Android.
- `test/CookieFlushPolicyTest.java`: plain-Java test run by `pnpm test` (needs a JDK;
  skipped locally without one, a failure under `CI`).
- `scripts/validate-plugin.mjs`: structural validation, also the `build` and `typecheck` step.

## Invariants

- Android only, no JS entry. The plugin loads on `cap sync` plugin registration; the web app
  adds no code. `Capacitor.Plugins.SmrtSession.flush()` exists for an explicit flush.
- The loss window is at most `POLL_MS` after a cookie change. Cookies for origins other than
  the current page are flushed on pause/stop, not polled.
- No credential, token or cookie value is read, stored or logged; the snapshot string stays in memory.
- The Gradle compile happens in the consuming app (`cap sync`, assemble), against its Capacitor.
