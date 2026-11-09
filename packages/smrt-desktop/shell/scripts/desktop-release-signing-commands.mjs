// The commands the desktop-release signing steps may run, and nothing else.
// A step that references `secrets` must match exactly one rule by its `key`
// command, hold only that rule's secrets (each as the exact value of its own
// env entry) and plain env names, and every logical line of its `run` (a `\`
// continuation is joined, comment lines are dropped) must equal one of the
// rule's `lines`. A string is an exact line; a RegExp must be anchored.
//
// A line is listed here only because the signing step uses it. Adding one is a
// reviewed change to this file, not to the workflow alone. Not allowed, by
// omission: running a script file, an interpreter, `source`, `eval`, `sh -c`,
// `make`, a heredoc, a pipe into an unlisted command, or any package manager.

export const SECRET_STEPS = Object.freeze([
  {
    id: 'preflight presence check',
    key: /^node "\$SHELL_DIR\/scripts\/release-preflight\.mjs" --secrets /m,
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
      'node "$SHELL_DIR/scripts/release-preflight.mjs" --secrets --config "$SHELL_DIR/tauri.conf.json" --inputs "$PRODUCT_DIR" "$BRIDGE_PATH"',
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
      '"$PWD/$SHELL_DIR/signing-tools/node_modules/.bin/tauri" signer sign "${payloads[0]}"',
    ],
  },
]);
