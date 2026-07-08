#!/usr/bin/env node
/**
 * Validation for the smrt-ios package (ADR 0001 Phase 6, issue #1743).
 *
 * Default: **structural, SDK-free** — file layout + load-bearing substrings, no
 * Xcode/Gradle/JDK. This is the package `build` script and runs on every PR via
 * turbo on any runner (CI lane a), modelled on smrt-android's validate-android.mjs.
 *
 * `--native` (macOS only, the path-filtered mobile.yml lane): additionally builds
 * the exported SmrtMobile framework, stages it, and runs the real XcodeGen +
 * simulator build + tests. Hard-fails off darwin (never silently skips).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMRT_MOBILE = join(PKG, '..', 'smrt-mobile');
const NATIVE = process.argv.includes('--native');

const SRC = 'Sources/SmrtIos';
const PLATFORM = `${SRC}/Platform`;
const SAMPLE = 'Sample/SmrtIosSample';

// One entry per required file; `mustContain` lists load-bearing substrings.
const SPEC = [
  { path: 'package.json', mustContain: ['"@happyvertical/smrt-ios"', '"private": true'] },
  { path: 'AGENTS.md' },
  { path: 'CLAUDE.md', mustContain: ['@AGENTS.md'] },
  { path: 'README.md' },
  { path: 'turbo.json' },
  {
    path: 'project.yml',
    mustContain: [
      'SmrtIos',
      'SmrtIosSample',
      'Frameworks/SmrtMobile.framework',
      '_sqlite3_load_extension',
    ],
  },
  {
    path: `${SRC}/Theme/MobileTheme.swift`,
    mustContain: [
      'struct MobileColors',
      'struct MobileStatusColors',
      'struct MobileSpacing',
      'struct MobileTheme',
      'struct MobileSectionLabel',
      'struct MobileResultCard',
      'struct MobileStatusPill',
    ],
  },
  {
    path: `${SRC}/Shell/MobileShellScaffold.swift`,
    mustContain: ['struct MobileShellScaffold', 'MobileShellState', 'struct MobileTabHeader'],
  },
  { path: `${PLATFORM}/CryptoKitSha256Hasher.swift`, mustContain: [', Sha256Hasher', 'CryptoKit'] },
  {
    path: `${PLATFORM}/KeychainAuthStorage.swift`,
    mustContain: [', AuthStorage', 'kSecAttrAccessibleAfterFirstUnlock', 'SecItemAdd'],
  },
  {
    path: `${PLATFORM}/WebAuthSessionLauncher.swift`,
    mustContain: [', ExternalAuthLauncher', 'ASWebAuthenticationSession'],
  },
  { path: `${PLATFORM}/NativeSqlDriverFactory.swift`, mustContain: ['SmrtMobileIos', 'createDatabase'] },
  {
    path: `${PLATFORM}/IOSDeviceCapabilityAdapter.swift`,
    mustContain: [', DeviceCapabilityAdapter', 'mapAuthorization', 'notDetermined'],
  },
  {
    path: `${PLATFORM}/DataScannerBarcodeScanner.swift`,
    mustContain: [', BarcodeScanner', 'DataScannerViewController', 'barcodeFormatLabel'],
  },
  {
    path: `${PLATFORM}/FoundationModelsLanguageModel.swift`,
    mustContain: [', OnDeviceLanguageModel', 'FoundationModels', 'HIDDEN_UNAVAILABLE'],
  },
  {
    path: `${PLATFORM}/IOSSpeechTranscriber.swift`,
    mustContain: ['SmrtMobile.SpeechTranscriber', 'SFSpeechRecognizer'],
  },
  {
    path: `${SAMPLE}/SmrtIosSampleApp.swift`,
    mustContain: ['@main', 'MobileShellState', 'createOfflinePackStore'],
  },
  { path: `${SAMPLE}/SampleScreens.swift`, mustContain: ['MobileShellScaffold', 'MobileTheme'] },
  { path: `${SAMPLE}/Info.plist`, mustContain: ['NSCameraUsageDescription', 'NSSpeechRecognitionUsageDescription'] },
  { path: 'Tests/SmrtIosTests/AdapterMappingTests.swift', mustContain: ['XCTest', '@testable import SmrtIos'] },
];

const failures = [];
let contentChecks = 0;

for (const { path, mustContain = [] } of SPEC) {
  const abs = join(PKG, path);
  if (!existsSync(abs)) {
    failures.push(`missing required file: ${path}`);
    continue;
  }
  if (mustContain.length === 0) continue;
  const content = readFileSync(abs, 'utf8');
  for (const needle of mustContain) {
    contentChecks += 1;
    if (!content.includes(needle)) {
      failures.push(`${path}: missing expected content ${JSON.stringify(needle)}`);
    }
  }
}

if (failures.length > 0) {
  console.error('✗ smrt-ios structural validation failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ smrt-ios structural validation passed (${SPEC.length} files, ${contentChecks} content checks).`);

if (!NATIVE) process.exit(0);

// -------------------------------------------------------------------------
// Native lane (macOS only): real framework build + simulator build + tests.
// -------------------------------------------------------------------------
if (process.platform !== 'darwin') {
  throw new Error('iOS native validation (--native) requires macOS with Xcode and XcodeGen.');
}

console.log('› building exported SmrtMobile framework (Gradle)…');
run(join(SMRT_MOBILE, 'gradlew'), ['linkDebugFrameworkIosSimulatorArm64', '--console=plain'], SMRT_MOBILE);

const builtFramework = join(
  SMRT_MOBILE,
  'build/bin/iosSimulatorArm64/debugFramework/SmrtMobile.framework',
);
if (!existsSync(builtFramework)) {
  throw new Error(`framework not produced at ${builtFramework}`);
}
const stagedFrameworks = join(PKG, 'Frameworks');
const stagedFramework = join(stagedFrameworks, 'SmrtMobile.framework');
rmSync(stagedFramework, { recursive: true, force: true });
mkdirSync(stagedFrameworks, { recursive: true });
cpSync(builtFramework, stagedFramework, { recursive: true });
console.log('› staged SmrtMobile.framework → Frameworks/');

run('plutil', ['-lint', `${SAMPLE}/Info.plist`], PKG);

console.log('› swiftc typecheck (library sources, fast fail)…');
run('xcrun', [
  '-sdk', 'iphonesimulator', 'swiftc', '-parse-as-library', '-typecheck',
  '-swift-version', '5', // mirror the project's language mode (project.yml SWIFT_VERSION)
  '-target', 'arm64-apple-ios17.0-simulator', '-F', 'Frameworks',
  ...swiftSources(join(PKG, SRC)),
], PKG);

run('xcodegen', ['generate'], PKG);

const buildArgs = [
  '-project', 'SmrtIos.xcodeproj', '-scheme', 'SmrtIosSample',
  '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
  'CODE_SIGNING_ALLOWED=NO',
];
console.log('› xcodebuild build (simulator)…');
run('xcodebuild', [...buildArgs, 'build'], PKG);

const udid = resolveSimulatorUDID();
if (udid) {
  console.log(`› xcodebuild test (simulator ${udid})…`);
  run('xcodebuild', [
    '-project', 'SmrtIos.xcodeproj', '-scheme', 'SmrtIosSample',
    '-destination', `platform=iOS Simulator,id=${udid}`, 'CODE_SIGNING_ALLOWED=NO', 'test',
  ], PKG);
} else {
  console.warn('› no iOS simulator resolvable — compiling tests without running them.');
  run('xcodebuild', [...buildArgs, 'build-for-testing'], PKG);
}

console.log('✓ smrt-ios native validation passed.');

// -------------------------------------------------------------------------

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function swiftSources(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.swift')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function resolveSimulatorUDID() {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const devices = JSON.parse(result.stdout).devices ?? {};
    for (const runtime of Object.keys(devices)) {
      if (!runtime.includes('iOS')) continue;
      const iphone = devices[runtime].find((d) => d.isAvailable && /iPhone/.test(d.name));
      if (iphone) return iphone.udid;
    }
  } catch {
    return null;
  }
  return null;
}
