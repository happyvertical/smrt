//! Termination signals as a quit request (unix).
//!
//! Without this, `kill`, a logout or a launchd/systemd stop would end the
//! wrapper with the default action and orphan the sidecar, which would keep the
//! data directory's writer lease. Instead the signals are blocked process
//! wide (threads inherit the mask, and `std::process` resets it for children
//! so the sidecar still receives SIGTERM normally) and one thread waits for
//! them synchronously, turning them into the same orderly quit as the tray's
//! Quit item.

/// Block SIGTERM, SIGINT and SIGHUP for this thread and every thread it
/// creates afterwards. Call first thing in `main`, before any thread exists.
#[cfg(unix)]
pub fn block_termination_signals() {
    let set = termination_set();
    // SAFETY: `set` is a fully initialised sigset_t; a null old-set is allowed.
    unsafe {
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

/// Block until one of the termination signals arrives.
#[cfg(unix)]
pub fn wait_for_termination_signal() -> Option<i32> {
    let set = termination_set();
    let mut signal = 0;
    // SAFETY: `set` is initialised and `signal` is a valid out pointer.
    let status = unsafe { libc::sigwait(&set, &mut signal) };
    (status == 0).then_some(signal)
}

#[cfg(unix)]
fn termination_set() -> libc::sigset_t {
    // SAFETY: sigemptyset/sigaddset initialise and update the set in place.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        set
    }
}

/// Windows has no equivalent here; console control events are not used.
#[cfg(not(unix))]
pub fn block_termination_signals() {}

/// Never returns a signal on platforms without signal support.
#[cfg(not(unix))]
pub fn wait_for_termination_signal() -> Option<i32> {
    None
}
