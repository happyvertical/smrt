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
use std::path::{Path, PathBuf};

use serde_json::Value;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {path:?}: {e}"))
}

fn has_remote(capability: &Value) -> bool {
    capability.get("remote").is_some()
}

/// Every file under `dir`, as a `/`-separated path relative to it. Tauri v2
/// loads `capabilities/**/*` (nested directories; `.json`, `.json5`, `.toml`),
/// so nothing may be filtered by extension or depth.
fn walk(dir: &Path) -> Vec<String> {
    fn go(dir: &Path, base: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}")) {
            let path = entry.expect("directory entry").path();
            // `metadata` follows symlinks; a link to a directory is walked.
            if path.is_dir() {
                go(&path, base, out);
            } else {
                let rel = path.strip_prefix(base).expect("under base");
                let parts: Vec<_> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(parts.join("/"));
            }
        }
    }
    let mut out = Vec::new();
    go(dir, dir, &mut out);
    out.sort();
    out
}

/// True when the text declares a `remote` key in any capability format:
/// `"remote":`, `remote:` (json5), `remote =`, `remote.urls =` or a `[remote]`
/// table. Prose such as "is remote content" does not match.
fn declares_remote(text: &str) -> bool {
    let bytes = text.as_bytes();
    let word = b"remote";
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let mut from = 0;
    while let Some(found) = text[from..].find("remote") {
        let start = from + found;
        let end = start + word.len();
        from = end;
        let mut before = start;
        if before > 0 && (bytes[before - 1] == b'"' || bytes[before - 1] == b'\'') {
            before -= 1;
        }
        if before > 0 && ident(bytes[before - 1]) {
            continue;
        }
        let mut after = end;
        if after < bytes.len() && (bytes[after] == b'"' || bytes[after] == b'\'') {
            after += 1;
        }
        while after < bytes.len() && (bytes[after] == b' ' || bytes[after] == b'\t') {
            after += 1;
        }
        if after < bytes.len() && matches!(bytes[after], b':' | b'=' | b'.' | b']') {
            return true;
        }
    }
    false
}

/// Everything wrong with a capabilities directory: any file other than
/// `default.json`, any `remote` key in any file, and a default that grants
/// anything. Empty means the directory is acceptable.
fn capability_violations(dir: &Path) -> Vec<String> {
    let mut violations = Vec::new();
    let files = walk(dir);
    if !files.iter().any(|f| f == "default.json") {
        violations.push("default.json is missing".to_string());
    }
    for name in &files {
        if name != "default.json" {
            violations.push(format!(
                "{name}: only capabilities/default.json may exist; Tauri loads \
                 capabilities/** in every format"
            ));
        }
        let text = fs::read_to_string(dir.join(name)).unwrap_or_default();
        if declares_remote(&text) {
            violations.push(format!("{name}: declares remote"));
        }
        if name == "default.json" {
            match serde_json::from_str::<Value>(&text) {
                Err(_) => violations.push("default.json: not valid JSON".to_string()),
                Ok(value) => {
                    if has_remote(&value) {
                        violations.push("default.json: declares remote".to_string());
                    }
                    let empty = value["permissions"].as_array().is_some_and(Vec::is_empty);
                    if !empty {
                        violations.push("default.json: grants permissions".to_string());
                    }
                }
            }
        }
    }
    violations
}

/// A command handler or runtime capability anywhere under `src/**/*.rs`.
fn source_violations(dir: &Path) -> Vec<String> {
    let mut violations = Vec::new();
    for name in walk(dir).into_iter().filter(|f| f.ends_with(".rs")) {
        let text = fs::read_to_string(dir.join(&name)).unwrap_or_default();
        if text.contains("invoke_handler") || text.contains("generate_handler") {
            violations.push(format!("{name}: registers a command handler"));
        }
        if text.contains("CapabilityBuilder") || text.contains("add_capability") {
            violations.push(format!("{name}: adds a capability at runtime"));
        }
    }
    violations
}

#[test]
fn only_the_default_capability_exists_and_none_grants_remote_ipc() {
    let found = capability_violations(&manifest_dir().join("capabilities"));
    assert!(
        found.is_empty(),
        "{found:#?}; see the module comment: the command allowlist, on_navigation and the \
         origin check must land with any remote capability"
    );
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

#[test]
fn the_shell_sources_register_no_command_handler_or_runtime_capability() {
    let found = source_violations(&manifest_dir().join("src"));
    assert!(
        found.is_empty(),
        "{found:#?}; the preconditions in the module comment must land in the same change"
    );
}

/// A scratch directory seeded with `files`, removed on drop.
struct Fixture(PathBuf);

impl Fixture {
    fn new(tag: &str, files: &[(&str, &str)]) -> Fixture {
        let dir =
            std::env::temp_dir().join(format!("smrt-desktop-caps-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for (name, text) in files {
            let path = dir.join(name);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(path, text).expect("write fixture");
        }
        Fixture(dir)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const OK_DEFAULT: &str = r#"{"identifier":"default","description":"Splash only. The sidecar origin is remote content.","permissions":[]}"#;

#[test]
fn guard_accepts_the_lone_default_capability() {
    let f = Fixture::new("ok", &[("default.json", OK_DEFAULT)]);
    assert_eq!(capability_violations(&f.0), Vec::<String>::new());
}

#[test]
fn guard_catches_a_nested_capability_file() {
    let f = Fixture::new(
        "nested",
        &[
            ("default.json", OK_DEFAULT),
            ("x/y.json", r#"{"identifier":"y","permissions":[]}"#),
        ],
    );
    let found = capability_violations(&f.0).join("\n");
    assert!(
        found.contains("x/y.json: only capabilities/default.json"),
        "{found}"
    );
}

#[test]
fn guard_catches_a_toml_capability_with_a_remote_table() {
    let f = Fixture::new(
        "toml",
        &[
            ("default.json", OK_DEFAULT),
            (
                "sidecar.toml",
                "identifier = \"sidecar\"\n[remote]\nurls = [\"http://127.0.0.1:*\"]\n",
            ),
        ],
    );
    let found = capability_violations(&f.0).join("\n");
    assert!(found.contains("sidecar.toml: only"), "{found}");
    assert!(found.contains("sidecar.toml: declares remote"), "{found}");
}

#[test]
fn guard_catches_a_json5_capability_with_an_unquoted_remote_key() {
    let f = Fixture::new(
        "json5",
        &[
            ("default.json", OK_DEFAULT),
            (
                "a/b/side.json5",
                "{ identifier: 'side', remote: { urls: ['http://127.0.0.1:*'] } }",
            ),
        ],
    );
    let found = capability_violations(&f.0).join("\n");
    assert!(found.contains("a/b/side.json5: declares remote"), "{found}");
}

#[test]
fn guard_catches_a_remote_block_or_a_permission_in_default_json() {
    let remote = Fixture::new(
        "default-remote",
        &[(
            "default.json",
            r#"{"identifier":"default","permissions":[],"remote":{"urls":["http://127.0.0.1:*"]}}"#,
        )],
    );
    assert!(capability_violations(&remote.0)
        .join("\n")
        .contains("default.json: declares remote"));
    let granted = Fixture::new(
        "default-grant",
        &[(
            "default.json",
            r#"{"identifier":"default","permissions":["core:default"]}"#,
        )],
    );
    assert!(capability_violations(&granted.0)
        .join("\n")
        .contains("grants permissions"));
}

#[test]
fn guard_catches_a_handler_or_capability_in_a_nested_source_file() {
    let f = Fixture::new(
        "src",
        &[
            ("lib.rs", "fn main() {}"),
            (
                "a/b/mod.rs",
                "builder.invoke_handler(h); app.add_capability(c);",
            ),
        ],
    );
    assert_eq!(
        source_violations(&f.0),
        vec![
            "a/b/mod.rs: registers a command handler".to_string(),
            "a/b/mod.rs: adds a capability at runtime".to_string(),
        ]
    );
}
