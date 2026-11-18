# @happyvertical/smrt-capacitor-session

Capacitor Android plugin that flushes the WebView `CookieManager` to disk so a cookie session
survives the app being killed right after sign-in (happyvertical/smrt#5077).

## Use

```bash
pnpm add @happyvertical/smrt-capacitor-session   # in the Capacitor shell, not the web app
pnpm exec cap sync android
```

`cap sync` registers the plugin; no web or Java change is needed. The plugin flushes within
500 ms of any cookie change on the current page, and on pause, stop and destroy. A page can
force one with `Capacitor.Plugins.SmrtSession.flush()`.

Android only (the plugin has no iOS code). Requires `@capacitor/core` >= 8.
