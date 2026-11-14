//! Strict parser for the v1 sidecar manifest.
//!
//! Mirrors the TypeScript contract in `@happyvertical/smrt-desktop`
//! (`src/sidecar-manifest.ts`, documented in the package README). The manifest
//! is loaded from the installed bundle and is therefore trusted, but it is
//! still parsed strictly: the schema is closed, duplicate keys are rejected
//! (plain `serde_json::Value` would silently keep the last one), and every
//! field is validated lexically with the same rules on every platform.
//!
//! Diagnostics name the failing field and never echo manifest values.

use std::collections::BTreeSet;
use std::fmt;

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;

/// Upper bound for a manifest file; the real thing is a few hundred bytes.
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// Environment names the supervisor owns (compared case-insensitively).
pub const RESERVED_ENV_KEYS: [&str; 6] = [
    "HOST",
    "PORT",
    "ORIGIN",
    "SMRT_DATA_DIR",
    "SMRT_DESKTOP_OWNER_LINK_SECRET",
    "SMRT_DESKTOP_KEYCHAIN",
];

const WINDOWS_DEVICE_STEMS: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

/// Why a manifest was rejected. Messages never include manifest values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    /// The document is not valid JSON, or has a wrong shape or type.
    Malformed(String),
    /// A field is present twice.
    DuplicateKey(String),
    /// A field outside the closed v1 schema.
    UnknownKey(String),
    /// A required field is absent.
    MissingField(&'static str),
    /// `version` is not `1`.
    UnsupportedVersion,
    /// A field failed lexical validation.
    InvalidField {
        /// Field name, e.g. `healthRoute` or `env.KEY`.
        field: &'static str,
        /// What was wrong, in fixed words.
        reason: &'static str,
    },
    /// The document exceeds [`MAX_MANIFEST_BYTES`].
    TooLarge,
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(why) => write!(f, "sidecar manifest is malformed: {why}"),
            Self::DuplicateKey(key) => {
                write!(f, "sidecar manifest repeats the field `{key}`")
            }
            Self::UnknownKey(key) => {
                write!(f, "sidecar manifest has an unknown field `{key}`")
            }
            Self::MissingField(field) => {
                write!(f, "sidecar manifest is missing the field `{field}`")
            }
            Self::UnsupportedVersion => write!(f, "sidecar manifest version must be 1"),
            Self::InvalidField { field, reason } => {
                write!(f, "sidecar manifest field `{field}` is invalid: {reason}")
            }
            Self::TooLarge => write!(f, "sidecar manifest is too large"),
        }
    }
}

impl std::error::Error for ManifestError {}

/// File name of the manifest inside the bundled resource directory.
pub const MANIFEST_FILE_NAME: &str = "sidecar-manifest.json";

/// Read and parse a manifest file, bounding the read at [`MAX_MANIFEST_BYTES`].
pub fn read_manifest_file(path: &std::path::Path) -> Result<SidecarManifest, String> {
    use std::io::Read;
    let file = std::fs::File::open(path)
        .map_err(|error| format!("cannot read the sidecar manifest ({})", error.kind()))?;
    let mut text = String::new();
    file.take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("cannot read the sidecar manifest ({})", error.kind()))?;
    SidecarManifest::parse(&text).map_err(|error| error.to_string())
}

/// A validated v1 manifest snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarManifest {
    /// Logical `externalBin` basename; Tauri adds the target suffix at launch.
    pub executable: String,
    /// Literal arguments passed to the executable.
    pub args: Vec<String>,
    /// Optional app-root cwd; absent preserves the resource-root contract.
    pub working_directory: Option<String>,
    /// Path probed on the selected loopback origin.
    pub health_route: String,
    /// Portable path under the Tauri app local data dir, exported as `SMRT_DATA_DIR`.
    pub data_directory: String,
    /// Extra child environment, in manifest order.
    pub env: Vec<(String, String)>,
    /// Path on the selected origin the window opens on (appended to the origin,
    /// never an absolute URL). The runtime answers it with a redirect to its
    /// loopback owner setup link while the owner is unclaimed, `/` after.
    pub owner_claim_route: Option<String>,
}

impl SidecarManifest {
    /// Parse and validate manifest JSON.
    pub fn parse(json: &str) -> Result<Self, ManifestError> {
        if json.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge);
        }
        let raw: RawManifest = serde_json::from_str(json).map_err(map_serde_error)?;
        raw.validate()
    }
}

/// Fixed prefixes used to smuggle our typed errors through serde's error type.
const DUP_PREFIX: &str = "\u{0}dup:";
const UNKNOWN_PREFIX: &str = "\u{0}unknown:";

fn map_serde_error(error: serde_json::Error) -> ManifestError {
    let text = error.to_string();
    // serde_json appends " at line N column M" to custom messages.
    if let Some(rest) = text.strip_prefix(DUP_PREFIX) {
        return ManifestError::DuplicateKey(strip_position(rest).to_owned());
    }
    if let Some(rest) = text.strip_prefix(UNKNOWN_PREFIX) {
        return ManifestError::UnknownKey(strip_position(rest).to_owned());
    }
    // Only the category and position: serde messages can quote input values.
    let why = match error.classify() {
        serde_json::error::Category::Io => "unreadable",
        serde_json::error::Category::Syntax => "invalid JSON syntax",
        serde_json::error::Category::Data => "unexpected shape or type",
        serde_json::error::Category::Eof => "truncated JSON",
    };
    ManifestError::Malformed(why.to_owned())
}

fn strip_position(text: &str) -> &str {
    match text.rfind(" at line ") {
        Some(index) => &text[..index],
        None => text,
    }
}

#[derive(Default)]
struct RawManifest {
    version: Option<Version>,
    executable: Option<String>,
    args: Option<Vec<String>>,
    working_directory: Option<String>,
    health_route: Option<String>,
    data_directory: Option<String>,
    env: Option<Vec<(String, String)>>,
    owner_claim_route: Option<String>,
}

/// `version` accepted as JSON number `1`, matching JavaScript's `=== 1`.
struct Version(bool);

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Version;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("the number 1")
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Version, E> {
                Ok(Version(v == 1))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Version, E> {
                Ok(Version(v == 1))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Version, E> {
                Ok(Version(v == 1.0))
            }
        }
        deserializer.deserialize_any(V)
    }
}

/// `env` object collected as an ordered list so duplicates are detectable.
struct EnvPairs(Vec<(String, String)>);

impl<'de> Deserialize<'de> for EnvPairs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = EnvPairs;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of strings")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<EnvPairs, A::Error> {
                let mut seen = BTreeSet::new();
                let mut pairs = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(de::Error::custom(format!("{DUP_PREFIX}env.{key}")));
                    }
                    pairs.push((key, value));
                }
                Ok(EnvPairs(pairs))
            }
        }
        deserializer.deserialize_map(V)
    }
}

/// `args` array; strings only (no coercion).
struct Args(Vec<String>);

impl<'de> Deserialize<'de> for Args {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Args;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an array of strings")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Args, A::Error> {
                let mut out = Vec::new();
                while let Some(item) = seq.next_element::<String>()? {
                    out.push(item);
                }
                Ok(Args(out))
            }
        }
        deserializer.deserialize_seq(V)
    }
}

impl<'de> Deserialize<'de> for RawManifest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = RawManifest;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a manifest object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawManifest, A::Error> {
                let mut raw = RawManifest::default();
                while let Some(key) = map.next_key::<String>()? {
                    macro_rules! once {
                        ($slot:expr, $name:literal, $ty:ty) => {{
                            if $slot.is_some() {
                                return Err(de::Error::custom(format!("{DUP_PREFIX}{}", $name)));
                            }
                            $slot = Some(map.next_value::<$ty>()?);
                        }};
                    }
                    match key.as_str() {
                        "version" => once!(raw.version, "version", Version),
                        "executable" => once!(raw.executable, "executable", String),
                        "args" => {
                            if raw.args.is_some() {
                                return Err(de::Error::custom(format!("{DUP_PREFIX}args")));
                            }
                            raw.args = Some(map.next_value::<Args>()?.0);
                        }
                        "workingDirectory" => {
                            once!(raw.working_directory, "workingDirectory", String)
                        }
                        "healthRoute" => once!(raw.health_route, "healthRoute", String),
                        "dataDirectory" => once!(raw.data_directory, "dataDirectory", String),
                        "env" => {
                            if raw.env.is_some() {
                                return Err(de::Error::custom(format!("{DUP_PREFIX}env")));
                            }
                            raw.env = Some(map.next_value::<EnvPairs>()?.0);
                        }
                        "ownerClaimRoute" => {
                            once!(raw.owner_claim_route, "ownerClaimRoute", String)
                        }
                        other => {
                            return Err(de::Error::custom(format!("{UNKNOWN_PREFIX}{other}")));
                        }
                    }
                }
                Ok(raw)
            }
        }
        deserializer.deserialize_map(V)
    }
}

impl RawManifest {
    fn validate(self) -> Result<SidecarManifest, ManifestError> {
        match self.version {
            None => return Err(ManifestError::MissingField("version")),
            Some(Version(false)) => return Err(ManifestError::UnsupportedVersion),
            Some(Version(true)) => {}
        }
        let executable = self
            .executable
            .ok_or(ManifestError::MissingField("executable"))?;
        let args = self.args.ok_or(ManifestError::MissingField("args"))?;
        let health_route = self
            .health_route
            .ok_or(ManifestError::MissingField("healthRoute"))?;
        let data_directory = self
            .data_directory
            .ok_or(ManifestError::MissingField("dataDirectory"))?;

        validate_executable(&executable)?;
        for arg in &args {
            if arg.contains('\0') {
                return Err(ManifestError::InvalidField {
                    field: "args",
                    reason: "contains NUL",
                });
            }
        }
        if self
            .working_directory
            .as_deref()
            .is_some_and(|dir| dir != "app")
        {
            return Err(invalid("workingDirectory", "must be app"));
        }
        validate_route("healthRoute", &health_route)?;
        validate_portable_path("dataDirectory", &data_directory)?;
        if let Some(route) = &self.owner_claim_route {
            validate_route("ownerClaimRoute", route)?;
        }
        let env = self.env.unwrap_or_default();
        validate_env(&env)?;

        Ok(SidecarManifest {
            executable,
            args,
            working_directory: self.working_directory,
            health_route,
            data_directory,
            env,
            owner_claim_route: self.owner_claim_route,
        })
    }
}

fn invalid(field: &'static str, reason: &'static str) -> ManifestError {
    ManifestError::InvalidField { field, reason }
}

fn is_segment_start(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn is_segment_rest(c: char) -> bool {
    is_segment_start(c) || c == '.'
}

fn validate_segment(field: &'static str, segment: &str) -> Result<(), ManifestError> {
    let mut chars = segment.chars();
    match chars.next() {
        None => return Err(invalid(field, "empty segment")),
        Some(c) if !is_segment_start(c) => {
            return Err(invalid(field, "segment has a disallowed first character"))
        }
        Some(_) => {}
    }
    if !chars.all(is_segment_rest) {
        return Err(invalid(field, "segment has a disallowed character"));
    }
    if segment.ends_with('.') {
        return Err(invalid(field, "segment ends with a period"));
    }
    // Windows treats `CON`, `CON.txt`, `com1.tar.gz` ... as devices.
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
    };
    if WINDOWS_DEVICE_STEMS.contains(&stem.as_str()) || numbered("COM") || numbered("LPT") {
        return Err(invalid(field, "reserved Windows device name"));
    }
    Ok(())
}

/// `executable`: one portable segment (no `/`).
pub fn validate_executable(value: &str) -> Result<(), ManifestError> {
    if value.contains('/') {
        return Err(invalid("executable", "must be a single path segment"));
    }
    validate_segment("executable", value)
}

/// `dataDirectory`: `/`-separated portable segments, relative.
pub fn validate_portable_path(field: &'static str, value: &str) -> Result<(), ManifestError> {
    if value.is_empty() {
        return Err(invalid(field, "empty path"));
    }
    value
        .split('/')
        .try_for_each(|segment| validate_segment(field, segment))
}

/// `healthRoute` / `ownerClaimRoute` grammar.
pub fn validate_route(field: &'static str, value: &str) -> Result<(), ManifestError> {
    let Some(rest) = value.strip_prefix('/') else {
        return Err(invalid(field, "must begin with a single slash"));
    };
    if rest.is_empty() {
        return Ok(());
    }
    let body = rest.strip_suffix('/').unwrap_or(rest);
    if body.is_empty() {
        return Err(invalid(field, "empty segment"));
    }
    for segment in body.split('/') {
        if segment.is_empty() {
            return Err(invalid(field, "empty segment"));
        }
        if segment == "." || segment == ".." {
            return Err(invalid(field, "dot segment"));
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
        {
            return Err(invalid(field, "disallowed character"));
        }
    }
    Ok(())
}

/// Environment name grammar: `^[A-Za-z_][A-Za-z0-9_]*$`.
pub fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether `key` is one of the supervisor-owned names, ignoring case.
pub fn is_reserved_env_key(key: &str) -> bool {
    RESERVED_ENV_KEYS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(key))
}

fn validate_env(env: &[(String, String)]) -> Result<(), ManifestError> {
    let mut seen = BTreeSet::new();
    for (key, value) in env {
        if !is_valid_env_key(key) {
            return Err(invalid("env", "key is not a valid environment name"));
        }
        if is_reserved_env_key(key) {
            return Err(invalid("env", "key is reserved by the supervisor"));
        }
        if !seen.insert(key.to_ascii_uppercase()) {
            return Err(invalid("env", "keys collide case-insensitively"));
        }
        if value.contains('\0') {
            return Err(invalid("env", "value contains NUL"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
      "version": 1,
      "executable": "node",
      "args": ["build/index.js"],
      "healthRoute": "/api/_runtime/health",
      "dataDirectory": "runtime"
    }"#;

    fn with(field: &str, value: &str) -> String {
        let mut doc: serde_json::Value = serde_json::from_str(GOOD).unwrap();
        doc[field] = serde_json::from_str(value).unwrap();
        doc.to_string()
    }

    fn err(json: &str) -> ManifestError {
        SidecarManifest::parse(json).unwrap_err()
    }

    #[test]
    fn parses_the_documented_example() {
        let m = SidecarManifest::parse(GOOD).unwrap();
        assert_eq!(m.executable, "node");
        assert_eq!(m.args, vec!["build/index.js"]);
        assert_eq!(m.health_route, "/api/_runtime/health");
        assert_eq!(m.data_directory, "runtime");
        assert!(m.env.is_empty());
        assert_eq!(m.owner_claim_route, None);
    }

    #[test]
    fn parses_optional_fields() {
        let json = with(
            "env",
            r#"{"NODE_ENV":"production","Z_LAST":"1","A_FIRST":""}"#,
        );
        let mut doc: serde_json::Value = serde_json::from_str(&json).unwrap();
        doc["ownerClaimRoute"] = "/owner/claim/".into();
        let m = SidecarManifest::parse(&doc.to_string()).unwrap();
        assert_eq!(m.owner_claim_route.as_deref(), Some("/owner/claim/"));
        assert_eq!(m.env.len(), 3);
        assert!(m.env.contains(&("A_FIRST".into(), String::new())));
    }

    #[test]
    fn accepts_version_one_point_zero_like_javascript() {
        let json = GOOD.replace("\"version\": 1", "\"version\": 1.0");
        assert!(SidecarManifest::parse(&json).is_ok());
    }

    #[test]
    fn rejects_other_versions_and_types() {
        for bad in ["2", "0", "\"1\"", "true", "null", "1.5"] {
            let json = GOOD.replace("\"version\": 1", &format!("\"version\": {bad}"));
            assert!(SidecarManifest::parse(&json).is_err(), "version {bad}");
        }
        assert_eq!(
            err(&GOOD.replace("\"version\": 1", "\"version\": 2")),
            ManifestError::UnsupportedVersion
        );
    }

    #[test]
    fn rejects_missing_required_fields() {
        for field in [
            "version",
            "executable",
            "args",
            "healthRoute",
            "dataDirectory",
        ] {
            let mut doc: serde_json::Value = serde_json::from_str(GOOD).unwrap();
            doc.as_object_mut().unwrap().remove(field);
            assert!(
                matches!(err(&doc.to_string()), ManifestError::MissingField(f) if f == field),
                "{field}"
            );
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let json = GOOD.replace("\"version\": 1,", "\"version\": 1, \"shell\": true,");
        assert_eq!(err(&json), ManifestError::UnknownKey("shell".into()));
    }

    #[test]
    fn rejects_duplicate_keys_anywhere() {
        let json = GOOD.replace("\"version\": 1,", "\"version\": 1, \"version\": 1,");
        assert_eq!(err(&json), ManifestError::DuplicateKey("version".into()));
        let json = GOOD.replace(
            "\"dataDirectory\": \"runtime\"",
            "\"dataDirectory\": \"a\", \"dataDirectory\": \"b\"",
        );
        assert_eq!(
            err(&json),
            ManifestError::DuplicateKey("dataDirectory".into())
        );
        let json = GOOD.replace(
            "\"dataDirectory\": \"runtime\"",
            "\"dataDirectory\": \"runtime\", \"env\": {\"A\": \"1\", \"A\": \"2\"}",
        );
        assert_eq!(err(&json), ManifestError::DuplicateKey("env.A".into()));
        let json = GOOD.replace(
            "\"dataDirectory\": \"runtime\"",
            "\"dataDirectory\": \"runtime\", \"env\": {}, \"env\": {}",
        );
        assert_eq!(err(&json), ManifestError::DuplicateKey("env".into()));
    }

    #[test]
    fn rejects_malformed_documents_without_echoing_values() {
        for bad in ["", "[]", "null", "{", "{} trailing", "\u{feff}{}"] {
            assert!(SidecarManifest::parse(bad).is_err(), "{bad:?}");
        }
        let json = GOOD.replace("\"build/index.js\"", "5");
        let message = err(&json).to_string();
        assert!(!message.contains("build/index.js"));
        let secret = r#"{"version":1,"executable":"node","args":[],"healthRoute":"/h","dataDirectory":"d","env":{"A":7}}"#;
        assert!(matches!(err(secret), ManifestError::Malformed(_)));
    }

    #[test]
    fn rejects_lone_surrogates_and_nul_in_args() {
        let lone = GOOD.replace("build/index.js", "\\ud800");
        assert!(SidecarManifest::parse(&lone).is_err());
        let nul = GOOD.replace("build/index.js", "a\\u0000b");
        assert!(matches!(
            err(&nul),
            ManifestError::InvalidField { field: "args", .. }
        ));
        // Empty strings and empty arrays are valid.
        assert!(SidecarManifest::parse(&with("args", r#"["", "x"]"#)).is_ok());
        assert!(SidecarManifest::parse(&with("args", "[]")).is_ok());
        assert!(SidecarManifest::parse(&with("args", "[1]")).is_err());
    }

    #[test]
    fn executable_is_one_portable_segment() {
        for ok in ["node", "my-app_1", "node.exe", "a"] {
            assert!(validate_executable(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "binaries/node",
            "/node",
            "node/",
            "..",
            ".hidden",
            "node.",
            "no de",
            "no\\de",
            "CON",
            "nul.txt",
            "com1",
            "Lpt9.exe",
        ] {
            assert!(validate_executable(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn portable_paths_follow_the_documented_grammar() {
        for ok in [
            "runtime",
            "a/b",
            "A_b-c.d/e",
            "-x",
            "_x",
            "9",
            "com10",
            "lpt",
            "console",
        ] {
            assert!(validate_portable_path("dataDirectory", ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "/",
            "/abs",
            "a//b",
            "a/",
            "./a",
            "a/..",
            "a/.",
            "a.",
            "a./b",
            "a\\b",
            "C:",
            "a b",
            "é",
            "CON",
            "a/aux",
            "NUL.txt",
            "COM0",
            "com9.log",
            "LPT3",
            "a/lpt1.tar.gz",
            ".a",
        ] {
            assert!(
                validate_portable_path("dataDirectory", bad).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn routes_follow_the_documented_grammar() {
        for ok in [
            "/",
            "/health",
            "/health/",
            "/api/_runtime/health",
            "/a.b/c~d/e-f",
            "/...",
            "/a..b",
        ] {
            assert!(validate_route("healthRoute", ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "health",
            "//",
            "//host/x",
            "/a//b",
            "/a//",
            "/.",
            "/..",
            "/a/./b",
            "/a/../b",
            "/a?x=1",
            "/a#f",
            "/a%2fb",
            "/a\\b",
            "/a b",
            "http://x/",
            "/é",
            "/a:b",
        ] {
            assert!(validate_route("healthRoute", bad).is_err(), "{bad:?}");
        }
        assert!(validate_route("healthRoute", "/a/").is_ok());
    }

    #[test]
    fn owner_claim_route_uses_the_same_grammar() {
        let mut doc: serde_json::Value = serde_json::from_str(GOOD).unwrap();
        doc["ownerClaimRoute"] = "/owner?x=1".into();
        assert!(matches!(
            err(&doc.to_string()),
            ManifestError::InvalidField {
                field: "ownerClaimRoute",
                ..
            }
        ));
    }

    #[test]
    fn app_working_directory_is_optional_and_cannot_escape() {
        assert_eq!(
            SidecarManifest::parse(&with("workingDirectory", r#""app""#))
                .unwrap()
                .working_directory
                .as_deref(),
            Some("app")
        );
        for bad in [
            r#""..""#,
            r#""../app""#,
            r#""/app""#,
            r#""app/build""#,
            "null",
            "1",
        ] {
            assert!(SidecarManifest::parse(&with("workingDirectory", bad)).is_err());
        }
        let duplicate = GOOD.replacen(
            '{',
            r#"{"workingDirectory":"app","workingDirectory":"app","#,
            1,
        );
        assert!(SidecarManifest::parse(&duplicate).is_err());
    }

    #[test]
    fn env_keys_are_validated() {
        for ok in ["A", "_A", "a1_b", "NODE_ENV"] {
            let json = with("env", &format!("{{\"{ok}\":\"v\"}}"));
            assert!(SidecarManifest::parse(&json).is_ok(), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A B", "A=B", "é"] {
            let json = with("env", &format!("{{\"{bad}\":\"v\"}}"));
            assert!(SidecarManifest::parse(&json).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn reserved_env_keys_are_rejected_case_insensitively() {
        for key in [
            "HOST",
            "host",
            "Port",
            "PORT",
            "origin",
            "OrIgIn",
            "SMRT_DATA_DIR",
            "smrt_data_dir",
            "SMRT_DESKTOP_OWNER_LINK_SECRET",
            "smrt_desktop_owner_link_secret",
            "SMRT_DESKTOP_KEYCHAIN",
            "smrt_desktop_keychain",
        ] {
            let json = with("env", &format!("{{\"{key}\":\"v\"}}"));
            assert!(
                matches!(err(&json), ManifestError::InvalidField { field: "env", .. }),
                "{key}"
            );
        }
        // Near misses are fine.
        let json = with(
            "env",
            r#"{"HOSTNAME":"v","SMRT_DATA_DIR2":"v","MY_PORT":"1"}"#,
        );
        assert!(SidecarManifest::parse(&json).is_ok());
    }

    #[test]
    fn env_case_collisions_and_bad_values_are_rejected() {
        let json = with("env", r#"{"Foo":"1","FOO":"2"}"#);
        assert!(matches!(
            err(&json),
            ManifestError::InvalidField { field: "env", .. }
        ));
        assert!(SidecarManifest::parse(&with("env", r#"{"A":"a\u0000"}"#)).is_err());
        assert!(SidecarManifest::parse(&with("env", r#"{"A":null}"#)).is_err());
        assert!(SidecarManifest::parse(&with("env", r#"["A"]"#)).is_err());
    }

    #[test]
    fn reads_manifest_files_with_a_bounded_read() {
        let dir =
            std::env::temp_dir().join(format!("smrt-wrapper-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.json");
        std::fs::write(&good, GOOD).unwrap();
        assert!(read_manifest_file(&good).is_ok());
        let big = dir.join("big.json");
        std::fs::write(&big, " ".repeat(MAX_MANIFEST_BYTES + 10)).unwrap();
        assert!(read_manifest_file(&big).unwrap_err().contains("too large"));
        let missing = read_manifest_file(&dir.join("missing.json")).unwrap_err();
        assert!(missing.contains("cannot read"));
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{}").unwrap();
        assert!(read_manifest_file(&bad).unwrap_err().contains("missing"));
        let binary = dir.join("binary.json");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_manifest_file(&binary).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversize_documents_are_rejected() {
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_MANIFEST_BYTES));
        assert_eq!(err(&big), ManifestError::TooLarge);
    }

    #[test]
    fn the_shared_example_still_parses_when_it_meets_the_contract() {
        // The example lives in the TypeScript package, owned by another
        // change; read it when present and only assert on current-contract
        // documents so the two sides cannot drift silently.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/node26-sidecar.json");
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        if value["executable"]
            .as_str()
            .is_some_and(|e| !e.contains('/'))
        {
            SidecarManifest::parse(&text).unwrap();
        }
    }
}
