//! Bounded stop escalation: graceful request, wait, forced kill, wait.
//!
//! The escalation always ends with either a confirmed exit or an explicit
//! [`ShutdownOutcome::Unconfirmed`]. The supervisor never starts a
//! replacement child after `Unconfirmed`, which is how it keeps the
//! "at most one live sidecar per data directory" invariant (smrt#3379: two
//! SQLite writers do not see each other's writes).
//!
//! On unix the graceful step is SIGTERM and the forced step SIGKILL. Windows
//! has no portable SIGTERM for a console-less child; the graceful step is a
//! best-effort `taskkill` close request that Node servers usually ignore, so
//! there the bounded wait mostly elapses before the forced `taskkill /T /F`.
//! Tests configure short timeouts through [`ShutdownConfig`].

use std::time::Duration;

use crate::process::ManagedChild;

/// Escalation timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShutdownConfig {
    /// How long a graceful stop may take before the forced kill.
    pub graceful_timeout: Duration,
    /// How long to wait for exit after the forced kill.
    pub kill_timeout: Duration,
}

impl Default for ShutdownConfig {
    fn default() -> Self {
        Self {
            graceful_timeout: Duration::from_secs(10),
            kill_timeout: Duration::from_secs(5),
        }
    }
}

/// How a stop ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShutdownOutcome {
    /// The child had already exited.
    AlreadyExited,
    /// The child exited after the graceful request.
    Graceful,
    /// The child had to be force-killed and has exited.
    Killed,
    /// Exit could not be confirmed; the child may still be alive.
    Unconfirmed(String),
}

impl ShutdownOutcome {
    /// Whether the child is known to be gone.
    pub fn child_is_gone(&self) -> bool {
        !matches!(self, Self::Unconfirmed(_))
    }
}

/// Stop `child`, escalating from graceful to forced, and wait for exit.
pub fn stop_child(child: &mut dyn ManagedChild, config: ShutdownConfig) -> ShutdownOutcome {
    if child.try_exit().is_some() {
        return ShutdownOutcome::AlreadyExited;
    }
    // A failed graceful request (for example a Windows close request that
    // has no window to land on) is not an error: escalation covers it.
    let _ = child.request_graceful_stop();
    if child.wait_for_exit(config.graceful_timeout).is_some() {
        return ShutdownOutcome::Graceful;
    }
    let kill_result = child.force_kill();
    if child.wait_for_exit(config.kill_timeout).is_some() {
        return ShutdownOutcome::Killed;
    }
    match kill_result {
        Ok(()) => {
            ShutdownOutcome::Unconfirmed("the process did not exit after a forced kill".into())
        }
        Err(error) => ShutdownOutcome::Unconfirmed(format!("forced kill failed: {}", error.kind())),
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! In-memory child for deterministic escalation tests.
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use crate::process::{ExitInfo, ManagedChild};

    #[derive(Default, Clone)]
    pub struct Script {
        pub exits_on_graceful: bool,
        pub exits_on_kill: bool,
        pub kill_errors: bool,
        pub already_exited: bool,
    }

    pub struct FakeChild {
        pub script: Script,
        pub calls: Arc<Mutex<Vec<&'static str>>>,
        exited: bool,
    }

    impl FakeChild {
        pub fn new(script: Script) -> Self {
            Self {
                exited: script.already_exited,
                script,
                calls: Arc::default(),
            }
        }
    }

    impl ManagedChild for FakeChild {
        fn pid(&self) -> u32 {
            4242
        }
        fn try_exit(&mut self) -> Option<ExitInfo> {
            self.exited.then_some(ExitInfo {
                code: Some(0),
                signal: None,
            })
        }
        fn wait_for_exit(&mut self, _timeout: Duration) -> Option<ExitInfo> {
            self.calls.lock().unwrap().push("wait");
            self.try_exit()
        }
        fn request_graceful_stop(&mut self) -> io::Result<()> {
            self.calls.lock().unwrap().push("term");
            if self.script.exits_on_graceful {
                self.exited = true;
            }
            Ok(())
        }
        fn force_kill(&mut self) -> io::Result<()> {
            self.calls.lock().unwrap().push("kill");
            if self.script.kill_errors {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            if self.script.exits_on_kill {
                self.exited = true;
            }
            Ok(())
        }
        fn output_tail(&self) -> Vec<String> {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn cfg() -> ShutdownConfig {
        ShutdownConfig {
            graceful_timeout: Duration::from_millis(10),
            kill_timeout: Duration::from_millis(10),
        }
    }

    #[test]
    fn already_exited_children_are_not_signalled() {
        let mut child = FakeChild::new(Script {
            already_exited: true,
            ..Script::default()
        });
        assert_eq!(
            stop_child(&mut child, cfg()),
            ShutdownOutcome::AlreadyExited
        );
        assert!(child.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn a_cooperative_child_is_never_killed() {
        let mut child = FakeChild::new(Script {
            exits_on_graceful: true,
            ..Script::default()
        });
        assert_eq!(stop_child(&mut child, cfg()), ShutdownOutcome::Graceful);
        assert!(!child.calls.lock().unwrap().contains(&"kill"));
    }

    #[test]
    fn a_stubborn_child_is_killed_after_the_graceful_bound() {
        let mut child = FakeChild::new(Script {
            exits_on_kill: true,
            ..Script::default()
        });
        assert_eq!(stop_child(&mut child, cfg()), ShutdownOutcome::Killed);
        let calls = child.calls.lock().unwrap().clone();
        assert_eq!(calls, vec!["term", "wait", "kill", "wait"]);
    }

    #[test]
    fn an_unkillable_child_is_reported_unconfirmed() {
        let mut child = FakeChild::new(Script::default());
        let outcome = stop_child(&mut child, cfg());
        assert!(matches!(outcome, ShutdownOutcome::Unconfirmed(_)));
        assert!(!outcome.child_is_gone());

        let mut child = FakeChild::new(Script {
            kill_errors: true,
            ..Script::default()
        });
        let outcome = stop_child(&mut child, cfg());
        assert!(matches!(&outcome, ShutdownOutcome::Unconfirmed(m) if m.contains("failed")));
    }
}
