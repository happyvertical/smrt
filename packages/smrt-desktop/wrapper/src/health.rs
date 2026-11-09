//! Loopback HTTP health probe.
//!
//! Chosen client: `ureq` 3 with `default-features = false`. That build is a
//! blocking, plain-HTTP/1.1 client without a TLS stack, without a tokio
//! runtime, and with redirect following, proxy support and compression all
//! switchable off per agent. The supervisor runs on plain threads, so a
//! blocking client keeps the glue small; `hyper` would drag in an async
//! runtime for a status-line check, and a hand-rolled socket client would
//! re-implement HTTP framing. Every guard that matters is explicit below:
//!
//! * the target is a [`SocketAddr`] that must be loopback, never a hostname
//!   (no DNS, no `localhost` ambiguity);
//! * redirects are disabled and any 3xx is a failure, so a health route cannot
//!   bounce the probe to another host or port;
//! * environment proxies (`HTTP_PROXY` and friends) are disabled;
//! * only a 2xx counts as healthy; 4xx/5xx mean "not (yet) healthy";
//! * each request and the overall wait are time bounded.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::thread;
use std::time::{Duration, Instant};

/// Timing for a readiness wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthConfig {
    /// Total time allowed before the sidecar is declared unhealthy.
    pub total_timeout: Duration,
    /// Pause between probes.
    pub poll_interval: Duration,
    /// Bound for one probe request (connect plus response).
    pub request_timeout: Duration,
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            total_timeout: Duration::from_secs(60),
            poll_interval: Duration::from_millis(250),
            request_timeout: Duration::from_secs(2),
        }
    }
}

/// Result of a single probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// 2xx from the health route on the selected origin.
    Healthy,
    /// Any 3xx; redirects are never followed.
    Redirect(u16),
    /// A non-2xx, non-3xx status.
    BadStatus(u16),
    /// Connection refused, timeout, reset or malformed response.
    Unreachable(String),
    /// The target was not a loopback address; nothing was sent.
    NotLoopback,
}

impl ProbeOutcome {
    /// Whether the probe succeeded.
    pub fn is_healthy(&self) -> bool {
        matches!(self, Self::Healthy)
    }
}

impl fmt::Display for ProbeOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Healthy => f.write_str("healthy"),
            Self::Redirect(status) => write!(f, "health route redirected (HTTP {status})"),
            Self::BadStatus(status) => write!(f, "health route returned HTTP {status}"),
            Self::Unreachable(why) => write!(f, "health route unreachable: {why}"),
            Self::NotLoopback => f.write_str("health target is not a loopback address"),
        }
    }
}

/// `127.0.0.1:<port>`, the only target the supervisor ever probes.
pub fn loopback_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// Probe `route` on `addr` once.
pub fn probe_once(addr: SocketAddr, route: &str, request_timeout: Duration) -> ProbeOutcome {
    if !addr.ip().is_loopback() {
        return ProbeOutcome::NotLoopback;
    }
    // `route` is manifest-validated (no query, fragment, escapes or dots); a
    // route that is not `/`-prefixed cannot be formed into a request line.
    if !route.starts_with('/') {
        return ProbeOutcome::Unreachable("invalid health route".into());
    }
    let url = match addr {
        SocketAddr::V4(v4) => format!("http://{}:{}{route}", v4.ip(), v4.port()),
        SocketAddr::V6(v6) => format!("http://[{}]:{}{route}", v6.ip(), v6.port()),
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .max_redirects_will_error(false)
        .http_status_as_error(false)
        .proxy(None)
        .timeout_global(Some(request_timeout))
        .user_agent("smrt-desktop-wrapper-health/1")
        .build()
        .into();
    match agent.get(&url).call() {
        Ok(response) => {
            let status = response.status().as_u16();
            match status {
                200..=299 => ProbeOutcome::Healthy,
                300..=399 => ProbeOutcome::Redirect(status),
                _ => ProbeOutcome::BadStatus(status),
            }
        }
        Err(ureq::Error::TooManyRedirects) => ProbeOutcome::Redirect(0),
        Err(error) => ProbeOutcome::Unreachable(error.to_string()),
    }
}

/// How a readiness wait ended without success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitFailure {
    /// The total timeout elapsed; carries the last probe outcome.
    TimedOut(ProbeOutcome),
    /// The caller asked to stop waiting (child exited, shutdown requested).
    Aborted,
    /// A redirecting health route is a configuration fault, not a warm-up
    /// state, so the wait ends immediately instead of consuming the budget.
    Redirected(u16),
}

/// Poll until healthy, `abort` returns true, or the timeout elapses.
///
/// `abort` is checked before every probe and while sleeping so a dead child or
/// a shutdown request ends the wait promptly.
pub fn wait_until_healthy(
    addr: SocketAddr,
    route: &str,
    config: HealthConfig,
    mut abort: impl FnMut() -> bool,
) -> Result<(), WaitFailure> {
    let deadline = Instant::now() + config.total_timeout;
    loop {
        if abort() {
            return Err(WaitFailure::Aborted);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let budget = config
            .request_timeout
            .min(remaining.max(Duration::from_millis(50)));
        let last = match probe_once(addr, route, budget) {
            ProbeOutcome::Healthy => return Ok(()),
            ProbeOutcome::Redirect(status) => return Err(WaitFailure::Redirected(status)),
            ProbeOutcome::NotLoopback => {
                return Err(WaitFailure::TimedOut(ProbeOutcome::NotLoopback))
            }
            other => other,
        };
        if Instant::now() >= deadline {
            return Err(WaitFailure::TimedOut(last));
        }
        // Sleep in slices so `abort` stays responsive.
        let wake = (Instant::now() + config.poll_interval).min(deadline);
        while Instant::now() < wake {
            if abort() {
                return Err(WaitFailure::Aborted);
            }
            thread::sleep(Duration::from_millis(20).min(config.poll_interval));
        }
    }
}

#[cfg(test)]
pub(crate) mod test_server {
    //! Minimal one-thread HTTP/1.1 responder for probe tests.
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    pub struct TestServer {
        pub addr: SocketAddr,
        pub requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    /// `respond(path)` returns the full raw HTTP response for a request path.
    pub fn serve(respond: impl Fn(&str) -> String + Send + 'static) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (stop2, requests2) = (stop.clone(), requests.clone());
        let handle = thread::spawn(move || {
            while !stop2.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).ok();
                        stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                        let mut buffer = [0u8; 2048];
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                        let path = request
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or_default()
                            .to_owned();
                        requests2.lock().unwrap().push(path.clone());
                        stream.write_all(respond(&path).as_bytes()).ok();
                    }
                    Err(_) => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        TestServer {
            addr,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                handle.join().ok();
            }
        }
    }

    pub fn ok() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into()
    }

    pub fn status(code: u16) -> String {
        format!("HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }

    pub fn redirect(code: u16, location: &str) -> String {
        format!(
            "HTTP/1.1 {code} Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::*;
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    const T: Duration = Duration::from_secs(2);

    fn fast() -> HealthConfig {
        HealthConfig {
            total_timeout: Duration::from_millis(600),
            poll_interval: Duration::from_millis(20),
            request_timeout: Duration::from_millis(300),
        }
    }

    #[test]
    fn healthy_on_2xx_from_the_supplied_origin() {
        let server = serve(|path| if path == "/health" { ok() } else { status(404) });
        assert_eq!(probe_once(server.addr, "/health", T), ProbeOutcome::Healthy);
        assert_eq!(
            probe_once(server.addr, "/other", T),
            ProbeOutcome::BadStatus(404)
        );
    }

    #[test]
    fn passes_only_on_the_supplied_origin() {
        let server = serve(|_| ok());
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let other_addr = other.local_addr().unwrap();
        drop(other);
        assert!(probe_once(server.addr, "/", T).is_healthy());
        assert!(matches!(
            probe_once(other_addr, "/", T),
            ProbeOutcome::Unreachable(_)
        ));
    }

    #[test]
    fn refuses_non_loopback_targets_without_sending() {
        let addr: SocketAddr = "192.0.2.1:80".parse().unwrap();
        assert_eq!(probe_once(addr, "/", T), ProbeOutcome::NotLoopback);
        let addr: SocketAddr = "0.0.0.0:80".parse().unwrap();
        assert_eq!(probe_once(addr, "/", T), ProbeOutcome::NotLoopback);
    }

    #[test]
    fn any_3xx_is_a_failure_and_is_not_followed() {
        for code in [301, 302, 303, 307, 308] {
            let target = serve(|_| ok());
            let location = format!("http://{}/landed", target.addr);
            let redirecting = serve(move |_| redirect(code, &location));
            let outcome = probe_once(redirecting.addr, "/health", T);
            assert!(
                matches!(outcome, ProbeOutcome::Redirect(_)),
                "{code}: {outcome:?}"
            );
            assert!(
                target.requests.lock().unwrap().is_empty(),
                "redirect target must never be contacted"
            );
        }
    }

    #[test]
    fn a_5xx_during_warmup_is_retried_until_healthy() {
        let hits = Arc::new(AtomicU32::new(0));
        let counter = hits.clone();
        let server = serve(move |_| {
            if counter.fetch_add(1, Ordering::SeqCst) < 3 {
                status(503)
            } else {
                ok()
            }
        });
        wait_until_healthy(server.addr, "/h", fast(), || false).unwrap();
        assert!(hits.load(Ordering::SeqCst) >= 4);
    }

    #[test]
    fn a_redirecting_route_fails_immediately() {
        let server = serve(|_| redirect(302, "http://127.0.0.1:1/"));
        let started = Instant::now();
        let result = wait_until_healthy(server.addr, "/h", fast(), || false);
        assert_eq!(result, Err(WaitFailure::Redirected(302)));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn times_out_with_the_last_outcome() {
        let server = serve(|_| status(500));
        let started = Instant::now();
        let result = wait_until_healthy(server.addr, "/h", fast(), || false);
        assert_eq!(
            result,
            Err(WaitFailure::TimedOut(ProbeOutcome::BadStatus(500)))
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn abort_ends_the_wait_promptly() {
        let free = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = free.local_addr().unwrap();
        drop(free);
        let polls = AtomicU32::new(0);
        let config = HealthConfig {
            total_timeout: Duration::from_secs(30),
            ..fast()
        };
        let started = Instant::now();
        let result = wait_until_healthy(addr, "/h", config, || {
            polls.fetch_add(1, Ordering::SeqCst) > 3
        });
        assert_eq!(result, Err(WaitFailure::Aborted));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn environment_proxies_are_ignored() {
        // A proxy that would swallow the request must not be consulted.
        let trap = serve(|_| status(418));
        let server = serve(|_| ok());
        let proxy = format!("http://{}", trap.addr);
        std::env::set_var("HTTP_PROXY", &proxy);
        std::env::set_var("http_proxy", &proxy);
        std::env::set_var("ALL_PROXY", &proxy);
        let outcome = probe_once(server.addr, "/", T);
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("http_proxy");
        std::env::remove_var("ALL_PROXY");
        assert_eq!(outcome, ProbeOutcome::Healthy);
        assert!(trap.requests.lock().unwrap().is_empty());
    }
}
