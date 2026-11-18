#!/usr/bin/env node
/**
 * Validation for @happyvertical/smrt-capacitor-session (#5077).
 *
 * Default: structural checks, no JDK or Android SDK needed. `--test` also
 * compiles CookieFlushPolicy with javac and runs its plain-Java test; with no
 * JDK that step is skipped locally and fails when CI is set. The Gradle compile
 * against Capacitor happens in the consuming app's `cap sync` + assemble.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = 'android/src/main/java/com/happyvertical/smrt/capacitor/session';

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
    ],
  },
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

if (process.argv.includes('--test')) {
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
