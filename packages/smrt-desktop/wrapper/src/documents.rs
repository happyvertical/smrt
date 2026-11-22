//! Private PDF trust boundary. No URL, cookie, response body or filesystem path
//! is ever included in an error. The sidecar remains the authorization authority.
use serde::Deserialize;
use std::io::Read;
#[cfg(unix)]
use std::io::{self, Write};
#[cfg(unix)]
use std::path::Path;
use std::time::Duration;
use tauri::Url;

pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub routes: Vec<String>,
}

fn segment(value: &str, template: bool) -> bool {
    (template && value == ":id")
        || (!value.is_empty()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && ![
                "auth",
                "login",
                "logout",
                "setup",
                "owner",
                "owner-link",
                "owner-claim",
                "proof",
                "token",
                "_runtime",
                "mcp",
                "ownerlink",
                "ownerclaim",
                "owner_link",
                "owner_claim",
                "sign-in",
                "sign-out",
                "signin",
                "signout",
                "_auth",
                "_owner",
                "oauth",
                "callback",
                "session",
                "sessions",
                "secret",
                "credential",
                "credentials",
                "onboarding",
            ]
            .contains(&value.to_ascii_lowercase().as_str()))
}

pub fn route(value: &str, template: bool) -> bool {
    value.len() <= 256
        && value.starts_with('/')
        && value[1..].split('/').count() >= 2
        && value[1..].split('/').all(|part| segment(part, template))
}

impl Policy {
    pub fn valid(&self) -> bool {
        !self.routes.is_empty()
            && self.routes.len() <= 16
            && self.routes.iter().all(|r| route(r, true))
            && self
                .routes
                .iter()
                .enumerate()
                .all(|(i, r)| !self.routes[..i].contains(r))
    }

    pub fn permits(&self, origin: &Url, target: &Url, owner_route: Option<&str>) -> bool {
        self.valid()
            && origin.scheme() == "http"
            && origin.host_str() == Some("127.0.0.1")
            && origin.port().is_some()
            && target.origin() == origin.origin()
            && target.username().is_empty()
            && target.password().is_none()
            && target.query().is_none()
            && target.fragment().is_none()
            && route(target.path(), false)
            && owner_route.is_none_or(|r| {
                let r = r.trim_end_matches('/');
                target.path() != r && !target.path().starts_with(&format!("{r}/"))
            })
            && self.routes.iter().any(|pattern| {
                let a: Vec<_> = pattern.split('/').collect();
                let b: Vec<_> = target.path().split('/').collect();
                a.len() == b.len() && a.iter().zip(b).all(|(p, v)| *p == ":id" || *p == v)
            })
    }
}

/// Select cookies from the *same* native main-WebView store. Wry 0.57's
/// cookies_for_url compares Url::domain() (None for IPv4) to cookie domains and
/// omits path filtering, so it cannot implement this loopback boundary.
/// Only exact IPv4 host cookies, RFC path matches and live non-Secure cookies
/// are eligible for our exclusively HTTP loopback transport.
pub fn cookie_header(target: &Url, cookies: Vec<tauri::webview::Cookie<'static>>) -> String {
    if target.scheme() != "http" || target.host_str() != Some("127.0.0.1") {
        return String::new();
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(i64::MAX);
    let mut cookies: Vec<_> = cookies
        .into_iter()
        .filter(|cookie| {
            let path = cookie.path().unwrap_or("/");
            cookie
                .domain()
                .is_some_and(|domain| matches!(domain, "127.0.0.1" | ".127.0.0.1"))
                && !cookie.name().is_empty()
                && cookie
                    .name()
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                && cookie
                    .value()
                    .bytes()
                    .all(|b| (0x21..=0x7e).contains(&b) && !matches!(b, b'"' | b',' | b';' | b'\\'))
                && !cookie.secure().unwrap_or(false)
                && cookie
                    .expires_datetime()
                    .is_none_or(|date| date.unix_timestamp() > now)
                && (target.path() == path
                    || (target.path().starts_with(path)
                        && (path.ends_with('/')
                            || target.path().as_bytes().get(path.len()) == Some(&b'/'))))
        })
        .collect();
    cookies.sort_by_key(|c| std::cmp::Reverse(c.path().unwrap_or("/").len()));
    cookies
        .into_iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Native HTTP only. Cookie extraction happens in the originating WebView;
/// credentials never pass through JavaScript. Redirects are rejected *before*
/// following, and proxy environment variables are ignored.
pub fn retrieve(url: &Url, cookie: &str) -> Result<Vec<u8>, &'static str> {
    retrieve_with_timeout(url, cookie, TIMEOUT)
}

fn retrieve_with_timeout(
    url: &Url,
    cookie: &str,
    timeout: Duration,
) -> Result<Vec<u8>, &'static str> {
    if cookie.is_empty() {
        return Err("Sign in again, then reopen the PDF.");
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .max_redirects_will_error(false)
        .http_status_as_error(false)
        .proxy(None)
        .timeout_global(Some(timeout))
        .build()
        .into();
    let mut response = agent
        .get(url.as_str())
        .header("Cookie", cookie)
        .header("Accept", "application/pdf")
        .call()
        .map_err(|_| "PDF retrieval failed or timed out. Reopen the PDF to retry.")?;
    if response.status().as_u16() != 200 {
        return Err("PDF access was refused. Sign in and check access, then retry.");
    }
    if response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        != Some("application/pdf")
    {
        return Err("The server did not return a PDF. Reopen the document to retry.");
    }
    let declared = response
        .headers()
        .get("content-length")
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .ok_or("Invalid PDF length.")
        })
        .transpose()?;
    if declared.is_some_and(|len| len > MAX_BYTES) {
        return Err("PDF exceeds the 20 MiB desktop limit.");
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "PDF transfer was interrupted. Reopen the PDF to retry.")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("PDF exceeds the 20 MiB desktop limit.");
    }
    if declared.is_some_and(|n| n != bytes.len() as u64)
        || !bytes.starts_with(b"%PDF-")
        || !bytes.trim_ascii_end().ends_with(b"%%EOF")
    {
        return Err("The PDF is incomplete or invalid. Reopen the document to retry.");
    }
    Ok(bytes)
}

pub fn safe_filename(value: &str) -> bool {
    value.len() <= 128
        && value.ends_with(".pdf")
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'_' | b'-' | b'.'))
}

/// Atomic, private, never-overwrite native publication. Parent directory is
/// pinned by fd, the sibling temporary is exclusive/no-follow and final exclusive publication
/// fails if *anything* already exists at the selected destination. No check/use
/// race can replace an existing file or follow a final symlink.
#[cfg(unix)]
pub fn save_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    save_new_inner(path, bytes, || {})
}

#[cfg(unix)]
fn save_new_inner(path: &Path, bytes: &[u8], before_publish: impl FnOnce()) -> io::Result<()> {
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
    if !path.is_absolute() {
        return Err(io::Error::other("Choose an absolute destination."));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| safe_filename(n))
        .ok_or_else(|| io::Error::other("Choose a plain PDF filename."))?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Choose a destination folder."))?;
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(parent)?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| io::Error::other("Random source unavailable."))?;
    let temp = CString::new(format!(".smrt-pdf-{:032x}", u128::from_le_bytes(random))).unwrap();
    let dest = CString::new(std::ffi::OsStr::new(name).as_bytes()).unwrap();
    // SAFETY: names are NUL-free single basenames; dir remains open throughout.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        // SAFETY: fd is an exclusively owned descriptor returned by openat.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        before_publish();
        // SAFETY: same pinned directory and NUL-free basenames. macOS
        // atomically moves the sibling with RENAME_EXCL, so a successful
        // publication cannot leave a second temporary hardlink behind.
        #[cfg(target_os = "macos")]
        let published = unsafe {
            libc::renameatx_np(
                dir.as_raw_fd(),
                temp.as_ptr(),
                dir.as_raw_fd(),
                dest.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(target_os = "macos"))]
        let published = unsafe {
            libc::linkat(
                dir.as_raw_fd(),
                temp.as_ptr(),
                dir.as_raw_fd(),
                dest.as_ptr(),
                0,
            )
        };
        if published != 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(())
    })();
    // SAFETY: unlink only our exclusive random sibling in the pinned directory.
    unsafe {
        libc::unlinkat(dir.as_raw_fd(), temp.as_ptr(), 0);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    const PDF: &[u8] = b"%PDF-1.7\nsynthetic authorized fixture\n%%EOF\n";
    fn origin() -> Url {
        "http://127.0.0.1:49123/".parse().unwrap()
    }
    fn policy() -> Policy {
        Policy {
            routes: vec!["/admin/resume-assets/:id/pdf".into()],
        }
    }
    fn server(status: u16, mime: &str, body: &[u8], extra: &str) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/admin/resume-assets/abc/pdf",
            listener.local_addr().unwrap()
        )
        .parse()
        .unwrap();
        let response = format!("HTTP/1.1 {status} Response\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
        let body = body.to_vec();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..n]).contains("Cookie: session=owner")
                    || String::from_utf8_lossy(&request[..n]).contains("cookie: session=owner")
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        url
    }

    #[test]
    fn owner_authorized_exact_bytes_and_cross_owner_denial() {
        assert_eq!(
            retrieve(&server(200, "application/pdf", PDF, ""), "session=owner").unwrap(),
            PDF
        );
        assert!(retrieve(&server(403, "application/pdf", PDF, ""), "session=owner").is_err());
        assert!(retrieve(&origin(), "").is_err());
    }
    #[test]
    fn strict_route_and_origin_boundary() {
        let p = policy();
        let base = origin();
        assert!(p.permits(
            &base,
            &base.join("admin/resume-assets/abc-123/pdf").unwrap(),
            None
        ));
        for target in [
            "http://127.0.0.1:49124/admin/resume-assets/a/pdf",
            "http://localhost:49123/admin/resume-assets/a/pdf",
            "https://127.0.0.1:49123/admin/resume-assets/a/pdf",
            "http://owner@127.0.0.1:49123/admin/resume-assets/a/pdf",
            "http://127.0.0.1:49123/admin/resume-assets/a/pdf?proof=secret",
            "http://127.0.0.1:49123/admin/resume-assets/a/pdf#fragment",
            "http://127.0.0.1:49123/admin/resume-assets/%61/pdf",
            "http://127.0.0.1:49123/admin/resume-assets/auth/pdf",
            "http://127.0.0.1:49123/admin/resume-assets/../pdf",
            "file:///admin/resume-assets/a/pdf",
        ] {
            assert!(
                !p.permits(&base, &target.parse().unwrap(), None),
                "{target}"
            );
        }
        let target = base.join("admin/resume-assets/a/pdf").unwrap();
        assert!(!p.permits(&base, &target, Some("/admin/resume-assets")));
        for route in [
            "/auth/:id",
            "/api/_runtime/pdf",
            "/owner-claim/pdf",
            "/documents/./pdf",
            "/documents/%2e/pdf",
            "/documents/:other/pdf",
            "/documents//pdf",
            "/documents/id/pdf?x",
            "/documents/proof/pdf",
        ] {
            assert!(!Policy {
                routes: vec![route.into()]
            }
            .valid());
        }
        assert!(!Policy { routes: vec![] }.valid());
        assert!(serde_json::from_str::<Policy>(
            r#"{"routes":["/documents/:id/pdf"],"unsafe":true}"#
        )
        .is_err());
    }
    #[test]
    fn redirect_denied_before_following_even_same_origin() {
        let trap = TcpListener::bind("127.0.0.1:0").unwrap();
        trap.set_nonblocking(true).unwrap();
        let location = format!(
            "Location: http://{}/private\r\n",
            trap.local_addr().unwrap()
        );
        assert!(retrieve(
            &server(302, "application/pdf", PDF, &location),
            "session=owner"
        )
        .is_err());
        assert!(matches!(trap.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
    #[test]
    fn login_html_wrong_status_mime_and_signatures_fail_closed() {
        for (status, mime, body) in [
            (200, "text/html", PDF),
            (206, "application/pdf", PDF),
            (200, "application/pdf", b"<html>Login</html>".as_slice()),
            (200, "application/pdf", b"%PDF-1.7\ntruncated".as_slice()),
        ] {
            assert!(retrieve(&server(status, mime, body, ""), "session=owner").is_err());
        }
    }
    #[test]
    fn oversized_and_truncated_and_stalled_responses_are_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for response in [format!("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: {}\r\n\r\n", MAX_BYTES + 1), "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: 100\r\n\r\n%PDF-1.7\n%%EOF".into()] {
                let (mut s, _) = listener.accept().unwrap(); let mut b = [0; 4096]; let _ = s.read(&mut b); s.write_all(response.as_bytes()).unwrap();
            }
            let (mut s, _) = listener.accept().unwrap();
            let mut b = [0; 4096];
            let _ = s.read(&mut b);
            thread::sleep(Duration::from_millis(200));
        });
        let url = format!("http://{address}/doc/pdf").parse().unwrap();
        for _ in 0..3 {
            assert!(
                retrieve_with_timeout(&url, "session=owner", Duration::from_millis(100)).is_err()
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_save_is_exact_private_atomic_noclobber_and_cleans_failures() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!("smrt-document-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let destination = root.join("chosen.pdf");
        save_new(&destination, PDF).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), PDF);
        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(save_new(&destination, b"replacement").is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), PDF);
        symlink(&destination, root.join("link.pdf")).unwrap();
        assert!(save_new(&root.join("link.pdf"), b"replacement").is_err());
        symlink(&root, root.join("parent-link")).unwrap();
        assert!(save_new(&root.join("parent-link/escape.pdf"), PDF).is_err());
        assert!(save_new(&root.join("../invalid.txt"), PDF).is_err());
        let contested = root.join("race.pdf");
        let other = contested.clone();
        let racing = thread::spawn(move || save_new(&other, PDF));
        let ours = save_new(&contested, PDF);
        assert_ne!(ours.is_ok(), racing.join().unwrap().is_ok());
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".smrt-pdf-")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn filename_policy_rejects_paths_hidden_controls_and_ambiguous_extensions() {
        for name in [
            "../secret.pdf",
            ".hidden.pdf",
            "folder/name.pdf",
            "a\\b.pdf",
            "name.pdf.exe",
            "name\n.pdf",
            "name.PDF",
        ] {
            assert!(!safe_filename(name));
        }
        assert!(safe_filename("Candidate resume-123.pdf"));
    }
}

#[cfg(all(test, unix))]
mod parent_race_tests {
    use super::*;
    #[test]
    fn pinned_directory_prevents_parent_replacement_from_redirecting_write() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("smrt-parent-race-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let original = root.join("selected");
        let displaced = root.join("displaced");
        let trap = root.join("trap");
        std::fs::create_dir(&original).unwrap();
        std::fs::create_dir(&trap).unwrap();
        let destination = original.join("chosen.pdf");
        save_new_inner(&destination, b"exact", || {
            std::fs::rename(&original, &displaced).unwrap();
            symlink(&trap, &original).unwrap();
        })
        .unwrap();
        assert!(!trap.join("chosen.pdf").exists());
        assert_eq!(
            std::fs::read(displaced.join("chosen.pdf")).unwrap(),
            b"exact"
        );
        assert!(std::fs::read_dir(&displaced).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".smrt-pdf-")));
        assert!(save_new(&root.join("missing/retry.pdf"), b"exact").is_err());
        std::fs::create_dir(root.join("missing")).unwrap();
        save_new(&root.join("missing/retry.pdf"), b"exact").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod cookie_tests {
    use super::*;
    use tauri::webview::Cookie;
    fn cookie(
        name: &'static str,
        domain: &'static str,
        path: &'static str,
        secure: bool,
    ) -> Cookie<'static> {
        let mut c = Cookie::new(name, "synthetic");
        c.set_domain(domain);
        c.set_path(path);
        c.set_secure(secure);
        c
    }
    #[test]
    fn native_cookie_selection_handles_ipv4_path_boundaries_secure_and_priority() {
        let target = "http://127.0.0.1:49123/documents/id/pdf".parse().unwrap();
        let mut httponly = cookie("httponly", "127.0.0.1", "/", false);
        httponly.set_http_only(true);
        let expired = Cookie::parse(
            "expired=synthetic; Domain=127.0.0.1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        )
        .unwrap()
        .into_owned();
        let mut invalid = cookie("invalid", "127.0.0.1", "/", false);
        invalid.set_value("bad\r\nvalue");
        let header = cookie_header(
            &target,
            vec![
                httponly,
                expired,
                invalid,
                cookie("localhost", "localhost", "/", false),
                cookie("root", "127.0.0.1", "/", false),
                cookie("scoped", "127.0.0.1", "/documents", false),
                cookie("wrongpath", "127.0.0.1", "/document", false),
                cookie("ownerproof", "127.0.0.1", "/owner", false),
                cookie("external", "example.com", "/", false),
                cookie("secure", "127.0.0.1", "/", true),
            ],
        );
        assert_eq!(
            header,
            "scoped=synthetic; httponly=synthetic; root=synthetic"
        );
        let mut broad = cookie("session", "127.0.0.1", "/", false);
        broad.set_value("broad");
        let mut scoped = cookie("session", "127.0.0.1", "/documents", false);
        scoped.set_value("scoped");
        assert_eq!(
            cookie_header(&target, vec![broad, scoped]),
            "session=scoped; session=broad"
        );
        let admin = "http://127.0.0.1:49123/admin-other/doc/pdf"
            .parse()
            .unwrap();
        assert_eq!(
            cookie_header(&admin, vec![cookie("admin", "127.0.0.1", "/admin", false)]),
            ""
        );
        assert_eq!(
            cookie_header(
                &"http://foreign:49123/documents/id/pdf".parse().unwrap(),
                vec![cookie("root", "127.0.0.1", "/", false)]
            ),
            ""
        );
    }
}

#[cfg(test)]
mod shared_grammar_tests {
    use super::*;
    #[test]
    fn matches_the_shared_typescript_rust_canonical_route_cases() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/private-documents-policy-cases.json");
        let cases: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(path).expect("shared private document grammar fixture"),
        )
        .unwrap();
        for value in cases["valid"].as_array().unwrap() {
            assert!(route(value.as_str().unwrap(), true));
        }
        for value in cases["invalid"].as_array().unwrap() {
            assert!(!route(value.as_str().unwrap(), true));
        }
    }
}

#[cfg(test)]
mod custom_owner_route_tests {
    use super::*;
    #[test]
    fn live_custom_owner_route_is_denied_independently_of_reserved_segments() {
        let origin: Url = "http://127.0.0.1:49123/".parse().unwrap();
        let target = origin.join("documents/record-9001/pdf").unwrap();
        let policy = Policy {
            routes: vec!["/documents/:id/pdf".into()],
        };
        assert!(policy.permits(&origin, &target, None));
        assert!(policy.permits(&origin, &target, Some("/bootstrap-link")));
        assert!(!policy.permits(&origin, &target, Some("/documents/record-9001/pdf")));
        assert!(!policy.permits(&origin, &target, Some("/documents/record-9001/pdf/")));
        assert!(!policy.permits(&origin, &target, Some("/documents/")));
    }
}
