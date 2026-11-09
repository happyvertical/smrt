//! Supervisor integration tests against a fake Node sidecar.
//!
//! They need a `node` binary on PATH and skip (with a note) when it is
//! absent. Nothing here starts containers or touches the network beyond
//! 127.0.0.1.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use smrt_desktop_wrapper::env::origin_for;
use smrt_desktop_wrapper::health::{loopback_addr, probe_once, HealthConfig};
use smrt_desktop_wrapper::log::Logger;
use smrt_desktop_wrapper::manifest::SidecarManifest;
use smrt_desktop_wrapper::process::StdLauncher;
use smrt_desktop_wrapper::shutdown::ShutdownConfig;
use smrt_desktop_wrapper::supervisor::{
    Phase, RecoveryPolicy, Supervisor, SupervisorConfig, SupervisorParams,
};

fn find_node() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

macro_rules! node_or_skip {
    () => {
        match find_node() {
            Some(node) => node,
            None => {
                eprintln!("skipping: `node` is not on PATH");
                return;
            }
        }
    };
}

fn scratch(label: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "smrt-wrapper-it-{label}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(&dir).unwrap()
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-sidecar.mjs")
}

struct Harness {
    supervisor: Supervisor,
    state: PathBuf,
    resource: PathBuf,
    data: PathBuf,
    log: Arc<Logger>,
    phases: Arc<Mutex<Vec<Phase>>>,
}

struct Options {
    mode: &'static str,
    fail_runs: u32,
    health_route: &'static str,
    extra_env: Vec<(&'static str, &'static str)>,
    inherited: Vec<(String, String)>,
    recovery: RecoveryPolicy,
    config: Option<SupervisorConfig>,
    log_dir: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: "ok",
            fail_runs: 0,
            health_route: "/health",
            extra_env: Vec::new(),
            inherited: Vec::new(),
            recovery: fast_recovery(),
            config: None,
            log_dir: None,
        }
    }
}

fn fast_recovery() -> RecoveryPolicy {
    RecoveryPolicy {
        max_restarts: 5,
        base_delay: Duration::from_millis(30),
        max_delay: Duration::from_millis(120),
        stable_after: Duration::from_secs(60),
    }
}

fn fast_config(recovery: RecoveryPolicy) -> SupervisorConfig {
    SupervisorConfig {
        health: HealthConfig {
            total_timeout: Duration::from_secs(10),
            poll_interval: Duration::from_millis(25),
            request_timeout: Duration::from_millis(500),
        },
        shutdown: ShutdownConfig {
            graceful_timeout: Duration::from_secs(3),
            kill_timeout: Duration::from_secs(3),
        },
        recovery,
        max_port_retries: 5,
        monitor_interval: Duration::from_millis(25),
        output_settle: Duration::from_millis(100),
        confirm_window: Duration::from_millis(100),
        log_failure_output: false,
    }
}

fn start(node: &Path, options: Options) -> Harness {
    let state = scratch("state");
    let resource = scratch("resource");
    let data = scratch("data").join("runtime");
    let mut env = serde_json::Map::new();
    env.insert("FAKE_MODE".into(), options.mode.into());
    env.insert("FAKE_STATE_DIR".into(), state.to_str().unwrap().into());
    env.insert(
        "FAKE_FAIL_RUNS".into(),
        options.fail_runs.to_string().into(),
    );
    env.insert("FAKE_HEALTH_ROUTE".into(), options.health_route.into());
    for (key, value) in &options.extra_env {
        env.insert((*key).into(), (*value).into());
    }
    let manifest_json = serde_json::json!({
        "version": 1,
        "executable": "node",
        "args": [fixture().to_str().unwrap(), "--flag", "two words"],
        "healthRoute": options.health_route,
        "dataDirectory": "runtime",
        "env": env,
    })
    .to_string();
    // The fixture path is absolute, which the argument policy allows: args
    // are literal strings owned by the packaging tool.
    let manifest = SidecarManifest::parse(&manifest_json).unwrap();

    let log_dir = options.log_dir.unwrap_or_else(|| scratch("log"));
    let log = Arc::new(Logger::new(log_dir, "supervisor.log"));
    let phases = Arc::new(Mutex::new(Vec::new()));
    let seen = phases.clone();
    let mut inherited: Vec<(String, String)> = std::env::vars().collect();
    inherited.extend(options.inherited);
    let config = options
        .config
        .unwrap_or_else(|| fast_config(options.recovery));
    let supervisor = Supervisor::start(SupervisorParams {
        manifest,
        resource_dir: resource.clone(),
        data_dir: data.clone(),
        inherited_env: inherited,
        launcher: Arc::new(StdLauncher::with_program(node)),
        logger: log.clone(),
        config,
        listener: Arc::new(move |phase| seen.lock().unwrap().push(phase.clone())),
    })
    .unwrap();
    Harness {
        supervisor,
        state,
        resource,
        data,
        log,
        phases,
    }
}

impl Harness {
    fn wait_ready(&self) -> (String, u16) {
        match self.supervisor.wait_for(Duration::from_secs(20), |p| {
            matches!(p, Phase::Ready { .. } | Phase::Failed(_))
        }) {
            Some(Phase::Ready { origin, port }) => (origin, port),
            other => panic!("expected Ready, got {other:?}\n{}", self.log_text()),
        }
    }

    fn wait_failed(&self) -> String {
        match self.supervisor.wait_for(Duration::from_secs(20), |p| {
            matches!(p, Phase::Ready { .. } | Phase::Failed(_))
        }) {
            Some(Phase::Failed(message)) => message,
            other => panic!("expected Failed, got {other:?}\n{}", self.log_text()),
        }
    }

    fn log_text(&self) -> String {
        fs::read_to_string(self.log.path()).unwrap_or_default()
    }

    fn state_file(&self, name: &str) -> Option<String> {
        fs::read_to_string(self.state.join(name)).ok()
    }

    fn runs(&self) -> u32 {
        // A momentarily empty or partial read counts as "not yet written".
        self.state_file("runs")
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    }

    fn pid(&self) -> u32 {
        self.state_file("pid")
            .and_then(|s| s.trim().parse().ok())
            .expect("the sidecar has written its pid")
    }

    fn phases(&self) -> Vec<Phase> {
        self.phases.lock().unwrap().clone()
    }
}

fn get(url: &str) -> String {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();
    agent
        .get(url)
        .call()
        .unwrap()
        .body_mut()
        .read_to_string()
        .unwrap()
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    false
}

fn wait_dead(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(pid) {
        assert!(Instant::now() < deadline, "pid {pid} is still alive");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn reserved_env_wins_and_the_launch_shape_is_exact() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            extra_env: vec![("CUSTOM", "from-manifest")],
            inherited: vec![
                ("HOST".into(), "0.0.0.0".into()),
                ("PORT".into(), "1".into()),
                ("ORIGIN".into(), "https://attacker.example".into()),
                ("SMRT_DATA_DIR".into(), "/etc".into()),
                ("host".into(), "lowercase".into()),
                ("INHERITED_MARKER".into(), "kept".into()),
            ],
            ..Options::default()
        },
    );
    let (origin, port) = h.wait_ready();
    assert_eq!(origin, origin_for(port));

    let seen: serde_json::Value = serde_json::from_str(&get(&format!("{origin}/env"))).unwrap();
    assert_eq!(seen["HOST"], "127.0.0.1");
    assert_eq!(seen["PORT"], port.to_string());
    assert_eq!(seen["ORIGIN"], origin);
    assert_eq!(seen["SMRT_DATA_DIR"], h.data.to_str().unwrap());
    assert_eq!(seen["CUSTOM"], "from-manifest");
    assert_eq!(seen["INHERITED_MARKER"], "kept");
    assert!(
        seen["lowerHost"].is_null(),
        "shadowing inherited names are dropped"
    );
    // Working directory is the packaged app root, separate from the data dir.
    assert_eq!(seen["cwd"], h.resource.to_str().unwrap());
    assert_ne!(seen["cwd"], seen["SMRT_DATA_DIR"]);
    // Arguments are passed literally, without shell splitting.
    assert_eq!(seen["argv"], serde_json::json!(["--flag", "two words"]));
    h.supervisor.shutdown();
}

#[test]
fn the_probe_passes_only_on_the_selected_origin() {
    let node = node_or_skip!();
    let h = start(&node, Options::default());
    let (_, port) = h.wait_ready();
    assert!(probe_once(loopback_addr(port), "/health", Duration::from_secs(2)).is_healthy());
    // Same route, any other port: not ready.
    let other = smrt_desktop_wrapper::port::reserve_loopback_port().unwrap();
    assert!(!probe_once(loopback_addr(other), "/health", Duration::from_secs(2)).is_healthy());
    // Same origin, other route: not the health route.
    assert!(!probe_once(loopback_addr(port), "/missing", Duration::from_secs(2)).is_healthy());
    h.supervisor.shutdown();
}

#[test]
fn a_redirecting_health_route_never_becomes_ready() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "redirect",
            ..Options::default()
        },
    );
    let message = h.wait_failed();
    assert!(message.contains("redirect"), "{message}");
    assert!(!h.phases().iter().any(|p| matches!(p, Phase::Ready { .. })));
    // The failed child was stopped; nothing is left running.
    wait_dead(h.pid());
    assert_eq!(h.runs(), 1, "a configuration fault is not retried");
    h.supervisor.shutdown();
}

#[test]
fn a_child_that_never_turns_healthy_is_stopped_and_reported() {
    let node = node_or_skip!();
    let mut config = fast_config(RecoveryPolicy {
        max_restarts: 0,
        ..fast_recovery()
    });
    config.health.total_timeout = Duration::from_millis(500);
    let h = start(
        &node,
        Options {
            mode: "never-healthy",
            config: Some(config),
            ..Options::default()
        },
    );
    let message = h.wait_failed();
    assert!(message.contains("did not become healthy"), "{message}");
    wait_dead(h.pid());
    h.supervisor.shutdown();
}

#[cfg(unix)]
#[test]
fn a_sigterm_ignoring_child_is_killed_after_the_bound() {
    let node = node_or_skip!();
    let mut config = fast_config(fast_recovery());
    config.shutdown = ShutdownConfig {
        graceful_timeout: Duration::from_millis(600),
        kill_timeout: Duration::from_secs(3),
    };
    let h = start(
        &node,
        Options {
            mode: "ignore-sigterm",
            config: Some(config),
            ..Options::default()
        },
    );
    h.wait_ready();
    let pid = h.pid();
    assert!(process_alive(pid));

    let started = Instant::now();
    h.supervisor.shutdown();
    let took = started.elapsed();

    assert!(
        took >= Duration::from_millis(550),
        "SIGTERM must be given its full bound first ({took:?})"
    );
    assert!(
        took < Duration::from_secs(3),
        "SIGKILL must follow the bound ({took:?})"
    );
    assert!(
        h.state_file("sigterm").is_some(),
        "the child was asked to stop first"
    );
    wait_dead(pid);
    assert!(h.log_text().contains("Killed"), "{}", h.log_text());
    assert_eq!(h.supervisor.phase(), Phase::Stopped);
}

#[test]
fn a_cooperative_child_stops_gracefully_without_a_kill() {
    let node = node_or_skip!();
    let h = start(&node, Options::default());
    h.wait_ready();
    let pid = h.pid();
    h.supervisor.shutdown();
    wait_dead(pid);
    assert!(h.log_text().contains("Graceful"), "{}", h.log_text());
    assert_eq!(h.supervisor.phase(), Phase::Stopped);
    // Idempotent.
    h.supervisor.shutdown();
}

#[test]
fn address_in_use_relaunches_on_a_new_port_without_spending_the_crash_budget() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "addr-in-use",
            fail_runs: 2,
            // Any budget use would turn this into Failed.
            recovery: RecoveryPolicy {
                max_restarts: 0,
                ..fast_recovery()
            },
            ..Options::default()
        },
    );
    h.wait_ready();
    assert_eq!(h.runs(), 3);
    assert!(!h
        .phases()
        .iter()
        .any(|p| matches!(p, Phase::Restarting { .. } | Phase::Failed(_))));
    assert!(h.log_text().contains("relaunching on a new port"));
    h.supervisor.shutdown();
}

/// Plain HTTP responder that answers every request 200, standing in for a
/// non-child process that grabbed the chosen port.
struct Squatter {
    requests: Arc<AtomicU32>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Squatter {
    fn bind(port: u16) -> Self {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(AtomicU32::new(0));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (seen, halt) = (requests.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !halt.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).ok();
                        stream
                            .set_read_timeout(Some(Duration::from_millis(500)))
                            .ok();
                        let mut buffer = [0u8; 1024];
                        let _ = stream.read(&mut buffer);
                        seen.fetch_add(1, Ordering::SeqCst);
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        );
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Self {
            requests,
            stop,
            handle: Some(handle),
        }
    }
}

impl Drop for Squatter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[test]
fn a_squatter_answering_the_first_probe_is_never_published_as_ready() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "squatted",
            fail_runs: 1,
            // Any budget use would turn this into Failed.
            recovery: RecoveryPolicy {
                max_restarts: 0,
                ..fast_recovery()
            },
            config: Some(SupervisorConfig {
                confirm_window: Duration::from_millis(1500),
                ..fast_config(RecoveryPolicy {
                    max_restarts: 0,
                    ..fast_recovery()
                })
            }),
            ..Options::default()
        },
    );

    // Run 1 reports the port it was given and then waits at the gate.
    let deadline = Instant::now() + Duration::from_secs(10);
    let squatted_port: u16 = loop {
        if let Some(text) = h.state_file("port-1") {
            break text.trim().parse().unwrap();
        }
        assert!(Instant::now() < deadline, "run 1 never reported its port");
        std::thread::sleep(Duration::from_millis(10));
    };
    // The supervisor released the port before launching; take it, answer the
    // supervisor's first probe, and only then let the child try to bind.
    let squatter = Squatter::bind(squatted_port);
    while squatter.requests.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "no probe reached the squatter");
        std::thread::sleep(Duration::from_millis(5));
    }
    fs::write(h.state.join("squatter-ready-1"), "").unwrap();

    let (origin, port) = h.wait_ready();
    assert_ne!(port, squatted_port);
    assert_eq!(origin, origin_for(port));
    assert_eq!(h.runs(), 2);
    let squatted_origin = origin_for(squatted_port);
    assert!(
        !h.phases().iter().any(|p| matches!(
            p,
            Phase::Ready { origin, .. } if *origin == squatted_origin
        )),
        "the squatter's origin was published as Ready"
    );
    assert!(!h
        .phases()
        .iter()
        .any(|p| matches!(p, Phase::Restarting { .. } | Phase::Failed(_))));
    assert!(h.log_text().contains("relaunching on a new port"));
    h.supervisor.shutdown();
    drop(squatter);
}

#[test]
fn a_held_lease_is_a_retryable_startup_failure_with_backoff() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "lease-held",
            fail_runs: 2,
            ..Options::default()
        },
    );
    h.wait_ready();
    assert_eq!(h.runs(), 3);
    let reasons: Vec<String> = h
        .phases()
        .into_iter()
        .filter_map(|p| match p {
            Phase::Restarting { reason, .. } => Some(reason),
            _ => None,
        })
        .collect();
    assert_eq!(reasons.len(), 2);
    assert!(reasons.iter().all(|r| r.contains("lease")), "{reasons:?}");
    // The raw child output is never surfaced or logged by default.
    assert!(!h.log_text().contains("99999"));
    h.supervisor.shutdown();
}

#[test]
fn a_lease_that_never_frees_ends_in_failed_and_a_manual_retry_recovers() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "lease-held",
            fail_runs: 1000,
            recovery: RecoveryPolicy {
                max_restarts: 2,
                ..fast_recovery()
            },
            ..Options::default()
        },
    );
    let message = h.wait_failed();
    assert!(message.contains("lease"), "{message}");
    assert_eq!(h.runs(), 3, "first try plus two restarts");

    // The lease holder goes away (the fake checks for this marker).
    fs::write(h.state.join("release"), "").unwrap();
    h.supervisor.retry();
    // `Failed` is still the current phase until the supervisor wakes up.
    let ready = h.supervisor.wait_for(Duration::from_secs(20), |p| {
        matches!(p, Phase::Ready { .. })
    });
    assert!(ready.is_some(), "{}", h.log_text());
    h.supervisor.shutdown();
}

#[test]
fn a_crashed_sidecar_is_restarted_on_the_same_origin_and_never_overlaps() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "crash-after-ready",
            fail_runs: 2,
            ..Options::default()
        },
    );
    let (first_origin, _) = h.wait_ready();
    // Wait for the third (stable) run.
    let deadline = Instant::now() + Duration::from_secs(20);
    while h.runs() < 3 {
        assert!(Instant::now() < deadline, "{}", h.log_text());
        std::thread::sleep(Duration::from_millis(25));
    }
    let (final_origin, _) = match h.supervisor.wait_for(Duration::from_secs(10), |p| {
        matches!(p, Phase::Ready { .. })
    }) {
        Some(Phase::Ready { origin, port }) => (origin, port),
        other => panic!("{other:?}"),
    };
    assert_eq!(h.runs(), 3);
    // The previous port is reused when still free, keeping the origin stable.
    assert_eq!(first_origin, final_origin);
    let restarts = h
        .phases()
        .iter()
        .filter(|p| matches!(p, Phase::Restarting { .. }))
        .count();
    assert_eq!(restarts, 2);
    assert!(
        h.state_file("VIOLATION").is_none(),
        "two sidecars were alive at once for one data directory"
    );
    h.supervisor.shutdown();
    assert!(h.state_file("VIOLATION").is_none());
}

#[test]
fn a_crash_loop_hits_the_cap_and_stops_restarting() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "always-exit",
            recovery: RecoveryPolicy {
                max_restarts: 3,
                ..fast_recovery()
            },
            ..Options::default()
        },
    );
    let message = h.wait_failed();
    assert!(message.contains("gave up"), "{message}");
    assert!(message.contains("exit code 2"), "{message}");
    assert_eq!(h.runs(), 4);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(h.runs(), 4, "no launches after giving up");
    h.supervisor.shutdown();
}

#[test]
fn shutdown_during_backoff_does_not_launch_another_child() {
    let node = node_or_skip!();
    let h = start(
        &node,
        Options {
            mode: "always-exit",
            recovery: RecoveryPolicy {
                max_restarts: 5,
                base_delay: Duration::from_secs(30),
                max_delay: Duration::from_secs(30),
                stable_after: Duration::from_secs(60),
            },
            ..Options::default()
        },
    );
    h.supervisor
        .wait_for(Duration::from_secs(10), |p| {
            matches!(p, Phase::Restarting { .. })
        })
        .expect("restarting");
    let started = Instant::now();
    h.supervisor.shutdown();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(h.runs(), 1);
    assert_eq!(h.supervisor.phase(), Phase::Stopped);
}

#[test]
fn a_missing_executable_is_a_permanent_failure() {
    let _node = node_or_skip!();
    let h = start(
        Path::new("/definitely/not/a/real/binary"),
        Options::default(),
    );
    let message = h.wait_failed();
    assert!(message.contains("could not start"), "{message}");
    h.supervisor.shutdown();
}

#[test]
fn an_unwritable_log_directory_does_not_disturb_supervision() {
    let node = node_or_skip!();
    let blocker = scratch("blocker").join("file");
    fs::write(&blocker, b"x").unwrap();
    let h = start(
        &node,
        Options {
            log_dir: Some(blocker.join("logs")),
            ..Options::default()
        },
    );
    h.wait_ready();
    h.supervisor.shutdown();
    assert!(!h.log.path().exists());
}
