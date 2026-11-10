//! Reusable Tauri 2 wrapper that supervises a stock Node sidecar.
//!
//! The behaviour lives in small, individually tested modules; `app` is the
//! thin Tauri glue (tray, window, single instance, sidecar launch).

pub mod env;
pub mod health;
pub mod log;
pub mod manifest;
pub mod port;
pub mod process;
pub mod shutdown;
pub mod signals;
pub mod supervisor;

mod app;

pub use app::run;
