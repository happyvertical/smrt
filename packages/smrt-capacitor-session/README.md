# @happyvertical/smrt-capacitor-session

Capacitor Android plugin that flushes the WebView `CookieManager` to disk so a cookie session
survives the app being killed right after sign-in (happyvertical/smrt#5077).

## Use

```bash
pnpm add @happyvertical/smrt-capacitor-session   # in the Capacitor shell, not the web app
pnpm exec cap sync android
```

`cap sync` registers the plugin; no web or Java change is needed. The plugin flushes as soon
as a fetch, XHR or beacon that changed a watched cookie completes (a `use:enhance` sign-in),
otherwise within 500 ms of any cookie change, and on pause, stop and destroy. A page can
force one with `Capacitor.Plugins.SmrtSession.flush()`.

On every page load the plugin checks the jar and injects a small `PerformanceObserver`
(`android/src/main/res/raw/smrt_session_watch.js`) that calls
`Capacitor.Plugins.SmrtSession.checkCookies()` when a fetch, XHR or beacon completes; the
plugin flushes only if the watched cookies changed. It reads no cookie and adds no idle work
(#5160).

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

## Emailed sign-in links (opt-in)

A one-time sign-in link sent by email (for example `/sign-in/email/complete#proof=…`) has to
finish in the app's own WebView. If it finishes in a browser, the browser gets the session and
the app stays signed out. Capacitor does not load an incoming link into the WebView, so the
plugin does it for the paths a shell lists (#5361):

```js
// capacitor.config.js
plugins: { SmrtSession: { links: ['/sign-in/email/complete'] } }
```

A VIEW intent that reaches the activity, on launch or while running, is loaded into the WebView
only when all of these hold:

- the link is http(s) with no user info;
- its origin equals the origin of `server.url` (host case and default port ignored);
- its path is a listed prefix or lies under one at a segment boundary, with no `.`/`..`
  segments or encoded slashes or dots.

Query and fragment are kept. Anything else is ignored. The intent's data is cleared once it is
used, and a launch replayed from Recents is ignored, so a spent one-time link is never reopened.
Without `links`, nothing changes.

The plugin only routes the link. The shell still declares the Android App Link: an
`autoVerify` intent filter for those paths in its `AndroidManifest.xml`, and
`/.well-known/assetlinks.json` served by the web app for its signing certificate.
