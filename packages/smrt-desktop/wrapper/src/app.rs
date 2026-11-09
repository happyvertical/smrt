//! Thin Tauri glue: single instance, tray, window, sidecar launch.
//!
//! Everything with real logic lives in the tested modules; this file wires
//! them to Tauri and is verified by running the app, not by unit tests.

use std::ffi::OsString;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent, Wry};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::env::{resolve_data_dir, window_log_line, window_url};
use crate::log::Logger;
use crate::manifest::{read_manifest_file, MANIFEST_FILE_NAME};
use crate::process::{
    signal_graceful, ExitInfo, ExitLatch, LaunchPlan, Launcher, ManagedChild, OutputTail,
};
use crate::signals::{block_termination_signals, wait_for_termination_signal};
use crate::supervisor::{emergency_kill, Phase, Supervisor, SupervisorConfig, SupervisorParams};

const MAIN_WINDOW: &str = "main";
const LOG_DIR: &str = ".desktop-wrapper";
const LOG_FILE: &str = "supervisor.log";
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");
/// Opt-in debugging switch: log a truncated tail of the child's output when a
/// start fails. Off by default because a runtime can print one-time secrets.
const LOG_OUTPUT_ENV: &str = "SMRT_DESKTOP_LOG_SIDECAR_OUTPUT";

struct TrayUi {
    tray: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    retry: MenuItem<Wry>,
}

#[derive(Default)]
struct Wrapper {
    supervisor: Mutex<Option<Supervisor>>,
    tray: Mutex<Option<TrayUi>>,
    quitting: AtomicBool,
    shown_once: AtomicBool,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// Launches the sidecar through the Tauri shell plugin (`externalBin`).
struct TauriLauncher {
    app: AppHandle,
}

struct TauriChild {
    pid: u32,
    child: Option<CommandChild>,
    latch: ExitLatch,
    tail: OutputTail,
}

impl Launcher for TauriLauncher {
    fn launch(&self, plan: &LaunchPlan) -> io::Result<Box<dyn ManagedChild>> {
        let to_io = |error: tauri_plugin_shell::Error| match error {
            tauri_plugin_shell::Error::Io(error) => error,
            other => io::Error::other(other),
        };
        let command = self
            .app
            .shell()
            .sidecar(&plan.program)
            .map_err(to_io)?
            .args(&plan.args)
            .env_clear()
            .envs(plan.env.clone())
            .current_dir(&plan.cwd)
            // SIGKILL / job-object kill reaches grandchildren, and a dropped
            // handle (panic unwinding) kills the group.
            .set_process_group(true)
            .kill_on_drop(true);
        let (mut events, child) = command.spawn().map_err(to_io)?;
        let latch = ExitLatch::default();
        let tail = OutputTail::default();
        let (reader_latch, reader_tail) = (latch.clone(), tail.clone());
        thread::Builder::new()
            .name("smrt-sidecar-events".into())
            .spawn(move || {
                while let Some(event) = events.blocking_recv() {
                    match event {
                        CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                            reader_tail.push(&String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Error(_) => reader_tail.push("process event error"),
                        CommandEvent::Terminated(payload) => {
                            reader_latch.set(ExitInfo {
                                code: payload.code,
                                signal: payload.signal,
                            });
                        }
                        _ => {}
                    }
                }
                // Channel closed without `Terminated`: nothing more will come.
                reader_latch.set(ExitInfo {
                    code: None,
                    signal: None,
                });
            })?;
        Ok(Box::new(TauriChild {
            pid: child.pid(),
            child: Some(child),
            latch,
            tail,
        }))
    }
}

impl ManagedChild for TauriChild {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn try_exit(&mut self) -> Option<ExitInfo> {
        self.latch.get()
    }

    fn wait_for_exit(&mut self, timeout: std::time::Duration) -> Option<ExitInfo> {
        self.latch.wait(timeout)
    }

    fn request_graceful_stop(&mut self) -> io::Result<()> {
        if self.latch.get().is_some() {
            return Ok(());
        }
        signal_graceful(self.pid)
    }

    fn force_kill(&mut self) -> io::Result<()> {
        match self.child.take() {
            Some(child) => child.kill().map_err(io::Error::other),
            None => Ok(()),
        }
    }

    fn output_tail(&self) -> Vec<String> {
        self.tail.snapshot()
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn status_text(text: &str) -> String {
    let mut text: String = text.chars().take(140).collect();
    if text.chars().count() == 140 {
        text.push('\u{2026}');
    }
    text
}

/// Update tray text and (on first ready) point the window at the sidecar.
/// `ready_url` is the origin plus the manifest's owner route and the launch
/// secret query; the route answers with a redirect that carries the one-time owner link to the
/// webview, so this process never sees that link. Safe to call from any thread.
fn publish(app: &AppHandle, status: String, retryable: bool, ready_url: Option<String>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let wrapper = handle.state::<Wrapper>();
        if let Some(ui) = locked(&wrapper.tray).as_ref() {
            let _ = ui.status.set_text(&status);
            let _ = ui.retry.set_enabled(retryable);
            let _ = ui.tray.set_tooltip(Some(&status));
        }
        let Some(target) = ready_url else { return };
        let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        if let Ok(url) = target.parse() {
            let _ = window.navigate(url);
        }
        // Only the first ready state raises the window; later restarts must
        // not pop it up if the user hid it.
        if !wrapper.shown_once.swap(true, Ordering::SeqCst) {
            show_main_window(&handle);
        }
    });
}

fn on_phase(app: &AppHandle, logger: &Logger, owner_route: Option<&str>, phase: &Phase) {
    logger.info(&format!("phase: {}", phase.status_line()));
    let (retryable, target) = match phase {
        Phase::Failed(_) => (true, None),
        Phase::Ready {
            origin,
            launch_secret,
            ..
        } => {
            // Origin and route only: neither the launch secret (the window URL's
            // query) nor the redirect's Location (which carries the owner token)
            // is logged.
            logger.info(&window_log_line(origin, owner_route));
            (false, Some(window_url(origin, owner_route, launch_secret)))
        }
        _ => (false, None),
    };
    publish(app, status_text(&phase.status_line()), retryable, target);
}

fn build_tray(app: &AppHandle) -> tauri::Result<TrayUi> {
    let status = MenuItem::with_id(app, "status", "Starting\u{2026}", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let retry = MenuItem::with_id(app, "retry", "Restart", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &open, &retry, &separator, &quit])?;
    let tray = TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(TRAY_ICON)?)
        .tooltip("Starting\u{2026}")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "retry" => {
                let wrapper = app.state::<Wrapper>();
                let supervisor = locked(&wrapper.supervisor);
                if let Some(supervisor) = supervisor.as_ref() {
                    supervisor.retry();
                }
            }
            "quit" => begin_quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(TrayUi {
        tray,
        status,
        retry,
    })
}

/// Stop the sidecar (blocking) exactly once, then leave the process.
fn begin_quit(app: &AppHandle) {
    let wrapper = app.state::<Wrapper>();
    if wrapper.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    let spawned = thread::Builder::new()
        .name("smrt-quit".into())
        .spawn(move || {
            stop_supervisor(&handle);
            handle.exit(0);
        });
    if spawned.is_err() {
        stop_supervisor(app);
        app.exit(0);
    }
}

fn stop_supervisor(app: &AppHandle) {
    let wrapper = app.state::<Wrapper>();
    let supervisor = locked(&wrapper.supervisor).take();
    if let Some(supervisor) = supervisor {
        supervisor.shutdown();
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    // The machine-local root, never the roaming one: on Windows `app_data_dir`
    // is `%APPDATA%` (Roaming), which would copy the SQLite files, pid and
    // socket state to other machines. On macOS and Linux the two coincide.
    let app_local_data_dir = app.path().app_local_data_dir()?;
    let resource_dir = app.path().resource_dir()?;
    let logger = Arc::new(Logger::new(app_local_data_dir.join(LOG_DIR), LOG_FILE));
    logger.info("wrapper starting");

    app.manage(Wrapper::default());
    let ui = build_tray(&handle)?;
    *locked(&handle.state::<Wrapper>().tray) = Some(ui);
    spawn_signal_thread(&handle, logger.clone());

    let manifest = match read_manifest_file(&resource_dir.join(MANIFEST_FILE_NAME)) {
        Ok(manifest) => manifest,
        Err(message) => {
            logger.error(&format!("manifest: {message}"));
            publish(
                &handle,
                status_text(&format!("Unavailable: {message}")),
                false,
                None,
            );
            return Ok(());
        }
    };
    let data_dir = match resolve_data_dir(&app_local_data_dir, &manifest.data_directory) {
        Ok(path) => path,
        Err(error) => {
            logger.error(&format!("data directory: {error}"));
            publish(
                &handle,
                status_text(&format!("Unavailable: {error}")),
                false,
                None,
            );
            return Ok(());
        }
    };

    let owner_route = manifest.owner_claim_route.clone();
    let config = SupervisorConfig {
        log_failure_output: std::env::var_os(LOG_OUTPUT_ENV).is_some_and(|v| v == "1"),
        ..SupervisorConfig::default()
    };
    let listener_app = handle.clone();
    let listener_log = logger.clone();
    let supervisor = Supervisor::start(SupervisorParams {
        manifest,
        resource_dir,
        data_dir,
        inherited_env: utf8_env(std::env::vars_os()),
        launcher: Arc::new(TauriLauncher {
            app: handle.clone(),
        }),
        logger,
        config,
        listener: Arc::new(move |phase| {
            on_phase(&listener_app, &listener_log, owner_route.as_deref(), phase)
        }),
    })?;
    *locked(&handle.state::<Wrapper>().supervisor) = Some(supervisor);
    Ok(())
}

/// Keep only environment pairs whose name and value are both valid Unicode.
///
/// `std::env::vars()` panics on anything else, which on Linux is a realistic
/// environment; a skipped pair is simply not inherited by the sidecar.
fn utf8_env(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(String, String)> {
    vars.into_iter()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// Turn SIGTERM/SIGINT/SIGHUP into an orderly quit; a second signal while the
/// quit is still running forces the issue.
fn spawn_signal_thread(app: &AppHandle, logger: Arc<Logger>) {
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("smrt-signals".into())
        .spawn(move || {
            while let Some(signal) = wait_for_termination_signal() {
                if app.state::<Wrapper>().quitting.load(Ordering::SeqCst) {
                    logger.warn(&format!("signal {signal} during quit; killing the sidecar"));
                    emergency_kill();
                    std::process::exit(1);
                }
                logger.info(&format!("signal {signal}: quitting"));
                begin_quit(&app);
            }
        });
}

/// Kill the sidecar if the main thread dies of a panic, so it is not orphaned
/// holding the data directory's writer lease.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if thread::current().name() == Some("main") {
            emergency_kill();
        }
        previous(info);
    }));
}

/// Run the desktop wrapper.
pub fn run() {
    // Before any other thread exists, so every thread inherits the mask.
    block_termination_signals();
    install_panic_hook();
    let app = tauri::Builder::default()
        // Must be registered first. A second launch focuses the first window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(setup)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .app_handle()
                    .try_state::<Wrapper>()
                    .is_some_and(|wrapper| wrapper.quitting.load(Ordering::SeqCst));
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("smrt-desktop-wrapper failed to start: {error}");
            std::process::exit(1);
        }
    };
    app.run(|handle, event| match event {
        // `None` means the user asked to quit (for example Cmd+Q); stop the
        // sidecar first. `Some` is our own `exit()` after shutdown.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => {
            api.prevent_exit();
            begin_quit(handle);
        }
        RunEvent::Exit => stop_supervisor(handle),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// D7 (assumed, pending owner confirmation): the data directory and the
    /// log live under `app_local_data_dir`. Tauri's `app_data_dir` is Roaming
    /// on Windows; SQLite and pid/socket state must not roam. This guards the
    /// non-test source from calling the roaming resolver again.
    #[test]
    fn wrapper_state_uses_the_local_data_dir_never_the_roaming_one() {
        let source = include_str!("app.rs");
        let production = source
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("split always yields a first part");
        let roaming_call = [".app_data", "_dir("].concat();
        assert!(
            !production.contains(&roaming_call),
            "app.rs must resolve the data directory with app_local_data_dir"
        );
        assert!(production.contains(".app_local_data_dir()"));
    }

    #[test]
    fn valid_pairs_are_kept_in_order() {
        let kept = utf8_env([
            (OsString::from("A"), OsString::from("1")),
            (OsString::from("B"), OsString::from("")),
        ]);
        assert_eq!(
            kept,
            vec![
                ("A".to_owned(), "1".to_owned()),
                ("B".to_owned(), String::new())
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_names_and_values_are_skipped_instead_of_panicking() {
        use std::os::unix::ffi::OsStringExt;
        let bad = || OsString::from_vec(vec![b'x', 0xff, 0xfe]);
        let kept = utf8_env([
            (OsString::from("GOOD"), OsString::from("yes")),
            (bad(), OsString::from("value")),
            (OsString::from("BAD_VALUE"), bad()),
            (OsString::from("ALSO_GOOD"), OsString::from("ok")),
        ]);
        assert_eq!(
            kept,
            vec![
                ("GOOD".to_owned(), "yes".to_owned()),
                ("ALSO_GOOD".to_owned(), "ok".to_owned())
            ]
        );
    }
}
