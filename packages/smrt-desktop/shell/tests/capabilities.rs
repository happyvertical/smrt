//! Guard: the sidecar origin gets no IPC until its preconditions land.
//!
//! The credential contract (README, "Webview helper") needs four native
//! commands callable from the sidecar's loopback origin. That is remote
//! content reaching IPC, and it is safe only if three things land in the SAME
//! change as the capability, never after it:
//!
//! 1. an `AppManifest` command allowlist in `build.rs`;
//! 2. `on_navigation` on the main window, pinned to the ready origin;
//! 3. the per-command check that the invoking origin equals the ready origin.
//!
//! None exists yet, so no capability may carry a `remote` block. A glob such
//! as `http://127.0.0.1:*` matches every loopback port, so once it is added
//! every registered command is reachable from any loopback page the webview
//! lands on. If you are here because this test failed: do not edit the test,
//! build the three preconditions, then replace this guard with tests for them.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &PathBuf) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {path:?}: {e}"))
}

fn has_remote(capability: &Value) -> bool {
    capability.get("remote").is_some()
}

#[test]
fn no_capability_file_grants_remote_ipc() {
    let dir = manifest_dir().join("capabilities");
    let mut seen = 0;
    for entry in fs::read_dir(&dir).expect("capabilities directory") {
        let path = entry.expect("directory entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        seen += 1;
        let capability = read_json(&path);
        assert!(
            !has_remote(&capability),
            "{path:?} grants remote IPC; see the module comment: the command allowlist, \
             on_navigation and the origin check must land with it"
        );
    }
    assert!(seen > 0, "expected at least the default capability");
}

#[test]
fn the_default_capability_is_the_splash_window_only() {
    let capability = read_json(&manifest_dir().join("capabilities").join("default.json"));
    assert_eq!(capability["identifier"], "default");
    assert!(!has_remote(&capability));
    let permissions = capability["permissions"].as_array().expect("permissions");
    assert!(
        permissions.is_empty(),
        "the default capability grants the splash window nothing: {permissions:?}"
    );
}

#[test]
fn tauri_conf_declares_no_inline_remote_capability() {
    let conf = read_json(&manifest_dir().join("tauri.conf.json"));
    let inline = conf["app"]["security"]["capabilities"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for capability in inline {
        // A string is a reference to a file in `capabilities/`, checked above.
        if capability.is_object() {
            assert!(
                !has_remote(&capability),
                "tauri.conf.json declares an inline remote capability"
            );
        }
    }
}
