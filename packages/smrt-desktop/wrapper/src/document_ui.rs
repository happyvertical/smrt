//! Native private PDF windows. Supported only on Darwin arm64. No renderer IPC,
//! external opener, disk preview cache or renderer-supplied bytes/credentials.
use crate::documents::{self, Policy};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// WKWebView can suppress target=_blank before its new-window delegate is
/// called. Capture an actual user activation before that decision. This passes
/// only an untrusted requested URL; Rust owns every permission and credential.
pub(crate) const ANCHOR_SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  const capability = '__SMRT_PRIVATE_ACTION_CAPABILITY__';
  const documentAnchor = (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    return anchor && ((anchor.getAttribute('target') || '').toLowerCase() === '_blank' || anchor.hasAttribute('download')) ? anchor : null;
  };
  const guidance = new WeakMap();
  window.addEventListener('contextmenu', (event) => {
    const anchor = documentAnchor(event);
    if (!event.isTrusted || !anchor) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!guidance.has(anchor)) {
      const note = document.createElement('span'); note.setAttribute('role', 'status');
      note.textContent = ' Use this link with a primary click or Enter, then Save PDF in the preview.';
      anchor.after(note); guidance.set(anchor, note);
    }
  }, true);
  window.addEventListener('click', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const anchor = documentAnchor(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.href = 'smrt-private-document://open/?cap=' + capability + '&url=' + encodeURIComponent(anchor.href);
  }, true);
})();
"#;

fn action_target(action: &Url, expected: &str) -> Option<Url> {
    let values: Vec<_> = action.query_pairs().collect();
    if action.scheme() != "smrt-private-document"
        || action.host_str() != Some("open")
        || action.path() != "/"
        || !action.username().is_empty()
        || action.password().is_some()
        || action.port().is_some()
        || action.fragment().is_some()
        || values.len() != 2
        || expected.len() != 64
    {
        return None;
    }
    let capability = values.iter().find(|(key, _)| key == "cap")?.1.as_bytes();
    let target = &values.iter().find(|(key, _)| key == "url")?.1;
    if capability.len() != expected.len()
        || capability
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            != 0
    {
        return None;
    }
    Url::parse(target).ok()
}

pub(crate) fn action(app: &AppHandle, action: &Url) {
    let target = action_target(action, &app.state::<Documents>().action_key.lock().unwrap());
    if let Some(target) = target {
        open(app, target);
    } else {
        unsupported(app);
    }
}

pub(crate) fn unsupported(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_title(
            "Document action denied — use a PDF link in the main app with click or Enter",
        );
    }
}

#[derive(Default)]
pub(crate) struct Documents {
    pub action_key: Mutex<String>,
    error: Mutex<Option<&'static str>>,
    pub origin: Mutex<Option<Url>>,
    pub owner_route: Mutex<Option<String>>,
    bytes: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    busy: AtomicBool,
}

pub(crate) fn protocol(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let label = context.webview_label();
    let state = context.app_handle().state::<Documents>();
    if label == "private-document-error"
        && request.method() == "GET"
        && request
            .uri()
            .authority()
            .is_some_and(|a| a.as_str() == "localhost")
        && request.uri().path() == "/"
        && request.uri().query().is_none()
    {
        if let Some(message) = *state.error.lock().unwrap() {
            let message = message
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            return tauri::http::Response::builder().header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store").header("Content-Security-Policy", "default-src 'none'").body(format!("<!doctype html><html><head><title>Private PDF</title></head><body><h1>PDF action could not finish</h1><p>{message}</p><p>Close this window to return to the app.</p></body></html>").into_bytes()).unwrap();
        }
    }
    let bytes = state.bytes.lock().unwrap().get(label).cloned();
    response_for(label, &request, bytes)
}

fn response_for(
    label: &str,
    request: &tauri::http::Request<Vec<u8>>,
    bytes: Option<Arc<Vec<u8>>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();
    let authorized = label.starts_with("private-pdf-")
        && request.method() == "GET"
        && request
            .uri()
            .authority()
            .is_some_and(|a| a.as_str() == "localhost")
        && request.uri().query().is_none()
        && bytes.is_some();
    let (status, mime, body) = if !authorized {
        (
            403,
            "text/plain",
            b"Document unavailable. Close and reopen it.".to_vec(),
        )
    } else if path == format!("/{label}/pdf") {
        (200, "application/pdf", bytes.unwrap().as_ref().clone())
    } else if path == format!("/{label}/") {
        (200, "text/html", format!("<!doctype html><html><head><meta charset='utf-8'><title>Private PDF</title></head><body><p><a href='smrt-save://save'>Save PDF…</a> — Close this window to discard the preview.</p><iframe title='Private PDF' style='width:100%;height:88vh;border:0' src='smrt-document://localhost/{label}/pdf'></iframe></body></html>").into_bytes())
    } else {
        (403, "text/plain", b"Document unavailable.".to_vec())
    };
    tauri::http::Response::builder().status(status).header("Content-Type", mime)
        .header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; frame-src smrt-document:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
        .body(body).unwrap()
}

fn feedback(app: &AppHandle, message: &'static str) {
    let app = app.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        *handle.state::<Documents>().error.lock().unwrap() = Some(message);
        if let Some(window) = handle.get_webview_window("private-document-error") {
            let _ = window.reload();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
        let error_url: Url = "smrt-document://localhost/".parse().unwrap();
        let window = WebviewWindowBuilder::new(
            &handle,
            "private-document-error",
            WebviewUrl::External(error_url.clone()),
        )
        .title("Private PDF — action could not finish")
        .inner_size(620.0, 260.0)
        .incognito(true)
        .on_navigation(move |url| *url == error_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
        if let Ok(window) = window {
            let app = handle.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    *app.state::<Documents>().error.lock().unwrap() = None;
                }
            });
        } else if let Some(main) = handle.get_webview_window("main") {
            let _ = main.set_title(message);
        }
    });
}

pub(crate) fn open(app: &AppHandle, target: Url) {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        feedback(app, "Private PDF windows require Darwin arm64.");
        return;
    }
    let state = app.state::<Documents>();
    let policy = app
        .config()
        .plugins
        .0
        .get("smrt-desktop")
        .and_then(|v| v.get("privateDocuments"))
        .and_then(|v| serde_json::from_value::<Policy>(v.clone()).ok());
    let origin = state.origin.lock().unwrap().clone();
    let allowed = policy
        .zip(origin)
        .is_some_and(|(p, o)| p.permits(&o, &target, state.owner_route.lock().unwrap().as_deref()));
    if !allowed {
        feedback(app, "This document route is not permitted by the desktop product. Return to the app and choose an allowed PDF.");
        return;
    }
    if state.bytes.lock().unwrap().len() >= 4 || state.busy.swap(true, Ordering::SeqCst) {
        feedback(
            app,
            "Close a PDF window or wait for the current PDF, then retry.",
        );
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| {
            let main = app
                .get_webview_window("main")
                .ok_or("Return to the app and reopen the PDF.")?;
            if main
                .url()
                .map_err(|_| "Cannot verify the app window. Reopen the PDF.")?
                .origin()
                != target.origin()
            {
                return Err("Return to the active app window and reopen the PDF.");
            }
            // Uses the existing main WebView's store, including HttpOnly cookies;
            // no incognito store or independent unauthenticated window is used.
            let cookie = documents::cookie_header(
                &target,
                main.cookies()
                    .map_err(|_| "Cannot read the app session. Sign in and retry.")?,
            );
            let bytes = documents::retrieve(&target, &cookie)?;
            // Do not publish bytes after a sidecar restart changes the origin.
            if app
                .state::<Documents>()
                .origin
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|o| o.origin() != target.origin())
            {
                return Err("The app restarted. Reopen the PDF to retry.");
            }
            show(&app, bytes, target)
        })();
        app.state::<Documents>().busy.store(false, Ordering::SeqCst);
        if let Err(message) = result {
            feedback(&app, message);
        }
    });
}

fn show(app: &AppHandle, bytes: Vec<u8>, target: Url) -> Result<(), &'static str> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "Cannot open a document window. Retry.")?;
    let label = format!("private-pdf-{:032x}", u128::from_le_bytes(random));
    let url = format!("smrt-document://localhost/{label}/");
    let pdf_url = format!("smrt-document://localhost/{label}/pdf");
    let bytes = Arc::new(bytes);
    app.state::<Documents>()
        .bytes
        .lock()
        .unwrap()
        .insert(label.clone(), bytes.clone());
    let handle = app.clone();
    let save_label = label.clone();
    let document_url = url.clone();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse().unwrap()))
        .title("Private PDF — Save PDF using the link above the preview")
        .inner_size(900.0, 800.0)
        .incognito(true)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |url| {
            if url.as_str() == "smrt-save://save" {
                save(&handle, &save_label, bytes.clone(), target.clone());
                return false;
            }
            url.as_str() == document_url || url.as_str() == pdf_url
        })
        .build();
    match window {
        Ok(window) => {
            let app = app.clone();
            let id = label;
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    app.state::<Documents>().bytes.lock().unwrap().remove(&id);
                }
            });
            Ok(())
        }
        Err(_) => {
            app.state::<Documents>()
                .bytes
                .lock()
                .unwrap()
                .remove(&label);
            Err("Cannot open the PDF window. Reopen the document to retry.")
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
struct BusyGuard(AppHandle);
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0
            .state::<Documents>()
            .busy
            .store(false, Ordering::SeqCst);
    }
}

fn save(app: &AppHandle, label: &str, bytes: Arc<Vec<u8>>, target: Url) {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        if app.state::<Documents>().busy.swap(true, Ordering::SeqCst) {
            feedback(
                app,
                "Wait for the current PDF operation, then retry Save PDF.",
            );
            return;
        }
        let handle = app.clone();
        let label = label.to_owned();
        std::thread::spawn(move || {
            let guard = BusyGuard(handle.clone());
            let authorized = (|| {
                if handle
                    .state::<Documents>()
                    .origin
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_none_or(|o| o.origin() != target.origin())
                {
                    return Err("The app restarted. Reopen the PDF before saving.");
                }
                let main = handle
                    .get_webview_window("main")
                    .ok_or("Return to the app and reopen the PDF.")?;
                let cookie = documents::cookie_header(
                    &target,
                    main.cookies()
                        .map_err(|_| "Cannot read the app session. Sign in and reopen the PDF.")?,
                );
                let current = documents::retrieve(&target, &cookie)?;
                if current != *bytes {
                    return Err("The PDF changed. Close this preview and reopen the document before saving.");
                }
                Ok(())
            })();
            if let Err(message) = authorized {
                feedback(&handle, message);
                return;
            }
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                // Keep the single-operation guard through the native panel.
                let _guard = guard;
                if app.get_webview_window(&label).is_none() || app.state::<Documents>().origin.lock().unwrap().as_ref().is_none_or(|o| o.origin() != target.origin()) { return; }
                let chosen = rfd::FileDialog::new().set_title("Save private PDF — choose a new filename")
                    .set_file_name("document.pdf").add_filter("PDF", &["pdf"]).save_file();
                let Some(path) = chosen else {
                    if let Some(window) = app.get_webview_window(&label) { let _ = window.set_title("Private PDF — Save cancelled; no file written"); } return;
                };
                if app.get_webview_window(&label).is_none() { return; }
                match documents::save_new(&path, &bytes) {
                    Ok(()) => { if let Some(window) = app.get_webview_window(&label) { let _ = window.set_title("Private PDF — Saved"); } }
                    Err(_) => feedback(&app, "PDF was not saved. Choose a new plain filename ending .pdf in a writable folder. Existing files and symlinks are never replaced, even after a Replace prompt. Retry Save PDF."),
                }
            });
        });
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (app, label, bytes, target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_action_requires_a_closed_per_window_capability() {
        let key = "a".repeat(64);
        let action: Url = format!("smrt-private-document://open/?cap={key}&url=http%3A%2F%2F127.0.0.1%3A49123%2Fdocuments%2Fid%2Fpdf").parse().unwrap();
        assert_eq!(
            action_target(&action, &key).unwrap().as_str(),
            "http://127.0.0.1:49123/documents/id/pdf"
        );
        assert!(action_target(&action, &"b".repeat(64)).is_none());
        assert!(action_target(&action, "").is_none());
        for value in [
            "smrt-private-document://open/?url=http://127.0.0.1",
            "smrt-private-document://foreign/?cap=bad&url=http://127.0.0.1",
            "smrt-private-document://open/?cap=bad&url=http://127.0.0.1&url=http://foreign",
            "smrt-private-document://owner@open/?cap=bad&url=http://127.0.0.1",
            "smrt-private-document://open/?cap=bad&url=http://127.0.0.1#proof",
            "smrt-private-document://open/?cap=bad&unknown=http://127.0.0.1",
        ] {
            assert!(action_target(&value.parse().unwrap(), &key).is_none());
        }
    }
    #[test]
    fn protocol_bytes_are_bound_to_document_identity_and_exact_local_path() {
        let bytes = Arc::new(b"%PDF-1.7\n%%EOF".to_vec());
        let request = |uri: &str| {
            tauri::http::Request::builder()
                .uri(uri)
                .body(Vec::new())
                .unwrap()
        };
        let owner = "private-pdf-owner";
        assert_eq!(
            response_for(
                owner,
                &request("smrt-document://localhost/private-pdf-owner/pdf"),
                Some(bytes.clone())
            )
            .body(),
            bytes.as_ref()
        );
        for (label, uri, present) in [
            (
                "main",
                "smrt-document://localhost/private-pdf-owner/pdf",
                true,
            ),
            (
                "private-pdf-other",
                "smrt-document://localhost/private-pdf-owner/pdf",
                true,
            ),
            (owner, "smrt-document://foreign/private-pdf-owner/pdf", true),
            (
                owner,
                "smrt-document://localhost/private-pdf-owner/pdf?proof=x",
                true,
            ),
            (
                owner,
                "smrt-document://localhost/private-pdf-owner/%70df",
                true,
            ),
            (
                owner,
                "smrt-document://localhost/private-pdf-owner/pdf",
                false,
            ),
        ] {
            assert_eq!(
                response_for(
                    label,
                    &request(uri),
                    if present { Some(bytes.clone()) } else { None }
                )
                .status(),
                403
            );
        }
        let post = tauri::http::Request::builder()
            .method("POST")
            .uri("smrt-document://localhost/private-pdf-owner/pdf")
            .body(Vec::new())
            .unwrap();
        assert_eq!(response_for(owner, &post, Some(bytes)).status(), 403);
    }
}
