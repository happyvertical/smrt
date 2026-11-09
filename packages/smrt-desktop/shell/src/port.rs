//! Loopback port selection and the bind-release race.
//!
//! The sidecar is a stock Node server that must be told its port through
//! `PORT`, so the supervisor has to pick one first. The only portable way to
//! get a free port is to bind `127.0.0.1:0`, read the number the OS chose and
//! release the socket before launching the child. Between the release and the
//! child's own `listen()` another process can take the port. That window is
//! unavoidable without handing the listening socket to the child, which a
//! stock Node server cannot accept through `PORT`.
//!
//! The race is handled, not prevented, and only up to a bound:
//!
//! - A child that dies of an address-in-use failure before it is healthy is a
//!   retryable launch failure; the next attempt starts on a new port without
//!   spending the crash budget (see [`crate::supervisor`]).
//! - A process that grabbed the port can answer the first health probe while
//!   the child is still starting, so a 2xx alone is not trusted. The sidecar
//!   only counts as ready after the first 2xx, a confirmation window
//!   (`SupervisorConfig::confirm_window`, 1s by default) with the child still
//!   alive, a second 2xx, and a final liveness check. A child that dies of
//!   `EADDRINUSE` inside that window takes the same relaunch-on-a-new-port
//!   path, and `Ready` (and so navigation and showing the window) is never
//!   published for the squatter's origin.
//!
//! Residual limits: the window is a time bound, not a proof. A child that
//! needs longer than the window to fail its bind, or a squatter that takes the
//! port after the confirmation, is not caught here; a squatter that outlives a
//! child that keeps running without listening would be probed as the sidecar.
//! A stock Node server fails its `listen()` within milliseconds of starting, so
//! the default leaves a wide margin for the case the window exists for.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};

/// Bind `127.0.0.1:0`, take the port and release it.
pub fn reserve_loopback_port() -> io::Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Whether `port` can be bound right now on the loopback interface.
pub fn is_port_free(port: u16) -> bool {
    port != 0 && TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok()
}

/// Pick the port for the next launch.
///
/// A restart prefers the previous port when it is still free so the origin
/// (and with it origin-scoped web storage in the window) survives a crash
/// restart; otherwise it falls back to a fresh OS-chosen port.
pub fn choose_port(preferred: Option<u16>) -> io::Result<u16> {
    match preferred {
        Some(port) if is_port_free(port) => Ok(port),
        _ => reserve_loopback_port(),
    }
}

/// True when child output shows it could not bind its port.
///
/// Matches Node's `EADDRINUSE` and the common OS phrasing.
pub fn is_address_in_use(lines: &[String]) -> bool {
    lines.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains("eaddrinuse") || lower.contains("address already in use")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_a_nonzero_port_that_is_then_free() {
        let port = reserve_loopback_port().unwrap();
        assert_ne!(port, 0);
        assert!(is_port_free(port));
    }

    #[test]
    fn a_bound_port_is_not_free() {
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(!is_port_free(port));
        drop(held);
    }

    #[test]
    fn choose_port_prefers_a_free_previous_port() {
        let port = reserve_loopback_port().unwrap();
        assert_eq!(choose_port(Some(port)).unwrap(), port);
    }

    #[test]
    fn choose_port_falls_back_when_the_previous_port_is_taken() {
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = held.local_addr().unwrap().port();
        let chosen = choose_port(Some(taken)).unwrap();
        assert_ne!(chosen, taken);
        assert_ne!(chosen, 0);
        assert_ne!(choose_port(Some(0)).unwrap(), 0);
    }

    #[test]
    fn detects_address_in_use_output() {
        let lines = |s: &str| vec![s.to_owned()];
        assert!(is_address_in_use(&lines(
            "Error: listen EADDRINUSE: address already in use 127.0.0.1:4000"
        )));
        assert!(is_address_in_use(&lines("bind: Address already in use")));
        assert!(!is_address_in_use(&lines("listening on 4000")));
        assert!(!is_address_in_use(&[]));
    }
}
