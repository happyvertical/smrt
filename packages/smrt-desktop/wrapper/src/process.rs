//! Child-process abstraction shared by production and tests.
//!
//! [`ManagedChild`] is the seam between the supervisor's pure logic and a
//! concrete process. Production uses the Tauri shell plugin's sidecar command
//! (see `app.rs`); [`StdLauncher`] drives the same logic with
//! `std::process` for the integration tests and headless harnesses.
//!
//! Raw output stays in a bounded in-memory tail for failure classification.
//! Separate redacted tails suppress sensitive lines before truncation; only
//! those diagnostics can reach the log, including stderr on non-zero exits.

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
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
    /// Capture diagnostics without retaining secret-bearing lines. The native
    /// wrapper cannot load the CLI's Node redactor; use the same credential
    /// categories, conservatively suppressing entire lines before truncation.
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
                    .filter(|line| !line.is_empty())
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
        let lower = line.to_ascii_lowercase();
        let credential = lower
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|word| {
                matches!(
                    word,
                    "token"
                        | "secret"
                        | "password"
                        | "passwd"
                        | "credentials"
                        | "credential"
                        | "authorization"
                        | "api_key"
                        | "apikey"
                        | "access_token"
                        | "refresh_token"
                        | "private_key"
                        | "launch"
                )
            });
        let opaque_token = line
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
            .any(|part| part.len() >= 32);
        if self
            .secret_values
            .iter()
            .any(|value| value.len() >= 8 && line.contains(value))
            || lower.split_whitespace().any(|word| word == "bearer")
            || (credential && (line.contains('=') || line.contains(':')))
            || (line.contains("://")
                && (line.contains('@') || line.contains('?') || line.contains('#')))
            || opaque_token
        {
            "[redacted sensitive sidecar output]".into()
        } else {
            // Strictly redact short values too, without losing the whole error
            // to an auth flag such as SMRT_AUTH_ENABLED=1.
            let mut result = line.to_owned();
            for value in self.secret_values.iter().filter(|value| value.len() < 8) {
                result = result.replace(value, "[redacted]");
            }
            result
        }
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
        assert!(tail
            .snapshot()
            .iter()
            .all(|line| line == "[redacted sensitive sidecar output]"));
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
            ["Error: path longer than [redacted]30 UTF-[redacted]6 units"]
        );
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
