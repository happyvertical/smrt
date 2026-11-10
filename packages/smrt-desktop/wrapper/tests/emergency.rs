//! The panic-path kill switch is process-global, so it gets its own test
//! process instead of sharing one with the other supervisor tests.

#![cfg(unix)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use smrt_desktop_wrapper::health::HealthConfig;
use smrt_desktop_wrapper::log::Logger;
use smrt_desktop_wrapper::manifest::SidecarManifest;
use smrt_desktop_wrapper::process::StdLauncher;
use smrt_desktop_wrapper::supervisor::{
    emergency_kill, Phase, Supervisor, SupervisorConfig, SupervisorParams,
};

#[test]
fn emergency_kill_terminates_the_live_sidecar_and_the_supervisor_recovers() {
    let Some(node) = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("node"))
            .find(|candidate| candidate.is_file())
    }) else {
        eprintln!("skipping: `node` is not on PATH");
        return;
    };
    let dir = std::env::temp_dir().join(format!("smrt-wrapper-emergency-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(dir).unwrap();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-sidecar.mjs");
    let manifest = SidecarManifest::parse(
        &serde_json::json!({
            "version": 1,
            "executable": "node",
            "args": [fixture.to_str().unwrap()],
            "healthRoute": "/health",
            "dataDirectory": "runtime",
            "env": { "FAKE_STATE_DIR": dir.to_str().unwrap() },
        })
        .to_string(),
    )
    .unwrap();
    let supervisor = Supervisor::start(SupervisorParams {
        manifest,
        resource_dir: dir.clone(),
        data_dir: dir.join("runtime"),
        inherited_env: std::env::vars().collect(),
        launcher: Arc::new(StdLauncher::with_program(node)),
        logger: Arc::new(Logger::new(&dir, "supervisor.log")),
        config: SupervisorConfig {
            health: HealthConfig {
                total_timeout: Duration::from_secs(10),
                poll_interval: Duration::from_millis(25),
                request_timeout: Duration::from_millis(500),
            },
            monitor_interval: Duration::from_millis(25),
            output_settle: Duration::from_millis(50),
            confirm_window: Duration::from_millis(100),
            ..SupervisorConfig::default()
        },
        listener: Arc::new(|_| {}),
    })
    .unwrap();
    supervisor
        .wait_for(Duration::from_secs(20), |p| {
            matches!(p, Phase::Ready { .. })
        })
        .expect("ready");
    let pid: i32 = std::fs::read_to_string(dir.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    emergency_kill();

    let deadline = Instant::now() + Duration::from_secs(5);
    // SAFETY: signal 0 only checks for existence.
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(
            Instant::now() < deadline,
            "sidecar survived the emergency kill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // A killed child is treated like any crash: back off and relaunch.
    supervisor
        .wait_for(Duration::from_secs(10), |p| {
            matches!(p, Phase::Restarting { .. })
        })
        .expect("restarting after the kill");
    supervisor.shutdown();
}
