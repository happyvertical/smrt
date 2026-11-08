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
//! The race is handled, not prevented: the supervisor treats an
//! address-in-use failure before the child becomes healthy as a retryable
//! launch failure and starts the next attempt on a new port
//! (see [`crate::supervisor`]). A health probe that succeeds while the child
//! has already exited is likewise rejected, so a squatter answering on the
//! chosen port is never mistaken for the sidecar.

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
