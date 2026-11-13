//! Child-process abstraction shared by production and tests.
//!
//! [`ManagedChild`] is the seam between the supervisor's pure logic and a
//! concrete process. Production uses the Tauri shell plugin's sidecar command
//! (see `app.rs`); [`StdLauncher`] drives the same logic with
//! `std::process` for the integration tests and headless harnesses.
//!
//! Raw output stays in a bounded in-memory tail for failure classification.
//! Separate redacted tails mask credential spans before truncation; only
//! those diagnostics can reach the log, including stderr on non-zero exits.

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Lines of recent child output kept in memory.
pub const OUTPUT_TAIL_LINES: usize = 40;
/// Bytes kept per line; longer lines are truncated.
pub const OUTPUT_LINE_BYTES: usize = 400;

/// What happened to a child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Exit code if the process exited normally.
    pub code: Option<i32>,
    /// Terminating signal on unix, if any.
    pub signal: Option<i32>,
}

impl ExitInfo {
    /// Short, value-free description for tray and log lines.
    pub fn describe(&self) -> String {
        match (self.code, self.signal) {
            (Some(code), _) => format!("exit code {code}"),
            (None, Some(signal)) => format!("signal {signal}"),
            (None, None) => "unknown exit status".into(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One-shot exit notification shared between a reaper thread and waiters.
#[derive(Clone, Default)]
pub struct ExitLatch {
    inner: Arc<(Mutex<Option<ExitInfo>>, Condvar)>,
}

impl ExitLatch {
    /// Record the exit (first writer wins) and wake waiters.
    pub fn set(&self, info: ExitInfo) {
        let (slot, cv) = &*self.inner;
        let mut guard = lock(slot);
        if guard.is_none() {
            *guard = Some(info);
        }
        cv.notify_all();
    }

    /// The exit, if it has happened.
    pub fn get(&self) -> Option<ExitInfo> {
        lock(&self.inner.0).clone()
    }

    /// Wait up to `timeout` for the exit.
    pub fn wait(&self, timeout: Duration) -> Option<ExitInfo> {
        let (slot, cv) = &*self.inner;
        let deadline = Instant::now() + timeout;
        let mut guard = lock(slot);
        loop {
            if let Some(info) = guard.clone() {
                return Some(info);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            guard = cv
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

/// Bounded ring of recent output lines.
#[derive(Clone, Default)]
pub struct OutputTail {
    lines: Arc<Mutex<VecDeque<String>>>,
    secret_values: Arc<Vec<String>>,
    redact: bool,
}

impl OutputTail {
    /// Capture diagnostics without retaining secret-bearing spans. The native
    /// wrapper cannot load the CLI's Node redactor; use the same credential
    /// categories and merge spans on the original line before truncation.
    pub fn redacted(env: &BTreeMap<String, String>) -> Self {
        let secret_values = env
            .iter()
            .filter(|(name, _)| {
                name.to_ascii_uppercase().split('_').any(|part| {
                    matches!(
                        part,
                        "URL"
                            | "DSN"
                            | "TOKEN"
                            | "SECRET"
                            | "PASSWORD"
                            | "PASSWD"
                            | "KEY"
                            | "CREDENTIAL"
                            | "CREDENTIALS"
                            | "AUTH"
                    )
                })
            })
            .flat_map(|(_, value)| {
                value
                    .lines()
                    .filter(|line| line.chars().count() >= 8)
                    .map(str::to_owned)
            })
            .collect();
        Self {
            secret_values: Arc::new(secret_values),
            redact: true,
            ..Self::default()
        }
    }

    fn diagnostic_line(&self, line: &str) -> String {
        if !self.redact {
            return line.to_owned();
        }
        let mut spans: Vec<(usize, usize)> = self
            .secret_values
            .iter()
            .flat_map(|value| {
                line.match_indices(value)
                    .map(|(start, _)| (start, start + value.len()))
            })
            .collect();
        // Match credential values, not a keyword elsewhere on an error line.
        // Authority userinfo ends before the first slash: @scope in a file://
        // stack frame or an HTTP path is not a credential.
        static PATTERNS: OnceLock<[regex::Regex; 4]> = OnceLock::new();
        let patterns = PATTERNS.get_or_init(|| [
            regex::Regex::new(r"(?i)\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)").unwrap(),
            regex::Regex::new(r#"(?i)\b(?:\w*(?:token|secret|password|passwd|key)|credentials?|launch)\b["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s"'&;<>{},)]+))"#).unwrap(),
            regex::Regex::new(r#"(?i)\b(?:set-cookie|cookie|authorization)\b["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\r\n]+))"#).unwrap(),
            regex::Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*://(?:[^/\s@'"]+@[^\s"'<>)]*|[^\s"'<>)]*[?&;#](?:token|password|secret|key|api_key|access_token|refresh_token|id_token|session_token|client_secret|launch|code|state|signature|sig)=[^\s"'<>)]*))"#).unwrap(),
        ]);
        for pattern in patterns {
            for captures in pattern.captures_iter(line) {
                for value in captures.iter().skip(1).flatten() {
                    if !value.is_empty() {
                        spans.push((value.start(), value.end()));
                    }
                }
            }
        }
        // A 64+ hex run can carry a launch secret even inside a path. Keep
        // surrounding paths and ordinary short build chunk hashes readable.
        static HEX: OnceLock<regex::Regex> = OnceLock::new();
        for value in HEX
            .get_or_init(|| regex::Regex::new(r"[0-9a-fA-F]{64,}").unwrap())
            .find_iter(line)
        {
            spans.push((value.start(), value.end()));
        }
        // Merge overlapping matches against the original bytes. A short env
        // value must not split a bearer/URL match or rewrite a redaction marker.
        spans.sort_unstable();
        let mut result = String::new();
        let mut cursor = 0;
        for (start, end) in spans {
            if start >= cursor {
                result.push_str(&line[cursor..start]);
                result.push_str("[redacted]");
            }
            cursor = cursor.max(end);
        }
        result.push_str(&line[cursor..]);
        result
    }

    /// Append one line (truncated, control characters replaced).
    pub fn push(&self, line: &str) {
        let mut cleaned: String = self
            .diagnostic_line(line)
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        if cleaned.len() > OUTPUT_LINE_BYTES {
            let mut end = OUTPUT_LINE_BYTES;
            while !cleaned.is_char_boundary(end) {
                end -= 1;
            }
            cleaned.truncate(end);
        }
        let mut lines = lock(&self.lines);
        if lines.len() == OUTPUT_TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(cleaned);
    }

    /// Snapshot of the retained lines, oldest first.
    pub fn snapshot(&self) -> Vec<String> {
        lock(&self.lines).iter().cloned().collect()
    }
}

/// A running (or exited) sidecar process.
pub trait ManagedChild: Send {
    /// OS process id.
    fn pid(&self) -> u32;
    /// The exit status if the child has already exited (non-blocking).
    fn try_exit(&mut self) -> Option<ExitInfo>;
    /// Wait up to `timeout` for exit.
    fn wait_for_exit(&mut self, timeout: Duration) -> Option<ExitInfo>;
    /// Ask the child to stop cleanly (SIGTERM / best-effort on Windows).
    fn request_graceful_stop(&mut self) -> io::Result<()>;
    /// Terminate the child forcefully (SIGKILL / TerminateProcess).
    fn force_kill(&mut self) -> io::Result<()>;
    /// Recent output lines, oldest first.
    fn output_tail(&self) -> Vec<String>;
    /// Redacted stderr only. Custom launchers default to no diagnostics.
    fn stderr_tail(&self) -> Vec<String> {
        Vec::new()
    }
    /// Redacted stdout/stderr for the legacy diagnostic opt-in.
    fn diagnostic_tail(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Everything needed to start one sidecar attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    /// Logical executable name (Tauri sidecar) or a resolved path (tests).
    pub program: String,
    /// Literal arguments.
    pub args: Vec<String>,
    /// Working directory: the packaged app root, not the data directory.
    pub cwd: PathBuf,
    /// The complete child environment; the child inherits nothing else.
    pub env: BTreeMap<String, String>,
}

/// Starts a sidecar. Spawn failures are permanent (missing binary, bad cwd).
pub trait Launcher: Send + Sync {
    /// Spawn the process described by `plan`.
    fn launch(&self, plan: &LaunchPlan) -> io::Result<Box<dyn ManagedChild>>;
}

/// Deliver SIGTERM (unix) or a best-effort close request (Windows).
pub fn signal_graceful(pid: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        send_signal(pid, libc::SIGTERM)
    }
    #[cfg(windows)]
    {
        // Without /F `taskkill` posts WM_CLOSE to the process's windows. A
        // console-less Node server has none, so this frequently fails and the
        // escalation to a forced kill follows after the graceful timeout.
        run_taskkill(&["/PID", &pid.to_string()])
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported platform",
        ))
    }
}

/// Deliver SIGKILL (unix) or terminate the process tree (Windows).
pub fn signal_kill(pid: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        send_signal(pid, libc::SIGKILL)
    }
    #[cfg(windows)]
    {
        run_taskkill(&["/PID", &pid.to_string(), "/T", "/F"])
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported platform",
        ))
    }
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: i32) -> io::Result<()> {
    let pid = libc::pid_t::try_from(pid)
        .ok()
        .filter(|pid| *pid > 1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "refusing to signal pid"))?;
    // SAFETY: kill(2) takes plain integers and has no memory-safety contract.
    if unsafe { libc::kill(pid, signal) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn run_taskkill(args: &[&str]) -> io::Result<()> {
    let status = Command::new("taskkill")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("taskkill failed"))
    }
}

/// Reference launcher built on `std::process`.
///
/// Used by the integration tests and headless harnesses; the shipped app
/// launches through the Tauri shell plugin instead so the sidecar resolves
/// through `externalBin`.
#[derive(Default)]
pub struct StdLauncher {
    program: Option<PathBuf>,
}

impl StdLauncher {
    /// Launch `program` instead of `LaunchPlan::program`. Tests use this to
    /// map the manifest's logical name (`node`) onto a real binary path.
    pub fn with_program(program: impl Into<PathBuf>) -> Self {
        Self {
            program: Some(program.into()),
        }
    }
}

struct StdChild {
    pid: u32,
    child: std::process::Child,
    latch: ExitLatch,
    tail: OutputTail,
    stderr: OutputTail,
    diagnostics: OutputTail,
}

fn pump(
    reader: impl Read + Send + 'static,
    tail: OutputTail,
    stderr: Option<OutputTail>,
    diagnostics: OutputTail,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n') {
            match line {
                Ok(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    tail.push(&line);
                    diagnostics.push(&line);
                    if let Some(stderr) = &stderr {
                        stderr.push(&line);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

impl Launcher for StdLauncher {
    fn launch(&self, plan: &LaunchPlan) -> io::Result<Box<dyn ManagedChild>> {
        let program = self
            .program
            .clone()
            .unwrap_or_else(|| PathBuf::from(&plan.program));
        let mut child = Command::new(program)
            .args(&plan.args)
            .current_dir(&plan.cwd)
            .env_clear()
            .envs(&plan.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let tail = OutputTail::default();
        let diagnostics = OutputTail::redacted(&plan.env);
        let stderr = OutputTail::redacted(&plan.env);
        if let Some(out) = child.stdout.take() {
            pump(out, tail.clone(), None, diagnostics.clone());
        }
        if let Some(err) = child.stderr.take() {
            pump(err, tail.clone(), Some(stderr.clone()), diagnostics.clone());
        }
        Ok(Box::new(StdChild {
            pid: child.id(),
            child,
            latch: ExitLatch::default(),
            tail,
            stderr,
            diagnostics,
        }))
    }
}

#[cfg(unix)]
fn exit_info(status: std::process::ExitStatus) -> ExitInfo {
    use std::os::unix::process::ExitStatusExt;
    ExitInfo {
        code: status.code(),
        signal: status.signal(),
    }
}

#[cfg(not(unix))]
fn exit_info(status: std::process::ExitStatus) -> ExitInfo {
    ExitInfo {
        code: status.code(),
        signal: None,
    }
}

impl ManagedChild for StdChild {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn try_exit(&mut self) -> Option<ExitInfo> {
        if let Some(info) = self.latch.get() {
            return Some(info);
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.latch.set(exit_info(status));
                self.latch.get()
            }
            Ok(None) => None,
            Err(_) => None,
        }
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Option<ExitInfo> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(info) = self.try_exit() {
                return Some(info);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn request_graceful_stop(&mut self) -> io::Result<()> {
        if self.try_exit().is_some() {
            return Ok(());
        }
        signal_graceful(self.pid)
    }

    fn force_kill(&mut self) -> io::Result<()> {
        if self.try_exit().is_some() {
            return Ok(());
        }
        self.child.kill()
    }

    fn output_tail(&self) -> Vec<String> {
        self.tail.snapshot()
    }
    fn stderr_tail(&self) -> Vec<String> {
        self.stderr.snapshot()
    }
    fn diagnostic_tail(&self) -> Vec<String> {
        self.diagnostics.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latch_first_writer_wins_and_wakes_waiters() {
        let latch = ExitLatch::default();
        assert_eq!(latch.get(), None);
        assert_eq!(latch.wait(Duration::from_millis(20)), None);
        let setter = latch.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            setter.set(ExitInfo {
                code: Some(3),
                signal: None,
            });
            setter.set(ExitInfo {
                code: Some(9),
                signal: None,
            });
        });
        let info = latch.wait(Duration::from_secs(5)).unwrap();
        assert_eq!(info.code, Some(3));
        handle.join().unwrap();
        assert_eq!(latch.get().unwrap().code, Some(3));
    }

    #[test]
    fn tail_is_bounded_and_sanitised() {
        let tail = OutputTail::default();
        for n in 0..(OUTPUT_TAIL_LINES + 10) {
            tail.push(&format!("line {n}"));
        }
        let lines = tail.snapshot();
        assert_eq!(lines.len(), OUTPUT_TAIL_LINES);
        assert_eq!(lines[0], "line 10");
        tail.push(&"é".repeat(OUTPUT_LINE_BYTES));
        assert!(tail.snapshot().last().unwrap().len() <= OUTPUT_LINE_BYTES);
        tail.push("a\u{1b}[31mred\r");
        assert!(!tail.snapshot().last().unwrap().contains('\u{1b}'));
    }

    #[test]
    fn access_token_camel_case_is_redacted() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        tail.push("accessToken: 'stored-access'");
        assert_eq!(tail.snapshot(), ["accessToken: '[redacted]'"]);
    }

    #[test]
    fn refresh_token_camel_case_is_redacted() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        tail.push("refreshToken: 'stored-refresh'");
        assert_eq!(tail.snapshot(), ["refreshToken: '[redacted]'"]);
    }

    #[test]
    fn id_token_camel_case_is_redacted() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        tail.push(r#""idToken":"stored-id""#);
        assert_eq!(tail.snapshot(), [r#""idToken":"[redacted]""#]);
    }

    #[test]
    fn client_secret_camel_case_is_redacted() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        tail.push(r#"clientSecret: "stored-client""#);
        assert_eq!(tail.snapshot(), [r#"clientSecret: "[redacted]""#]);
    }

    #[test]
    fn session_token_camel_case_is_redacted() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        tail.push("sessionToken=stored-session");
        assert_eq!(tail.snapshot(), ["sessionToken=[redacted]"]);
    }

    #[test]
    fn suffix_keys_cover_environment_style_names_and_quoted_values() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        for (line, expected) in [
            (
                "OPENAI_API_KEY=fixture-provider",
                "OPENAI_API_KEY=[redacted]",
            ),
            (
                "SMRT_LAUNCH_SECRET=fixture-launch",
                "SMRT_LAUNCH_SECRET=[redacted]",
            ),
            (
                r#""CUSTOM_PASSWORD":"with spaces""#,
                r#""CUSTOM_PASSWORD":"[redacted]""#,
            ),
            (
                "customPasswd: 'stored-password'",
                "customPasswd: '[redacted]'",
            ),
            (
                r#"encryptionKey: "stored-key""#,
                r#"encryptionKey: "[redacted]""#,
            ),
            ("notASecretSuffix: readable", "notASecretSuffix: readable"),
        ] {
            tail.push(line);
            assert_eq!(tail.snapshot().last().unwrap(), expected, "{line}");
        }
    }

    #[test]
    fn cookie_headers_are_redacted_including_multiple_cookie_values() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        tail.push("Cookie: session=stored-session; csrf=stored-csrf");
        assert_eq!(tail.snapshot(), ["Cookie: [redacted]"]);
        tail.push("Set-Cookie: session=stored-session; Path=/; HttpOnly, other=stored-other");
        assert_eq!(tail.snapshot().last().unwrap(), "Set-Cookie: [redacted]");
        tail.push(
            r#""cookie": "session=stored-session; csrf=stored-csrf", path: "C:\\app\\src.js""#,
        );
        assert_eq!(
            tail.snapshot().last().unwrap(),
            r#""cookie": "[redacted]", path: "C:\\app\\src.js""#
        );
    }

    #[test]
    fn authorization_headers_are_redacted_with_any_scheme_or_none() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        for value in [
            "stored-bare",
            "DPoP stored-dpop",
            "Bearer stored-bearer",
            "Basic stored-basic",
        ] {
            tail.push(&format!("Authorization: {value}"));
            assert_eq!(tail.snapshot().last().unwrap(), "Authorization: [redacted]");
        }
        tail.push(r#"authorization: 'stored-bare', code: 'invalid_configuration'"#);
        assert_eq!(
            tail.snapshot().last().unwrap(),
            r#"authorization: '[redacted]', code: 'invalid_configuration'"#
        );
    }

    #[test]
    fn hex_secrets_are_redacted_after_path_and_filename_separators() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        for separator in ["/", ".", "-", "_", "\\"] {
            tail.push(&format!(
                "Error at /app/secret{separator}{} failed",
                "ab".repeat(32)
            ));
            assert_eq!(
                tail.snapshot().last().unwrap(),
                &format!("Error at /app/secret{separator}[redacted] failed")
            );
        }
        tail.push("    at preflight (file:///D:/app/chunks/src-DshfJZdH.js:37:17)");
        assert_eq!(
            tail.snapshot().last().unwrap(),
            "    at preflight (file:///D:/app/chunks/src-DshfJZdH.js:37:17)"
        );
    }

    #[test]
    fn node_runtime_errors_keep_messages_and_windows_file_url_frames() {
        let tail = OutputTail::redacted(&BTreeMap::new());
        let frame = "file:///D:/a/_temp/smrt-launch-smoke-ABCdef/target/debug/app/node_modules/@happyvertical/smrt-app-runtime/dist/chunks/src-runtime.js:37:17";
        let path = r"D:\a\_temp\app\build\chunks\src-DshfJZdH.js";
        let dump = [
            frame.to_owned(),
            "    throw new LocalRuntimeError('invalid_configuration', message);".into(),
            "          ^".into(),
            format!("LocalRuntimeError: Application secret file could not be opened safely: {path}"),
            format!("    at unsafeFilesystemEntry ({frame})"),
            format!("    at preflightWindowsRoot ({frame})"),
            "    at a_very_long_but_ordinary_error_function_name (D:\\a\\_temp\\app\\build\\index.js:1:2)".into(),
            "    code: 'invalid_configuration'".into(),
            "}".into(),
            "Node.js v26.8.1".into(),
        ];
        for line in &dump {
            tail.push(line);
        }
        assert_eq!(tail.snapshot(), dump);
    }

    #[test]
    fn diagnostic_tail_redacts_before_truncation_and_preserves_useful_errors() {
        let env = BTreeMap::from([("APP_SECRET".into(), "known-sensitive-value".into())]);
        let tail = OutputTail::redacted(&env);
        for line in [
            "Authorization: Bearer x".into(),
            "https://127.0.0.1/setup?launch=unknown-value".into(),
            "https://user:pass@server/path".into(),
            "Token=unknown-value".into(),
            "ab".repeat(32),
            format!("{}known-sensitive-value", "x ".repeat(198)),
        ] {
            tail.push(&line);
        }
        let lines = tail.snapshot();
        assert_eq!(
            &lines[..5],
            [
                "Authorization: [redacted]",
                "[redacted]",
                "[redacted]",
                "Token=[redacted]",
                "[redacted]",
            ]
        );
        assert!(
            !lines[5].contains("know"),
            "secret must be masked before the byte cut"
        );
        tail.push("Error: Local application data directory is not a safe Windows path: longer than 130 UTF-16 units");
        assert!(tail.snapshot().last().unwrap().contains("longer than 130"));
        tail.push(&format!("\u{1b}{}", "é ".repeat(OUTPUT_LINE_BYTES)));
        let last = tail.snapshot().pop().unwrap();
        assert!(last.len() <= OUTPUT_LINE_BYTES);
        assert!(!last.chars().any(char::is_control));
        let short = OutputTail::redacted(&BTreeMap::from([("AUTH_ENABLED".into(), "1".into())]));
        short.push("Error: path longer than 130 UTF-16 units");
        assert_eq!(
            short.snapshot(),
            ["Error: path longer than 130 UTF-16 units"]
        );
    }

    #[test]
    fn literal_environment_values_require_eight_characters_but_named_secrets_do_not() {
        let tail = OutputTail::redacted(&BTreeMap::from([
            ("APP_SECRET".into(), "1234567".into()),
            ("OTHER_SECRET".into(), "12345678".into()),
        ]));
        tail.push("Error 1234567 at line 1; detail 12345678");
        assert_eq!(
            tail.snapshot(),
            ["Error 1234567 at line 1; detail [redacted]"]
        );
        tail.push("sessionToken: 'x'");
        assert_eq!(
            tail.snapshot().last().unwrap(),
            "sessionToken: '[redacted]'"
        );
    }

    #[test]
    fn credential_spans_merge_without_exposing_quoted_or_overlapping_values() {
        let tail =
            OutputTail::redacted(&BTreeMap::from([("APP_SECRET".into(), "valuepart".into())]));
        tail.push(r#"Error: "password": "with spaces", 'token': 'short-valuepart', Authorization: Bearer short-valuepart; next"#);
        assert_eq!(
            tail.snapshot(),
            [
                r#"Error: "password": "[redacted]", 'token': '[redacted]', Authorization: [redacted]"#,
            ]
        );
        tail.push("Error: launch=secret-value failed at D:\\a\\_temp\\ordinary-very-long-directory-name-that-is-not-a-token\\runtime");
        assert_eq!(tail.snapshot().last().unwrap(),
            "Error: launch=[redacted] failed at D:\\a\\_temp\\ordinary-very-long-directory-name-that-is-not-a-token\\runtime");
        tail.push(
            "Failed request https://example.invalid/@happyvertical/pkg?token=short-valuepart&ok=1",
        );
        assert_eq!(tail.snapshot().last().unwrap(), "Failed request [redacted]");
    }

    #[test]
    fn exit_info_describes_without_values() {
        assert_eq!(
            ExitInfo {
                code: Some(1),
                signal: None
            }
            .describe(),
            "exit code 1"
        );
        assert_eq!(
            ExitInfo {
                code: None,
                signal: Some(9)
            }
            .describe(),
            "signal 9"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_signal_pid_one_or_zero() {
        assert!(signal_graceful(0).is_err());
        assert!(signal_graceful(1).is_err());
        assert!(signal_kill(1).is_err());
    }
}
