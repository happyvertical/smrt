//! Child environment construction and reserved-value precedence.
//!
//! The supervisor owns `HOST`, `PORT`, `ORIGIN`, `SMRT_DATA_DIR`,
//! `SMRT_DESKTOP_OWNER_LINK_SECRET` and `SMRT_DESKTOP_KEYCHAIN`. They are applied last and always win: over the manifest `env` (which the parser
//! already forbids from naming them) and over whatever the parent process
//! inherited, including differently-cased spellings (`Port`, `host`) that a
//! case-insensitive platform would treat as the same variable.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::manifest::SidecarManifest;

/// The reserved environment name that carries the launch secret to the sidecar.
pub const OWNER_LINK_SECRET_ENV: &str = "SMRT_DESKTOP_OWNER_LINK_SECRET";

/// The reserved environment name that tells the sidecar's runtime to keep vault
/// key material in the OS keychain. It carries no secret; the value is always
/// `1` and only the supervisor sets it.
pub const KEYCHAIN_ENV: &str = "SMRT_DESKTOP_KEYCHAIN";

/// Random bytes in a launch secret.
pub const LAUNCH_SECRET_BYTES: usize = 32;

/// Length of the lowercase-hex encoding of a launch secret.
pub const LAUNCH_SECRET_HEX_LEN: usize = LAUNCH_SECRET_BYTES * 2;

/// A per-launch secret: 32 bytes from the OS random source, held as 64
/// lowercase hex characters.
///
/// It proves to the owner-link route that the request comes from the window
/// this wrapper opened, not from another process or user on the machine. It
/// is exported only to the sidecar child and put only in the window's query
/// string. `Debug` never prints it, so phases and plans that hold one stay
/// loggable.
#[derive(Clone, PartialEq, Eq)]
pub struct LaunchSecret(String);

impl LaunchSecret {
    /// Draw a new secret from the OS random source (never a seeded PRNG).
    pub fn generate() -> Result<Self, getrandom::Error> {
        let mut bytes = [0u8; LAUNCH_SECRET_BYTES];
        getrandom::fill(&mut bytes)?;
        Ok(Self::from_bytes(&bytes))
    }

    /// Hex-encode fixed bytes (tests and `generate`).
    pub fn from_bytes(bytes: &[u8; LAUNCH_SECRET_BYTES]) -> Self {
        let mut hex = String::with_capacity(LAUNCH_SECRET_HEX_LEN);
        for byte in bytes {
            hex.push_str(&format!("{byte:02x}"));
        }
        Self(hex)
    }

    /// The secret text. Callers must not log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LaunchSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LaunchSecret(<redacted>)")
    }
}

/// Values the supervisor injects into the child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorEnv {
    /// Selected loopback port.
    pub port: u16,
    /// Absolute data directory exported as `SMRT_DATA_DIR`.
    pub data_dir: String,
    /// Fresh secret exported as `SMRT_DESKTOP_OWNER_LINK_SECRET`.
    pub launch_secret: LaunchSecret,
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
/// manifest's `ownerClaimRoute` and `?launch=<secret>` appended, or the bare
/// origin (no secret) when there is no usable route.
///
/// The route is only ever a path on the origin. The manifest parser already
/// requires one leading slash and rejects `//host`, backslashes, schemes, queries
/// and fragments; a value that is not a plain absolute path is dropped here as
/// well, so a manifest can never move the window to another host. The secret
/// is only added to a claim route; the bare origin never carries it. The
/// result holds the secret: never log it.
pub fn window_url(
    origin: &str,
    owner_claim_route: Option<&str>,
    launch_secret: &LaunchSecret,
) -> String {
    match owner_claim_route {
        Some(route)
            if route.starts_with('/')
                && !route.starts_with("//")
                && !route.contains(['\\', '?', '#', ':', '@']) =>
        {
            format!("{origin}{route}?launch={}", launch_secret.expose())
        }
        _ => origin.to_owned(),
    }
}

/// The log line for opening the window: origin and route only, never the
/// secret, the query string or the full URL.
pub fn window_log_line(origin: &str, owner_claim_route: Option<&str>) -> String {
    format!(
        "window origin={origin} route={}",
        owner_claim_route.unwrap_or("/")
    )
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
    env.insert(
        OWNER_LINK_SECRET_ENV.into(),
        supervisor.launch_secret.expose().to_owned(),
    );
    env.insert(KEYCHAIN_ENV.into(), "1".into());
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
            launch_secret: LaunchSecret::from_bytes(&[0xab; LAUNCH_SECRET_BYTES]),
        }
    }

    fn secret() -> LaunchSecret {
        sup().launch_secret
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
            window_url("http://127.0.0.1:4321", None, &secret()),
            "http://127.0.0.1:4321"
        );
    }

    #[test]
    fn the_owner_route_is_appended_to_the_origin() {
        assert_eq!(
            window_url(
                "http://127.0.0.1:4321",
                Some("/api/_runtime/owner-link"),
                &secret()
            ),
            format!(
                "http://127.0.0.1:4321/api/_runtime/owner-link?launch={}",
                "ab".repeat(32)
            )
        );
        assert_eq!(
            window_url("http://127.0.0.1:4321", Some("/"), &secret()),
            format!("http://127.0.0.1:4321/?launch={}", "ab".repeat(32))
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
                window_url("http://127.0.0.1:4321", Some(route), &secret()),
                "http://127.0.0.1:4321",
                "{route}"
            );
        }
    }

    #[test]
    fn the_secret_is_only_added_when_a_route_is_set() {
        let bare = window_url("http://127.0.0.1:4321", None, &secret());
        assert!(!bare.contains(&"ab".repeat(32)));
        assert!(!bare.contains('?'));
    }

    #[test]
    fn the_log_line_names_origin_and_route_but_never_the_secret() {
        let secret = secret();
        for route in [Some("/api/_runtime/owner-link"), None] {
            let line = window_log_line("http://127.0.0.1:4321", route);
            assert!(!line.contains(secret.expose()), "{line}");
            assert!(!line.contains("launch"), "{line}");
            assert!(!line.contains('?'), "{line}");
        }
        assert_eq!(
            window_log_line("http://127.0.0.1:4321", Some("/api/_runtime/owner-link")),
            "window origin=http://127.0.0.1:4321 route=/api/_runtime/owner-link"
        );
        assert!(!format!("{secret:?}").contains(secret.expose()));
    }

    #[test]
    fn a_launch_secret_is_32_random_bytes_in_lowercase_hex() {
        let first = LaunchSecret::generate().unwrap();
        let second = LaunchSecret::generate().unwrap();
        for secret in [&first, &second] {
            assert_eq!(secret.expose().len(), LAUNCH_SECRET_HEX_LEN);
            assert_eq!(LAUNCH_SECRET_HEX_LEN, 64);
            assert!(secret
                .expose()
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        }
        assert_ne!(first, second);
        assert_eq!(
            LaunchSecret::from_bytes(&[0x0f; LAUNCH_SECRET_BYTES]).expose(),
            "0f".repeat(32)
        );
    }

    #[test]
    fn the_secret_env_name_is_reserved_in_the_manifest_list() {
        assert!(crate::manifest::is_reserved_env_key(OWNER_LINK_SECRET_ENV));
        assert!(crate::manifest::is_reserved_env_key(
            "smrt_desktop_owner_link_secret"
        ));
    }

    #[test]
    fn supervisor_values_are_always_present() {
        let env = build_child_env(Vec::new(), &manifest("{}"), &sup());
        assert_eq!(env["HOST"], "127.0.0.1");
        assert_eq!(env["PORT"], "4321");
        assert_eq!(env["ORIGIN"], "http://127.0.0.1:4321");
        assert_eq!(env["SMRT_DATA_DIR"], "/data/app/runtime");
        assert_eq!(env[OWNER_LINK_SECRET_ENV], "ab".repeat(32));
        assert_eq!(env[KEYCHAIN_ENV], "1");
        assert_eq!(env.len(), 6);
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
            ("SMRT_DESKTOP_OWNER_LINK_SECRET", "inherited"),
            ("smrt_desktop_owner_link_secret", "lower"),
            ("SMRT_DESKTOP_KEYCHAIN", "0"),
            ("smrt_desktop_keychain", "0"),
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
        assert_eq!(env[OWNER_LINK_SECRET_ENV], "ab".repeat(32));
        assert!(!env.contains_key("smrt_desktop_owner_link_secret"));
        assert_eq!(env[KEYCHAIN_ENV], "1");
        assert!(!env.contains_key("smrt_desktop_keychain"));
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
