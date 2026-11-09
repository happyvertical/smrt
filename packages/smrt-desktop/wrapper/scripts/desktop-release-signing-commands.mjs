// The commands the desktop-release signing steps may run, and nothing else.
// A step that references `secrets` must match exactly one rule by its `key`
// command, hold only that rule's secrets (each as the exact value of its own
// env entry) and plain env names, and every logical line of its `run` (a `\`
// continuation is joined, comment lines are dropped) must equal one of the
// rule's `lines`. A string is an exact line; a RegExp must be anchored. A
// comment line (first non-blank character `#`) is a comment on its own and
// never joins the line after it, whatever it ends with.
//
// A line is listed here only because the signing step uses it. Adding one is a
// reviewed change to this file, not to the workflow alone. Not allowed, by
// omission: running a script file, an interpreter, `source`, `eval`, `sh -c`,
// `make`, a heredoc, a pipe into an unlisted command, or any package manager.
//
// The other steps of a job that holds a secret are not trusted either: every
// run of the job is checked for builders, installers, downloaders and
// interpreters (`node -e`, python, ...) and for writes to the workflow command
// files ($GITHUB_ENV / $GITHUB_PATH / $GITHUB_OUTPUT / $GITHUB_STATE), because
// a step that sets BASH_ENV, NODE_OPTIONS or PATH there changes what the later
// signing lines execute (`.bin/tauri` is `#!/usr/bin/env node`). The only
// steps that may do any of that are VETTED_STEPS, matched by their exact run
// text, and the exact CLEANUP_STEP is the last step of a job that imports the
// certificate.

/** The one npm command a job that holds secrets may run. */
export const SIGNING_TOOLS_INSTALL =
  'npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org/ --prefix "$WRAPPER_DIR/signing-tools"';

export const SECRET_STEPS = Object.freeze([
  {
    id: 'preflight presence check',
    key: /^node "\$WRAPPER_DIR\/scripts\/release-preflight\.mjs" --secrets /m,
    secrets: [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ],
    env: [
      'PRODUCT_DIR',
      'BRIDGE_PATH',
    ],
    lines: [
      'node "$WRAPPER_DIR/scripts/release-preflight.mjs" --secrets --config "$WRAPPER_DIR/tauri.conf.json" --inputs "$PRODUCT_DIR" "$BRIDGE_PATH"',
    ],
  },
  {
    id: 'certificate import',
    key: /^security import /m,
    secrets: [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
    ],
    env: [],
    lines: [
      'set -euo pipefail',
      'umask 077',
      'keychain="$RUNNER_TEMP/desktop-signing.keychain-db"',
      'cert="$RUNNER_TEMP/desktop-signing-cert.p12"',
      'keychain_password="$(openssl rand -hex 24)"',
      'echo "::add-mask::$keychain_password"',
      'trap \'rm -f "$cert"\' EXIT',
      'security create-keychain -p "$keychain_password" "$keychain"',
      'security set-keychain-settings -lut 21600 "$keychain"',
      'security unlock-keychain -p "$keychain_password" "$keychain"',
      'printf \'%s\' "$APPLE_CERTIFICATE" | base64 --decode > "$cert"',
      'security import "$cert" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign',
      'security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null',
      'existing="$(security list-keychains -d user | tr -d \'"\')"',
      'security list-keychains -d user -s "$keychain" $existing',
    ],
  },
  {
    id: 'codesign and notarize',
    key: /\bxcrun notarytool submit\b/,
    secrets: [
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
    ],
    env: [
      'TARGET',
    ],
    lines: [
      'set -euo pipefail',
      'keychain="$RUNNER_TEMP/desktop-signing.keychain-db"',
      'app="$UNSIGNED_DIR/$PRODUCT_NAME.app"',
      'test -d "$app" || { echo "The unsigned build has no $PRODUCT_NAME.app." >&2; exit 1; }',
      'chmod -R u+rwX "$app"',
      'chmod 755 "$app"/Contents/MacOS/*',
      'sign() {',
      'codesign --force --timestamp --options runtime --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" "$1"',
      '}',
      'notarize() {',
      'result="$(xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait --output-format json)" || { echo "Notarization could not be submitted." >&2; exit 1; }',
      'printf \'%s\' "$result" | grep -Eq \'"status" *: *"Accepted"\' || { echo "Notarization was not accepted." >&2; exit 1; }',
      '}',
      'while IFS= read -r -d \'\' file; do',
      'if file -b "$file" | grep -q \'Mach-O\'; then sign "$file"; fi',
      'done < <(find "$app/Contents" -type f -print0)',
      'sign "$app"',
      'codesign --verify --deep --strict --verbose=2 "$app"',
      'zip="$RUNNER_TEMP/desktop-notarize-app.zip"',
      'ditto -c -k --keepParent "$app" "$zip"',
      'notarize "$zip"',
      'xcrun stapler staple "$app"',
      'arch="${TARGET%%-*}"',
      'dmg_src="$RUNNER_TEMP/desktop-dmg-src"',
      'mkdir -p "$dmg_src" "$SIGNED_DIR/dmg" "$SIGNED_DIR/macos"',
      'ditto "$app" "$dmg_src/$PRODUCT_NAME.app"',
      'ln -s /Applications "$dmg_src/Applications"',
      'dmg="$SIGNED_DIR/dmg/${PRODUCT_NAME}_${PRODUCT_VERSION}_${arch}.dmg"',
      'hdiutil create -volname "$PRODUCT_NAME" -srcfolder "$dmg_src" -ov -format UDZO "$dmg"',
      'sign "$dmg"',
      'notarize "$dmg"',
      'xcrun stapler staple "$dmg"',
      'COPYFILE_DISABLE=1 tar -czf "$SIGNED_DIR/macos/$PRODUCT_NAME.app.tar.gz" -C "$UNSIGNED_DIR" "$PRODUCT_NAME.app"',
    ],
  },
  {
    id: 'updater signature',
    key: /\/signing-tools\/node_modules\/\.bin\/tauri" signer sign /,
    secrets: [
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ],
    env: [],
    lines: [
      'set -euo pipefail',
      'shopt -s nullglob',
      'if [ "$RUNNER_OS" = macOS ]; then',
      'payloads=("$SIGNED_DIR"/macos/*.app.tar.gz)',
      'else',
      'payloads=("$SIGNED_DIR"/nsis/*-setup.exe)',
      'fi',
      'test "${#payloads[@]}" -eq 1',
      '"$GITHUB_WORKSPACE/$WRAPPER_DIR/signing-tools/node_modules/.bin/tauri" signer sign "${payloads[0]}"',
    ],
  },
]);

// Steps without a secret that sit in a job with one and may still build,
// install, run an interpreter or write a workflow command file. Each is matched
// by its EXACT `run` text (the parsed string, trailing newlines aside) and may
// carry only the keys name / id / if / env / run, with env names from `env`.
// Every name they write to GITHUB_ENV is listed in `writes`; none is PATH,
// BASH_ENV, NODE_OPTIONS, LD_*, DYLD_* or ENV.
export const VETTED_STEPS = Object.freeze([
  {
    id: 'export the working directories',
    env: [],
    writes: ['UNSIGNED_DIR', 'SIGNED_DIR', 'OVERLAY_FILE'],
    run: [
      '{',
      '  echo "UNSIGNED_DIR=$RUNNER_TEMP/desktop-unsigned"',
      '  echo "SIGNED_DIR=$RUNNER_TEMP/desktop-signed"',
      '  echo "OVERLAY_FILE=$RUNNER_TEMP/desktop-overlay.json"',
      '} >> "$GITHUB_ENV"',
      'rm -rf "$RUNNER_TEMP/desktop-bundle" "$RUNNER_TEMP/desktop-unsigned" "$RUNNER_TEMP/desktop-signed"',
      'mkdir -p "$RUNNER_TEMP/desktop-bundle" "$RUNNER_TEMP/desktop-unsigned" "$RUNNER_TEMP/desktop-signed"',
    ].join('\n'),
  },
  {
    id: 're-verify the bundle and read the product identity',
    env: ['TARGET'],
    writes: ['PRODUCT_NAME', 'PRODUCT_VERSION'],
    run: [
      'node "$WRAPPER_DIR/scripts/release-preflight.mjs" \\',
      '  --config "$WRAPPER_DIR/tauri.conf.json" \\',
      '  --bundle "$RUNNER_TEMP/desktop-bundle" \\',
      '  --target "$TARGET" \\',
      '  --node-pins packages/smrt-desktop/src/bundler/node-pins.ts \\',
      '  --write-overlay "$OVERLAY_FILE"',
      "node -e '",
      '  const o = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));',
      '  process.stdout.write("PRODUCT_NAME=" + o.productName + "\\n");',
      '  process.stdout.write("PRODUCT_VERSION=" + o.version + "\\n");',
      '\' "$OVERLAY_FILE" >> "$GITHUB_ENV"',
    ].join('\n'),
  },
  {
    id: 'install the locked Tauri CLI',
    env: [],
    writes: [],
    run: SIGNING_TOOLS_INSTALL,
  },
]);

// The last step of a job that imports the certificate: exactly this `run`,
// `if: always()`, and only the keys name / if / run. A look at the lines alone
// would let an `exit 0` in front, or an `if false` around, skip the deletion.
export const CLEANUP_STEP = Object.freeze({
  id: 'always() cleanup',
  run: [
    'if [ "$RUNNER_OS" = macOS ]; then',
    '  security delete-keychain "$RUNNER_TEMP/desktop-signing.keychain-db" || true',
    'fi',
    'rm -rf "$WRAPPER_DIR/signing-tools/node_modules"',
    'rm -rf "$RUNNER_TEMP"/desktop-* .desktop-leg',
  ].join('\n'),
});
