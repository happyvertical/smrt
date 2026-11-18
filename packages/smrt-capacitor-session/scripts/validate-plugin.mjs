#!/usr/bin/env node
/**
 * Validation for @happyvertical/smrt-capacitor-session (#5077).
 *
 * Default: structural checks, no JDK or Android SDK needed. `--test` also runs
 * the page watch script (res/raw/smrt_session_watch.js) against fakes in a Node
 * vm (#5160), and compiles CookieFlushPolicy with javac and runs its plain-Java
 * test; with no JDK that step is skipped locally and fails when CI is set. The Gradle compile
 * against Capacitor happens in the consuming app's `cap sync` + assemble.
 */
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = 'android/src/main/java/com/happyvertical/smrt/capacitor/session';
const WATCH = 'android/src/main/res/raw/smrt_session_watch.js';

const SPEC = [
  { path: 'AGENTS.md' },
  { path: 'CLAUDE.md', mustContain: ['@AGENTS.md'] },
  { path: 'README.md' },
  { path: 'android/build.gradle', mustContain: ["namespace = \"com.happyvertical.smrt.capacitor.session\"", "project(':capacitor-android')"] },
  { path: 'android/src/main/AndroidManifest.xml' },
  {
    path: `${JAVA}/SmrtSessionPlugin.java`,
    mustContain: [
      '@CapacitorPlugin(name = "SmrtSession")',
      'CookieManager.getInstance().flush()',
      'handleOnPause',
      'handleOnStop',
      'handleOnDestroy',
      'webView.getUrl()',
      'public void checkCookies(PluginCall call)',
      'R.raw.smrt_session_watch',
      'onPageLoaded',
    ],
  },
  { path: WATCH, mustContain: ['PerformanceObserver', 'checkCookies'] },
  { path: `${JAVA}/CookieFlushPolicy.java`, mustContain: ['shouldFlush'] },
  { path: 'test/CookieFlushPolicyTest.java' },
  {
    path: 'package.json',
    mustContain: ['"@happyvertical/smrt-capacitor-session"', '"android/src/main/"', '"src": "android"', '"@capacitor/core"'],
  },
];

const problems = [];
for (const { path, mustContain = [] } of SPEC) {
  const file = join(PKG, path);
  if (!existsSync(file)) {
    problems.push(`missing ${path}`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const s of mustContain) if (!text.includes(s)) problems.push(`${path} must contain ${JSON.stringify(s)}`);
}
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
if (pkg.private) problems.push('package.json must not be private: Hearth consumes it from npm');
if (problems.length) {
  console.error(`validate-plugin: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('validate-plugin: structure ok');

/** Run the page watch script in a fresh context with a fake shell; returns what it did. */
function runWatch({ plugin = true, observer = true, times = 1 } = {}) {
  const calls = { check: 0 };
  const observers = [];
  const window = {};
  if (plugin) {
    window.Capacitor = {
      Plugins: {
        SmrtSession: {
          checkCookies() {
            calls.check += 1;
            return Promise.resolve();
          },
        },
      },
    };
  }
  if (observer) {
    window.PerformanceObserver = class {
      constructor(cb) {
        this.cb = cb;
        observers.push(this);
      }
      observe(opts) {
        this.opts = opts;
      }
    };
  }
  const script = readFileSync(join(PKG, WATCH), 'utf8');
  for (let i = 0; i < times; i++) runInNewContext(script, { window, Promise });
  const emit = (...kinds) => {
    for (const o of observers) o.cb({ getEntries: () => kinds.map((initiatorType) => ({ initiatorType })) });
  };
  return { calls, observers, emit };
}

function testWatchScript() {
  const fail = (what) => {
    throw new Error(`watch script: ${what}`);
  };
  const shell = runWatch({ times: 2 });
  if (shell.observers.length !== 1) fail('installs exactly one observer per document, even when injected twice');
  if (shell.observers[0].opts?.type !== 'resource') fail('observes resource timing entries');
  shell.emit('img', 'script', 'link', 'css');
  if (shell.calls.check !== 0) fail('static subresources do not nudge the plugin');
  shell.emit('fetch');
  if (shell.calls.check !== 1) fail('a completed fetch (fetch-set sign-in cookie) nudges the plugin');
  shell.emit('xmlhttprequest', 'fetch', 'beacon');
  if (shell.calls.check !== 2) fail('one nudge per observer batch');
  shell.emit('beacon');
  if (shell.calls.check !== 3) fail('a beacon nudges the plugin');
  if (runWatch({ plugin: false }).observers.length !== 0) fail('outside the Capacitor shell it installs nothing');
  if (runWatch({ observer: false }).calls.check !== 0) fail('without PerformanceObserver it is a no-op');
  console.log('validate-plugin: watch script ok');
}

if (process.argv.includes('--test')) {
  testWatchScript();
  const out = join(PKG, 'test/out');
  mkdirSync(out, { recursive: true });
  let hasJdk = true;
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
  } catch {
    hasJdk = false;
  }
  if (!hasJdk && !process.env.CI) {
    console.warn('validate-plugin: no JDK on PATH; policy test skipped (fails under CI)');
  } else {
    try {
      execFileSync('javac', ['-d', out, join(PKG, JAVA, 'CookieFlushPolicy.java'), join(PKG, 'test/CookieFlushPolicyTest.java')], { stdio: 'inherit' });
    execFileSync('java', ['-cp', out, 'com.happyvertical.smrt.capacitor.session.CookieFlushPolicyTest'], { stdio: 'inherit' });
    } catch (error) {
      console.error(`validate-plugin: policy test failed: ${error.message}`);
      process.exit(1);
    }
  }
}
