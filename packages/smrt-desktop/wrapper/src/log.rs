//! Append-only supervisor log.
//!
//! Guarantees:
//!
//! * logging never panics and never returns an error; an unwritable
//!   directory, a full disk or a poisoned lock silently drops the line (a
//!   tray app must not die because it cannot log);
//! * the file is size capped: when the next line would exceed the cap the
//!   current file replaces the single rotated file (`<name>.1`) and a fresh
//!   file is started, so at most `2 * max_bytes` is on disk;
//! * lines are single-line, control-character free and length bounded;
//! * the API takes only preformatted message text. Callers must log fixed
//!   phrases and non-secret facts (ports, phases, exit codes), never the child
//!   environment or argument list, and never raw child output.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default cap for one log file.
pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024;
/// Longest message body kept per line.
pub const MAX_LINE_CHARS: usize = 1024;

/// Severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Normal lifecycle events.
    Info,
    /// Recoverable problems.
    Warn,
    /// Failures.
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// Size-capped append-only file logger.
pub struct Logger {
    path: PathBuf,
    max_bytes: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    file: Option<File>,
    len: u64,
}

impl Logger {
    /// Log to `<dir>/<name>`; nothing touches disk until the first line.
    pub fn new(dir: impl AsRef<Path>, name: &str) -> Self {
        Self::with_max_bytes(dir, name, DEFAULT_MAX_BYTES)
    }

    /// As [`Logger::new`] with an explicit size cap.
    pub fn with_max_bytes(dir: impl AsRef<Path>, name: &str, max_bytes: u64) -> Self {
        Self {
            path: dir.as_ref().join(name),
            max_bytes: max_bytes.max(256),
            state: Mutex::new(State::default()),
        }
    }

    /// The active log file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The single rotated file path.
    pub fn rotated_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".1");
        PathBuf::from(name)
    }

    /// Info line.
    pub fn info(&self, message: &str) {
        self.log(Level::Info, message);
    }

    /// Warning line.
    pub fn warn(&self, message: &str) {
        self.log(Level::Warn, message);
    }

    /// Error line.
    pub fn error(&self, message: &str) {
        self.log(Level::Error, message);
    }

    /// Append one line. Infallible by design.
    pub fn log(&self, level: Level, message: &str) {
        let line = format_line(level, message);
        // Swallow even a (should-be-impossible) panic so logging can never
        // take the supervisor down.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = self.append(&mut state, line.as_bytes());
        }));
    }

    fn append(&self, state: &mut State, bytes: &[u8]) -> std::io::Result<()> {
        if state.file.is_none() {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            let file = open_append(&self.path)?;
            state.len = file.metadata().map(|m| m.len()).unwrap_or(0);
            state.file = Some(file);
        }
        if state.len > 0 && state.len + bytes.len() as u64 > self.max_bytes {
            // Close, rotate over the previous rotation, start fresh.
            state.file = None;
            let _ = fs::rename(&self.path, self.rotated_path());
            let file = open_append(&self.path)?;
            state.len = file.metadata().map(|m| m.len()).unwrap_or(0);
            state.file = Some(file);
        }
        let Some(file) = state.file.as_mut() else {
            return Ok(());
        };
        if let Err(error) = file.write_all(bytes) {
            // Reopen next time; the handle may be stale.
            state.file = None;
            return Err(error);
        }
        state.len += bytes.len() as u64;
        Ok(())
    }
}

fn open_append(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Single-line, control-free, bounded message with a UTC timestamp.
fn format_line(level: Level, message: &str) -> String {
    let mut body: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_LINE_CHARS)
        .collect();
    if message.chars().count() > MAX_LINE_CHARS {
        body.push_str("...");
    }
    format!(
        "{} {:5} {}\n",
        timestamp(SystemTime::now()),
        level.as_str(),
        body
    )
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` without a date-time dependency.
fn timestamp(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let millis = since.subsec_millis();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    fn scratch() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "smrt-wrapper-log-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn timestamps_are_correct_utc() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::new(1_709_210_096, 7_000_000); // leap day 2024
        assert_eq!(timestamp(t), "2024-02-29T12:34:56.007Z");
        let t = UNIX_EPOCH + Duration::from_secs(951_782_400); // 2000-02-29
        assert!(timestamp(t).starts_with("2000-02-29T"));
    }

    #[test]
    fn appends_lines_and_creates_missing_directories() {
        let dir = scratch().join("nested").join("logs");
        let log = Logger::new(&dir, "wrapper.log");
        log.info("starting");
        log.error("failed");
        let text = fs::read_to_string(log.path()).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("INFO  starting"));
        assert!(lines[1].contains("ERROR failed"));
    }

    #[test]
    fn lines_are_single_line_and_bounded() {
        let dir = scratch();
        let log = Logger::new(&dir, "wrapper.log");
        log.info("a\nb\r\n\u{1b}[31mc");
        log.info(&"x".repeat(MAX_LINE_CHARS * 3));
        let text = fs::read_to_string(log.path()).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains('\u{1b}'));
        assert!(text.lines().nth(1).unwrap().len() < MAX_LINE_CHARS + 64);
    }

    #[test]
    fn size_is_capped_with_one_rotated_file() {
        let dir = scratch();
        let log = Logger::with_max_bytes(&dir, "wrapper.log", 1024);
        for n in 0..200 {
            log.info(&format!("line number {n} with some padding to take space"));
        }
        let live = fs::metadata(log.path()).unwrap().len();
        let rotated = fs::metadata(log.rotated_path()).unwrap().len();
        assert!(live <= 1024, "live {live}");
        assert!(rotated <= 1024, "rotated {rotated}");
        let mut names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, vec!["wrapper.log", "wrapper.log.1"]);
        let newest = fs::read_to_string(log.path()).unwrap();
        assert!(newest.contains("line number 199"));
    }

    #[test]
    fn resumes_size_accounting_from_an_existing_file() {
        let dir = scratch();
        {
            let log = Logger::with_max_bytes(&dir, "wrapper.log", 512);
            for _ in 0..4 {
                log.info("first session padding padding padding padding");
            }
        }
        let log = Logger::with_max_bytes(&dir, "wrapper.log", 512);
        for _ in 0..20 {
            log.info("second session padding padding padding padding");
        }
        assert!(fs::metadata(log.path()).unwrap().len() <= 512);
    }

    #[test]
    fn never_panics_or_errors_when_the_directory_is_unwritable() {
        let dir = scratch();
        // A regular file where the directory should be: create_dir_all and
        // open both fail, for root as well as for ordinary users.
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let log = Logger::new(blocker.join("logs"), "wrapper.log");
        log.info("dropped");
        log.warn("dropped");
        log.error("dropped");
        log.log(Level::Info, &"y".repeat(10_000));
        assert!(!log.path().exists());
    }

    #[test]
    fn never_panics_with_a_poisoned_lock() {
        let dir = scratch();
        let log = std::sync::Arc::new(Logger::new(&dir, "wrapper.log"));
        let poisoner = log.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.state.lock().unwrap();
            panic!("poison");
        })
        .join();
        log.info("still works");
        assert!(fs::read_to_string(log.path())
            .unwrap()
            .contains("still works"));
    }

    #[cfg(unix)]
    #[test]
    fn log_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let log = Logger::new(&dir, "wrapper.log");
        log.info("x");
        let mode = fs::metadata(log.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }
}
