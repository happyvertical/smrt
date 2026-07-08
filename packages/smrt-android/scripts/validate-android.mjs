#!/usr/bin/env node
/**
 * CI-safe structural validation for the smrt-android package (ADR 0001,
 * CI lane (a) — the `validate-android` gate from issue #1742). Checks file
 * layout and load-bearing content patterns WITHOUT requiring a JDK or the
 * Android SDK — the real Gradle compile+test lane is
 * .github/workflows/mobile.yml (lane (b), path-filtered).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

const LIB_ROOT = 'library/src/main/kotlin/com/happyvertical/smrt/android';
const LIB_TEST_ROOT = 'library/src/test/kotlin/com/happyvertical/smrt/android';
const SAMPLE_ROOT = 'sample/src/main';
const NAMESPACE = 'package com.happyvertical.smrt.android';

// One entry per required file; `mustContain` lists load-bearing substrings.
// Kotlin sources under LIB_ROOT additionally get the namespace check.
const SPEC = [
  {
    path: 'package.json',
    mustContain: ['"@happyvertical/smrt-android"', '"private": true'],
  },
  { path: 'AGENTS.md' },
  { path: 'CLAUDE.md' },
  { path: 'README.md' },
  { path: 'turbo.json' },
  { path: 'gradlew' },
  { path: 'gradle/wrapper/gradle-wrapper.jar' },
  {
    path: 'settings.gradle.kts',
    mustContain: [
      'rootProject.name = "smrt-android"',
      'includeBuild("../smrt-mobile")',
      'include(":smrt-android")',
      'include(":sample")',
    ],
  },
  {
    path: 'gradle/libs.versions.toml',
    mustContain: [
      'agp = ',
      'compose-bom = ',
      'mlkit-barcode-scanning = ',
      'mlkit-genai-prompt = ',
      'sqldelight = ',
    ],
  },
  {
    path: 'library/build.gradle.kts',
    mustContain: [
      'group = "com.happyvertical.smrt"',
      'namespace = "com.happyvertical.smrt.android"',
      'api(libs.smrt.mobile)',
      'compose = true',
    ],
  },
  {
    path: 'sample/build.gradle.kts',
    mustContain: [
      'namespace = "com.happyvertical.smrt.android.sample"',
      'implementation(project(":smrt-android"))',
    ],
  },
  {
    path: `${LIB_ROOT}/ui/MobileTheme.kt`,
    mustContain: [
      'fun MobileTheme(',
      'data class MobileStatusColors(',
      'data class MobileSpacing(',
      'fun MobileSectionLabel(',
      'fun MobileResultCard(',
      'fun MobileStatusPill(',
    ],
  },
  {
    path: `${LIB_ROOT}/ui/MobileShellScaffold.kt`,
    mustContain: ['fun MobileShellScaffold(', 'MobileShellState', 'fun MobileTabHeader('],
  },
  {
    path: `${LIB_ROOT}/ui/BarcodeScannerPreview.kt`,
    mustContain: ['fun BarcodeScannerPreview('],
  },
  {
    path: `${LIB_ROOT}/platform/MlKitBarcodeScanner.kt`,
    mustContain: ['class MlKitBarcodeScanner(', ': BarcodeScanner'],
  },
  {
    path: `${LIB_ROOT}/platform/AndroidSpeechTranscriber.kt`,
    mustContain: ['class AndroidSpeechTranscriber(', ': SpeechTranscriber'],
  },
  {
    path: `${LIB_ROOT}/platform/GeminiNanoLanguageModel.kt`,
    mustContain: ['class GeminiNanoLanguageModel', ': OnDeviceLanguageModel'],
  },
  {
    path: `${LIB_ROOT}/platform/AndroidDeviceCapabilityAdapter.kt`,
    mustContain: ['class AndroidDeviceCapabilityAdapter(', ': DeviceCapabilityAdapter'],
  },
  {
    path: `${LIB_ROOT}/platform/AndroidSha256Hasher.kt`,
    mustContain: ['object AndroidSha256Hasher : Sha256Hasher'],
  },
  {
    path: `${LIB_ROOT}/platform/AndroidSqlDriverFactory.kt`,
    mustContain: ['class AndroidSqlDriverFactory(', 'SmrtMobileDatabase.Schema'],
  },
  {
    path: `${LIB_ROOT}/platform/KeystoreAuthStorage.kt`,
    mustContain: ['class KeystoreAuthStorage(', ': AuthStorage', 'AndroidKeyStore'],
  },
  {
    path: `${LIB_ROOT}/platform/CustomTabAuthLauncher.kt`,
    mustContain: ['class CustomTabAuthLauncher(', ': ExternalAuthLauncher'],
  },
  {
    path: `${LIB_ROOT}/platform/AndroidEvidenceCaptureAdapter.kt`,
    mustContain: [
      'class AndroidEvidenceCaptureAdapter(',
      ': EvidenceCapturePlatformAdapter',
      'suspend fun captureOrPickPhoto(',
      'FileProvider.getUriForFile(',
    ],
  },
  {
    path: `${LIB_ROOT}/platform/SmrtEvidenceFileProvider.kt`,
    mustContain: ['class SmrtEvidenceFileProvider : FileProvider('],
  },
  {
    // Library-shipped FileProvider: manifest-merge authority + paths resource.
    path: 'library/src/main/AndroidManifest.xml',
    mustContain: [
      'com.happyvertical.smrt.android.platform.SmrtEvidenceFileProvider',
      '${applicationId}.evidence.files',
    ],
  },
  {
    path: 'library/src/main/res/xml/smrt_evidence_file_paths.xml',
    mustContain: ['<files-path', 'evidence/'],
  },
  { path: `${LIB_TEST_ROOT}/platform/AdapterMappingTest.kt` },
  { path: `${LIB_TEST_ROOT}/platform/EvidenceCaptureMappingTest.kt` },
  {
    path: `${SAMPLE_ROOT}/AndroidManifest.xml`,
    mustContain: [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_FINE_LOCATION',
    ],
  },
  {
    path: `${SAMPLE_ROOT}/kotlin/com/happyvertical/smrt/android/sample/MainActivity.kt`,
    mustContain: ['MobileShellScaffold(', 'MobileTheme {', 'CaptureTab('],
  },
];

const failures = [];
let contentChecks = 0;

for (const { path, mustContain = [] } of SPEC) {
  const absPath = join(PKG, path);
  if (!existsSync(absPath)) {
    failures.push(`missing required file: ${path}`);
    continue;
  }

  const isLibraryKotlinSource = path.startsWith(LIB_ROOT) && path.endsWith('.kt');
  if (mustContain.length === 0 && !isLibraryKotlinSource) continue;

  const content = readFileSync(absPath, 'utf8');
  const required = [...mustContain];
  if (isLibraryKotlinSource) required.push(NAMESPACE);

  for (const needle of required) {
    contentChecks += 1;
    if (!content.includes(needle)) {
      failures.push(`${path}: missing expected content ${JSON.stringify(needle)}`);
    }
  }
}

if (failures.length > 0) {
  console.error('✗ smrt-android validation failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `✓ smrt-android validation passed (${SPEC.length} files, ${contentChecks} content checks).`,
);
