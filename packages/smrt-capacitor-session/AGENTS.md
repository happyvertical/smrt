# @happyvertical/smrt-capacitor-session

Capacitor Android plugin that keeps a WebView cookie session durable (#5077).
Android's WebView writes new cookies to disk lazily (about every 30 s), so a shell
killed soon after a cookie-session sign-in comes back signed out. This plugin is the
framework's answer for Capacitor shells that load a smrt web app and use its cookie
session (Hearth, #254); it is not part of the KMP `smrt-mobile` / `smrt-android`
native-bearer stack, which has no WebView.

## Layout

- `android/src/main/java/.../SmrtSessionPlugin.java`: `@CapacitorPlugin(name = "SmrtSession")`.
  While the app is resumed it polls the cookie jars of the current page, `server.url` and `plugins.SmrtSession.origins` origins every `POLL_MS` (500 ms)
  and calls `CookieManager.flush()` when it changed; it also flushes on pause, stop and
  destroy. Polling is required: a fetch-set cookie raises no page load or lifecycle event,
  and `am force-stop` of a foreground app runs no callback. On each page load it also checks
  the jar and injects `res/raw/smrt_session_watch.js`, a `PerformanceObserver` that calls
  `checkCookies()` when a fetch, XHR or beacon completes, so a fetch-set sign-in cookie is
  flushed within one bridge hop instead of up to `POLL_MS` later (#5160).
- `.../CookieFlushPolicy.java`: the pure change detector, tested without Android.
- `test/CookieFlushPolicyTest.java`: plain-Java test run by `pnpm test` (needs a JDK;
  skipped locally without one, a failure under `CI`). `pnpm test` also runs the watch
  script against fakes in a Node vm.
- `scripts/validate-plugin.mjs`: structural validation, also the `build` and `typecheck` step.

## Invariants

- Android only, no JS entry. The plugin loads on `cap sync` plugin registration; the web app
  adds no code. `Capacitor.Plugins.SmrtSession.flush()` exists for an explicit flush.
- The loss window is one bridge hop after a fetch/XHR/beacon that set a watched cookie, and at
  most `POLL_MS` after any other cookie change. Cookies of other origins
  are flushed on pause/stop, not polled.
- No credential, token or cookie value is read, stored or logged; the snapshot string stays in memory.
- The Gradle compile happens in the consuming app (`cap sync`, assemble), against its Capacitor.
