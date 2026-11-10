//! Sidecar supervisor: one thread, one child at a time.
//!
//! ```text
//!            +--------------------------------------------+
//!            v                                            |
//!   Starting(n) --healthy--> Ready --unexpected exit--> Restarting --+
//!      |  ^                                                          |
//!      |  +---- address in use: new port, no backoff ----------------+
//!      +--exit/unhealthy/lease held--> Restarting(backoff) --> Starting
//!      +--budget spent / permanent fault--> Failed --retry()--> Starting
//!   any state --shutdown()--> Stopped
//! ```
//!
//! # Single live sidecar
//!
//! The supervisor loop is sequential: a new child is never launched until the
//! previous one has been observed to exit. If the escalation in
//! [`crate::shutdown`] cannot confirm an exit, the supervisor enters a
//! terminal `Failed` state and refuses to launch anything else. Together with
//! the single-instance plugin this keeps at most one writer per data
//! directory (smrt#3379).
//!
//! # Locks and leases
//!
//! The runtime inside the sidecar owns the writer lease and the operation
//! lock (`@happyvertical/app-runtime`). The supervisor does not reimplement,
//! inspect or delete them. A restarted sidecar re-acquires them itself; that
//! runtime reclaims a lease whose recorded owner process is gone. If the new
//! child dies because a live process still holds the lease (a previous child
//! that is still winding down, an operator command), the startup output says
//! so and the supervisor classifies it as the retryable
//! [`FailureKind::LeaseHeld`] with backoff.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::env::{build_child_env, origin_for, LaunchSecret, SupervisorEnv};
use crate::health::{loopback_addr, wait_until_healthy, HealthConfig, ProbeOutcome, WaitFailure};
use crate::log::Logger;
use crate::manifest::SidecarManifest;
use crate::port::{choose_port, is_address_in_use};
use crate::process::{ExitInfo, LaunchPlan, Launcher, ManagedChild};
use crate::shutdown::{stop_child, ShutdownConfig, ShutdownOutcome};

/// Observable supervisor state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// A launch attempt is in flight (`attempt` counts from 1).
    Starting {
        /// Attempt ordinal within the current failure streak.
        attempt: u32,
    },
    /// The sidecar passed its health probe on `origin`.
    Ready {
        /// `http://127.0.0.1:<port>`.
        origin: String,
        /// The selected port.
        port: u16,
        /// This launch's secret, exported to the sidecar and carried in the
        /// window's first URL. `Debug` redacts it.
        launch_secret: LaunchSecret,
    },
    /// The previous child is gone; the next attempt starts after `retry_in`.
    Restarting {
        /// 1-based retry ordinal.
        attempt: u32,
        /// Retry cap before the supervisor gives up.
        max: u32,
        /// Backoff before the next launch.
        retry_in: Duration,
        /// Why the previous child is gone.
        reason: String,
    },
    /// Terminal until [`Supervisor::retry`]; the message is shown to the user.
    Failed(String),
    /// Shut down by request.
    Stopped,
}

impl Phase {
    /// One tray-sized status line.
    pub fn status_line(&self) -> String {
        match self {
            Self::Starting { attempt } if *attempt <= 1 => "Starting\u{2026}".into(),
            Self::Starting { attempt } => format!("Starting (attempt {attempt})\u{2026}"),
            Self::Ready { .. } => "Running".into(),
            Self::Restarting {
                attempt,
                max,
                retry_in,
                reason,
            } => format!(
                "Restarting ({attempt}/{max}) in {}s: {reason}",
                retry_in.as_secs().max(1)
            ),
            Self::Failed(message) => format!("Unavailable: {message}"),
            Self::Stopped => "Stopped".into(),
        }
    }
}

/// Why a launch attempt or a running child ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureKind {
    /// The child could not bind its port (bind-release race).
    AddressInUse,
    /// A live process holds the runtime's writer lease or operation lock.
    LeaseHeld,
    /// The child exited for another reason.
    Exited(ExitInfo),
    /// The child never passed its health probe in time.
    Unhealthy(String),
    /// The health route redirects; a configuration fault that retries cannot fix.
    Redirected(u16),
}

impl FailureKind {
    /// Short reason for the tray and log, never including child output.
    pub fn describe(&self) -> String {
        match self {
            Self::AddressInUse => "the selected port was taken".into(),
            Self::LeaseHeld => {
                "another process holds the data directory writer lease or operation lock".into()
            }
            Self::Exited(info) => format!("the sidecar exited ({})", info.describe()),
            Self::Unhealthy(why) => format!("the sidecar did not become healthy ({why})"),
            Self::Redirected(status) => {
                format!("the health route redirects (HTTP {status}), which is not allowed")
            }
        }
    }
}

/// Phrases the runtime prints when its writer lease or operation lock is held
/// by a live process (see `app-runtime` `writer-lease.ts`, `operation-lock.ts`
/// and `stale-reclaim.ts`).
const LEASE_PHRASES: [&str; 3] = [
    "another application writer is active",
    "another application operation is active",
    "reclaiming a stale application lock",
];

fn mentions_lease_held(lines: &[String]) -> bool {
    lines.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        LEASE_PHRASES.iter().any(|phrase| lower.contains(phrase))
    })
}

/// Classify a child that exited before (or after) becoming healthy.
pub fn classify_exit(exit: &ExitInfo, output: &[String]) -> FailureKind {
    if is_address_in_use(output) {
        FailureKind::AddressInUse
    } else if mentions_lease_held(output) {
        FailureKind::LeaseHeld
    } else {
        FailureKind::Exited(exit.clone())
    }
}

/// Bounded exponential backoff with a streak cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryPolicy {
    /// Consecutive failures tolerated before giving up.
    pub max_restarts: u32,
    /// Delay before the first retry; doubles each time.
    pub base_delay: Duration,
    /// Upper bound for the delay.
    pub max_delay: Duration,
    /// Uptime after which a child counts as healthy and the streak resets.
    pub stable_after: Duration,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 5,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(30),
            stable_after: Duration::from_secs(60),
        }
    }
}

impl RecoveryPolicy {
    /// Backoff before retry number `retry` (1-based).
    pub fn delay_for(&self, retry: u32) -> Duration {
        let shift = retry.saturating_sub(1).min(20);
        self.base_delay
            .checked_mul(1u32 << shift)
            .unwrap_or(self.max_delay)
            .min(self.max_delay)
    }
}

/// What the budget says after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Try again after `delay`; `attempt` is the retry ordinal.
    Retry {
        /// 1-based retry ordinal.
        attempt: u32,
        /// Backoff.
        delay: Duration,
    },
    /// The streak cap is spent.
    GiveUp,
}

/// Tracks the current failure streak.
#[derive(Debug, Clone, Copy)]
pub struct RestartBudget {
    policy: RecoveryPolicy,
    streak: u32,
}

impl RestartBudget {
    /// Fresh budget.
    pub fn new(policy: RecoveryPolicy) -> Self {
        Self { policy, streak: 0 }
    }

    /// Current streak length.
    pub fn streak(&self) -> u32 {
        self.streak
    }

    /// Forget the streak (manual retry).
    pub fn reset(&mut self) {
        self.streak = 0;
    }

    /// Record a failure after `uptime` of healthy running (zero for a failed
    /// start) and decide what to do next.
    pub fn on_failure(&mut self, uptime: Duration) -> Decision {
        if uptime >= self.policy.stable_after {
            self.streak = 0;
        }
        self.streak += 1;
        if self.streak > self.policy.max_restarts {
            Decision::GiveUp
        } else {
            Decision::Retry {
                attempt: self.streak,
                delay: self.policy.delay_for(self.streak),
            }
        }
    }
}

/// All supervisor tunables.
#[derive(Debug, Clone, Copy)]
pub struct SupervisorConfig {
    /// Readiness probe timing.
    pub health: HealthConfig,
    /// Stop escalation timing.
    pub shutdown: ShutdownConfig,
    /// Restart backoff and cap.
    pub recovery: RecoveryPolicy,
    /// Immediate relaunches (new port) allowed for address-in-use per streak.
    pub max_port_retries: u32,
    /// Poll interval while the child is running.
    pub monitor_interval: Duration,
    /// Wait after an exit so trailing output reaches the tail before it is
    /// classified.
    pub output_settle: Duration,
    /// How long the child must stay alive after the first successful probe
    /// before the sidecar counts as ready. Closes the bind-release race: a
    /// process that grabbed the chosen port answers the first probe while the
    /// child is still starting and about to die of `EADDRINUSE`.
    pub confirm_window: Duration,
    /// Log the (truncated) child output tail when a start fails. Off by
    /// default because a runtime may print one-time secrets.
    pub log_failure_output: bool,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            health: HealthConfig::default(),
            shutdown: ShutdownConfig::default(),
            recovery: RecoveryPolicy::default(),
            max_port_retries: 5,
            monitor_interval: Duration::from_millis(250),
            output_settle: Duration::from_millis(150),
            confirm_window: Duration::from_secs(1),
            log_failure_output: false,
        }
    }
}

/// Phase change callback; invoked on the supervisor thread, never under a lock.
pub type PhaseListener = Arc<dyn Fn(&Phase) + Send + Sync>;

/// Everything the supervisor needs.
pub struct SupervisorParams {
    /// Validated manifest.
    pub manifest: SidecarManifest,
    /// Packaged app root: the child's working directory.
    pub resource_dir: PathBuf,
    /// Absolute data directory exported as `SMRT_DATA_DIR`.
    pub data_dir: PathBuf,
    /// Parent environment to inherit (supervisor values still win).
    pub inherited_env: Vec<(String, String)>,
    /// Process launcher.
    pub launcher: Arc<dyn Launcher>,
    /// Log sink.
    pub logger: Arc<Logger>,
    /// Tunables.
    pub config: SupervisorConfig,
    /// Observer of phase changes.
    pub listener: PhaseListener,
}

#[derive(Debug)]
struct Control {
    phase: Phase,
    stop: bool,
    retry: bool,
    /// Set when a child's exit could not be confirmed; nothing may launch.
    wedged: bool,
}

struct Core {
    params: SupervisorParams,
    control: Mutex<Control>,
    changed: Condvar,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// PID of the live sidecar for panic-path cleanup (0 when none).
static ACTIVE_CHILD_PID: AtomicU32 = AtomicU32::new(0);

/// Best-effort forced kill of the live sidecar. Safe to call from a panic
/// hook; does nothing when no child is running.
pub fn emergency_kill() {
    let pid = ACTIVE_CHILD_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        let _ = crate::process::signal_kill(pid);
    }
}

/// Handle to the supervisor thread.
pub struct Supervisor {
    core: Arc<Core>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    /// Start supervising on a dedicated thread.
    pub fn start(params: SupervisorParams) -> io::Result<Self> {
        let core = Arc::new(Core {
            params,
            control: Mutex::new(Control {
                phase: Phase::Starting { attempt: 1 },
                stop: false,
                retry: false,
                wedged: false,
            }),
            changed: Condvar::new(),
        });
        let worker = core.clone();
        let handle = thread::Builder::new()
            .name("smrt-sidecar-supervisor".into())
            .spawn(move || worker.run_guarded())?;
        Ok(Self {
            core,
            thread: Mutex::new(Some(handle)),
        })
    }

    /// Current phase.
    pub fn phase(&self) -> Phase {
        guard(&self.core.control).phase.clone()
    }

    /// Ask a `Failed` supervisor to try again with a fresh budget. Ignored
    /// when running, stopping, or after an unconfirmed child exit.
    pub fn retry(&self) {
        let mut control = guard(&self.core.control);
        if matches!(control.phase, Phase::Failed(_)) && !control.wedged {
            control.retry = true;
            self.core.changed.notify_all();
        }
    }

    /// Stop the sidecar (graceful, then forced) and the supervisor thread.
    /// Blocks until the child is gone. Idempotent.
    pub fn shutdown(&self) {
        {
            let mut control = guard(&self.core.control);
            control.stop = true;
            self.core.changed.notify_all();
        }
        let handle = guard(&self.thread).take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    /// Block until `predicate` holds for the phase or `timeout` elapses.
    pub fn wait_for(&self, timeout: Duration, predicate: impl Fn(&Phase) -> bool) -> Option<Phase> {
        let deadline = Instant::now() + timeout;
        let mut control = guard(&self.core.control);
        loop {
            if predicate(&control.phase) {
                return Some(control.phase.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            control = self
                .core
                .changed
                .wait_timeout(control, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// How one launch attempt ended. The child is gone in every variant except
/// `Wedged`.
enum AttemptEnd {
    /// Shutdown was requested and the child was stopped.
    Stopped,
    /// The process could not be spawned at all.
    SpawnFailed(String),
    /// The child never became healthy or died while starting.
    StartFailed { kind: FailureKind, port: u16 },
    /// The child ran and later exited by itself.
    RanThenExited {
        kind: FailureKind,
        port: u16,
        uptime: Duration,
    },
    /// The port could not be selected.
    NoPort(String),
    /// The stop escalation could not confirm the child's exit.
    Wedged(String),
}

impl Core {
    fn log(&self) -> &Logger {
        &self.params.logger
    }

    fn stopping(&self) -> bool {
        guard(&self.control).stop
    }

    fn set_phase(&self, phase: Phase) {
        {
            let mut control = guard(&self.control);
            control.phase = phase.clone();
            self.changed.notify_all();
        }
        (self.params.listener)(&phase);
    }

    /// Sleep up to `duration`; returns true if shutdown was requested.
    fn sleep(&self, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        let mut control = guard(&self.control);
        loop {
            if control.stop {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            control = self
                .changed
                .wait_timeout(control, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    /// Wait in `Failed` until retry or stop. True means retry.
    fn wait_for_retry(&self) -> bool {
        let mut control = guard(&self.control);
        loop {
            if control.stop {
                return false;
            }
            if control.retry && !control.wedged {
                control.retry = false;
                return true;
            }
            control = self
                .changed
                .wait(control)
                .unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Run the loop; a panic must not orphan a live sidecar.
    fn run_guarded(self: Arc<Self>) {
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Arc::clone(&self).run()));
        if outcome.is_err() {
            emergency_kill();
            guard(&self.control).wedged = true;
            self.log()
                .error("supervisor thread panicked; sidecar killed");
            self.set_phase(Phase::Failed(
                "internal supervisor error; quit and relaunch the app".into(),
            ));
        }
    }

    fn run(self: Arc<Self>) {
        let policy = self.params.config.recovery;
        let mut budget = RestartBudget::new(policy);
        let mut port_retries = 0u32;
        let mut preferred_port: Option<u16> = None;

        loop {
            if self.stopping() {
                break;
            }
            let attempt = budget.streak() + 1;
            let end = self.attempt(attempt, preferred_port);
            let (kind, port, uptime) = match end {
                AttemptEnd::Stopped => break,
                AttemptEnd::Wedged(message) => {
                    guard(&self.control).wedged = true;
                    self.log()
                        .error(&format!("sidecar exit unconfirmed: {message}"));
                    self.set_phase(Phase::Failed(format!(
                        "the sidecar could not be stopped ({message}); quit and relaunch the app"
                    )));
                    self.wait_for_retry();
                    break;
                }
                AttemptEnd::SpawnFailed(message) | AttemptEnd::NoPort(message) => {
                    self.log().error(&message);
                    self.set_phase(Phase::Failed(message));
                    if self.wait_for_retry() {
                        budget.reset();
                        port_retries = 0;
                        preferred_port = None;
                        continue;
                    }
                    break;
                }
                AttemptEnd::StartFailed { kind, port } => (kind, port, Duration::ZERO),
                AttemptEnd::RanThenExited { kind, port, uptime } => (kind, port, uptime),
            };

            if uptime >= policy.stable_after {
                port_retries = 0;
            }
            // Bind-release race: retry at once on a fresh port.
            if kind == FailureKind::AddressInUse
                && uptime.is_zero()
                && port_retries < self.params.config.max_port_retries
            {
                port_retries += 1;
                preferred_port = None;
                self.log().warn(&format!(
                    "port {port} was taken before the sidecar bound it; relaunching on a new port ({port_retries}/{})",
                    self.params.config.max_port_retries
                ));
                if self.sleep(Duration::from_millis(50)) {
                    break;
                }
                continue;
            }
            preferred_port = Some(port);

            if let FailureKind::Redirected(_) = kind {
                let message = kind.describe();
                self.log().error(&message);
                self.set_phase(Phase::Failed(message));
                if self.wait_for_retry() {
                    budget.reset();
                    continue;
                }
                break;
            }

            match budget.on_failure(uptime) {
                Decision::Retry { attempt, delay } => {
                    let reason = kind.describe();
                    self.log().warn(&format!(
                        "restart {attempt}/{} in {}ms: {reason}",
                        policy.max_restarts,
                        delay.as_millis()
                    ));
                    self.set_phase(Phase::Restarting {
                        attempt,
                        max: policy.max_restarts,
                        retry_in: delay,
                        reason,
                    });
                    if self.sleep(delay) {
                        break;
                    }
                }
                Decision::GiveUp => {
                    let message = format!(
                        "{}; gave up after {} restarts",
                        kind.describe(),
                        policy.max_restarts
                    );
                    self.log().error(&message);
                    self.set_phase(Phase::Failed(message));
                    if self.wait_for_retry() {
                        budget.reset();
                        port_retries = 0;
                        preferred_port = None;
                        continue;
                    }
                    break;
                }
            }
        }
        ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
        self.set_phase(Phase::Stopped);
        self.log().info("supervisor stopped");
    }

    /// Stop the child through the escalation and clear the panic-path PID.
    fn stop(&self, child: &mut dyn ManagedChild) -> ShutdownOutcome {
        let outcome = stop_child(child, self.params.config.shutdown);
        if outcome.child_is_gone() {
            ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
        }
        self.log()
            .info(&format!("sidecar stop outcome: {outcome:?}"));
        outcome
    }

    fn exit_failure(&self, child: &dyn ManagedChild, exit: &ExitInfo) -> FailureKind {
        // Trailing output can lag the exit notification.
        thread::sleep(self.params.config.output_settle);
        let tail = child.output_tail();
        let kind = classify_exit(exit, &tail);
        if self.params.config.log_failure_output {
            for line in tail.iter().rev().take(10).rev() {
                self.log().warn(&format!("sidecar output: {line}"));
            }
        }
        kind
    }

    fn attempt(&self, ordinal: u32, preferred_port: Option<u16>) -> AttemptEnd {
        let config = &self.params.config;
        self.set_phase(Phase::Starting { attempt: ordinal });

        let port = match choose_port(preferred_port) {
            Ok(port) => port,
            Err(error) => {
                return AttemptEnd::NoPort(format!(
                    "could not select a loopback port ({})",
                    error.kind()
                ))
            }
        };
        let Some(data_dir) = self.params.data_dir.to_str() else {
            return AttemptEnd::SpawnFailed("the data directory path is not valid Unicode".into());
        };
        let launch_secret = match LaunchSecret::generate() {
            Ok(secret) => secret,
            Err(_) => {
                return AttemptEnd::SpawnFailed(
                    "could not generate the launch secret (OS random source)".into(),
                )
            }
        };
        let supervisor_env = SupervisorEnv {
            port,
            data_dir: data_dir.to_owned(),
            launch_secret: launch_secret.clone(),
        };
        let plan = LaunchPlan {
            program: self.params.manifest.executable.clone(),
            args: self.params.manifest.args.clone(),
            cwd: self.params.resource_dir.clone(),
            env: build_child_env(
                self.params.inherited_env.clone(),
                &self.params.manifest,
                &supervisor_env,
            ),
        };
        // Deliberately not logged: plan.env and plan.args.
        let mut child = match self.params.launcher.launch(&plan) {
            Ok(child) => child,
            Err(error) => {
                return AttemptEnd::SpawnFailed(format!(
                    "could not start the sidecar ({})",
                    error.kind()
                ))
            }
        };
        ACTIVE_CHILD_PID.store(child.pid(), Ordering::SeqCst);
        let started = Instant::now();
        self.log().info(&format!(
            "sidecar launched pid={} port={port} attempt={ordinal}",
            child.pid()
        ));

        let addr = loopback_addr(port);
        // Healthy only after a first 2xx, a confirmation window with the child
        // still alive, and a second 2xx. Nothing is published before that.
        let waited = self
            .wait_healthy(child.as_mut(), addr)
            .and_then(|()| self.confirm_window_elapsed(child.as_mut()))
            .and_then(|()| self.wait_healthy(child.as_mut(), addr));

        match waited {
            Ok(()) => {
                // Last guard: a squatter can keep answering after our child
                // died of EADDRINUSE; only a live child counts as ready.
                if let Some(exit) = child.try_exit() {
                    let kind = self.exit_failure(child.as_ref(), &exit);
                    ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
                    return AttemptEnd::StartFailed { kind, port };
                }
            }
            Err(WaitFailure::Aborted) => {
                if self.stopping() {
                    return self.finish_stop(child.as_mut());
                }
                let exit = child.try_exit().unwrap_or(ExitInfo {
                    code: None,
                    signal: None,
                });
                let kind = self.exit_failure(child.as_ref(), &exit);
                ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
                return AttemptEnd::StartFailed { kind, port };
            }
            Err(WaitFailure::Redirected(status)) => {
                return self.fail_and_stop(child.as_mut(), FailureKind::Redirected(status), port);
            }
            Err(WaitFailure::TimedOut(last)) => {
                let why = match last {
                    ProbeOutcome::Unreachable(_) => "no response".to_owned(),
                    other => other.to_string(),
                };
                return self.fail_and_stop(child.as_mut(), FailureKind::Unhealthy(why), port);
            }
        }

        let origin = origin_for(port);
        let ready_after = started.elapsed();
        self.log().info(&format!(
            "sidecar ready origin={origin} after {}ms",
            ready_after.as_millis()
        ));
        let ready_at = Instant::now();
        self.set_phase(Phase::Ready {
            origin,
            port,
            launch_secret,
        });

        loop {
            if self.stopping() {
                return self.finish_stop(child.as_mut());
            }
            if let Some(exit) = child.try_exit() {
                let kind = self.exit_failure(child.as_ref(), &exit);
                ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
                return AttemptEnd::RanThenExited {
                    kind,
                    port,
                    uptime: ready_at.elapsed(),
                };
            }
            if self.sleep(config.monitor_interval) {
                return self.finish_stop(child.as_mut());
            }
        }
    }

    /// Probe until healthy; ends early when the child exits or shutdown is
    /// requested.
    fn wait_healthy(
        &self,
        child: &mut dyn ManagedChild,
        addr: std::net::SocketAddr,
    ) -> Result<(), WaitFailure> {
        wait_until_healthy(
            addr,
            &self.params.manifest.health_route,
            self.params.config.health,
            || self.stopping() || child.try_exit().is_some(),
        )
    }

    /// Hold for `confirm_window` while the child stays alive. `Aborted` when
    /// the child exits or shutdown is requested inside the window.
    fn confirm_window_elapsed(&self, child: &mut dyn ManagedChild) -> Result<(), WaitFailure> {
        let deadline = Instant::now() + self.params.config.confirm_window;
        loop {
            if self.stopping() || child.try_exit().is_some() {
                return Err(WaitFailure::Aborted);
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10).min(deadline - now));
        }
    }

    fn finish_stop(&self, child: &mut dyn ManagedChild) -> AttemptEnd {
        match self.stop(child) {
            ShutdownOutcome::Unconfirmed(message) => AttemptEnd::Wedged(message),
            _ => AttemptEnd::Stopped,
        }
    }

    fn fail_and_stop(
        &self,
        child: &mut dyn ManagedChild,
        kind: FailureKind,
        port: u16,
    ) -> AttemptEnd {
        match self.stop(child) {
            ShutdownOutcome::Unconfirmed(message) => AttemptEnd::Wedged(message),
            _ => AttemptEnd::StartFailed { kind, port },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit(code: i32) -> ExitInfo {
        ExitInfo {
            code: Some(code),
            signal: None,
        }
    }

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn classifies_address_in_use_before_everything_else() {
        let out = lines(&["Error: listen EADDRINUSE: address already in use 127.0.0.1:1"]);
        assert_eq!(classify_exit(&exit(1), &out), FailureKind::AddressInUse);
    }

    #[test]
    fn classifies_lease_and_lock_conflicts_as_retryable() {
        for text in [
            "Error: Another application writer is active (process 42).",
            "Error: Another application operation is active (process 7).",
            "Another process is reclaiming a stale application lock; retry the operation.",
        ] {
            assert_eq!(
                classify_exit(&exit(1), &lines(&[text])),
                FailureKind::LeaseHeld,
                "{text}"
            );
        }
    }

    #[test]
    fn other_exits_keep_their_status() {
        assert_eq!(
            classify_exit(&exit(3), &lines(&["boom"])),
            FailureKind::Exited(exit(3))
        );
        assert_eq!(classify_exit(&exit(0), &[]), FailureKind::Exited(exit(0)));
    }

    #[test]
    fn descriptions_never_include_child_output() {
        let kind = classify_exit(&exit(1), &lines(&["token=SECRET"]));
        assert!(!kind.describe().contains("SECRET"));
        assert!(FailureKind::LeaseHeld.describe().contains("lease"));
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let policy = RecoveryPolicy {
            max_restarts: 10,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(10),
            stable_after: Duration::from_secs(60),
        };
        let delays: Vec<_> = (1..=6).map(|n| policy.delay_for(n).as_secs()).collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 10, 10]);
        assert_eq!(policy.delay_for(500), Duration::from_secs(10));
        assert_eq!(policy.delay_for(0), Duration::from_secs(1));
    }

    #[test]
    fn budget_gives_up_after_the_cap() {
        let mut budget = RestartBudget::new(RecoveryPolicy {
            max_restarts: 2,
            ..RecoveryPolicy::default()
        });
        assert!(matches!(
            budget.on_failure(Duration::ZERO),
            Decision::Retry { attempt: 1, .. }
        ));
        assert!(matches!(
            budget.on_failure(Duration::ZERO),
            Decision::Retry { attempt: 2, .. }
        ));
        assert_eq!(budget.on_failure(Duration::ZERO), Decision::GiveUp);
    }

    #[test]
    fn a_stable_run_resets_the_streak() {
        let policy = RecoveryPolicy {
            max_restarts: 2,
            stable_after: Duration::from_secs(30),
            ..RecoveryPolicy::default()
        };
        let mut budget = RestartBudget::new(policy);
        budget.on_failure(Duration::ZERO);
        budget.on_failure(Duration::ZERO);
        // Long healthy run, then a crash: back to the first retry.
        assert!(matches!(
            budget.on_failure(Duration::from_secs(31)),
            Decision::Retry { attempt: 1, .. }
        ));
        budget.reset();
        assert_eq!(budget.streak(), 0);
    }

    #[test]
    fn status_lines_are_short_and_informative() {
        assert_eq!(
            Phase::Starting { attempt: 1 }.status_line(),
            "Starting\u{2026}"
        );
        assert!(Phase::Starting { attempt: 3 }
            .status_line()
            .contains("attempt 3"));
        assert_eq!(
            Phase::Ready {
                origin: "http://127.0.0.1:1".into(),
                port: 1,
                launch_secret: LaunchSecret::from_bytes(&[0; 32]),
            }
            .status_line(),
            "Running"
        );
        let restarting = Phase::Restarting {
            attempt: 2,
            max: 5,
            retry_in: Duration::from_secs(4),
            reason: "boom".into(),
        };
        assert_eq!(restarting.status_line(), "Restarting (2/5) in 4s: boom");
        assert!(Phase::Failed("x".into())
            .status_line()
            .starts_with("Unavailable: "));
    }
}
