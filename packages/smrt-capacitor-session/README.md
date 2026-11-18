# @happyvertical/smrt-capacitor-session

Capacitor Android plugin that flushes the WebView `CookieManager` to disk so a cookie session
survives the app being killed right after sign-in (happyvertical/smrt#5077).

## Use

```bash
pnpm add @happyvertical/smrt-capacitor-session   # in the Capacitor shell, not the web app
pnpm exec cap sync android
```

`cap sync` registers the plugin; no web or Java change is needed. The plugin flushes within
500 ms of any cookie change, and on pause, stop and destroy. A page can
force one with `Capacitor.Plugins.SmrtSession.flush()`.

Android only (the plugin has no iOS code). Requires `@capacitor/core` >= 8.

## Which origins are covered

The cookies of these origins are watched and flushed within 500 ms of a change (deduplicated):

1. the origin of the page the WebView is showing;
2. the origin of Capacitor's `server.url`, so a shell that loads the app remotely is covered
   even while the page is on another origin;
3. extra origins listed in the plugin config:

```js
// capacitor.config.js
plugins: { SmrtSession: { origins: ['https://hearthed.org'] } }
```

A shell that serves the app from `https://localhost` and signs in against a remote origin must set
`server.url` or list that origin. Cookies of any other origin are flushed on pause, stop and destroy only.
