//! Child environment construction and reserved-value precedence.
//!
//! The supervisor owns `HOST`, `PORT`, `ORIGIN` and `SMRT_DATA_DIR`. They are
//! applied last and always win: over the manifest `env` (which the parser
//! already forbids from naming them) and over whatever the parent process
//! inherited, including differently-cased spellings (`Port`, `host`) that a
//! case-insensitive platform would treat as the same variable.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::manifest::SidecarManifest;

/// Values the supervisor injects into the child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorEnv {
    /// Selected loopback port.
    pub port: u16,
    /// Absolute data directory exported as `SMRT_DATA_DIR`.
    pub data_dir: String,
}

impl SupervisorEnv {
    /// `http://127.0.0.1:<port>`; the only origin the app is served from.
    pub fn origin(&self) -> String {
        origin_for(self.port)
    }
}

/// `http://127.0.0.1:<port>`.
pub fn origin_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The address the window opens on: the selected loopback `origin` with the
/// manifest's `ownerClaimRoute` appended, or the bare origin when there is none.
///
/// The route is only ever a path on the origin. The manifest parser already
/// requires one leading slash and rejects `//host`, backslashes, schemes, queries
/// and fragments; a value that is not a plain absolute path is dropped here as
/// well, so a manifest can never move the window to another host.
pub fn window_url(origin: &str, owner_claim_route: Option<&str>) -> String {
    match owner_claim_route {
        Some(route)
            if route.starts_with('/')
                && !route.starts_with("//")
                && !route.contains(['\\', '?', '#', ':', '@']) =>
        {
            format!("{origin}{route}")
        }
        _ => origin.to_owned(),
    }
}

/// Why the data directory could not be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataDirError {
    /// The app data root was not absolute.
    RootNotAbsolute,
    /// The resulting path is not valid UTF-8 and cannot be an env value.
    NotUnicode,
}

impl fmt::Display for DataDirError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootNotAbsolute => f.write_str("the app data directory is not absolute"),
            Self::NotUnicode => f.write_str("the data directory path is not valid Unicode"),
        }
    }
}

impl std::error::Error for DataDirError {}

/// Join the validated, `/`-separated `dataDirectory` onto the app local data
/// dir (Tauri `app_local_data_dir`, never the roaming `app_data_dir`).
///
/// The manifest validator already guarantees relative, dot-free segments, so
/// the join cannot escape `app_local_data_dir`.
pub fn resolve_data_dir(
    app_local_data_dir: &Path,
    data_directory: &str,
) -> Result<PathBuf, DataDirError> {
    if !app_local_data_dir.is_absolute() {
        return Err(DataDirError::RootNotAbsolute);
    }
    let mut path = app_local_data_dir.to_path_buf();
    path.extend(data_directory.split('/'));
    if path.to_str().is_none() {
        return Err(DataDirError::NotUnicode);
    }
    Ok(path)
}

/// Compose the complete child environment (the child is spawned with a
/// cleared environment plus exactly this map).
///
/// Precedence, lowest to highest: inherited, manifest `env`, supervisor.
pub fn build_child_env<I>(
    inherited: I,
    manifest: &SidecarManifest,
    supervisor: &SupervisorEnv,
) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let supplied = |key: &str| {
        crate::manifest::is_reserved_env_key(key)
            || manifest
                .env
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(key))
    };
    let mut env: BTreeMap<String, String> = inherited
        .into_iter()
        .filter(|(key, value)| !supplied(key) && !key.is_empty() && !value.contains('\0'))
        .collect();
    for (key, value) in &manifest.env {
        env.insert(key.clone(), value.clone());
    }
    env.insert("HOST".into(), "127.0.0.1".into());
    env.insert("PORT".into(), supervisor.port.to_string());
    env.insert("ORIGIN".into(), supervisor.origin());
    env.insert("SMRT_DATA_DIR".into(), supervisor.data_dir.clone());
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(env: &str) -> SidecarManifest {
        SidecarManifest::parse(&format!(
            r#"{{"version":1,"executable":"node","args":[],"healthRoute":"/h","dataDirectory":"runtime","env":{env}}}"#
        ))
        .unwrap()
    }

    fn sup() -> SupervisorEnv {
        SupervisorEnv {
            port: 4321,
            data_dir: "/data/app/runtime".into(),
        }
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn the_window_opens_on_the_origin_when_no_owner_route_is_declared() {
        assert_eq!(
            window_url("http://127.0.0.1:4321", None),
            "http://127.0.0.1:4321"
        );
    }

    #[test]
    fn the_owner_route_is_appended_to_the_origin() {
        assert_eq!(
            window_url("http://127.0.0.1:4321", Some("/api/_runtime/owner-link")),
            "http://127.0.0.1:4321/api/_runtime/owner-link"
        );
        assert_eq!(
            window_url("http://127.0.0.1:4321", Some("/")),
            "http://127.0.0.1:4321/"
        );
    }

    #[test]
    fn an_owner_route_is_never_an_absolute_url_or_another_host() {
        for route in [
            "https://evil.example/x",
            "//evil.example/x",
            "evil.example/x",
            "/x?token=1",
            "/x#frag",
            "/\\evil.example",
            "/@evil.example",
            "",
        ] {
            assert_eq!(
                window_url("http://127.0.0.1:4321", Some(route)),
                "http://127.0.0.1:4321",
                "{route}"
            );
        }
    }

    #[test]
    fn supervisor_values_are_always_present() {
        let env = build_child_env(Vec::new(), &manifest("{}"), &sup());
        assert_eq!(env["HOST"], "127.0.0.1");
        assert_eq!(env["PORT"], "4321");
        assert_eq!(env["ORIGIN"], "http://127.0.0.1:4321");
        assert_eq!(env["SMRT_DATA_DIR"], "/data/app/runtime");
        assert_eq!(env.len(), 4);
    }

    #[test]
    fn supervisor_values_beat_inherited_values_including_other_casings() {
        let inherited = pairs(&[
            ("HOST", "0.0.0.0"),
            ("PORT", "80"),
            ("ORIGIN", "https://evil.example"),
            ("SMRT_DATA_DIR", "/elsewhere"),
            ("host", "lower"),
            ("Port", "81"),
            ("smrt_data_dir", "/lower"),
            ("PATH", "/usr/bin"),
        ]);
        let env = build_child_env(inherited, &manifest("{}"), &sup());
        assert_eq!(env["HOST"], "127.0.0.1");
        assert_eq!(env["PORT"], "4321");
        assert_eq!(env["ORIGIN"], "http://127.0.0.1:4321");
        assert_eq!(env["SMRT_DATA_DIR"], "/data/app/runtime");
        assert_eq!(env["PATH"], "/usr/bin");
        assert!(!env.contains_key("host"));
        assert!(!env.contains_key("Port"));
        assert!(!env.contains_key("smrt_data_dir"));
    }

    #[test]
    fn manifest_env_beats_inherited_env_in_any_casing() {
        let inherited = pairs(&[
            ("NODE_ENV", "development"),
            ("node_env", "x"),
            ("KEEP", "1"),
        ]);
        let env = build_child_env(inherited, &manifest(r#"{"NODE_ENV":"production"}"#), &sup());
        assert_eq!(env["NODE_ENV"], "production");
        assert!(!env.contains_key("node_env"));
        assert_eq!(env["KEEP"], "1");
    }

    #[test]
    fn unusable_inherited_entries_are_dropped() {
        let env = build_child_env(
            pairs(&[("", "x"), ("BAD", "a\0b"), ("OK", "1")]),
            &manifest("{}"),
            &sup(),
        );
        assert!(!env.contains_key(""));
        assert!(!env.contains_key("BAD"));
        assert_eq!(env["OK"], "1");
    }

    #[test]
    fn data_dir_joins_segments_under_the_app_local_data_dir() {
        let root = std::env::temp_dir();
        let path = resolve_data_dir(&root, "a/b").unwrap();
        assert_eq!(path, root.join("a").join("b"));
        assert!(path.starts_with(&root));
    }

    #[test]
    fn data_dir_requires_an_absolute_root() {
        assert_eq!(
            resolve_data_dir(Path::new("relative"), "runtime"),
            Err(DataDirError::RootNotAbsolute)
        );
    }

    #[test]
    fn origin_is_loopback_http() {
        assert_eq!(origin_for(1), "http://127.0.0.1:1");
    }
}
