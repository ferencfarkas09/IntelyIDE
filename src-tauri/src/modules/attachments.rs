//! Tauri glue of the attachments module (alpha Attachments): commands on top of `intely_attachments::Store`.
//! Everything is a COPY into `<state dir>/attachments/<draftId>/`; no command reads or writes an arbitrary path
//! except `attachment_import_paths`, which reads exactly the dropped files. Raw bytes travel as the request body
//! (headers `x-draft`, `x-name` (percent-encoded), `x-mime`), never as a JSON array.

use std::path::PathBuf;

use intely_attachments::{Imported, Inspected, Meta, Store, STALE_AFTER_MS};
use intely_core::EngineError;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

type Res<T> = Result<T, EngineError>;

pub struct AttachmentsState {
    pub store: Store,
}

fn to_err(e: intely_attachments::AttachError) -> EngineError {
    EngineError::new(e.code, e.message)
}

pub fn state_root() -> PathBuf {
    std::env::var_os("INTELY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(intely_agent_core::events::log::JsonlEventLog::default_base_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("attachments")
}

/// Called once from `setup` (track marker in `lib.rs`): creates the state and sweeps drafts older than 7 days.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let store = Store::new(state_root());
    let sweeper = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        sweeper.cleanup(now, STALE_AFTER_MS);
    });
    app.manage(AttachmentsState { store });
    Ok(())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() && s.is_char_boundary(i + 1) && s.is_char_boundary(i + 3) {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(req: &Request<'_>, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

#[tauri::command]
pub async fn attachment_import_bytes(state: State<'_, AttachmentsState>, request: Request<'_>) -> Res<Imported> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err(EngineError::new("badRequest", "expected raw bytes")) };
    let draft = header(&request, "x-draft").ok_or_else(|| EngineError::new("badRequest", "missing x-draft"))?;
    let name = header(&request, "x-name").map(|n| percent_decode(&n)).unwrap_or_else(|| "attachment".into());
    let mime = header(&request, "x-mime");
    let source = header(&request, "x-source").map(|n| percent_decode(&n));
    state.store.import_bytes(&draft, &name, mime.as_deref(), bytes, source.as_deref()).map_err(to_err)
}

/// One result per dropped path, in order: either the imported attachment or the error code and message.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathImport {
    pub path: String,
    pub imported: Option<Imported>,
    pub error: Option<EngineError>,
}

#[tauri::command]
pub async fn attachment_import_paths(state: State<'_, AttachmentsState>, draft_id: String, paths: Vec<String>) -> Res<Vec<PathImport>> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| match store.import_path(&draft_id, std::path::Path::new(&p)) {
                Ok(i) => PathImport { path: p, imported: Some(i), error: None },
                Err(e) => PathImport { path: p, imported: None, error: Some(to_err(e)) },
            })
            .collect()
    })
    .await
    .map_err(|e| EngineError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn attachment_inspect(paths: Vec<String>) -> Res<Vec<Inspected>> {
    Ok(Store::inspect(&paths.into_iter().map(PathBuf::from).collect::<Vec<_>>()))
}

#[tauri::command]
pub async fn attachment_list(state: State<'_, AttachmentsState>, draft_id: String) -> Res<Vec<Meta>> {
    state.store.list(&draft_id).map_err(to_err)
}

#[tauri::command]
pub async fn attachment_read(state: State<'_, AttachmentsState>, draft_id: Option<String>, id: String) -> Result<Response, EngineError> {
    // A transcript only knows the attachment id; a composer knows its draft.
    let draft = match draft_id {
        Some(d) => d,
        None => state.store.locate(&id).map_err(to_err)?.draft_id,
    };
    state.store.read(&draft, &id).map(Response::new).map_err(to_err)
}

#[tauri::command]
pub async fn attachment_remove(state: State<'_, AttachmentsState>, draft_id: String, id: Option<String>) -> Res<()> {
    match id {
        Some(id) => state.store.remove(&draft_id, &id),
        None => state.store.remove_draft(&draft_id),
    }
    .map_err(to_err)
}

#[tauri::command]
pub async fn attachment_confirm(state: State<'_, AttachmentsState>, draft_id: String, id: String) -> Res<Meta> {
    state.store.confirm(&draft_id, &id).map_err(to_err)
}

/// The absolute store root (shown in the privacy line and used in prompts that reference stored files).
#[tauri::command]
pub async fn attachment_root(state: State<'_, AttachmentsState>) -> Res<String> {
    Ok(state.store.root().to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn attachment_cleanup(state: State<'_, AttachmentsState>) -> Res<usize> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(state.store.cleanup(now, STALE_AFTER_MS))
}
