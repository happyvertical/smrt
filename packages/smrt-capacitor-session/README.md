# @happyvertical/smrt-capacitor-session

Capacitor Android plugin for a shell that loads a smrt web app. It flushes the WebView
`CookieManager` to disk so a cookie session survives the app being killed right after sign-in
(happyvertical/smrt#5077), and, opt-in, routes [emailed sign-in links](#emailed-sign-in-links-opt-in)
into the app and [listed paths](#paths-that-leave-the-app-opt-in) out to the browser.

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

## Paths that leave the app (opt-in)

Capacitor keeps every URL of `server.url`'s origin in the WebView, and the WebView cannot
download files, so a same-origin file link (a direct-APK update, say) does nothing. List the
paths that should open in the system browser instead (#5703):

```js
// capacitor.config.js
plugins: { SmrtSession: { external: ['/download'] } }
```

A navigation (a link tap, a redirect, a script setting `location`) leaves with `ACTION_VIEW`
when it is http(s) with no user info, its origin is `server.url`'s, and its path is a listed
prefix or lies under one at a segment boundary, with no `.`/`..` segments or encoded slashes
or dots. A URL that `links` also covers stays in the WebView, since a verified App Link would
come straight back. Everything else follows Capacitor's own policy; without `external`,
nothing changes. No permission is added.

The browser has its own cookie jar: list only paths that work signed out (or where signing in
again in the browser is acceptable). The setting is read from the installed shell, so builds
already on devices need one update before it applies to them.

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

Query and fragment are kept. Anything else is ignored.

Each link opens once. When its page has loaded, the plugin remembers the link's SHA-256 (never
the link itself, at most 16, in the app's private preferences) and never loads that link again.
That covers Android rebuilding an activity killed in the background from the intent that first
started it, which Capacitor hands to plugins again. A link that failed to load, for example
offline, can be tapped again. A launch replayed from Recents is ignored too. Without `links`,
nothing changes.

The plugin only routes the link. The shell still declares the Android App Link: an
`autoVerify` intent filter for those paths in its `AndroidManifest.xml`, and
`/.well-known/assetlinks.json` served by the web app for its signing certificate.
