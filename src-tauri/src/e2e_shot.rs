//! E2E-only window tools: `e2e_screenshot` renders the REAL WKWebView content to a PNG with `takeSnapshot` (no screen
//! recording permission, works while the window is covered) and `e2e_resize` sets the window's inner size.
//! Both refuse to run unless the e2e harness is active (see `e2e.rs`: `INTELY_E2E_SCRIPT` and `INTELY_E2E=1`/debug build).

use std::path::PathBuf;

use tauri::{LogicalSize, State, WebviewWindow};

use crate::e2e::E2e;

/// `<INTELY_E2E_SHOTS | .scratch/shots>/<stem>.png`; the stem is restricted to file-name-safe characters.
fn target_path(stem: &str) -> Result<PathBuf, String> {
    if stem.is_empty() || !stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) || stem.starts_with('.') {
        return Err(format!("invalid screenshot name {stem:?}"));
    }
    let dir = std::env::var_os("INTELY_E2E_SHOTS").map_or_else(|| PathBuf::from(".scratch/shots"), PathBuf::from);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir.join(format!("{stem}.png")))
}

/// Saves a snapshot of the webview as `<stem>.png`, `scale` times the window's logical inner width wide in pixels (2 = retina-like).
#[tauri::command]
pub async fn e2e_screenshot(window: WebviewWindow, e2e: State<'_, E2e>, stem: String, scale: Option<f64>) -> Result<String, String> {
    if !e2e.enabled() {
        return Err("e2e harness is not enabled".to_owned());
    }
    let path = target_path(&stem)?;
    let scale = scale.unwrap_or(2.0).clamp(1.0, 4.0);
    // WebKit renders the snapshot at the display's backing scale, so the width in points is the wanted pixel width divided by it.
    let backing = window.scale_factor().map_err(|e| e.to_string())?;
    let width = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(backing).width * scale / backing;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    {
        let tx = tx.clone();
        window.with_webview(move |webview| snapshot::take(webview.inner(), width, tx)).map_err(|e| e.to_string())?;
    }
    drop(tx);
    let png = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(20)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "snapshot timed out".to_owned())??;
    std::fs::write(&path, png).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn e2e_resize(window: WebviewWindow, e2e: State<'_, E2e>, width: f64, height: f64) -> Result<(), String> {
    if !e2e.enabled() {
        return Err("e2e harness is not enabled".to_owned());
    }
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod snapshot {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::mpsc::Sender;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    type Reply = Sender<Result<Vec<u8>, String>>;

    fn png(image: &NSImage) -> Result<Vec<u8>, String> {
        let tiff = image.TIFFRepresentation().ok_or("the snapshot has no bitmap")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("the snapshot is not a bitmap")?;
        let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.ok_or("PNG encoding failed")?;
        Ok(data.to_vec())
    }

    /// Must run on the main thread (`with_webview` guarantees it); the completion handler runs there too.
    pub fn take(webview: *mut c_void, width: f64, reply: Reply) {
        // SAFETY: `inner()` is the window's WKWebView, alive for the duration of this call and retained by the block's use below.
        let view: Retained<WKWebView> = unsafe { Retained::retain(webview.cast()) }.expect("null WKWebView");
        let reply = RefCell::new(Some(reply));
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = match unsafe { image.as_ref() } {
                Some(image) => png(image),
                None => Err(unsafe { error.as_ref() }.map_or_else(|| "snapshot failed".to_owned(), |e| e.localizedDescription().to_string())),
            };
            if let Some(reply) = reply.borrow_mut().take() {
                let _ = reply.send(result);
            }
        });
        unsafe {
            let config = WKSnapshotConfiguration::new(MainThreadMarker::new().expect("snapshots are taken on the main thread"));
            config.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
            view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod snapshot {
    pub fn take(_: *mut std::ffi::c_void, _: f64, reply: std::sync::mpsc::Sender<Result<Vec<u8>, String>>) {
        let _ = reply.send(Err("screenshots are only implemented on macOS".to_owned()));
    }
}
